import { CATEGORIES } from '../../shared/v2/contracts.js';

/**
 * Ponte entre o agente e o Financial Core (as mesmas tabelas que o dashboard lê).
 *
 * O agente continua trabalhando sobre um "estado" em memória. A cada mensagem:
 *   1. carrega do banco os lançamentos reais do número (hidratação);
 *   2. roda o agente sem alterá-lo;
 *   3. compara antes/depois e grava no banco só a diferença (criar, editar, apagar).
 * O banco é a fonte da verdade: o que o agente "lembra" nunca contradiz o dashboard.
 */

export type Workspace = { userId: string; workspaceId: string; accountId: string };
export type Entry = { id: string; type: 'receita' | 'despesa'; amount: number; description: string; date: string; category?: string };
export type Snapshot = { initialBalanceCents: number; transactions: Entry[]; /** Categorias do usuário além das padrão do agente. */ customCategories: string[]; /** Lançamento criado mais recentemente (a que "isso" se refere). */ lastRecordId?: string };
export type Changes = { create: Entry[]; update: Entry[]; remove: string[] };

export interface Ledger {
  /** Acha (ou cria) a conta do número. Cada número tem seu workspace; criar a conta é o que o faz aparecer no login do dashboard. */
  resolve(phone: string, name?: string): Promise<Workspace>;
  load(ws: Workspace): Promise<Snapshot>;
  apply(ws: Workspace, changes: Changes, key: string): Promise<void>;
}

export const MAX_STATE_TRANSACTIONS = 300;
const MAX_INITIAL_CENTS = 100_000_000;

/** Um lançamento só entra no estado do agente se o contrato dele aceitá-lo; o resto continua valendo no saldo, só não é listado. */
export function agentCanSee(e: { amount: number; date: string | null | undefined; description: string }): boolean {
  if (!e.date || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) return false;
  if (!Number.isFinite(e.amount) || e.amount <= 0 || e.amount > 1_000_000) return false;
  if (Math.abs(e.amount * 100 - Math.round(e.amount * 100)) > 0.00001) return false;
  return e.description.trim().length > 0;
}

const cents = (n: number) => Math.round(n * 100);
const signed = (e: Pick<Entry, 'type' | 'amount'>) => (e.type === 'receita' ? 1 : -1) * cents(e.amount);

/** Saldo inicial do agente = abertura + resultado de TUDO que está confirmado no banco - o que o agente enxerga. Assim o saldo dele bate com o do dashboard. */
export function initialBalanceFor(openingCents: number, netAllCents: number, visible: Entry[]): number {
  const raw = openingCents + netAllCents - visible.reduce((s, e) => s + signed(e), 0);
  return Math.min(MAX_INITIAL_CENTS, Math.max(0, raw));
}

const same = (a: Entry, b: Entry) => a.type === b.type && a.amount === b.amount && a.description === b.description && a.date === b.date && (a.category ?? '') === (b.category ?? '');

export function diffEntries(before: Entry[], after: Entry[]): Changes {
  const old = new Map(before.map(e => [e.id, e]));
  const seen = new Set<string>();
  const changes: Changes = { create: [], update: [], remove: [] };
  for (const e of after) {
    seen.add(e.id);
    const prev = old.get(e.id);
    if (!prev) changes.create.push(e);
    else if (!same(prev, e)) changes.update.push(e);
  }
  for (const e of before) if (!seen.has(e.id)) changes.remove.push(e.id);
  return changes;
}

type Fetch = typeof fetch;

export class SupabaseLedger implements Ledger {
  private readonly base: string;
  constructor(
    url: string,
    private readonly serviceKey: string,
    private readonly fetchImpl: Fetch = fetch
  ) {
    if (!url || !serviceKey) throw new Error('SUPABASE_NOT_CONFIGURED');
    this.base = url.replace(/\/$/, '');
  }

