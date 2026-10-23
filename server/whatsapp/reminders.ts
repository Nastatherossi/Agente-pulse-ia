import { timingSafeEqual, createHash } from 'node:crypto';
import { brl, sessionSchema, todayBR } from '../../shared/v2/contracts.js';
import { type Contact } from '../../shared/whatsapp/access.js';
import { SupabaseLedger, type DueItem, type InvoiceNotice, type Ledger } from './ledger.js';
import { SupabaseStore, type Store } from './store.js';
import { ZApiClient, type Messenger } from './zapi.js';

/*
 * Lembretes proativos. Uma vez por dia (cron), o Pulse olha o que estava previsto para hoje (ou ficou para trás)
 * e pergunta se já aconteceu. Se a pessoa confirmar, o Pulse dá baixa. Regras fixas no código:
 * no máximo 1 mensagem proativa por pessoa por dia, cada lançamento é perguntado no máximo 3 vezes,
 * e a pessoa pode pedir "parar lembretes" a qualquer momento.
 */

export const MAX_ASKS_PER_ITEM = 3;
export const MAX_ITEMS_PER_MESSAGE = 3;
export const REPLY_WINDOW_MS = 48 * 3_600_000;
const MAX_MESSAGES_PER_RUN = 60;

export type ReminderDeps = {
  store: Store;
  ledger: Ledger;
  messenger: Messenger;
  today?: () => string;
  now?: () => number;
  /** Pausa entre mensagens de pessoas diferentes (evita rajada). */
  sleep?: (ms: number) => Promise<void>;
  log?: (event: Record<string, unknown>) => void;
};

const first = (name?: string | null) => name?.trim().split(/\s+/)[0] || undefined;
export const dm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const dayLabel = (item: DueItem, today: string) => (item.expectedDate === today ? 'pra hoje' : `pro dia ${dm(item.expectedDate)}`);
const what = (i: DueItem) => `${brl(Math.round(i.amount * 100))} de ${i.description}${i.category && i.category !== i.description ? ` (${i.category})` : ''}`;

export const optOutNote = 'Se preferir não receber esses lembretes, é só me dizer "parar lembretes". 😉';

/** Mensagem do lembrete: conversa de verdade, não notificação. */
export function composeReminder(items: DueItem[], name: string | undefined, today: string, firstEver: boolean): string {
  const nm = name ? `${name}, ` : '';
  const shown = items.slice(0, MAX_ITEMS_PER_MESSAGE);
  let body: string;
  if (shown.length === 1) {
    const i = shown[0];
    body =
      i.type === 'receita'
        ? `${name ? `Fala, ${name}, blz?` : 'Oi, tudo bem?'} Aqueles ${what(i)} que estavam previstos ${dayLabel(i, today)} já caíram? Me avisa aqui que eu dou baixa pra você. 💜`
        : `${nm}${name ? 'v' : 'V'}ocê tinha ${what(i)} previsto ${dayLabel(i, today)}. Já foi pago? Me avisa aqui que eu dou baixa pra você. 💜`;
  } else {
    const lines = shown.map(i => `• ${i.type === 'receita' ? 'Receber' : 'Pagar'} ${what(i)} (${i.expectedDate === today ? 'hoje' : dm(i.expectedDate)})`).join('\n');
    const more = items.length > shown.length ? `\n…e mais ${items.length - shown.length}.` : '';
    body = `${name ? `Fala, ${name}, blz?` : 'Oi, tudo bem?'} Hoje tem umas pendências por aqui:\n${lines}${more}\nJá aconteceram? Me conta aqui que eu dou baixa pra você. 💜`;
  }
  return firstEver ? `${body}\n\n${optOutNote}` : body;
}

export const MAX_NOTICES_PER_MESSAGE = 2;

