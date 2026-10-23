import { CATEGORIES } from '../../shared/v2/contracts.js';
import { cardKey, findCard, invoiceFor } from '../../shared/v2/cards.js';

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
export type CardRow = { id: string; name: string; closingDay: number; dueDay: number };
/** Compra no cartão feita nesta mensagem. `cardName` ausente = o usuário não disse o cartão. */
export type CardPurchase = { id: string; amount: number; description: string; date: string; category?: string; installments: number; cardName?: string };
export type CardUpsert = { name: string; closingDay: number; dueDay: number };
/** O que aconteceu com o cartão ao gravar: compras que ficaram esperando o cadastro e as que foram encaixadas numa fatura. */
export type ApplyResult = { waitingCard: number; placed: { count: number; total: number; dueDates: string[]; cardName: string } | null };
/** Aviso de fatura: "fechou" (uma vez) ou "vence" (até 3 vezes, com pergunta se já pagou). */
export type InvoiceNotice = { invoiceId: string; kind: 'closed' | 'due'; cardName: string; amount: number; closingDate: string; dueDate: string };
export type Snapshot = { cards?: CardRow[]; initialBalanceCents: number; transactions: Entry[]; /** Categorias do usuário além das padrão do agente. */ customCategories: string[]; /** Lançamento criado mais recentemente (a que "isso" se refere). */ lastRecordId?: string };
export type Changes = { create: Entry[]; update: Entry[]; remove: string[]; cardUpserts?: CardUpsert[]; cardPurchases?: CardPurchase[] };

export interface Ledger {
  /** Acha (ou cria) a conta do número. Cada número tem seu workspace; criar a conta é o que o faz aparecer no login do dashboard. */
  resolve(phone: string, name?: string): Promise<Workspace>;
  load(ws: Workspace): Promise<Snapshot>;
  apply(ws: Workspace, changes: Changes, key: string): Promise<ApplyResult | void>;
  /** Faturas que fecharam ou venceram e ainda não foram pagas. */
  invoiceNotices(ws: Workspace, today: string): Promise<InvoiceNotice[]>;
  /** Paga a fatura (sai da conta principal) na data informada. */
  payInvoice(ws: Workspace, invoiceId: string, date: string): Promise<void>;
  /** Lançamentos previstos que já deveriam ter acontecido (data prevista até hoje, últimos 30 dias), ainda sem baixa. */
  due(ws: Workspace, today: string): Promise<DueItem[]>;
  /** "Dar baixa": marca o lançamento previsto como realizado na data informada. */
  confirm(ws: Workspace, transactionId: string, effectiveDate: string): Promise<void>;
}

export type DueItem = { id: string; type: 'receita' | 'despesa'; amount: number; description: string; expectedDate: string; category?: string };

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