  private async call<T>(path: string, init: RequestInit & { prefer?: string } = {}): Promise<T> {
    const { prefer, ...rest } = init;
    const res = await this.fetchImpl(`${this.base}${path}`, {
      ...rest,
      headers: { apikey: this.serviceKey, ...(this.serviceKey.startsWith('eyJ') ? { Authorization: `Bearer ${this.serviceKey}` } : {}), 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw Object.assign(new Error(`SUPABASE_${res.status}`), { status: res.status });
    const text = await res.text();
    return (text ? JSON.parse(text) : []) as T;
  }
  private rest<T>(path: string, init?: RequestInit & { prefer?: string }) {
    return this.call<T>(`/rest/v1/${path}`, init);
  }
  private rpc<T>(name: string, args: Record<string, unknown>) {
    return this.rest<T>(`rpc/${name}`, { method: 'POST', body: JSON.stringify(args) });
  }

  private async find(phone: string): Promise<Workspace | null> {
    const rows = await this.rpc<{ user_id: string; workspace_id: string; account_id: string }[]>('whatsapp_workspace_for_phone', { p_phone: phone });
    const r = rows[0];
    return r ? { userId: r.user_id, workspaceId: r.workspace_id, accountId: r.account_id } : null;
  }

  async resolve(phone: string, name?: string) {
    let ws = await this.find(phone);
    if (!ws) {
      // O gatilho on_auth_user_created cria perfil, workspace e conta principal sozinho.
      try {
        await this.call('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ phone, phone_confirm: true, user_metadata: name ? { name } : {} }) });
      } catch (e) {
        // 422 = alguém criou no mesmo instante (duas mensagens seguidas): basta buscar de novo.
        if ((e as { status?: number }).status !== 422) throw e;
      }
      ws = await this.find(phone);
    }
    if (!ws) throw new Error('LEDGER_PROVISION_FAILED');
    await this.ensureCategories(ws.workspaceId);
    return ws;
  }

  private async categoryMap(workspaceId: string): Promise<Map<string, string>> {
    const rows = await this.rest<{ id: string; name: string }[]>(`finance_categories?workspace_id=eq.${workspaceId}&select=id,name&limit=200`);
    return new Map(rows.map(r => [r.name, r.id]));
  }

  private async ensureCategories(workspaceId: string) {
    const have = await this.categoryMap(workspaceId);
    const missing = CATEGORIES.filter(c => !have.has(c));
    if (!missing.length) return;
    await this.rest(`finance_categories?on_conflict=workspace_id,name`, {
      method: 'POST',
      body: JSON.stringify(missing.map(name => ({ workspace_id: workspaceId, name, kind: name === 'Renda' ? 'income' : 'expense' }))),
      prefer: 'resolution=ignore-duplicates,return=minimal',
    });
  }

  async load(ws: Workspace): Promise<Snapshot> {
    const [summary, rows, cats] = await Promise.all([
      this.rpc<{ opening_cents: number | string; net_cents: number | string }[]>('whatsapp_ledger_summary', { p_workspace: ws.workspaceId }),
      this.rest<{ id: string; type: 'income' | 'expense'; amount: number | string; description: string; effective_date: string | null; category_id: string | null; created_at: string }[]>(
        `finance_transactions?workspace_id=eq.${ws.workspaceId}&status=eq.confirmed&select=id,type,amount,description,effective_date,category_id,created_at&order=effective_date.desc,created_at.desc&limit=${MAX_STATE_TRANSACTIONS * 3}`
      ),
      this.categoryMap(ws.workspaceId),
    ]);
    // Sem "embed" do PostgREST: finance_transactions tem duas chaves para finance_categories e a junção automática é ambígua (HTTP 300).
    const nameOf = new Map([...cats].map(([name, id]) => [id, name]));
    const opening = Number(summary[0]?.opening_cents ?? 0);
    const net = Number(summary[0]?.net_cents ?? 0);
    const visible: Entry[] = [];
    for (const r of rows) {
      if (visible.length >= MAX_STATE_TRANSACTIONS) break;
      const amount = Number(r.amount);
      const description = String(r.description ?? '').trim().slice(0, 120);
      if (!agentCanSee({ amount, date: r.effective_date, description })) continue;
      visible.push({ id: r.id, type: r.type === 'income' ? 'receita' : 'despesa', amount, description, date: r.effective_date as string, ...(r.category_id && nameOf.get(r.category_id) ? { category: nameOf.get(r.category_id)!.slice(0, 50) } : {}) });
    }
    const newest = visible.length ? rows.filter(r => visible.some(v => v.id === r.id)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]?.id : undefined;
    visible.reverse(); // do mais antigo para o mais novo
    const builtIn = new Set<string>(CATEGORIES);
    const customCategories = [...cats.keys()].filter(name => !builtIn.has(name) && name.length <= 30).slice(0, 40);
    return { initialBalanceCents: initialBalanceFor(opening, net, visible), transactions: visible, customCategories, ...(newest ? { lastRecordId: newest } : {}) };
  }

  async apply(ws: Workspace, changes: Changes, key: string) {
    if (!changes.create.length && !changes.update.length && !changes.remove.length) return;
    let cats = await this.categoryMap(ws.workspaceId);
    // Categoria nova pedida pelo usuário: cria no workspace (aparece também no dashboard).
    const wanted = [...new Set([...changes.create, ...changes.update].map(e => e.category).filter((c): c is string => Boolean(c) && !cats.has(c as string)))];
    if (wanted.length) {
      await this.rest(`finance_categories?on_conflict=workspace_id,name`, {
        method: 'POST',
        body: JSON.stringify(wanted.map(name => ({ workspace_id: ws.workspaceId, name, kind: 'both' }))),
        prefer: 'resolution=ignore-duplicates,return=minimal',
      });
      cats = await this.categoryMap(ws.workspaceId);
    }
    const catId = (name?: string) => (name ? (cats.get(name) ?? null) : null);
    let i = 0;
    for (const e of changes.create) {
      await this.rpc('finance_create_transaction', {
        target_workspace_id: ws.workspaceId,
        target_account_id: ws.accountId,
        target_category_id: catId(e.category),
        target_description: e.description,
        target_amount: e.amount,
        target_type: e.type === 'receita' ? 'income' : 'expense',
        target_status: 'confirmed',
        target_competence_date: e.date,
        target_expected_date: e.date,
        target_effective_date: e.date,
        target_origin: 'ai',
        target_payment_method: null,
        target_note: 'Registrado pelo Pulse no WhatsApp',
        // Mesma mensagem reprocessada = mesma chave = nenhum lançamento duplicado.
        target_idempotency_key: `${key}:${i++}`,
      });
    }
    for (const e of changes.update) {
      await this.rest(`finance_transactions?id=eq.${e.id}&workspace_id=eq.${ws.workspaceId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          description: e.description,
          amount: e.amount,
          type: e.type === 'receita' ? 'income' : 'expense',
          competence_date: e.date,
          effective_date: e.date,
          category_id: catId(e.category),
        }),
      });
    }
    for (const id of changes.remove) {
      await this.rest(`finance_transactions?id=eq.${id}&workspace_id=eq.${ws.workspaceId}`, { method: 'DELETE' });
    }
  }
}

/** Implementação em memória, só para testes. Um "workspace" por telefone. */
export class MemoryLedger implements Ledger {
  workspaces = new Map<string, { ws: Workspace; opening: number; entries: Entry[]; categories?: Set<string> }>();
  applied: { key: string; changes: Changes }[] = [];
  failNextApply = false;
  private seq = 0;

  async resolve(phone: string, _name?: string) {
    let w = this.workspaces.get(phone);
    if (!w) {
      const n = ++this.seq;
      const id = (p: string) => `${p}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
      w = { ws: { userId: id('a'), workspaceId: id('b'), accountId: id('c') }, opening: 0, entries: [] };
      this.workspaces.set(phone, w);
    }
    return w.ws;
  }
  private of(ws: Workspace) {
    const w = [...this.workspaces.values()].find(x => x.ws.workspaceId === ws.workspaceId);
    if (!w) throw new Error('unknown workspace');
    return w;
  }
  async load(ws: Workspace) {
    const w = this.of(ws);
    const visible = w.entries.filter(e => agentCanSee(e)).slice(-MAX_STATE_TRANSACTIONS);
    const net = w.entries.reduce((s, e) => s + signed(e), 0);
    return { initialBalanceCents: initialBalanceFor(w.opening, net, visible), transactions: visible.map(({ idem: _idem, ...e }: Entry & { idem?: string }) => structuredClone(e)), customCategories: [...(w.categories ?? [])], ...(visible.length ? { lastRecordId: (w.entries[w.entries.length - 1] as Entry).id } : {}) };
  }
  async apply(ws: Workspace, changes: Changes, key: string) {
    if (this.failNextApply) {
      this.failNextApply = false;
      throw new Error('LEDGER_DOWN');
    }
    const w = this.of(ws);
    this.applied.push({ key, changes: structuredClone(changes) });
    for (const e of [...changes.create, ...changes.update]) if (e.category && !(CATEGORIES as readonly string[]).includes(e.category)) (w.categories ??= new Set()).add(e.category);
    let i = 0;
    for (const e of changes.create) {
      const idem = `${key}:${i++}`;
      if (w.entries.some(x => (x as Entry & { idem?: string }).idem === idem)) continue;
      w.entries.push({ ...structuredClone(e), idem } as Entry);
    }
    for (const e of changes.update) {
      const at = w.entries.findIndex(x => x.id === e.id);
      if (at >= 0) w.entries[at] = { ...w.entries[at], ...e };
    }
    w.entries = w.entries.filter(x => !changes.remove.includes(x.id));
  }
}