/** Avisos de fatura: "fechou" (informativo) e "vence" (pergunta se já pagou). */
export function composeNotices(notices: InvoiceNotice[], name: string | undefined, today: string): string {
  const shown = notices.slice(0, MAX_NOTICES_PER_MESSAGE);
  const line = (n: InvoiceNotice) => {
    const v = brl(Math.round(n.amount * 100));
    if (n.kind === 'closed') return `a fatura do ${n.cardName} fechou${n.closingDate === today ? ' hoje' : ''}: ${v}. Ela vence dia ${dm(n.dueDate)}.`;
    if (n.dueDate === today) return `hoje vence a fatura do ${n.cardName} (${v}). Já pagou? Me avisa aqui que eu dou baixa pra você.`;
    return `a fatura do ${n.cardName} (${v}) venceu dia ${dm(n.dueDate)}. Já pagou? Me avisa aqui que eu dou baixa pra você.`;
  };
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const lines = shown.map(n => (name ? `${name}, ${line(n)}` : cap(line(n))));
  return `${lines.join('\n\n')} 💜`;
}

export type RunResult = { sent: number; skipped: number; failed: number; messages: { phone: string; text: string }[] };

/** Roda uma vez por dia. `dry` só calcula o que enviaria. */
export async function runReminders(deps: ReminderDeps, opts: { dry?: boolean } = {}): Promise<RunResult> {
  const today = deps.today?.() ?? todayBR();
  const nowMs = deps.now?.() ?? Date.now();
  const startOfDay = new Date(`${today}T00:00:00-03:00`).toISOString();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const out: RunResult = { sent: 0, skipped: 0, failed: 0, messages: [] };
  const contacts = (await deps.store.listContacts()).filter((c: Contact) => c.status === 'authorized' && c.reminders_enabled !== false);
  for (const c of contacts) {
    if (out.sent >= MAX_MESSAGES_PER_RUN) break;
    try {
      const last = await deps.store.lastReminderAt(c.phone);
      if (last && last >= startOfDay) { out.skipped++; continue; }
      const ws = await deps.ledger.resolve(c.phone, c.name ?? undefined);
      const due = await deps.ledger.due(ws, today);
      const states = new Map((await deps.store.reminderStates(due.map(d => d.id))).map(s => [s.transaction_id, s]));
      const items = due.filter(d => (states.get(d.id)?.sent_count ?? 0) < MAX_ASKS_PER_ITEM);
      const allNotices = await deps.ledger.invoiceNotices(ws, today);
      const noticeStates = await deps.store.noticeStates(allNotices.map(n => n.invoiceId));
      const notices = allNotices.filter(n => {
        const sent = noticeStates.find(s => s.invoice_id === n.invoiceId && s.kind === n.kind)?.sent_count ?? 0;
        return sent < (n.kind === 'closed' ? 1 : MAX_ASKS_PER_ITEM);
      });
      if (!items.length && !notices.length) { out.skipped++; continue; }
      const firstEver = !last;
      const nm = first(c.name);
      const parts = [items.length ? composeReminder(items, nm, today, false) : '', notices.length ? composeNotices(notices, nm, today) : ''].filter(Boolean);
      const text = parts.join('\n\n') + (firstEver ? `\n\n${optOutNote}` : '');
      out.messages.push({ phone: c.phone, text });
      if (opts.dry) continue;
      await deps.messenger.sendText(c.phone, text);
      const asked = items.slice(0, MAX_ITEMS_PER_MESSAGE).map(i => ({ id: i.id, workspaceId: ws.workspaceId }));
      const at = new Date(nowMs).toISOString();
      if (asked.length) await deps.store.markReminded(asked, c.phone, at);
      const told = notices.slice(0, MAX_NOTICES_PER_MESSAGE).map(n => ({ invoiceId: n.invoiceId, kind: n.kind, workspaceId: ws.workspaceId }));
      if (told.length) await deps.store.markNoticed(told, c.phone, at);
      await rememberInSession(deps.store, c.phone, text, nowMs).catch(() => undefined);
      out.sent++;
      await sleep(2500 + Math.floor(Math.random() * 2500));
    } catch (e) {
      out.failed++;
      deps.log?.({ event: 'reminder_failed', message: e instanceof Error ? e.message : 'unknown' });
    }
  }
  return out;
}

