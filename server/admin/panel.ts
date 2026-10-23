import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Contact } from '../../shared/whatsapp/access.js';
import { parseOwnerCommand, normalizePhone } from '../../shared/whatsapp/access.js';
import { SupabaseStore, type UsageRecord } from '../whatsapp/store.js';
import { SupabaseLedger } from '../whatsapp/ledger.js';
import { ZApiClient } from '../whatsapp/zapi.js';
import { execOwnerCommand, type Deps } from '../whatsapp/handler.js';

/* Painel de gestão (v1): uma senha, páginas renderizadas no servidor, sem JavaScript no navegador. */

export type AdminSource = {
  contacts(): Promise<Contact[]>;
  usageSince(iso: string): Promise<UsageRecord[]>;
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

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
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

/** Agrega o consumo: totais por período, por pessoa e erros recentes. Puro, para ser testado sem banco. */
export function summarize(contacts: Contact[], usage: UsageRecord[], nowMs: number, price?: AdminDeps['price']) {
  const cost = (i: number, o: number) => (price ? (i * price.inputPerMTok + o * price.outputPerMTok) / 1_000_000 : undefined);
  const since = (ms: number) => usage.filter(u => nowMs - Date.parse(u.created_at) <= ms);
  const d1 = since(DAY), d7 = since(7 * DAY);
  const tokens = (rows: UsageRecord[]) => rows.reduce((a, u) => ({ i: a.i + u.input_tokens, o: a.o + u.output_tokens }), { i: 0, o: 0 });
  const t30 = tokens(usage);
  const isErr = (u: UsageRecord) => u.status === 'error' || Boolean(u.error_code);
  const people = contacts.map(c => {
    const mine = usage.filter(u => u.phone === c.phone);
    const t = tokens(mine);
    const last = mine.reduce<string | undefined>((m, u) => (!m || u.created_at > m ? u.created_at : m), undefined);
    return { contact: c, messages30d: mine.length, inputTokens: t.i, outputTokens: t.o, cost: cost(t.i, t.o), lastAt: last, errors: mine.filter(isErr).length };
  });
  const order = { pending: 0, authorized: 1, blocked: 2 } as Record<string, number>;
  people.sort((a, b) => (order[a.contact.status] ?? 3) - (order[b.contact.status] ?? 3) || (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
  return {
    counts: { authorized: contacts.filter(c => c.status === 'authorized').length, pending: contacts.filter(c => c.status === 'pending').length, blocked: contacts.filter(c => c.status === 'blocked').length },
    messages: { d1: d1.length, d7: d7.length, d30: usage.length },
    tokens30d: t30.i + t30.o,
    cost30d: cost(t30.i, t30.o),
    errors7d: d7.filter(isErr).length,
    people,
    recentErrors: usage.filter(isErr).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 20),
  };
}

const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : '—');
const fmtInt = (n: number) => n.toLocaleString('pt-BR');
const fmtUsd = (n?: number) => (n === undefined ? '—' : `US$ ${n.toFixed(n < 1 ? 3 : 2)}`);
const STATUS: Record<string, string> = { authorized: 'Autorizado', pending: 'Pendente', blocked: 'Bloqueado' };

const page = (title: string, body: string) =>
  `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><link rel="stylesheet" href="/admin.css"></head><body>${body}</body></html>`;

export const loginPage = (error?: string) =>
  page('Pulse — gestão', `<main class="login"><h1>Pulse · gestão</h1><form method="post" action="/admin"><input type="hidden" name="action" value="login"><label>Senha<input type="password" name="password" autocomplete="current-password" autofocus required></label>${error ? `<p class="err">${esc(error)}</p>` : ''}<button type="submit">Entrar</button></form></main>`);

export function dashboardPage(s: Summary, flash?: string) {
  const card = (label: string, value: string, hint = '') => `<div class="card"><span>${esc(label)}</span><strong>${esc(value)}</strong>${hint ? `<small>${esc(hint)}</small>` : ''}</div>`;
  const costNote = s.cost30d === undefined ? 'defina OPENAI_PRICE_IN_PER_MTOK e OPENAI_PRICE_OUT_PER_MTOK' : 'estimado';
  const action = (phone: string, act: string, label: string) => `<form method="post" action="/admin"><input type="hidden" name="action" value="${act}"><input type="hidden" name="phone" value="${esc(phone)}"><button type="submit" class="small">${label}</button></form>`;
  const rows = s.people.map(p => `<tr><td>${esc(p.contact.name || '—')}</td><td class="mono">${esc(p.contact.phone)}</td><td><span class="tag ${esc(p.contact.status)}">${esc(STATUS[p.contact.status] ?? p.contact.status)}</span></td><td>${fmtDate(p.lastAt)}</td><td class="num">${fmtInt(p.messages30d)}</td><td class="num">${fmtInt(p.inputTokens + p.outputTokens)}</td><td class="num">${fmtUsd(p.cost)}</td><td class="num">${p.errors || '—'}</td><td class="actions">${p.contact.status !== 'authorized' ? action(p.contact.phone, 'authorize', 'Autorizar') : ''}${p.contact.status !== 'blocked' ? action(p.contact.phone, 'block', 'Bloquear') : ''}</td></tr>`).join('');
  const errs = s.recentErrors.map(e => `<tr><td>${fmtDate(e.created_at)}</td><td class="mono">${esc(e.phone)}</td><td>${esc(e.error_code || e.status)}</td><td>${esc(e.model || '—')}</td></tr>`).join('');
  return page('Pulse — gestão', `<main><header><h1>Pulse · gestão</h1><form method="post" action="/admin"><input type="hidden" name="action" value="logout"><button type="submit" class="small ghost">Sair</button></form></header>${flash ? `<p class="flash">${esc(flash)}</p>` : ''}
<section class="cards">${card('Autorizados', fmtInt(s.counts.authorized))}${card('Pendentes', fmtInt(s.counts.pending))}${card('Bloqueados', fmtInt(s.counts.blocked))}${card('Mensagens 24h', fmtInt(s.messages.d1), `${fmtInt(s.messages.d7)} em 7 dias`)}${card('Tokens 30 dias', fmtInt(s.tokens30d))}${card('Custo IA 30 dias', fmtUsd(s.cost30d), costNote)}${card('Erros 7 dias', fmtInt(s.errors7d))}</section>
<h2>Usuários</h2><div class="scroll"><table><thead><tr><th>Nome</th><th>Telefone</th><th>Status</th><th>Última mensagem</th><th class="num">Msgs 30d</th><th class="num">Tokens 30d</th><th class="num">Custo 30d</th><th class="num">Erros</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="9">Ninguém ainda.</td></tr>'}</tbody></table></div>
<h2>Erros recentes</h2><div class="scroll"><table><thead><tr><th>Quando</th><th>Telefone</th><th>Erro</th><th>Modelo</th></tr></thead><tbody>${errs || '<tr><td colspan="4">Nenhum erro registrado.</td></tr>'}</tbody></table></div>
<p class="foot">Consumo registrado a partir de 22/10/2026. Mostra só números e códigos de erro, nunca o texto das conversas nem valores financeiros.</p></main>`);
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
    if (config.password.length < MIN_PASSWORD) return html(res, 503, page('Pulse — gestão', `<main class="login"><h1>Painel desativado</h1><p>Defina ADMIN_PASSWORD (mínimo ${MIN_PASSWORD} caracteres) nas variáveis da Vercel e faça um novo deploy.</p></main>`));
    const authed = same(cookieOf(req, COOKIE), token);
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET, POST');
      return html(res, 405, page('Erro', '<main><p>Método não permitido.</p></main>'));
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
      const [contacts, usage] = await Promise.all([deps.source.contacts(), deps.source.usageSince(new Date(now - 30 * DAY).toISOString())]);
      return html(res, 200, dashboardPage(summarize(contacts, usage, now, deps.price), flash));
    } catch {
      return html(res, 502, page('Pulse — gestão', '<main><h1>Pulse · gestão</h1><p class="err">Não consegui ler o banco agora. Atualize a página em instantes.</p></main>'));
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
    source: { contacts: () => store.listContacts(), usageSince: since => store.usageSince(since) },
    run: async command => {
      const cmd = parseOwnerCommand(command);
      return cmd ? execOwnerCommand(ownerDeps, cmd) : 'Comando inválido.';
    },
    price,
  })(req, res);
}
