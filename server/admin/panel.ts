import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Contact } from '../../shared/whatsapp/access.js';
import { parseOwnerCommand, normalizePhone } from '../../shared/whatsapp/access.js';
import { SupabaseStore, type UsageRecord, type TurnDetail } from '../whatsapp/store.js';
import { SupabaseLedger } from '../whatsapp/ledger.js';
import { ZApiClient } from '../whatsapp/zapi.js';
import { execOwnerCommand, type Deps } from '../whatsapp/handler.js';

/* Painel de gestão (v1): uma senha, páginas renderizadas no servidor, sem JavaScript no navegador. */

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

const isErr = (u: UsageRecord) => u.status === 'error' || Boolean(u.error_code);
const BRT = -3 * 3_600_000;
const dayKey = (ms: number) => new Date(ms + BRT).toISOString().slice(0, 10);

/** Agrega o consumo: totais por período, por pessoa e mensagens por dia. Puro, para ser testado sem banco. */
export function summarize(contacts: Contact[], usage: UsageRecord[], nowMs: number, price?: AdminDeps['price']) {
  const cost = (i: number, o: number) => (price ? (i * price.inputPerMTok + o * price.outputPerMTok) / 1_000_000 : undefined);
  const since = (ms: number) => usage.filter(u => nowMs - Date.parse(u.created_at) <= ms);
  const d1 = since(DAY), d7 = since(7 * DAY);
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
  return {
    counts: { authorized: contacts.filter(c => c.status === 'authorized').length, pending: contacts.filter(c => c.status === 'pending').length, blocked: contacts.filter(c => c.status === 'blocked').length },
    messages: { d1: d1.length, d7: d7.length, d30: usage.length },
    tokens30d: t30.i + t30.o,
    avgTokens: usage.length ? Math.round((t30.i + t30.o) / usage.length) : 0,
    cost30d: cost(t30.i, t30.o),
    errors7d: d7.filter(isErr).length,
    perDay,
    people,
  };
}

const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : '—');
const fmtFull = (iso?: string) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'full', timeStyle: 'medium' }) : '—');
const fmtInt = (n: number) => n.toLocaleString('pt-BR');
const fmtUsd = (n?: number) => (n === undefined ? '—' : `US$ ${n.toFixed(n < 1 ? 3 : 2)}`);
export const fmtPhone = (p: string) => (/^55\d{2}9\d{8}$/.test(p) ? `+55 (${p.slice(2, 4)}) ${p.slice(4, 9)}-${p.slice(9)}` : `+${p}`);
const STATUS: Record<string, string> = { authorized: 'Autorizado', pending: 'Pendente', blocked: 'Bloqueado' };

/** Em português claro: o que cada código de erro significa. */
export const ERROR_HELP: Record<string, string> = {
  TOKEN_LIMIT: 'A conversa desta mensagem passou do limite de tokens por mensagem (o agente chamou o modelo várias vezes). O usuário recebeu "problema técnico".',
  TOOL_LIMIT: 'O agente tentou usar ferramentas demais numa só mensagem.',
  OPENAI_TIMEOUT: 'A OpenAI demorou demais para responder.',
  OPENAI_NETWORK_FAILED: 'Falha de rede ao falar com a OpenAI.',
  OPENAI_QUOTA_EXCEEDED: 'Sem saldo ou cota na OpenAI.',
  OPENAI_AUTH_FAILED: 'A chave da OpenAI não foi aceita.',
  SESSION_CONFLICT: 'Duas mensagens do mesmo número chegaram ao mesmo tempo e a sessão não pôde ser salva.',
  INVALID_MODEL_JSON: 'A OpenAI devolveu uma resposta que o sistema não conseguiu ler.',
};
const KIND: Record<string, [string, string]> = { error: ['Erro', 'bad'], clarification: ['Não entendeu', 'warn'], blocked: ['Recusado', 'warn'] };
export function turnKind(t: { status: string; error_code: string | null; steps?: unknown }): [string, string] {
  if (t.status === 'error' || t.error_code) return KIND.error;
  if (Array.isArray(t.steps) && t.steps.some((x: any) => x?.status === 'blocked')) return KIND.blocked;
  return KIND[t.status] ?? ['Atenção', 'warn'];
}

const page = (title: string, body: string) =>
  `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><link rel="stylesheet" href="/admin.css"></head><body>${body}</body></html>`;

export const loginPage = (error?: string) =>
  page('Pulse — gestão', `<main class="login"><h1>Pulse · gestão</h1><form method="post" action="/admin"><input type="hidden" name="action" value="login"><label>Senha<input type="password" name="password" autocomplete="current-password" autofocus required></label>${error ? `<p class="err">${esc(error)}</p>` : ''}<button type="submit">Entrar</button></form></main>`);

