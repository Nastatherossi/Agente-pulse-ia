// server/whatsapp/reminders.ts
import { timingSafeEqual, createHash } from "node:crypto";

// shared/v2/memory-contracts.ts
import { z } from "zod";
var memoryTopics = ["career", "popcorn", "business", "housing", "marriage", "programming", "city"];
var memoryStatus = z.enum(["exploring", "planned", "declared_decision", "abandoned", "outdated"]);
var memoryRecord = z.object({ id: z.string().uuid(), ownerId: z.string().uuid(), topic: z.enum(memoryTopics), type: z.enum(["life_goal", "intention", "project"]), content: z.string().trim().min(1).max(240), status: memoryStatus, source: z.enum(["explicit_user_statement", "user_correction"]), confidence: z.enum(["high", "provisional"]), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }).strict();
var narrativeSchema = z.object({ enabled: z.boolean().default(false), noticeAccepted: z.boolean().default(false), records: z.array(memoryRecord).max(30).default([]), tombstones: z.array(z.enum(memoryTopics)).max(7).default([]), style: z.object({ signals: z.array(z.enum(["informal", "neutral"])).max(6).default([]), explicitStyle: z.boolean().default(false) }).default({ signals: [], explicitStyle: false }) }).strict();
var memoryActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("enable"), enabled: z.boolean(), noticeAccepted: z.literal(true) }).strict(),
  z.object({ kind: z.literal("list") }).strict(),
  z.object({ kind: z.literal("delete"), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("clear") }).strict(),
  z.object({ kind: z.literal("edit"), id: z.string().uuid(), content: z.string().trim().min(1).max(240), status: memoryStatus }).strict()
]);
var createNarrative = () => structuredClone(narrativeSchema.parse({}));
var MEMORY_LIMITS = { records: 30, retrieved: 3, contextCharacters: 800, retentionMs: 30 * 864e5, extractionCalls: 0 };

