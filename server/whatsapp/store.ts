import type { Contact, ContactStatus } from '../../shared/whatsapp/access.js';

export type UsageRow = { phone: string; messageId: string; source: 'text' | 'audio'; model?: string; modelCalls: number; inputTokens: number; outputTokens: number; status: string; errorCode?: string };

export type UsageRecord = { phone: string; model: string | null; input_tokens: number; output_tokens: number; status: string; error_code: string | null; created_at: string };

export type StoredSession = { session: unknown; version: number };

/** Tudo que o canal precisa guardar. Duas implementações: Supabase (produção) e memória (testes). */
export interface Store {
  getContact(phone: string): Promise<Contact | null>;
  upsertContact(contact: { phone: string; name?: string | null; status?: ContactStatus }): Promise<Contact>;
  setStatus(phone: string, status: ContactStatus): Promise<Contact | null>;
  markOwnerNotified(phone: string): Promise<void>;
  listContacts(): Promise<Contact[]>;
  latestPending(): Promise<Contact | null>;
  deleteContact(phone: string): Promise<void>;
  /** true se a mensagem é nova; false se já tinha sido recebida (Z-API pode reenviar o mesmo webhook). */
  claimMessage(messageId: string, phone: string, kind: 'text' | 'audio' | 'command' | 'other'): Promise<boolean>;
  recentMessageCount(phone: string, sinceMs: number): Promise<number>;
  /** Consumo de IA por mensagem (tokens, modelo, erro). Nunca guarda o texto nem valores financeiros. */
  recordUsage(row: UsageRow): Promise<void>;
  usageSince(iso: string): Promise<UsageRecord[]>;
  getSession(phone: string): Promise<StoredSession | null>;
  /** Grava só se a versão ainda for a lida (concorrência otimista). false = outra mensagem gravou antes. */
  saveSession(phone: string, session: unknown, expectedVersion: number | null): Promise<boolean>;
}

export class SupabaseStore implements Store {
  constructor(
    private readonly url: string,
    private readonly serviceKey: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    if (!url || !serviceKey) throw new Error('SUPABASE_NOT_CONFIGURED');
  }