const shell = (view: string, problems: number, inner: string, flash?: string) =>
  page('Pulse — gestão', `<div class="wrap"><header><div class="brand">Pulse <span>gestão</span></div><nav><a href="/admin"${view === 'home' ? ' class="on"' : ''}>Visão geral</a><a href="/admin?v=problemas"${view === 'problemas' ? ' class="on"' : ''}>Problemas${problems ? ` <b>${problems}</b>` : ''}</a></nav><form method="post" action="/admin"><input type="hidden" name="action" value="logout"><button type="submit" class="small ghost">Sair</button></form></header>${flash ? `<p class="flash">${esc(flash)}</p>` : ''}${inner}</div>`);

const who = (contacts: Contact[], phone: string) => contacts.find(c => c.phone === phone)?.name || fmtPhone(phone);
const clip = (t: string | null | undefined, n: number) => (t ? (t.length > n ? `${t.slice(0, n)}…` : t) : '—');

function turnCard(t: TurnDetail, contacts: Contact[]) {
  const [label, tone] = turnKind(t);
  return `<a class="turn" href="/admin?v=turno&amp;id=${encodeURIComponent(t.message_id)}"><div class="turn-top"><span class="tag ${tone}">${esc(label)}${t.error_code ? ` · ${esc(t.error_code)}` : ''}</span><span class="when">${fmtDate(t.created_at)}</span></div><div class="who">${esc(who(contacts, t.phone))}</div><div class="bubble in"><small>Usuário</small>${esc(clip(t.user_text, 220))}</div><div class="bubble out"><small>Pulse</small>${esc(clip(t.reply_text, 220))}</div></a>`;
}

export function homePage(s: Summary, problems: TurnDetail[], contacts: Contact[], flash?: string) {
  const card = (label: string, value: string, hint = '', tone = '') => `<div class="card ${tone}"><span>${esc(label)}</span><strong>${esc(value)}</strong>${hint ? `<small>${esc(hint)}</small>` : ''}</div>`;
  const max = Math.max(1, ...s.perDay.map(d => d.count));
  const bars = s.perDay.map(d => `<div class="bar" title="${esc(d.day)}: ${d.count}"><i class="h${Math.round(((d.count / max) * 100) / 5) * 5}"></i><em>${esc(d.day.slice(8))}</em></div>`).join('');
  const action = (phone: string, act: string, label: string) => `<form method="post" action="/admin"><input type="hidden" name="action" value="${act}"><input type="hidden" name="phone" value="${esc(phone)}"><button type="submit" class="small">${label}</button></form>`;
  const rows = s.people.map(p => `<tr><td data-l="Nome" class="name">${esc(p.contact.name || '—')}</td><td data-l="Telefone" class="mono">${esc(fmtPhone(p.contact.phone))}</td><td data-l="Status"><span class="tag ${esc(p.contact.status)}">${esc(STATUS[p.contact.status] ?? p.contact.status)}</span></td><td data-l="Última mensagem">${fmtDate(p.lastAt)}</td><td data-l="Mensagens (30d)" class="num">${fmtInt(p.messages30d)}</td><td data-l="Tokens (30d)" class="num">${fmtInt(p.inputTokens + p.outputTokens)}</td><td data-l="Custo (30d)" class="num">${fmtUsd(p.cost)}</td><td data-l="Erros" class="num">${p.errors || '—'}</td><td class="actions">${p.contact.status !== 'authorized' ? action(p.contact.phone, 'authorize', 'Autorizar') : ''}${p.contact.status !== 'blocked' ? action(p.contact.phone, 'block', 'Bloquear') : ''}</td></tr>`).join('');
  const recent = problems.slice(0, 4).map(t => turnCard(t, contacts)).join('');
  return shell('home', problems.length, `<section class="cards">${card('Autorizados', fmtInt(s.counts.authorized), s.counts.pending ? `${s.counts.pending} pendente(s)` : '')}${card('Mensagens hoje', fmtInt(s.messages.d1), `${fmtInt(s.messages.d7)} em 7 dias`)}${card('Tokens (30 dias)', fmtInt(s.tokens30d), `média ${fmtInt(s.avgTokens)} por mensagem`)}${card('Custo da IA (30 dias)', fmtUsd(s.cost30d), s.cost30d === undefined ? 'preço não configurado' : 'estimado')}${card('Erros (7 dias)', fmtInt(s.errors7d), '', s.errors7d ? 'alert' : '')}</section>
<section class="panel"><h2>Mensagens por dia</h2><div class="bars">${bars}</div></section>
<section><div class="h2row"><h2>Precisa de atenção</h2><a href="/admin?v=problemas">ver todos${problems.length ? ` (${problems.length})` : ''}</a></div>${recent ? `<div class="turns">${recent}</div>` : '<p class="empty">Nenhum problema nos últimos 30 dias.</p>'}</section>
<section><h2>Usuários</h2><div class="scroll"><table class="stack"><thead><tr><th>Nome</th><th>Telefone</th><th>Status</th><th>Última mensagem</th><th class="num">Mensagens</th><th class="num">Tokens</th><th class="num">Custo</th><th class="num">Erros</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="9">Ninguém ainda.</td></tr>'}</tbody></table></div></section>
<p class="foot">Consumo registrado desde 22/10/2026. O texto da conversa só fica guardado nos turnos com problema (erro, não entendeu, recusado), para você depurar.</p>`, flash);
}