/** O que o Pulse mandou entra na conversa, para o agente entender uma resposta como "caiu sim, valeu". */
async function rememberInSession(store: Store, phone: string, text: string, nowMs: number) {
  const stored = await store.getSession(phone);
  if (!stored) return;
  const parsed = sessionSchema.safeParse(stored.session);
  if (!parsed.success) return;
  const s = parsed.data;
  s.history = [...s.history, { role: 'assistant' as const, content: text.slice(0, 1800) }].slice(-10);
  s.expiresAt = nowMs + 365 * 86_400_000;
  await store.saveSession(phone, s, stored.version);
}

const YES = /^(sim|s|caiu|ja caiu|caiu sim|ja foi|foi|foi sim|recebi|recebi sim|ja recebi|paguei|ja paguei|pago|ja ta pago|ta na conta|ja ta na conta|entrou|ja entrou|pode dar baixa|da baixa|dar baixa|pode dar|confirmo|isso|isso mesmo|ok|certo|beleza)[.! ]*$/;
const NO = /^(nao|n|ainda nao|ainda n|nao caiu|ainda nao caiu|nao foi|ainda nao foi|nao recebi|ainda nao recebi|nao paguei|ainda nao paguei|amanha|depois|mais tarde)[.! ]*$/;
const OFF = /^(parar|pare|para|desativar|desligar|cancelar)( os| as)? lembretes?( por favor)?[.! ]*$/;
const ON = /^(ativar|voltar|religar|ligar|retomar)( os| as)? lembretes?[.! ]*$/;
const plain = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Responde a quem estava sendo perguntado (ou pediu para parar). undefined = não é com os lembretes, segue o fluxo normal. */
export async function handleReminderReply(deps: ReminderDeps, phone: string, name: string | null | undefined, text: string): Promise<string | undefined> {
  const t = plain(text);
  const nm = first(name);
  if (OFF.test(t)) {
    await deps.store.setRemindersEnabled(phone, false);
    return `Combinado${nm ? `, ${nm}` : ''}! Não te mando mais lembretes. Se quiser de volta, é só dizer "ativar lembretes". 😉`;
  }
  if (ON.test(t)) {
    await deps.store.setRemindersEnabled(phone, true);
    return `Fechado${nm ? `, ${nm}` : ''}! Os lembretes voltaram. 💜`;
  }
  const yes = YES.test(t), no = NO.test(t);
  if (!yes && !no) return undefined;
  const nowMs = deps.now?.() ?? Date.now();
  const since = new Date(nowMs - REPLY_WINDOW_MS).toISOString();
  const [waitingTx, waitingInv] = await Promise.all([deps.store.awaitingReminders(phone, since), deps.store.awaitingNotices(phone, since)]);
  if (!waitingTx.length && !waitingInv.length) return undefined;
  // Só o último lote perguntado (lançamentos e faturas mandados na mesma mensagem têm o mesmo horário).
  const latest = [...waitingTx.map(w => w.last_sent_at ?? ''), ...waitingInv.map(w => w.last_sent_at ?? '')].sort().at(-1);
  const batch = waitingTx.filter(w => w.last_sent_at === latest);
  const batchInv = waitingInv.filter(w => w.last_sent_at === latest);
  if (no) return `Tranquilo${nm ? `, ${nm}` : ''}! Amanhã eu te pergunto de novo. 😉`;
  const today = deps.today?.() ?? todayBR();
  const ws = await deps.ledger.resolve(phone, name ?? undefined);
  const at = new Date(nowMs).toISOString();
  const due = new Map((await deps.ledger.due(ws, today)).map(d => [d.id, d]));
  const done: DueItem[] = [];
  let failed = 0;
  for (const w of batch) {
    const item = due.get(w.transaction_id);
    if (!item) { await deps.store.markAnswered([w.transaction_id], at); continue; }
    try {
      await deps.ledger.confirm(ws, item.id, today);
      done.push(item);
    } catch (e) {
      failed++;
      deps.log?.({ event: 'reminder_confirm_failed', message: e instanceof Error ? e.message : 'unknown' });
    }
  }
  await deps.store.markAnswered(done.map(d => d.id), at);
  const paid: InvoiceNotice[] = [];
  if (batchInv.length) {
    const open = new Map((await deps.ledger.invoiceNotices(ws, today)).filter(n => n.kind === 'due').map(n => [n.invoiceId, n]));
    for (const w of batchInv) {
      const inv = open.get(w.invoice_id);
      if (!inv) { await deps.store.markNoticeAnswered([{ invoiceId: w.invoice_id, kind: 'due' }], at); continue; }
      try {
        await deps.ledger.payInvoice(ws, inv.invoiceId, today);
        await deps.store.markNoticeAnswered([{ invoiceId: inv.invoiceId, kind: 'due' }], at);
        paid.push(inv);
      } catch (e) {
        failed++;
        deps.log?.({ event: 'invoice_pay_failed', message: e instanceof Error ? e.message : 'unknown' });
      }
    }
  }
  if (!done.length && !paid.length && failed) return 'Não consegui dar baixa agora. Tenta de novo daqui a pouco, ou dá uma olhada no dashboard. 🙏';
  if (!done.length && !paid.length) return `Já estava tudo certo por aqui${nm ? `, ${nm}` : ''}! 😉`;
  const list = [...done.map(d => `${d.description} (${brl(Math.round(d.amount * 100))})`), ...paid.map(p => `fatura do ${p.cardName} (${brl(Math.round(p.amount * 100))})`)].join(', ');
  return `Boa${nm ? `, ${nm}` : ''}! Dei baixa em ${list}. 🎉${failed ? ' Um deles não consegui agora, tenta de novo daqui a pouco.' : ''}`;
}

