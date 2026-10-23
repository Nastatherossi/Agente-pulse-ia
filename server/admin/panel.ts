import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Contact } from '../../shared/whatsapp/access.js';
import { parseOwnerCommand, normalizePhone } from '../../shared/whatsapp/access.js';
import { SupabaseStore, type UsageRecord, type TurnDetail } from '../whatsapp/store.js';
import { SupabaseLedger } from '../whatsapp/ledger.js';
import { ZApiClient } from '../whatsapp/zapi.js';
import { execOwnerCommand, type Deps } from '../whatsapp/handler.js';
import { homePage, usersPage, aiPage, problemsPage, turnPage, configPage, loginPage, plainPage, type ViewCtx } from './views.js';

import { TRACKING_SINCE } from './format.js';
export { esc, fmtPhone, ERROR_HELP, turnKind, TRACKING_SINCE } from './format.js';
export { loginPage, homePage, problemsPage, turnPage } from './views.js';

/* Painel de gestão: uma senha, páginas renderizadas no servidor. O JavaScript do navegador (/admin.js) só melhora a
   experiência (busca, ordenação, confirmação, tooltips); sem ele, tudo continua funcionando por formulários e links. */

export type AdminSource = {
  contacts(): Promise<Contact[]>;
  usageSince(iso: string): Promise<UsageRecord[]>;
  problemTurns(iso: string): Promise<TurnDetail[]>;
  turn(messageId: string): Promise<TurnDetail | null>;
};
export type AdminDeps = {
  source: AdminSource;
  /** Autorizar ou bloquear com o mesmo efeito do comando do dono no WhatsApp (cria conta, manda boas-vindas). */
  run: (command: string) => Promise<string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Preço por 1 milhão de tokens, em dólar. Sem preço, o painel mostra só tokens. */
  price?: { inputPerMTok: number; outputPerMTok: number };
};

type Req = { method?: string; url?: string; body?: unknown; headers?: Record<string, string | string[] | undefined> };
type Res = { status: (n: number) => Res; setHeader: (k: string, v: string) => void; send: (x: string) => void; end: () => void };

export const COOKIE = 'pulse_admin';
export const MIN_PASSWORD = 16;
const DAY = 86_400_000;

const same = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
export const sessionToken = (password: string) => createHmac('sha256', password).update('pulse-admin-session-v1').digest('hex');