// shared/v2/contracts.ts
import { z as z2 } from "zod";
var isoDate = z2.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => {
  const d = /* @__PURE__ */ new Date(v + "T12:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
});
var money = z2.number().finite().positive().max(1e6).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-5);
var category = z2.string().trim().min(1).max(50);
var cardRef = z2.object({ name: z2.string().trim().min(1).max(30).optional(), installments: z2.number().int().min(1).max(48).optional() }).strict();
var cardInfo = z2.object({ name: z2.string().trim().min(1).max(30), closingDay: z2.number().int().min(1).max(31), dueDay: z2.number().int().min(1).max(31) }).strict();
var invoiceInfo = z2.object({ card: z2.string().max(30), competence: isoDate, closingDate: isoDate, dueDate: isoDate, amount: z2.number().min(0).max(1e8), status: z2.enum(["planned", "overdue", "paid"]) }).strict();
var transaction = z2.object({ type: z2.enum(["receita", "despesa"]), amount: money, description: z2.string().trim().min(1).max(120), date: isoDate, category: category.optional(), card: cardRef.optional() }).strict();
var storedTransaction = transaction.extend({ id: z2.string().uuid() });
var period = z2.object({ start: isoDate, end: isoDate }).strict().refine((p) => p.start <= p.end, "Per\xEDodo invertido");
var preferences = z2.object({ style: z2.enum(["direto", "descontraido", "neutro", "formal"]).default("neutro"), detail: z2.enum(["curto", "detalhado"]).default("curto"), proactivity: z2.enum(["discreto", "equilibrado", "proativo"]).default("discreto"), explanation: z2.enum(["minima", "completa"]).default("minima"), examples: z2.boolean().default(false), emojis: z2.boolean().default(false) }).strict();
var goal = z2.object({ description: z2.string().trim().min(1).max(120), amount: money, targetDate: isoDate.optional() }).strict();
var schemas = {
  consultar_saldo: z2.object({}).strict(),
  registrar_transacao: transaction,
  listar_transacoes: z2.object({ type: z2.enum(["receita", "despesa"]).optional(), limit: z2.number().int().min(1).max(100).default(20), period: period.optional() }).strict(),
  resumir_financas: z2.object({ period, type: z2.enum(["receita", "despesa"]).optional() }).strict(),
  comparar_periodos: z2.object({ periodA: period, periodB: period, metric: z2.enum(["receitas", "despesas", "resultado"]) }).strict(),
  consultar_gastos_categoria: z2.object({ category, period }).strict(),
  projetar_despesas: z2.object({ period, asOf: isoDate }).strict(),
  atualizar_preferencias: preferences,
  simular_compra: z2.object({ amount: money, available: money.optional() }).strict(),
  definir_objetivo: goal,
  cadastrar_cartao: cardInfo,
  consultar_fatura: z2.object({ month: z2.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(), card: z2.string().trim().max(30).optional() }).strict()
};
var CATEGORIES = ["Alimenta\xE7\xE3o", "Transporte", "Lazer", "Moradia", "Sa\xFAde", "Educa\xE7\xE3o", "Compras", "Contas e servi\xE7os", "Assinaturas", "Renda"];
var NATURE_ALIASES = { fato: "fato_ocorrido", ocorrido: "fato_ocorrido", fato_ocorrida: "fato_ocorrido", fato_realizado: "fato_ocorrido", realizado: "fato_ocorrido", hipotetico: "hipotese", hipotetica: "hipotese", planejamento: "plano", intencao: "desejo", vontade: "desejo", pergunta: "duvida" };
var nature = z2.preprocess((v) => {
  if (typeof v !== "string") return v;
  const k = v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/[\s-]+/g, "_");
  return NATURE_ALIASES[k] ?? k;
}, z2.enum(["fato_ocorrido", "hipotese", "plano", "desejo", "duvida"]));
var evidence = z2.string().trim().min(1).max(300);
var modelCategory = z2.string().trim().max(50).nullable().optional();
var modelCard = z2.object({ nome: z2.string().trim().max(30).nullable().optional(), parcelas: z2.number().int().min(1).max(48).nullable().optional() }).nullable().optional();
var entryFields = { type: z2.enum(["receita", "despesa"]), amount: money, description: z2.string().trim().min(1).max(120), date: isoDate, category: modelCategory, cartao: modelCard };
var target = z2.object({ transacao_id: z2.string().uuid().optional(), descricao: z2.string().trim().min(1).max(120).optional(), valor: money.optional(), data: isoDate.optional() }).strict().refine((t) => Object.keys(t).length > 0, "TARGET_REQUIRED");
var toolSchemas = {
  consultar_saldo: schemas.consultar_saldo,
  consultar_fatura: schemas.consultar_fatura,
  listar_transacoes: schemas.listar_transacoes,
  resumir_financas: schemas.resumir_financas,
  comparar_periodos: schemas.comparar_periodos,
  consultar_gastos_categoria: schemas.consultar_gastos_categoria,
  projetar_despesas: schemas.projetar_despesas,
  simular_compra: schemas.simular_compra,
  registrar_transacao: z2.object({ ...entryFields, evidencia: evidence, natureza: nature }).strict(),
  registrar_varios: z2.object({ lancamentos: z2.array(z2.object({ ...entryFields, evidencia: evidence }).strict()).min(2).max(5), natureza: nature }).strict(),
  propor_edicao_transacao: z2.object({ alvo: target, novo: z2.object({ amount: money.optional(), description: z2.string().trim().min(1).max(120).optional(), category: z2.string().trim().min(1).max(50).optional(), date: isoDate.optional() }).strict().refine((n) => Object.keys(n).length > 0, "CHANGE_REQUIRED"), evidencia: evidence }).strict(),
  propor_exclusao_transacao: z2.object({ alvo: target, evidencia: evidence }).strict(),
  atualizar_preferencias: z2.object({ style: z2.enum(["direto", "descontraido", "neutro", "formal"]).optional(), detail: z2.enum(["curto", "detalhado"]).optional(), proactivity: z2.enum(["discreto", "equilibrado", "proativo"]).optional(), explanation: z2.enum(["minima", "completa"]).optional(), examples: z2.boolean().optional(), emojis: z2.boolean().optional(), redefinir: z2.boolean().optional(), evidencia: evidence }).strict(),
  definir_objetivo: goal.extend({ evidencia: evidence }).strict(),
  cadastrar_cartao: z2.object({ nome: z2.string().trim().min(1).max(30), dia_fechamento: z2.number().int().min(1).max(31), dia_vencimento: z2.number().int().min(1).max(31), evidencia: evidence }).strict()
};
var financialState = z2.object({
  initialBalanceCents: z2.number().int().min(0).max(1e8),
  transactions: z2.array(transaction.extend({ id: z2.string().uuid() })).max(300),
  preferences,
  goal: goal.optional(),
  /** The user's own categories (beyond CATEGORIES). Loaded from the ledger; the user may create more by asking. */
  categories: z2.array(category.max(30)).max(40).optional(),
  /** The record registered most recently ("isso", "esse", "o último" refer to it). */
  lastRecordId: z2.string().uuid().optional(),
  /** Cartões cadastrados (vêm do banco a cada mensagem). */
  cards: z2.array(cardInfo).max(10).optional(),
  /** Faturas dos cartões (vencimento a partir de ~45 dias atrás), vindas do banco. */
  invoices: z2.array(invoiceInfo).max(40).optional(),
  /** Compras no cartão registradas NESTA mensagem; o servidor grava na fatura e esvazia. Não entram no saldo. */
  cardPurchases: z2.array(transaction.extend({ id: z2.string().uuid() })).max(20).optional()
}).strict();
var pendingOperation = z2.object({ id: z2.string().uuid(), kind: z2.enum(["edit", "delete", "goal", "create"]), targetId: z2.string().uuid().optional(), before: z2.union([transaction.extend({ id: z2.string().uuid() }), goal]).optional(), after: z2.union([transaction.extend({ id: z2.string().uuid() }), goal]).optional(), items: z2.array(transaction).min(1).max(5).optional(), createdAt: z2.number().int(), expiresAt: z2.number().int() }).strict().refine((op) => op.kind === "create" ? Boolean(op.items) && !op.before : op.kind === "goal" ? Boolean(op.after) && !op.items : Boolean(op.before) && !op.items, "OPERATION_SHAPE");
var memory = z2.object({ topic: z2.enum(["saldo", "despesas", "receitas", "analise"]).optional(), periods: z2.array(period).max(2).default([]), transactionDate: isoDate.optional(), pending: transaction.optional(), operation: pendingOperation.optional() }).strict();
var historyEntry = z2.object({ role: z2.enum(["user", "assistant"]), content: z2.string().max(1800) }).strict();
var sessionSchema = z2.object({ version: z2.literal(2), narrative: narrativeSchema.default(() => createNarrative()), id: z2.string().uuid(), state: financialState, memory, history: z2.array(historyEntry).max(10), lastRequests: z2.array(z2.object({ id: z2.string().uuid(), messageHash: z2.string().max(64), trace: z2.unknown() })).max(8), expiresAt: z2.number().int() }).strict().refine((s) => s.narrative.records.every((r) => r.ownerId === s.id), "MEMORY_OWNER_MISMATCH");
var brl = (cents2) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents2 / 100);
var todayBR = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(/* @__PURE__ */ new Date());
var normalize = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// shared/v2/cards.ts
var cardKey = (name) => normalize(name).replace(/\bcartao\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
function findCard(cards, name) {
  const list = cards ?? [];
  if (!name || !cardKey(name)) return list.length === 1 ? list[0] : void 0;
  const key = cardKey(name);
  return list.find((c) => cardKey(c.name) === key);
}
var iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
var lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
var addMonths = (y, m, n) => {
  const t = y * 12 + (m - 1) + n;
  return { y: Math.floor(t / 12), m: t % 12 + 1 };
};
function invoiceFor(card, purchaseDate, index = 0) {
  const y0 = Number(purchaseDate.slice(0, 4)), m0 = Number(purchaseDate.slice(5, 7)), day = Number(purchaseDate.slice(8, 10));
  const base = addMonths(y0, m0, day > card.closingDay ? 1 : 0), c = addMonths(base.y, base.m, index);
  const closingDate = iso(c.y, c.m, Math.min(card.closingDay, lastDay(c.y, c.m)));
  const d = card.dueDay > card.closingDay ? c : addMonths(c.y, c.m, 1);
  const dueDate = iso(d.y, d.m, Math.min(card.dueDay, lastDay(d.y, d.m)));
  return { competence: iso(c.y, c.m, 1), closingDate, dueDate };
}

// server/whatsapp/ledger.ts
var MAX_STATE_TRANSACTIONS = 300;
var MAX_INITIAL_CENTS = 1e8;
function agentCanSee(e) {
  if (!e.date || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) return false;
  if (!Number.isFinite(e.amount) || e.amount <= 0 || e.amount > 1e6) return false;
  if (Math.abs(e.amount * 100 - Math.round(e.amount * 100)) > 1e-5) return false;
  return e.description.trim().length > 0;
}
var cents = (n) => Math.round(n * 100);
var signed = (e) => (e.type === "receita" ? 1 : -1) * cents(e.amount);
function initialBalanceFor(openingCents, netAllCents, visible) {
  const raw = openingCents + netAllCents - visible.reduce((s, e) => s + signed(e), 0);
  return Math.min(MAX_INITIAL_CENTS, Math.max(0, raw));
}
var SupabaseLedger = class {
  constructor(url, serviceKey, fetchImpl = fetch) {
    this.serviceKey = serviceKey;
    this.fetchImpl = fetchImpl;
    if (!url || !serviceKey) throw new Error("SUPABASE_NOT_CONFIGURED");
    this.base = url.replace(/\/$/, "");
  }
  serviceKey;
  fetchImpl;
  base;
  async call(path, init = {}) {
    const { prefer, ...rest } = init;
    const res = await this.fetchImpl(`${this.base}${path}`, {
      ...rest,
      headers: { apikey: this.serviceKey, ...this.serviceKey.startsWith("eyJ") ? { Authorization: `Bearer ${this.serviceKey}` } : {}, "Content-Type": "application/json", ...prefer ? { Prefer: prefer } : {} },
      signal: AbortSignal.timeout(1e4)
    });
    if (!res.ok) throw Object.assign(new Error(`SUPABASE_${res.status}`), { status: res.status });
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  }
  rest(path, init) {
    return this.call(`/rest/v1/${path}`, init);
  }
  rpc(name, args) {
    return this.rest(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
  }
  /** Só procura a conta do número; nunca cria (usado pela prévia de lembretes do painel). */
  lookup(phone) {
    return this.find(phone);
  }
  async find(phone) {
    const rows = await this.rpc("whatsapp_workspace_for_phone", { p_phone: phone });
    const r = rows[0];
    return r ? { userId: r.user_id, workspaceId: r.workspace_id, accountId: r.account_id } : null;
  }
  async resolve(phone, name) {
    let ws = await this.find(phone);
    if (!ws) {
      try {
        await this.call("/auth/v1/admin/users", { method: "POST", body: JSON.stringify({ phone, phone_confirm: true, user_metadata: name ? { name } : {} }) });
      } catch (e) {
        if (e.status !== 422) throw e;
      }
      ws = await this.find(phone);
    }
    if (!ws) throw new Error("LEDGER_PROVISION_FAILED");
    await this.ensureCategories(ws.workspaceId);
    return ws;
  }
  async categoryMap(workspaceId) {
    const rows = await this.rest(`finance_categories?workspace_id=eq.${workspaceId}&select=id,name&limit=200`);
    return new Map(rows.map((r) => [r.name, r.id]));
  }
  async ensureCategories(workspaceId) {
    const have = await this.categoryMap(workspaceId);
    const missing = CATEGORIES.filter((c) => !have.has(c));
    if (!missing.length) return;
    await this.rest(`finance_categories?on_conflict=workspace_id,name`, {
      method: "POST",
      body: JSON.stringify(missing.map((name) => ({ workspace_id: workspaceId, name, kind: name === "Renda" ? "income" : "expense" }))),
      prefer: "resolution=ignore-duplicates,return=minimal"
    });
  }
  async due(ws, today) {
    const from = new Date(Date.parse(`${today}T12:00:00Z`) - 30 * 864e5).toISOString().slice(0, 10);
    const rows = await this.rest(
      `finance_transactions?workspace_id=eq.${ws.workspaceId}&status=in.(planned,overdue)&settled_at=is.null&origin=neq.card&expected_date=lte.${today}&expected_date=gte.${from}&select=id,type,amount,description,expected_date,category_id&order=expected_date.asc&limit=20`
    );
    if (!rows.length) return [];
    const names = new Map([...await this.categoryMap(ws.workspaceId)].map(([name, id]) => [id, name]));
    return rows.map((r) => ({ id: r.id, type: r.type === "income" ? "receita" : "despesa", amount: Number(r.amount), description: r.description, expectedDate: r.expected_date, category: r.category_id ? names.get(r.category_id) : void 0 }));
  }
  async confirm(ws, transactionId, effectiveDate) {
    await this.rpc("finance_confirm_transaction", { target_transaction_id: transactionId, target_workspace_id: ws.workspaceId, target_effective_date: effectiveDate });
  }
  async cardRows(workspaceId) {
    const rows = await this.rest(`finance_cards?workspace_id=eq.${workspaceId}&status=eq.active&select=id,name,closing_day,due_day&order=created_at.asc&limit=20`);
    return rows.map((r) => ({ id: r.id, name: r.name, closingDay: r.closing_day, dueDay: r.due_day }));
  }
  async invoiceRows(workspaceId) {
    const from = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
    const [rows, cards] = await Promise.all([
      this.rest(`finance_invoices?workspace_id=eq.${workspaceId}&due_date=gte.${from}&select=card_id,competence,closing_date,due_date,amount,status&order=due_date.asc&limit=40`),
      this.cardRows(workspaceId)
    ]);
    const names = new Map(cards.map((c) => [c.id, c.name]));
    return rows.map((r) => ({ card: (names.get(r.card_id) ?? "cart\xE3o").slice(0, 30), competence: r.competence, closingDate: r.closing_date, dueDate: r.due_date, amount: Number(r.amount), status: r.status }));
  }
  async invoiceNotices(ws, today) {
    const back = (n) => new Date(Date.parse(`${today}T12:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
    const cols = "id,card_id,amount,status,closing_date,due_date";
    const [closing, due, cards] = await Promise.all([
      this.rest(`finance_invoices?workspace_id=eq.${ws.workspaceId}&status=neq.paid&amount=gt.0&closing_date=lte.${today}&closing_date=gte.${back(3)}&select=${cols}&limit=20`),
      this.rest(`finance_invoices?workspace_id=eq.${ws.workspaceId}&status=in.(planned,overdue)&amount=gt.0&due_date=lte.${today}&due_date=gte.${back(30)}&select=${cols}&order=due_date.asc&limit=20`),
      this.cardRows(ws.workspaceId)
    ]);
    const names = new Map(cards.map((c) => [c.id, c.name]));
    const mk = (kind) => (i) => ({ invoiceId: i.id, kind, cardName: names.get(i.card_id) ?? "cart\xE3o", amount: Number(i.amount), closingDate: i.closing_date, dueDate: i.due_date });
    return [...closing.map(mk("closed")), ...due.map(mk("due"))];
  }
  async payInvoice(ws, invoiceId, date) {
    await this.rpc("finance_pay_invoice", { target_invoice_id: invoiceId, target_workspace_id: ws.workspaceId, target_account_id: ws.accountId, target_payment_date: date, target_idempotency_key: `wa-invoice:${invoiceId}` });
  }
  /** Grava cartões e compras no cartão. Compra sem cartão cadastrado fica esperando; quando o cartão aparece, ela é encaixada na fatura. */
  async applyCards(ws, changes, key, catId) {
    const result = { waitingCard: 0, placed: null };
    const upserts = changes.cardUpserts ?? [], purchases = changes.cardPurchases ?? [];
    let cards = await this.cardRows(ws.workspaceId);
    for (const u of upserts) {
      const existing = cards.find((c) => cardKey(c.name) === cardKey(u.name));
      if (existing) await this.rest(`finance_cards?id=eq.${existing.id}&workspace_id=eq.${ws.workspaceId}`, { method: "PATCH", body: JSON.stringify({ closing_day: u.closingDay, due_day: u.dueDay }), prefer: "return=minimal" });
      else await this.rest("finance_cards", { method: "POST", body: JSON.stringify({ workspace_id: ws.workspaceId, name: u.name, closing_day: u.closingDay, due_day: u.dueDay }), prefer: "return=minimal" });
    }
    if (upserts.length) cards = await this.cardRows(ws.workspaceId);
    const place = async (p, card) => {
      await this.rpc("finance_create_card_purchase", { target_workspace_id: ws.workspaceId, target_account_id: ws.accountId, target_card_id: card.id, target_description: p.description, target_amount: p.amount, target_purchase_date: p.date, target_installments: p.installments, target_category_id: p.categoryId, target_idempotency_key: p.idem });
    };
    let i = 0;
    for (const p of purchases) {
      const card = findCard(cards, p.cardName);
      const idem = `${key}:cp${i++}`;
      if (card) await place({ description: p.description, amount: p.amount, date: p.date, installments: p.installments, categoryId: catId(p.category), idem }, card);
      else {
        await this.rest("whatsapp_card_pending?on_conflict=workspace_id,idempotency_key", { method: "POST", body: JSON.stringify({ workspace_id: ws.workspaceId, card_name: p.cardName ?? null, description: p.description, amount: p.amount, purchase_date: p.date, installments: p.installments, category_id: catId(p.category), idempotency_key: idem }), prefer: "resolution=ignore-duplicates,return=minimal" });
        result.waitingCard++;
      }
    }
    if (cards.length && (upserts.length || purchases.length)) {
      const waiting = await this.rest(`whatsapp_card_pending?workspace_id=eq.${ws.workspaceId}&select=*&order=created_at.asc&limit=30`);
      const target2 = upserts.length === 1 ? cards.find((c) => cardKey(c.name) === cardKey(upserts[0].name)) : void 0;
      let total = 0, count = 0, name = "";
      const dueDates = /* @__PURE__ */ new Set();
      for (const w of waiting) {
        const card = w.card_name ? findCard(cards, w.card_name) : target2 ?? (cards.length === 1 ? cards[0] : void 0);
        if (!card) continue;
        await place({ description: w.description, amount: Number(w.amount), date: w.purchase_date, installments: w.installments, categoryId: w.category_id, idem: w.idempotency_key }, card);
        await this.rest(`whatsapp_card_pending?id=eq.${w.id}`, { method: "DELETE" });
        total += Number(w.amount);
        count++;
        name = card.name;
        dueDates.add(invoiceFor(card, w.purchase_date).dueDate);
      }
      if (count) result.placed = { count, total, dueDates: [...dueDates].sort(), cardName: name };
      result.waitingCard = waiting.length - count;
    }
    return result;
  }
  async load(ws) {
    const [summary, rows, cats, cardRows, invoiceRows] = await Promise.all([
      this.rpc("whatsapp_ledger_summary", { p_workspace: ws.workspaceId }),
      this.rest(
        `finance_transactions?workspace_id=eq.${ws.workspaceId}&status=eq.confirmed&select=id,type,amount,description,effective_date,category_id,created_at&order=effective_date.desc,created_at.desc&limit=${MAX_STATE_TRANSACTIONS * 3}`
      ),
      this.categoryMap(ws.workspaceId),
      this.cardRows(ws.workspaceId),
      this.invoiceRows(ws.workspaceId)
    ]);
    const nameOf = new Map([...cats].map(([name, id]) => [id, name]));
    const opening = Number(summary[0]?.opening_cents ?? 0);
    const net = Number(summary[0]?.net_cents ?? 0);
    const visible = [];
    for (const r of rows) {
      if (visible.length >= MAX_STATE_TRANSACTIONS) break;
      const amount = Number(r.amount);
      const description = String(r.description ?? "").trim().slice(0, 120);
      if (!agentCanSee({ amount, date: r.effective_date, description })) continue;
      visible.push({ id: r.id, type: r.type === "income" ? "receita" : "despesa", amount, description, date: r.effective_date, ...r.category_id && nameOf.get(r.category_id) ? { category: nameOf.get(r.category_id).slice(0, 50) } : {} });
    }
    const newest = visible.length ? rows.filter((r) => visible.some((v) => v.id === r.id)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]?.id : void 0;
    visible.reverse();
    const builtIn = new Set(CATEGORIES);
    const customCategories = [...cats.keys()].filter((name) => !builtIn.has(name) && name.length <= 30).slice(0, 40);
    return { invoices: invoiceRows, cards: cardRows, initialBalanceCents: initialBalanceFor(opening, net, visible), transactions: visible, customCategories, ...newest ? { lastRecordId: newest } : {} };
  }
  async apply(ws, changes, key) {
    const hasCards = Boolean(changes.cardUpserts?.length || changes.cardPurchases?.length);
    if (!changes.create.length && !changes.update.length && !changes.remove.length && !hasCards) return;
    let cats = await this.categoryMap(ws.workspaceId);
    const wanted = [...new Set([...changes.create, ...changes.update, ...changes.cardPurchases ?? []].map((e) => e.category).filter((c) => Boolean(c) && !cats.has(c)))];
    if (wanted.length) {
      await this.rest(`finance_categories?on_conflict=workspace_id,name`, {
        method: "POST",
        body: JSON.stringify(wanted.map((name) => ({ workspace_id: ws.workspaceId, name, kind: "both" }))),
        prefer: "resolution=ignore-duplicates,return=minimal"
      });
      cats = await this.categoryMap(ws.workspaceId);
    }
    const catId = (name) => name ? cats.get(name) ?? null : null;
    let i = 0;
    for (const e of changes.create) {
      await this.rpc("finance_create_transaction", {
        target_workspace_id: ws.workspaceId,
        target_account_id: ws.accountId,
        target_category_id: catId(e.category),
        target_description: e.description,
        target_amount: e.amount,
        target_type: e.type === "receita" ? "income" : "expense",
        target_status: "confirmed",
        target_competence_date: e.date,
        target_expected_date: e.date,
        target_effective_date: e.date,
        target_origin: "ai",
        target_payment_method: null,
        target_note: "Registrado pelo Pulse no WhatsApp",
        // Mesma mensagem reprocessada = mesma chave = nenhum lançamento duplicado.
        target_idempotency_key: `${key}:${i++}`
      });
    }
    for (const e of changes.update) {
      await this.rest(`finance_transactions?id=eq.${e.id}&workspace_id=eq.${ws.workspaceId}`, {
        method: "PATCH",
        body: JSON.stringify({
          description: e.description,
          amount: e.amount,
          type: e.type === "receita" ? "income" : "expense",
          competence_date: e.date,
          effective_date: e.date,
          category_id: catId(e.category)
        })
      });
    }
    for (const id of changes.remove) {
      await this.rest(`finance_transactions?id=eq.${id}&workspace_id=eq.${ws.workspaceId}`, { method: "DELETE" });
    }
    if (hasCards) return this.applyCards(ws, changes, key, catId);
  }
};

// server/whatsapp/store.ts
var SupabaseStore = class {
  constructor(url, serviceKey, fetchImpl = fetch) {
    this.url = url;
    this.serviceKey = serviceKey;
    this.fetchImpl = fetchImpl;
    if (!url || !serviceKey) throw new Error("SUPABASE_NOT_CONFIGURED");
  }
  url;
  serviceKey;
  fetchImpl;
  async rest(path, init = {}) {
    const { prefer, ...rest } = init;
    const res = await this.fetchImpl(`${this.url.replace(/\/$/, "")}/rest/v1/${path}`, {
      ...rest,
      headers: {
        apikey: this.serviceKey,
        // Chave nova (sb_secret_…) vai só em apikey; a chave antiga (JWT service_role) também em Authorization.
        ...this.serviceKey.startsWith("eyJ") ? { Authorization: `Bearer ${this.serviceKey}` } : {},
        "Content-Type": "application/json",
        ...prefer ? { Prefer: prefer } : {}
      },
      signal: AbortSignal.timeout(1e4)
    });
    if (!res.ok) throw new Error(`SUPABASE_${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  }
  async getContact(phone) {
    const rows = await this.rest(`whatsapp_contacts?phone=eq.${encodeURIComponent(phone)}&select=*&limit=1`);
    return rows[0] ?? null;
  }
  async upsertContact(c) {
    const existing = await this.getContact(c.phone);
    if (existing) {
      const patch = {};
      if (c.name && !existing.name) patch.name = c.name;
      if (c.status && c.status !== existing.status) patch.status = c.status;
      if (c.status === "authorized") patch.authorized_at = (/* @__PURE__ */ new Date()).toISOString();
      if (Object.keys(patch).length) {
        const rows2 = await this.rest(`whatsapp_contacts?phone=eq.${encodeURIComponent(c.phone)}`, { method: "PATCH", body: JSON.stringify(patch), prefer: "return=representation" });
        return rows2[0] ?? existing;
      }
      return existing;
    }
    const row = { phone: c.phone, name: c.name ?? null, status: c.status ?? "pending", ...c.status === "authorized" ? { authorized_at: (/* @__PURE__ */ new Date()).toISOString() } : {} };
    const rows = await this.rest("whatsapp_contacts", { method: "POST", body: JSON.stringify(row), prefer: "resolution=ignore-duplicates,return=representation" });
    return rows[0] ?? await this.getContact(c.phone) ?? { phone: c.phone, status: row.status };
  }
  async setStatus(phone, status) {
    const patch = { status, ...status === "authorized" ? { authorized_at: (/* @__PURE__ */ new Date()).toISOString() } : {} };
    const rows = await this.rest(`whatsapp_contacts?phone=eq.${encodeURIComponent(phone)}`, { method: "PATCH", body: JSON.stringify(patch), prefer: "return=representation" });
    return rows[0] ?? null;
  }
  async markOwnerNotified(phone) {
    await this.rest(`whatsapp_contacts?phone=eq.${encodeURIComponent(phone)}`, { method: "PATCH", body: JSON.stringify({ owner_notified_at: (/* @__PURE__ */ new Date()).toISOString() }) });
  }
  listContacts() {
    return this.rest("whatsapp_contacts?select=*&order=first_seen_at.asc&limit=200");
  }
  async latestPending() {
    const rows = await this.rest("whatsapp_contacts?status=eq.pending&select=*&order=first_seen_at.desc&limit=1");
    return rows[0] ?? null;
  }
  async deleteContact(phone) {
    await this.rest(`whatsapp_contacts?phone=eq.${encodeURIComponent(phone)}`, { method: "DELETE" });
  }
  async claimMessage(messageId, phone, kind) {
    const rows = await this.rest("whatsapp_messages", { method: "POST", body: JSON.stringify({ message_id: messageId, phone, kind }), prefer: "resolution=ignore-duplicates,return=representation" });
    return rows.length > 0;
  }
  async recentMessageCount(phone, sinceMs) {
    const since = new Date(Date.now() - sinceMs).toISOString();
    const rows = await this.rest(`whatsapp_messages?phone=eq.${encodeURIComponent(phone)}&received_at=gte.${encodeURIComponent(since)}&select=message_id&limit=500`);
    return rows.length;
  }
  async recordUsage(r) {
    await this.rest("whatsapp_usage", { method: "POST", body: JSON.stringify({ message_id: r.messageId, phone: r.phone, source: r.source, model: r.model ?? null, model_calls: r.modelCalls, input_tokens: r.inputTokens, output_tokens: r.outputTokens, status: r.status, error_code: r.errorCode ?? null, user_text: r.userText ?? null, reply_text: r.replyText ?? null, intent: r.intent ?? null, duration_ms: r.durationMs ?? null, confirmation: r.confirmation ?? null, steps: r.steps ?? null }), prefer: "resolution=ignore-duplicates,return=minimal" });
  }
  async problemTurns(iso2, limit = 100) {
    return this.rest(`whatsapp_usage?created_at=gte.${encodeURIComponent(iso2)}&or=(user_text.not.is.null,error_code.not.is.null)&select=*&order=created_at.desc&limit=${limit}`);
  }
  /** Painel de gestão: configuração salva (admin_settings). null = nada salvo. */
  async getSetting(key) {
    const rows = await this.rest(`admin_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
    return rows[0]?.value ?? null;
  }
  async setSetting(key, value) {
    await this.rest("admin_settings?on_conflict=key", { method: "POST", body: JSON.stringify({ key, value, updated_at: (/* @__PURE__ */ new Date()).toISOString() }), prefer: "resolution=merge-duplicates,return=minimal" });
  }
  async deleteSetting(key) {
    await this.rest(`admin_settings?key=eq.${encodeURIComponent(key)}`, { method: "DELETE", prefer: "return=minimal" });
  }
  /** Painel de gestão: marca (ou desmarca, com null) um problema como resolvido. */
  async setResolved(messageId, atIso) {
    await this.rest(`whatsapp_usage?message_id=eq.${encodeURIComponent(messageId)}`, { method: "PATCH", body: JSON.stringify({ resolved_at: atIso }), prefer: "return=minimal" });
  }
  /** Painel de gestão: lembretes enviados ou criados desde `iso` (histórico, só leitura). */
  remindersSince(iso2) {
    const t = encodeURIComponent(iso2);
    return this.rest(`whatsapp_reminders?or=(last_sent_at.gte.${t},created_at.gte.${t})&select=*&order=last_sent_at.desc.nullslast&limit=1000`);
  }
  async turn(messageId) {
    const rows = await this.rest(`whatsapp_usage?message_id=eq.${encodeURIComponent(messageId)}&select=*&limit=1`);
    return rows[0] ?? null;
  }
  async usageSince(iso2) {
    return this.rest(`whatsapp_usage?created_at=gte.${encodeURIComponent(iso2)}&select=phone,model,input_tokens,output_tokens,status,error_code,created_at&order=created_at.desc&limit=20000`);
  }
  async reminderStates(ids) {
    if (!ids.length) return [];
    return this.rest(`whatsapp_reminders?transaction_id=in.(${ids.map(encodeURIComponent).join(",")})&select=*`);
  }
  async markReminded(items, phone, atIso) {
    const have = new Map((await this.reminderStates(items.map((i) => i.id))).map((r) => [r.transaction_id, r.sent_count]));
    await this.rest("whatsapp_reminders?on_conflict=transaction_id", {
      method: "POST",
      body: JSON.stringify(items.map((i) => ({ transaction_id: i.id, workspace_id: i.workspaceId, phone, sent_count: (have.get(i.id) ?? 0) + 1, last_sent_at: atIso, answered_at: null }))),
      prefer: "resolution=merge-duplicates,return=minimal"
    });
  }
  async noticeStates(ids) {
    if (!ids.length) return [];
    return this.rest(`whatsapp_invoice_notices?invoice_id=in.(${ids.map(encodeURIComponent).join(",")})&select=*`);
  }
  async markNoticed(items, phone, atIso) {
    const have = new Map((await this.noticeStates(items.map((i) => i.invoiceId))).map((r) => [`${r.invoice_id}:${r.kind}`, r.sent_count]));
    await this.rest("whatsapp_invoice_notices?on_conflict=invoice_id,kind", {
      method: "POST",
      body: JSON.stringify(items.map((i) => ({ invoice_id: i.invoiceId, kind: i.kind, workspace_id: i.workspaceId, phone, sent_count: (have.get(`${i.invoiceId}:${i.kind}`) ?? 0) + 1, last_sent_at: atIso, answered_at: null }))),
      prefer: "resolution=merge-duplicates,return=minimal"
    });
  }
  awaitingNotices(phone, sinceIso) {
    return this.rest(`whatsapp_invoice_notices?phone=eq.${encodeURIComponent(phone)}&kind=eq.due&answered_at=is.null&last_sent_at=gte.${encodeURIComponent(sinceIso)}&select=*&order=last_sent_at.desc&limit=10`);
  }
  async markNoticeAnswered(items, atIso) {
    for (const i of items) await this.rest(`whatsapp_invoice_notices?invoice_id=eq.${encodeURIComponent(i.invoiceId)}&kind=eq.${i.kind}`, { method: "PATCH", body: JSON.stringify({ answered_at: atIso }), prefer: "return=minimal" });
  }
  awaitingReminders(phone, sinceIso) {
    return this.rest(`whatsapp_reminders?phone=eq.${encodeURIComponent(phone)}&answered_at=is.null&last_sent_at=gte.${encodeURIComponent(sinceIso)}&select=*&order=last_sent_at.desc&limit=10`);
  }
  async markAnswered(ids, atIso) {
    if (!ids.length) return;
    await this.rest(`whatsapp_reminders?transaction_id=in.(${ids.map(encodeURIComponent).join(",")})`, { method: "PATCH", body: JSON.stringify({ answered_at: atIso }), prefer: "return=minimal" });
  }
  async lastReminderAt(phone) {
    const q = (table) => this.rest(`${table}?phone=eq.${encodeURIComponent(phone)}&last_sent_at=not.is.null&select=last_sent_at&order=last_sent_at.desc&limit=1`);
    const [a, b] = await Promise.all([q("whatsapp_reminders"), q("whatsapp_invoice_notices")]);
    return [a[0]?.last_sent_at, b[0]?.last_sent_at].filter((x) => Boolean(x)).sort().at(-1) ?? null;
  }
  async setRemindersEnabled(phone, enabled) {
    await this.rest(`whatsapp_contacts?phone=eq.${encodeURIComponent(phone)}`, { method: "PATCH", body: JSON.stringify({ reminders_enabled: enabled }), prefer: "return=minimal" });
  }
  async getSession(phone) {
    const rows = await this.rest(`whatsapp_sessions?phone=eq.${encodeURIComponent(phone)}&select=session,version&limit=1`);
    return rows[0] ?? null;
  }
  async saveSession(phone, session, expectedVersion) {
    if (expectedVersion === null) {
      const rows2 = await this.rest("whatsapp_sessions", { method: "POST", body: JSON.stringify({ phone, session, version: 1 }), prefer: "resolution=ignore-duplicates,return=representation" });
      return rows2.length > 0;
    }
    const rows = await this.rest(`whatsapp_sessions?phone=eq.${encodeURIComponent(phone)}&version=eq.${expectedVersion}`, {
      method: "PATCH",
      body: JSON.stringify({ session, version: expectedVersion + 1, updated_at: (/* @__PURE__ */ new Date()).toISOString() }),
      prefer: "return=representation"
    });
    return rows.length > 0;
  }
};

// server/whatsapp/zapi.ts
function isSafeMediaUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) return false;
    return h.includes(".");
  } catch {
    return false;
  }
}
var ZApiClient = class {
  constructor(instanceId, token, clientToken, fetchImpl = fetch) {
    this.instanceId = instanceId;
    this.token = token;
    this.clientToken = clientToken;
    this.fetchImpl = fetchImpl;
    if (!instanceId || !token || !clientToken) throw new Error("ZAPI_NOT_CONFIGURED");
  }
  instanceId;
  token;
  clientToken;
  fetchImpl;
  async sendText(phone, message) {
    const res = await this.fetchImpl(`https://api.z-api.io/instances/${encodeURIComponent(this.instanceId)}/token/${encodeURIComponent(this.token)}/send-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Client-Token": this.clientToken },
      // delayTyping: mostra "digitando…" por 2s, mais natural e mais seguro contra detecção de robô.
      body: JSON.stringify({ phone, message: message.slice(0, 3800), delayTyping: 2 }),
      signal: AbortSignal.timeout(15e3)
    });
    if (!res.ok) throw new Error(`ZAPI_SEND_${res.status}`);
  }
  async downloadAudio(url, maxBytes) {
    if (!isSafeMediaUrl(url)) throw new Error("AUDIO_URL_NOT_ALLOWED");
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(2e4), redirect: "error" });
    if (!res.ok) throw new Error(`AUDIO_DOWNLOAD_${res.status}`);
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error("AUDIO_TOO_LARGE");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("AUDIO_TOO_LARGE");
    return bytes;
  }
};

// server/whatsapp/reminders.ts
var MAX_ASKS_PER_ITEM = 3;
var MAX_ITEMS_PER_MESSAGE = 3;
var REPLY_WINDOW_MS = 48 * 36e5;
var MAX_MESSAGES_PER_RUN = 60;
var first = (name) => name?.trim().split(/\s+/)[0] || void 0;
var dm = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
var dayLabel = (item, today) => item.expectedDate === today ? "pra hoje" : `pro dia ${dm(item.expectedDate)}`;
var what = (i) => `${brl(Math.round(i.amount * 100))} de ${i.description}${i.category && i.category !== i.description ? ` (${i.category})` : ""}`;
var optOutNote = 'Se preferir n\xE3o receber esses lembretes, \xE9 s\xF3 me dizer "parar lembretes". \u{1F609}';
function composeReminder(items, name, today, firstEver) {
  const nm = name ? `${name}, ` : "";
  const shown = items.slice(0, MAX_ITEMS_PER_MESSAGE);
  let body;
  if (shown.length === 1) {
    const i = shown[0];
    body = i.type === "receita" ? `${name ? `Fala, ${name}, blz?` : "Oi, tudo bem?"} Aqueles ${what(i)} que estavam previstos ${dayLabel(i, today)} j\xE1 ca\xEDram? Me avisa aqui que eu dou baixa pra voc\xEA. \u{1F49C}` : `${nm}${name ? "v" : "V"}oc\xEA tinha ${what(i)} previsto ${dayLabel(i, today)}. J\xE1 foi pago? Me avisa aqui que eu dou baixa pra voc\xEA. \u{1F49C}`;
  } else {
    const lines = shown.map((i) => `\u2022 ${i.type === "receita" ? "Receber" : "Pagar"} ${what(i)} (${i.expectedDate === today ? "hoje" : dm(i.expectedDate)})`).join("\n");
    const more = items.length > shown.length ? `
\u2026e mais ${items.length - shown.length}.` : "";
    body = `${name ? `Fala, ${name}, blz?` : "Oi, tudo bem?"} Hoje tem umas pend\xEAncias por aqui:
${lines}${more}
J\xE1 aconteceram? Me conta aqui que eu dou baixa pra voc\xEA. \u{1F49C}`;
  }
  return firstEver ? `${body}

${optOutNote}` : body;
}
var MAX_NOTICES_PER_MESSAGE = 2;
function composeNotices(notices, name, today) {
  const shown = notices.slice(0, MAX_NOTICES_PER_MESSAGE);
  const line = (n) => {
    const v = brl(Math.round(n.amount * 100));
    if (n.kind === "closed") return `a fatura do ${n.cardName} fechou${n.closingDate === today ? " hoje" : ""}: ${v}. Ela vence dia ${dm(n.dueDate)}.`;
    if (n.dueDate === today) return `hoje vence a fatura do ${n.cardName} (${v}). J\xE1 pagou? Me avisa aqui que eu dou baixa pra voc\xEA.`;
    return `a fatura do ${n.cardName} (${v}) venceu dia ${dm(n.dueDate)}. J\xE1 pagou? Me avisa aqui que eu dou baixa pra voc\xEA.`;
  };
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const lines = shown.map((n) => name ? `${name}, ${line(n)}` : cap(line(n)));
  return `${lines.join("\n\n")} \u{1F49C}`;
}
async function runReminders(deps, opts = {}) {
  const today = deps.today?.() ?? todayBR();
  const nowMs = deps.now?.() ?? Date.now();
  const startOfDay = (/* @__PURE__ */ new Date(`${today}T00:00:00-03:00`)).toISOString();
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const out = { sent: 0, skipped: 0, failed: 0, messages: [] };
  const contacts = (await deps.store.listContacts()).filter((c) => c.status === "authorized" && c.reminders_enabled !== false);
  for (const c of contacts) {
    if (out.sent >= MAX_MESSAGES_PER_RUN) break;
    try {
      const last = await deps.store.lastReminderAt(c.phone);
      if (last && last >= startOfDay) {
        out.skipped++;
        continue;
      }
      const ws = await deps.ledger.resolve(c.phone, c.name ?? void 0);
      const due = await deps.ledger.due(ws, today);
      const states = new Map((await deps.store.reminderStates(due.map((d) => d.id))).map((s) => [s.transaction_id, s]));
      const items = due.filter((d) => (states.get(d.id)?.sent_count ?? 0) < MAX_ASKS_PER_ITEM);
      const allNotices = await deps.ledger.invoiceNotices(ws, today);
      const noticeStates = await deps.store.noticeStates(allNotices.map((n) => n.invoiceId));
      const notices = allNotices.filter((n) => {
        const sent = noticeStates.find((s) => s.invoice_id === n.invoiceId && s.kind === n.kind)?.sent_count ?? 0;
        return sent < (n.kind === "closed" ? 1 : MAX_ASKS_PER_ITEM);
      });
      if (!items.length && !notices.length) {
        out.skipped++;
        continue;
      }
      const firstEver = !last;
      const nm = first(c.name);
      const parts = [items.length ? composeReminder(items, nm, today, false) : "", notices.length ? composeNotices(notices, nm, today) : ""].filter(Boolean);
      const text = parts.join("\n\n") + (firstEver ? `

${optOutNote}` : "");
      out.messages.push({ phone: c.phone, text });
      if (opts.dry) continue;
      await deps.messenger.sendText(c.phone, text);
      const asked = items.slice(0, MAX_ITEMS_PER_MESSAGE).map((i) => ({ id: i.id, workspaceId: ws.workspaceId }));
      const at = new Date(nowMs).toISOString();
      if (asked.length) await deps.store.markReminded(asked, c.phone, at);
      const told = notices.slice(0, MAX_NOTICES_PER_MESSAGE).map((n) => ({ invoiceId: n.invoiceId, kind: n.kind, workspaceId: ws.workspaceId }));
      if (told.length) await deps.store.markNoticed(told, c.phone, at);
      await rememberInSession(deps.store, c.phone, text, nowMs).catch(() => void 0);
      out.sent++;
      await sleep(2500 + Math.floor(Math.random() * 2500));
    } catch (e) {
      out.failed++;
      deps.log?.({ event: "reminder_failed", message: e instanceof Error ? e.message : "unknown" });
    }
  }
  return out;
}
async function rememberInSession(store, phone, text, nowMs) {
  const stored = await store.getSession(phone);
  if (!stored) return;
  const parsed = sessionSchema.safeParse(stored.session);
  if (!parsed.success) return;
  const s = parsed.data;
  s.history = [...s.history, { role: "assistant", content: text.slice(0, 1800) }].slice(-10);
  s.expiresAt = nowMs + 365 * 864e5;
  await store.saveSession(phone, s, stored.version);
}
var YES = /^(sim|s|caiu|ja caiu|caiu sim|ja foi|foi|foi sim|recebi|recebi sim|ja recebi|paguei|ja paguei|pago|ja ta pago|ta na conta|ja ta na conta|entrou|ja entrou|pode dar baixa|da baixa|dar baixa|pode dar|confirmo|isso|isso mesmo|ok|certo|beleza)[.! ]*$/;
var NO = /^(nao|n|ainda nao|ainda n|nao caiu|ainda nao caiu|nao foi|ainda nao foi|nao recebi|ainda nao recebi|nao paguei|ainda nao paguei|amanha|depois|mais tarde)[.! ]*$/;
var OFF = /^(parar|pare|para|desativar|desligar|cancelar)( os| as)? lembretes?( por favor)?[.! ]*$/;
var ON = /^(ativar|voltar|religar|ligar|retomar)( os| as)? lembretes?[.! ]*$/;
var plain = (t) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
async function handleReminderReply(deps, phone, name, text) {
  const t = plain(text);
  const nm = first(name);
  if (OFF.test(t)) {
    await deps.store.setRemindersEnabled(phone, false);
    return `Combinado${nm ? `, ${nm}` : ""}! N\xE3o te mando mais lembretes. Se quiser de volta, \xE9 s\xF3 dizer "ativar lembretes". \u{1F609}`;
  }
  if (ON.test(t)) {
    await deps.store.setRemindersEnabled(phone, true);
    return `Fechado${nm ? `, ${nm}` : ""}! Os lembretes voltaram. \u{1F49C}`;
  }
  const yes = YES.test(t), no = NO.test(t);
  if (!yes && !no) return void 0;
  const nowMs = deps.now?.() ?? Date.now();
  const since = new Date(nowMs - REPLY_WINDOW_MS).toISOString();
  const [waitingTx, waitingInv] = await Promise.all([deps.store.awaitingReminders(phone, since), deps.store.awaitingNotices(phone, since)]);
  if (!waitingTx.length && !waitingInv.length) return void 0;
  const latest = [...waitingTx.map((w) => w.last_sent_at ?? ""), ...waitingInv.map((w) => w.last_sent_at ?? "")].sort().at(-1);
  const batch = waitingTx.filter((w) => w.last_sent_at === latest);
  const batchInv = waitingInv.filter((w) => w.last_sent_at === latest);
  if (no) return `Tranquilo${nm ? `, ${nm}` : ""}! Amanh\xE3 eu te pergunto de novo. \u{1F609}`;
  const today = deps.today?.() ?? todayBR();
  const ws = await deps.ledger.resolve(phone, name ?? void 0);
  const at = new Date(nowMs).toISOString();
  const due = new Map((await deps.ledger.due(ws, today)).map((d) => [d.id, d]));
  const done = [];
  let failed = 0;
  for (const w of batch) {
    const item = due.get(w.transaction_id);
    if (!item) {
      await deps.store.markAnswered([w.transaction_id], at);
      continue;
    }
    try {
      await deps.ledger.confirm(ws, item.id, today);
      done.push(item);
    } catch (e) {
      failed++;
      deps.log?.({ event: "reminder_confirm_failed", message: e instanceof Error ? e.message : "unknown" });
    }
  }
  await deps.store.markAnswered(done.map((d) => d.id), at);
  const paid = [];
  if (batchInv.length) {
    const open = new Map((await deps.ledger.invoiceNotices(ws, today)).filter((n) => n.kind === "due").map((n) => [n.invoiceId, n]));
    for (const w of batchInv) {
      const inv = open.get(w.invoice_id);
      if (!inv) {
        await deps.store.markNoticeAnswered([{ invoiceId: w.invoice_id, kind: "due" }], at);
        continue;
      }
      try {
        await deps.ledger.payInvoice(ws, inv.invoiceId, today);
        await deps.store.markNoticeAnswered([{ invoiceId: inv.invoiceId, kind: "due" }], at);
        paid.push(inv);
      } catch (e) {
        failed++;
        deps.log?.({ event: "invoice_pay_failed", message: e instanceof Error ? e.message : "unknown" });
      }
    }
  }
  if (!done.length && !paid.length && failed) return "N\xE3o consegui dar baixa agora. Tenta de novo daqui a pouco, ou d\xE1 uma olhada no dashboard. \u{1F64F}";
  if (!done.length && !paid.length) return `J\xE1 estava tudo certo por aqui${nm ? `, ${nm}` : ""}! \u{1F609}`;
  const list = [...done.map((d) => `${d.description} (${brl(Math.round(d.amount * 100))})`), ...paid.map((p) => `fatura do ${p.cardName} (${brl(Math.round(p.amount * 100))})`)].join(", ");
  return `Boa${nm ? `, ${nm}` : ""}! Dei baixa em ${list}. \u{1F389}${failed ? " Um deles n\xE3o consegui agora, tenta de novo daqui a pouco." : ""}`;
}
var same = (a, b) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
function createCronHandler(config, make) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (config.secret.length < 16) return res.status(503).json({ error: "CRON_NOT_CONFIGURED" });
    const raw = req.headers?.authorization;
    const header = Array.isArray(raw) ? raw[0] : raw ?? "";
    if (!same(header, `Bearer ${config.secret}`)) return res.status(401).json({ error: "UNAUTHORIZED" });
    let dry = false;
    try {
      dry = new URL(req.url ?? "", "https://x.invalid").searchParams.get("dry") === "1";
    } catch {
    }
    const result = await runReminders(make(), { dry });
    return res.status(200).json({ ok: true, dry, sent: result.sent, skipped: result.skipped, failed: result.failed, ...dry ? { messages: result.messages } : {} });
  };
}
var log = (event) => console.warn(JSON.stringify({ ...event, at: (/* @__PURE__ */ new Date()).toISOString() }));
async function entry(req, res) {
  const e = process.env;
  const need = ["CRON_SECRET", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ZAPI_INSTANCE_ID", "ZAPI_TOKEN", "ZAPI_CLIENT_TOKEN"];
  const missing = need.filter((k) => !e[k]?.trim());
  if (missing.length) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ error: "NOT_CONFIGURED", missing });
  }
  return createCronHandler({ secret: e.CRON_SECRET }, () => ({
    store: new SupabaseStore(e.SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY),
    ledger: new SupabaseLedger(e.SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY),
    messenger: new ZApiClient(e.ZAPI_INSTANCE_ID, e.ZAPI_TOKEN, e.ZAPI_CLIENT_TOKEN),
    log
  }))(req, res);
}
export {
  MAX_ASKS_PER_ITEM,
  MAX_ITEMS_PER_MESSAGE,
  MAX_NOTICES_PER_MESSAGE,
  REPLY_WINDOW_MS,
  composeNotices,
  composeReminder,
  createCronHandler,
  entry as default,
  dm,
  handleReminderReply,
  optOutNote,
  runReminders
};