type Req = { method?: string; url?: string; headers?: Record<string, string | string[] | undefined> };
type Res = { status: (n: number) => Res; json: (x: unknown) => void; setHeader: (k: string, v: string) => void };
const same = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

export function createCronHandler(config: { secret: string }, make: () => ReminderDeps) {
  return async function handler(req: Req, res: Res) {
    res.setHeader('Cache-Control', 'no-store');
    if (config.secret.length < 16) return res.status(503).json({ error: 'CRON_NOT_CONFIGURED' });
    const raw = req.headers?.authorization;
    const header = Array.isArray(raw) ? raw[0] : raw ?? '';
    if (!same(header, `Bearer ${config.secret}`)) return res.status(401).json({ error: 'UNAUTHORIZED' });
    let dry = false;
    try {
      dry = new URL(req.url ?? '', 'https://x.invalid').searchParams.get('dry') === '1';
    } catch {
      /* url inválida */
    }
    const result = await runReminders(make(), { dry });
    return res.status(200).json({ ok: true, dry, sent: result.sent, skipped: result.skipped, failed: result.failed, ...(dry ? { messages: result.messages } : {}) });
  };
}

const log = (event: Record<string, unknown>) => console.warn(JSON.stringify({ ...event, at: new Date().toISOString() }));

/** Entrada do Vercel (cron diário). Exige CRON_SECRET: a Vercel manda o cabeçalho Authorization sozinha. */
export default async function entry(req: Req, res: Res) {
  const e = process.env;
  const need = ['CRON_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ZAPI_INSTANCE_ID', 'ZAPI_TOKEN', 'ZAPI_CLIENT_TOKEN'];
  const missing = need.filter(k => !e[k]?.trim());
  if (missing.length) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({ error: 'NOT_CONFIGURED', missing });
  }
  return createCronHandler({ secret: e.CRON_SECRET as string }, () => ({
    store: new SupabaseStore(e.SUPABASE_URL as string, e.SUPABASE_SERVICE_ROLE_KEY as string),
    ledger: new SupabaseLedger(e.SUPABASE_URL as string, e.SUPABASE_SERVICE_ROLE_KEY as string),
    messenger: new ZApiClient(e.ZAPI_INSTANCE_ID as string, e.ZAPI_TOKEN as string, e.ZAPI_CLIENT_TOKEN as string),
    log,
  }))(req, res);
}