function cookieOf(req: Req, name: string) {
  const raw = req.headers?.cookie;
  const header = Array.isArray(raw) ? raw.join(';') : raw ?? '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function formOf(req: Req): Record<string, string> {
  const b = req.body;
  if (typeof b === 'string') return Object.fromEntries(new URLSearchParams(b));
  if (b && typeof b === 'object') return Object.fromEntries(Object.entries(b as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  return {};
}

export type Summary = ReturnType<typeof summarize>;

const isErr = (u: UsageRecord) => u.status === 'error' || Boolean(u.error_code);
const BRT = -3 * 3_600_000;
const dayKey = (ms: number) => new Date(ms + BRT).toISOString().slice(0, 10);

/** Agrega o consumo: totais por período, por pessoa e por dia. Puro, para ser testado sem banco. */
export function summarize(contacts: Contact[], usage: UsageRecord[], nowMs: number, price?: AdminDeps['price']) {
  const cost = (i: number, o: number) => (price ? (i * price.inputPerMTok + o * price.outputPerMTok) / 1_000_000 : undefined);
  const since = (ms: number) => usage.filter(u => nowMs - Date.parse(u.created_at) <= ms);
  const d1 = since(DAY), d7 = since(7 * DAY);
  const prev7 = usage.filter(u => { const age = nowMs - Date.parse(u.created_at); return age > 7 * DAY && age <= 14 * DAY; });
  const tokens = (rows: UsageRecord[]) => rows.reduce((a, u) => ({ i: a.i + u.input_tokens, o: a.o + u.output_tokens }), { i: 0, o: 0 });
  const t30 = tokens(usage);
  const people = contacts.map(c => {
    const mine = usage.filter(u => u.phone === c.phone);
    const t = tokens(mine);
    const last = mine.reduce<string | undefined>((m, u) => (!m || u.created_at > m ? u.created_at : m), undefined);
    return { contact: c, messages30d: mine.length, inputTokens: t.i, outputTokens: t.o, cost: cost(t.i, t.o), lastAt: last, errors: mine.filter(isErr).length };
  });
  const order = { pending: 0, authorized: 1, blocked: 2 } as Record<string, number>;
  people.sort((a, b) => (order[a.contact.status] ?? 3) - (order[b.contact.status] ?? 3) || (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
  const perDay = Array.from({ length: 14 }, (_, i) => {
    const key = dayKey(nowMs - (13 - i) * DAY);
    return { day: key, count: usage.filter(u => dayKey(Date.parse(u.created_at)) === key).length };
  });
  /** 30 dias, do mais antigo ao de hoje, com tokens e erros; tracked=false antes do início do registro. */
  const daily = Array.from({ length: 30 }, (_, i) => {
    const key = dayKey(nowMs - (29 - i) * DAY);
    const rows = usage.filter(u => dayKey(Date.parse(u.created_at)) === key);
    const t = tokens(rows);
    return { day: key, tracked: key >= TRACKING_SINCE, messages: rows.length, input: t.i, output: t.o, errors: rows.filter(isErr).length, cost: cost(t.i, t.o) };
  });
  const byModel = new Map<string, { model: string; messages: number; tokens: number }>();
  for (const u of usage) {
    const m = u.model || 'não informado';
    const row = byModel.get(m) ?? { model: m, messages: 0, tokens: 0 };
    row.messages++;
    row.tokens += u.input_tokens + u.output_tokens;
    byModel.set(m, row);
  }
  return {
    counts: { authorized: contacts.filter(c => c.status === 'authorized').length, pending: contacts.filter(c => c.status === 'pending').length, blocked: contacts.filter(c => c.status === 'blocked').length },
    messages: { d1: d1.length, d7: d7.length, d30: usage.length },
    /** Mensagens dos 7 dias anteriores; só existe quando o registro já cobria esse período inteiro. */
    messagesPrev7: dayKey(nowMs - 14 * DAY) >= TRACKING_SINCE ? prev7.length : undefined,
    activePeople7d: new Set(d7.map(u => u.phone)).size,
    tokens30d: t30.i + t30.o,
    tokensIn30d: t30.i,
    tokensOut30d: t30.o,
    avgTokens: usage.length ? Math.round((t30.i + t30.o) / usage.length) : 0,
    cost30d: cost(t30.i, t30.o),
    errors1d: d1.filter(isErr).length,
    errors7d: d7.filter(isErr).length,
    errors30d: usage.filter(isErr).length,
    perDay,
    daily,
    models: [...byModel.values()].sort((a, b) => b.tokens - a.tokens),
    people,
  };
}

export function createAdmin(config: { password: string }, deps: AdminDeps) {
  const token = config.password ? sessionToken(config.password) : '';
  const html = (res: Res, status: number, body: string) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(status).send(body);
  };
  const redirect = (res: Res, to: string, cookie?: string) => {
    res.setHeader('Cache-Control', 'no-store');
    if (cookie) res.setHeader('Set-Cookie', cookie);
    res.setHeader('Location', to);
    res.status(303).end();
  };
  const cookie = (value: string, maxAge: number) => `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

  return async function handler(req: Req, res: Res) {
    if (config.password.length < MIN_PASSWORD) return html(res, 503, plainPage('Painel desativado', `Defina ADMIN_PASSWORD (mínimo ${MIN_PASSWORD} caracteres) nas variáveis da Vercel e faça um novo deploy.`));
    const authed = same(cookieOf(req, COOKIE), token);
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET, POST');
      return html(res, 405, plainPage('Método não permitido', 'Use o painel pelo navegador.'));
    }
    const form = method === 'POST' ? formOf(req) : {};
    if (method === 'POST' && form.action === 'login') {
      if (same(form.password ?? '', config.password)) return redirect(res, '/admin', cookie(token, 30 * 86_400));
      await (deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms))))(1200); // freia tentativas em sequência
      return html(res, 401, loginPage('Senha incorreta.'));
    }
    if (!authed) return html(res, method === 'POST' ? 401 : 200, loginPage());
    if (method === 'POST' && form.action === 'logout') return redirect(res, '/admin', cookie('', 0));
    let flash: string | undefined;
    if (method === 'POST' && (form.action === 'authorize' || form.action === 'block')) {
      const phone = (form.phone ?? '').replace(/\D/g, '');
      const command = `${form.action === 'authorize' ? 'autorizar' : 'bloquear'} ${phone}`;
      if (!phone || parseOwnerCommand(command)?.kind === 'invalid') flash = 'Número inválido.';
      else {
        try {
          flash = await deps.run(command);
        } catch {
          flash = 'Não consegui concluir agora. Tente de novo.';
        }
      }
    }
    try {
      const now = deps.now?.() ?? Date.now();
      const since = new Date(now - 30 * DAY).toISOString();
      let q = new URLSearchParams();
      try {
        q = new URL(req.url ?? '', 'https://x.invalid').searchParams;
      } catch {
        /* url inválida: visão geral */
      }
      const view = q.get('v');
      const contacts = await deps.source.contacts();
      const ctx = (problems: number): ViewCtx => ({ now, contacts, problems, pending: contacts.filter(c => c.status === 'pending').length, flash, price: deps.price });
      if (view === 'turno') {
        const [turn, problems] = await Promise.all([deps.source.turn(q.get('id') ?? ''), deps.source.problemTurns(since)]);
        return html(res, 200, turnPage(turn, ctx(problems.length)));
      }
      const [usage, problems] = await Promise.all([deps.source.usageSince(since), deps.source.problemTurns(since)]);
      const c = ctx(problems.length);
      if (view === 'problemas') return html(res, 200, problemsPage(problems, c));
      if (view === 'config') return html(res, 200, configPage(c));
      const s = summarize(contacts, usage, now, deps.price);
      if (view === 'usuarios') return html(res, 200, usersPage(s, c));
      if (view === 'ia') return html(res, 200, aiPage(s, c));
      return html(res, 200, homePage(s, problems, c));
    } catch {
      return html(res, 502, plainPage('Não consegui ler o banco agora', 'Atualize a página em instantes. Se continuar, confira o Supabase.'));
    }
  };
}

const log = (event: Record<string, unknown>) => console.warn(JSON.stringify({ ...event, at: new Date().toISOString() }));

/** Entrada do Vercel: monta as dependências a partir das variáveis de ambiente. */
export default async function entry(req: Req, res: Res) {
  const e = process.env;
  const password = e.ADMIN_PASSWORD?.trim() ?? '';
  const url = e.SUPABASE_URL?.trim() ?? '', key = e.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? '';
  const ownerPhone = normalizePhone(e.OWNER_PHONE);
  if (password.length >= MIN_PASSWORD && (!url || !key || !ownerPhone || !e.ZAPI_INSTANCE_ID || !e.ZAPI_TOKEN || !e.ZAPI_CLIENT_TOKEN)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).send('Painel sem configuração completa (Supabase, Z-API e OWNER_PHONE).');
  }
  const store = new SupabaseStore(url || 'x', key || 'x');
  const price = Number(e.OPENAI_PRICE_IN_PER_MTOK) > 0 && Number(e.OPENAI_PRICE_OUT_PER_MTOK) > 0 ? { inputPerMTok: Number(e.OPENAI_PRICE_IN_PER_MTOK), outputPerMTok: Number(e.OPENAI_PRICE_OUT_PER_MTOK) } : undefined;
  const ownerDeps: Deps = {
    ownerPhone,
    store,
    ledger: new SupabaseLedger(url, key),
    messenger: new ZApiClient(e.ZAPI_INSTANCE_ID ?? '', e.ZAPI_TOKEN ?? '', e.ZAPI_CLIENT_TOKEN ?? ''),
    provider: () => { throw new Error('NOT_USED'); },
    transcriber: () => { throw new Error('NOT_USED'); },
    log,
  };
  return createAdmin({ password }, {
    source: { contacts: () => store.listContacts(), usageSince: since => store.usageSince(since), problemTurns: since => store.problemTurns(since), turn: id => store.turn(id) },
    run: async command => {
      const cmd = parseOwnerCommand(command);
      return cmd ? execOwnerCommand(ownerDeps, cmd) : 'Comando inválido.';
    },
    price,
  })(req, res);
}