export function problemsPage(problems: TurnDetail[], contacts: Contact[]) {
  const cards = problems.map(t => turnCard(t, contacts)).join('');
  return shell('problemas', problems.length, `<h2>Problemas dos últimos 30 dias</h2><p class="lead">Mensagens em que o Pulse deu erro, não entendeu ou recusou uma ação. Clique para ver tudo.</p>${cards ? `<div class="turns">${cards}</div>` : '<p class="empty">Nenhum problema registrado.</p>'}`);
}

export function turnPage(t: TurnDetail | null, contacts: Contact[], problems: number) {
  if (!t) return shell('problemas', problems, '<p class="empty">Não encontrei essa mensagem.</p><p><a href="/admin?v=problemas">Voltar</a></p>');
  const [label, tone] = turnKind(t);
  const help = t.error_code ? ERROR_HELP[t.error_code] : undefined;
  const steps = Array.isArray(t.steps) ? (t.steps as any[]) : [];
  const stepRows = steps.map((x, i) => `<li class="step ${esc(x.status)}"><b>${i + 1}. ${esc(x.name)}</b> <span class="tag ${x.status === 'success' ? 'authorized' : 'bad'}">${esc(x.status)}</span><small>${esc(x.durationMs ?? 0)} ms</small>${x.arguments ? `<pre>${esc(JSON.stringify(x.arguments, null, 2))}</pre>` : ''}${x.error ? `<pre class="errtxt">${esc(JSON.stringify(x.error, null, 2))}</pre>` : ''}</li>`).join('');
  const kv = (k: string, v: string) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`;
  return shell('problemas', problems, `<p><a href="/admin?v=problemas">← Problemas</a></p><h2>${esc(who(contacts, t.phone))} <span class="tag ${tone}">${esc(label)}${t.error_code ? ` · ${esc(t.error_code)}` : ''}</span></h2><p class="lead">${esc(fmtFull(t.created_at))} · ${esc(fmtPhone(t.phone))} · ${t.source === 'audio' ? 'áudio' : 'texto'}</p>${help ? `<p class="explain"><b>O que significa:</b> ${esc(help)}</p>` : ''}
<div class="convo"><div class="bubble in"><small>O usuário mandou</small>${esc(t.user_text ?? '(não registrado)')}</div><div class="bubble out"><small>O Pulse respondeu</small>${esc(t.reply_text ?? '(não registrado)')}</div></div>
<h3>Detalhes</h3><dl class="kv">${kv('Intenção entendida', t.intent || '—')}${kv('Confirmação', t.confirmation || '—')}${kv('Modelo', t.model || '—')}${kv('Chamadas ao modelo', String(t.model_calls ?? 0))}${kv('Tokens', `${fmtInt(t.input_tokens)} entrada · ${fmtInt(t.output_tokens)} saída`)}${kv('Tempo total', t.duration_ms != null ? `${(t.duration_ms / 1000).toFixed(1)} s` : '—')}${kv('ID da mensagem', t.message_id)}</dl>
<h3>O que o agente tentou fazer</h3>${stepRows ? `<ol class="steps">${stepRows}</ol>` : '<p class="empty">Nenhuma ferramenta foi chamada.</p>'}`);
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
      const since = new Date(now - 30 * DAY).toISOString();
      let q = new URLSearchParams();
      try {
        q = new URL(req.url ?? '', 'https://x.invalid').searchParams;
      } catch {
        /* url inválida: visão geral */
      }
      const view = q.get('v');
      const contacts = await deps.source.contacts();
      if (view === 'turno') {
        const [turn, problems] = await Promise.all([deps.source.turn(q.get('id') ?? ''), deps.source.problemTurns(since)]);
        return html(res, 200, turnPage(turn, contacts, problems.length));
      }
      const [usage, problems] = await Promise.all([deps.source.usageSince(since), deps.source.problemTurns(since)]);
      if (view === 'problemas') return html(res, 200, problemsPage(problems, contacts));
      return html(res, 200, homePage(summarize(contacts, usage, now, deps.price), problems, contacts, flash));
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
    source: { contacts: () => store.listContacts(), usageSince: since => store.usageSince(since), problemTurns: since => store.problemTurns(since), turn: id => store.turn(id) },
    run: async command => {
      const cmd = parseOwnerCommand(command);
      return cmd ? execOwnerCommand(ownerDeps, cmd) : 'Comando inválido.';
    },
    price,
  })(req, res);
}