/** Cartões novos ou com dias alterados nesta mensagem. */
export function diffCards(before: { name: string; closingDay: number; dueDay: number }[], after: { name: string; closingDay: number; dueDay: number }[]): CardUpsert[] {
  const old = new Map(before.map(c => [cardKey(c.name), c]));
  return after.filter(c => { const o = old.get(cardKey(c.name)); return !o || o.closingDay !== c.closingDay || o.dueDay !== c.dueDay; }).map(c => ({ name: c.name, closingDay: c.closingDay, dueDay: c.dueDay }));
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

  /** Só procura a conta do número; nunca cria (usado pela prévia de lembretes do painel). */
  lookup(phone: string): Promise<Workspace | null> {
    return this.find(phone);
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

  async due(ws: Workspace, today: string): Promise<DueItem[]> {
    const from = new Date(Date.parse(`${today}T12:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
    const rows = await this.rest<{ id: string; type: 'income' | 'expense'; amount: number | string; description: string; expected_date: string; category_id: string | null }[]>(
      `finance_transactions?workspace_id=eq.${ws.workspaceId}&status=in.(planned,overdue)&settled_at=is.null&origin=neq.card&expected_date=lte.${today}&expected_date=gte.${from}&select=id,type,amount,description,expected_date,category_id&order=expected_date.asc&limit=20`
    );
    if (!rows.length) return [];
    const names = new Map([...(await this.categoryMap(ws.workspaceId))].map(([name, id]) => [id, name]));
    return rows.map(r => ({ id: r.id, type: r.type === 'income' ? 'receita' : 'despesa', amount: Number(r.amount), description: r.description, expectedDate: r.expected_date, category: r.category_id ? names.get(r.category_id) : undefined }));
  }

  async confirm(ws: Workspace, transactionId: string, effectiveDate: string) {
    await this.rpc('finance_confirm_transaction', { target_transaction_id: transactionId, target_workspace_id: ws.workspaceId, target_effective_date: effectiveDate });
  }

  private async cardRows(workspaceId: string): Promise<CardRow[]> {
    const rows = await this.rest<{ id: string; name: string; closing_day: number; due_day: number }[]>(`finance_cards?workspace_id=eq.${workspaceId}&status=eq.active&select=id,name,closing_day,due_day&order=created_at.asc&limit=20`);
    return rows.map(r => ({ id: r.id, name: r.name, closingDay: r.closing_day, dueDay: r.due_day }));
  }

  async invoiceNotices(ws: Workspace, today: string): Promise<InvoiceNotice[]> {
    const back = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
    const cols = 'id,card_id,amount,status,closing_date,due_date';
    type Inv = { id: string; card_id: string; amount: number | string; status: string; closing_date: string; due_date: string };
    const [closing, due, cards] = await Promise.all([
      this.rest<Inv[]>(`finance_invoices?workspace_id=eq.${ws.workspaceId}&status=neq.paid&amount=gt.0&closing_date=lte.${today}&closing_date=gte.${back(3)}&select=${cols}&limit=20`),
      this.rest<Inv[]>(`finance_invoices?workspace_id=eq.${ws.workspaceId}&status=in.(planned,overdue)&amount=gt.0&due_date=lte.${today}&due_date=gte.${back(30)}&select=${cols}&order=due_date.asc&limit=20`),
      this.cardRows(ws.workspaceId),
    ]);
    const names = new Map(cards.map(c => [c.id, c.name]));
    const mk = (kind: 'closed' | 'due') => (i: Inv): InvoiceNotice => ({ invoiceId: i.id, kind, cardName: names.get(i.card_id) ?? 'cartão', amount: Number(i.amount), closingDate: i.closing_date, dueDate: i.due_date });
    return [...closing.map(mk('closed')), ...due.map(mk('due'))];
  }

  async payInvoice(ws: Workspace, invoiceId: string, date: string) {
    await this.rpc('finance_pay_invoice', { target_invoice_id: invoiceId, target_workspace_id: ws.workspaceId, target_account_id: ws.accountId, target_payment_date: date, target_idempotency_key: `wa-invoice:${invoiceId}` });
  }

  /** Grava cartões e compras no cartão. Compra sem cartão cadastrado fica esperando; quando o cartão aparece, ela é encaixada na fatura. */
  private async applyCards(ws: Workspace, changes: Changes, key: string, catId: (n?: string) => string | null): Promise<ApplyResult> {
    const result: ApplyResult = { waitingCard: 0, placed: null };
    const upserts = changes.cardUpserts ?? [], purchases = changes.cardPurchases ?? [];
    let cards = await this.cardRows(ws.workspaceId);
    for (const u of upserts) {
      const existing = cards.find(c => cardKey(c.name) === cardKey(u.name));
      if (existing) await this.rest(`finance_cards?id=eq.${existing.id}&workspace_id=eq.${ws.workspaceId}`, { method: 'PATCH', body: JSON.stringify({ closing_day: u.closingDay, due_day: u.dueDay }), prefer: 'return=minimal' });
      else await this.rest('finance_cards', { method: 'POST', body: JSON.stringify({ workspace_id: ws.workspaceId, name: u.name, closing_day: u.closingDay, due_day: u.dueDay }), prefer: 'return=minimal' });
    }
    if (upserts.length) cards = await this.cardRows(ws.workspaceId);
    const place = async (p: { description: string; amount: number; date: string; installments: number; categoryId: string | null; idem: string }, card: CardRow) => {
      await this.rpc('finance_create_card_purchase', { target_workspace_id: ws.workspaceId, target_account_id: ws.accountId, target_card_id: card.id, target_description: p.description, target_amount: p.amount, target_purchase_date: p.date, target_installments: p.installments, target_category_id: p.categoryId, target_idempotency_key: p.idem });
    };
    let i = 0;
    for (const p of purchases) {
      const card = findCard(cards, p.cardName);
      const idem = `${key}:cp${i++}`;
      if (card) await place({ description: p.description, amount: p.amount, date: p.date, installments: p.installments, categoryId: catId(p.category), idem }, card);
      else {
        await this.rest('whatsapp_card_pending?on_conflict=workspace_id,idempotency_key', { method: 'POST', body: JSON.stringify({ workspace_id: ws.workspaceId, card_name: p.cardName ?? null, description: p.description, amount: p.amount, purchase_date: p.date, installments: p.installments, category_id: catId(p.category), idempotency_key: idem }), prefer: 'resolution=ignore-duplicates,return=minimal' });
        result.waitingCard++;
      }
    }
    // Encaixa o que estava esperando: compra com o nome do cartão que acabou de existir, ou sem nome quando só há um cartão.
    if (cards.length && (upserts.length || purchases.length)) {
      const waiting = await this.rest<{ id: string; card_name: string | null; description: string; amount: number | string; purchase_date: string; installments: number; category_id: string | null; idempotency_key: string }[]>(`whatsapp_card_pending?workspace_id=eq.${ws.workspaceId}&select=*&order=created_at.asc&limit=30`);
      const target = upserts.length === 1 ? cards.find(c => cardKey(c.name) === cardKey(upserts[0].name)) : undefined;
      let total = 0, count = 0, name = '';
      const dueDates = new Set<string>();
      for (const w of waiting) {
        const card = w.card_name ? findCard(cards, w.card_name) : (target ?? (cards.length === 1 ? cards[0] : undefined));
        if (!card) continue;
        await place({ description: w.description, amount: Number(w.amount), date: w.purchase_date, installments: w.installments, categoryId: w.category_id, idem: w.idempotency_key }, card);
        await this.rest(`whatsapp_card_pending?id=eq.${w.id}`, { method: 'DELETE' });
        total += Number(w.amount); count++; name = card.name;
        dueDates.add(invoiceFor(card, w.purchase_date).dueDate);
      }
      if (count) result.placed = { count, total, dueDates: [...dueDates].sort(), cardName: name };
      result.waitingCard = waiting.length - count;
    }
    return result;
  }

  async load(ws: Workspace): Promise<Snapshot> {
    const [summary, rows, cats, cardRows] = await Promise.all([
      this.rpc<{ opening_cents: number | string; net_cents: number | string }[]>('whatsapp_ledger_summary', { p_workspace: ws.workspaceId }),
      this.rest<{ id: string; type: 'income' | 'expense'; amount: number | string; description: string; effective_date: string | null; category_id: string | null; created_at: string }[]>(
        `finance_transactions?workspace_id=eq.${ws.workspaceId}&status=eq.confirmed&select=id,type,amount,description,effective_date,category_id,created_at&order=effective_date.desc,created_at.desc&limit=${MAX_STATE_TRANSACTIONS * 3}`
      ),
 this.categoryMap(ws.workspaceId),
      this.cardRows(ws.workspaceId),
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
    return { cards: cardRows, initialBalanceCents: initialBalanceFor(opening, net, visible), transactions: visible, customCategories, ...(newest ? { lastRecordId: newest } : {}) };
  }

  async apply(ws: Workspace, changes: Changes, key: string) {
    const hasCards = Boolean(changes.cardUpserts?.length || changes.cardPurchases?.length);
    if (!changes.create.length && !changes.update.length && !changes.remove.length && !hasCards) return;
    let cats = await this.categoryMap(ws.workspaceId);
    // Categoria nova pedida pelo usuário: cria no workspace (aparece também no dashboard).
    const wanted = [...new Set([...changes.create, ...changes.update, ...(changes.cardPurchases ?? [])].map(e => e.category).filter((c): c is string => Boolean(c) && !cats.has(c as string)))];
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
    if (hasCards) return this.applyCards(ws, changes, key, catId);
  }
}

/** Implementação em memória, só para testes. Um "workspace" por telefone. */
export class MemoryLedger implements Ledger {
  workspaces = new Map<string, { ws: Workspace; opening: number; entries: Entry[]; categories?: Set<string> }>();
  applied: { key: string; changes: Changes }[] = [];
  failNextApply = false;
  /** Previstos de teste por workspace. */
  planned = new Map<string, DueItem[]>();
  confirmed: { id: string; date: string }[] = [];
  /** Cartões, compras esperando cartão e faturas de teste por workspace. */
  cards = new Map<string, CardRow[]>();
  cardPlaced: { workspaceId: string; cardName: string; purchase: CardPurchase }[] = [];
  cardWaiting: { workspaceId: string; purchase: CardPurchase }[] = [];
  invoices = new Map<string, InvoiceNotice[]>();
  paidInvoices: { id: string; date: string }[] = [];
  async invoiceNotices(ws: Workspace, today: string) { return (this.invoices.get(ws.workspaceId) ?? []).filter(n => !this.paidInvoices.some(p => p.id === n.invoiceId) && (n.kind === 'closed' ? n.closingDate <= today : n.dueDate <= today)); }
  async payInvoice(_ws: Workspace, id: string, date: string) { this.paidInvoices.push({ id, date }); }
  async due(ws: Workspace, today: string) { return (this.planned.get(ws.workspaceId) ?? []).filter(i => i.expectedDate <= today && !this.confirmed.some(c => c.id === i.id)); }
  async confirm(_ws: Workspace, id: string, date: string) { this.confirmed.push({ id, date }); }
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
    return { cards: structuredClone(this.cards.get(ws.workspaceId) ?? []), initialBalanceCents: initialBalanceFor(w.opening, net, visible), transactions: visible.map(({ idem: _idem, ...e }: Entry & { idem?: string }) => structuredClone(e)), customCategories: [...(w.categories ?? [])], ...(visible.length ? { lastRecordId: (w.entries[w.entries.length - 1] as Entry).id } : {}) };
  }
  async apply(ws: Workspace, changes: Changes, key: string): Promise<ApplyResult | void> {
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
    if (!changes.cardUpserts?.length && !changes.cardPurchases?.length) return;
    const list = this.cards.get(ws.workspaceId) ?? [];
    for (const u of changes.cardUpserts ?? []) {
      const at = list.findIndex(c => cardKey(c.name) === cardKey(u.name));
      if (at >= 0) list[at] = { ...list[at], ...u };
      else list.push({ id: `card-${list.length + 1}`, ...u });
    }
    this.cards.set(ws.workspaceId, list);
    for (const p of changes.cardPurchases ?? []) this.cardWaiting.push({ workspaceId: ws.workspaceId, purchase: structuredClone(p) });
    const upserts = changes.cardUpserts ?? [];
    const target = upserts.length === 1 ? list.find(c => cardKey(c.name) === cardKey(upserts[0].name)) : undefined;
    let count = 0, total = 0, name = '';
    const dueDates = new Set<string>();
    for (const w of [...this.cardWaiting.filter(x => x.workspaceId === ws.workspaceId)]) {
      const card = w.purchase.cardName ? findCard(list, w.purchase.cardName) : (target ?? (list.length === 1 ? list[0] : undefined));
      if (!card) continue;
      this.cardPlaced.push({ workspaceId: ws.workspaceId, cardName: card.name, purchase: w.purchase });
      this.cardWaiting.splice(this.cardWaiting.indexOf(w), 1);
      count++; total += w.purchase.amount; name = card.name;
      dueDates.add(invoiceFor(card, w.purchase.date).dueDate);
    }
    return { waitingCard: this.cardWaiting.filter(x => x.workspaceId === ws.workspaceId).length, placed: count ? { count, total, dueDates: [...dueDates].sort(), cardName: name } : null };
  }
}