  private async rest<T>(path: string, init: RequestInit & { prefer?: string } = {}): Promise<T> {
    const { prefer, ...rest } = init;
    const res = await this.fetchImpl(`${this.url.replace(/\/$/, '')}/rest/v1/${path}`, {
      ...rest,
      headers: {
        apikey: this.serviceKey,
        // Chave nova (sb_secret_…) vai só em apikey; a chave antiga (JWT service_role) também em Authorization.
        ...(this.serviceKey.startsWith('eyJ') ? { Authorization: `Bearer ${this.serviceKey}` } : {}),
        'Content-Type': 'application/json',
        ...(prefer ? { Prefer: prefer } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`SUPABASE_${res.status}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : []) as T;
  }

  async getContact(phone: string) {
    const rows = await this.rest<Contact[]>(`whatsapp_contacts?phone=eq.${encodeURIComponent(phone)}&select=*&limit=1`);
    return rows[0] ?? null;
  }

  async upsertContact(c: { phone: string; name?: string | null; status?: ContactStatus }) {
    const existing = await this.getContact(c.phone);
    if (existing) {
      const patch: Record<string, unknown> = {};
      if (c.name && !existing.name) patch.name = c.name;
      if (c.status && c.status !== existing.status) patch.status = c.status;
      if (c.status === 'authorized') patch.authorized_at = new Date().toISOString();
      if (Object.keys(patch).length) {
        const rows = await this.rest<Contact[]>(`whatsapp_contacts?phone=eq.${encodeURIComponent(c.phone)}`, { method: 'PATCH', body: JSON.stringify(patch), prefer: 'return=representation' });
        return rows[0] ?? existing;
      }
      return existing;
    }
    const row = { phone: c.phone, name: c.name ?? null, status: c.status ?? 'pending', ...(c.status === 'authorized' ? { authorized_at: new Date().toISOString() } : {}) };
    const rows = await this.rest<Contact[]>('whatsapp_contacts', { method: 'POST', body: JSON.stringify(row), prefer: 'resolution=ignore-duplicates,return=representation' });
    return rows[0] ?? (await this.getContact(c.phone)) ?? { phone: c.phone, status: row.status as ContactStatus };
  }

  async setStatus(phone: string, status: ContactStatus) {
    const patch: Record<string, unknown> = { status, ...(status === 'authorized' ? { authorized_at: new Date().toISOString() } : {}) };
    const rows = await this.rest<Contact[]>(`whatsapp_contacts?phone=eq.${encodeURIComponent(phone)}`, { method: 'PATCH', body: JSON.stringify(patch), prefer: 'return=representation' });
    return rows[0] ?? null;
  }

  async markOwnerNotified(phone: string) {
    await this.rest(`whatsapp_contacts?phone=eq.${encodeURIComponent(phone)}`, { method: 'PATCH', body: JSON.stringify({ owner_notified_at: new Date().toISOString() }) });
  }

  listContacts() {
    return this.rest<Contact[]>('whatsapp_contacts?select=*&order=first_seen_at.asc&limit=200');
  }

  async latestPending() {
    const rows = await this.rest<Contact[]>('whatsapp_contacts?status=eq.pending&select=*&order=first_seen_at.desc&limit=1');
    return rows[0] ?? null;
  }

  async deleteContact(phone: string) {
    // whatsapp_sessions tem ON DELETE CASCADE.
    await this.rest(`whatsapp_contacts?phone=eq.${encodeURIComponent(phone)}`, { method: 'DELETE' });
  }

  async claimMessage(messageId: string, phone: string, kind: 'text' | 'audio' | 'command' | 'other') {
    const rows = await this.rest<unknown[]>('whatsapp_messages', { method: 'POST', body: JSON.stringify({ message_id: messageId, phone, kind }), prefer: 'resolution=ignore-duplicates,return=representation' });
    return rows.length > 0;
  }

  async recentMessageCount(phone: string, sinceMs: number) {
    const since = new Date(Date.now() - sinceMs).toISOString();
    const rows = await this.rest<unknown[]>(`whatsapp_messages?phone=eq.${encodeURIComponent(phone)}&received_at=gte.${encodeURIComponent(since)}&select=message_id&limit=500`);
    return rows.length;
  }

  async recordUsage(r: UsageRow) {
    await this.rest('whatsapp_usage', { method: 'POST', body: JSON.stringify({ message_id: r.messageId, phone: r.phone, source: r.source, model: r.model ?? null, model_calls: r.modelCalls, input_tokens: r.inputTokens, output_tokens: r.outputTokens, status: r.status, error_code: r.errorCode ?? null }), prefer: 'resolution=ignore-duplicates,return=minimal' });
  }

  async usageSince(iso: string) {
    return this.rest<UsageRecord[]>(`whatsapp_usage?created_at=gte.${encodeURIComponent(iso)}&select=phone,model,input_tokens,output_tokens,status,error_code,created_at&order=created_at.desc&limit=20000`);
  }

  async getSession(phone: string) {
    const rows = await this.rest<{ session: unknown; version: number }[]>(`whatsapp_sessions?phone=eq.${encodeURIComponent(phone)}&select=session,version&limit=1`);
    return rows[0] ?? null;
  }

  async saveSession(phone: string, session: unknown, expectedVersion: number | null) {
    if (expectedVersion === null) {
      const rows = await this.rest<unknown[]>('whatsapp_sessions', { method: 'POST', body: JSON.stringify({ phone, session, version: 1 }), prefer: 'resolution=ignore-duplicates,return=representation' });
      return rows.length > 0;
    }
    const rows = await this.rest<unknown[]>(`whatsapp_sessions?phone=eq.${encodeURIComponent(phone)}&version=eq.${expectedVersion}`, {
      method: 'PATCH',
      body: JSON.stringify({ session, version: expectedVersion + 1, updated_at: new Date().toISOString() }),
      prefer: 'return=representation',
    });
    return rows.length > 0;
  }
}

/** Implementação em memória, só para testes. */
export class MemoryStore implements Store {
  contacts = new Map<string, Contact & { first_seen_at: number }>();
  messages = new Map<string, { phone: string; at: number }>();
  sessions = new Map<string, { session: unknown; version: number }>();
  private tick = 0;

  usage: UsageRow[] = [];
  async usageSince(): Promise<UsageRecord[]> { return []; }
  async recordUsage(r: UsageRow) { this.usage.push(r); }
  async getContact(phone: string) { return this.contacts.get(phone) ?? null; }
  async upsertContact(c: { phone: string; name?: string | null; status?: ContactStatus }) {
    const cur = this.contacts.get(c.phone);
    const next = { phone: c.phone, name: cur?.name ?? c.name ?? null, status: c.status ?? cur?.status ?? 'pending', owner_notified_at: cur?.owner_notified_at ?? null, first_seen_at: cur?.first_seen_at ?? ++this.tick } as Contact & { first_seen_at: number };
    this.contacts.set(c.phone, next);
    return next;
  }
  async setStatus(phone: string, status: ContactStatus) {
    const cur = this.contacts.get(phone);
    if (!cur) return null;
    cur.status = status;
    return cur;
  }
  async markOwnerNotified(phone: string) { const c = this.contacts.get(phone); if (c) c.owner_notified_at = 'now'; }
  async listContacts() { return [...this.contacts.values()].sort((a, b) => a.first_seen_at - b.first_seen_at); }
  async latestPending() { return [...this.contacts.values()].filter(c => c.status === 'pending').sort((a, b) => b.first_seen_at - a.first_seen_at)[0] ?? null; }
  async deleteContact(phone: string) { this.contacts.delete(phone); this.sessions.delete(phone); }
  async claimMessage(messageId: string, phone: string) {
    if (this.messages.has(messageId)) return false;
    this.messages.set(messageId, { phone, at: Date.now() });
    return true;
  }
  async recentMessageCount(phone: string, sinceMs: number) { return [...this.messages.values()].filter(m => m.phone === phone && Date.now() - m.at <= sinceMs).length; }
  async getSession(phone: string) { return this.sessions.get(phone) ?? null; }
  async saveSession(phone: string, session: unknown, expected: number | null) {
    const cur = this.sessions.get(phone);
    if ((cur?.version ?? null) !== expected) return false;
    this.sessions.set(phone, { session: structuredClone(session), version: (cur?.version ?? 0) + 1 });
    return true;
  }
}
