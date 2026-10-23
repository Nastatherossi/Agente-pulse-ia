import type { Contact } from '../../shared/whatsapp/access.js';
import type { TurnDetail } from '../whatsapp/store.js';
import type { Summary, AdminDeps } from './panel.js';
import { TRACKING_SINCE, esc, fmtDate, fmtFull, fmtTime, fmtInt, fmtUsd, fmtShort, fmtPhone, maskPhone, relTime, dayLabel, weekday, STATUS, ERROR_HELP, problemKind } from './format.js';
import { icon, mark } from './icons.js';

/* Telas do painel. Regras: nada de estilo inline (a CSP bloqueia), todo texto vindo do banco passa por esc(),
   e ausência de dado aparece como "sem registro" ou "—", nunca como zero. */

export type ViewCtx = { now: number; contacts: Contact[]; problems: number; pending: number; flash?: string; price?: AdminDeps['price'] };

const trackingLabel = dayLabel(TRACKING_SINCE);
const plural = (n: number, one: string, many: string) => `${fmtInt(n)} ${n === 1 ? one : many}`;
const clip = (t: string | null | undefined, n: number) => (t ? (t.length > n ? `${t.slice(0, n)}…` : t) : '');
const who = (contacts: Contact[], phone: string) => contacts.find(c => c.phone === phone)?.name || '';
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '#';
const hue = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 6;
const avatar = (name: string | null | undefined, phone: string) => `<span class="avatar a${hue(phone)}" aria-hidden="true">${esc(name ? initials(name) : phone.slice(-2))}</span>`;
const tip = (text: string, label: string) => `<button type="button" class="info" data-tip="${esc(text)}" aria-label="${esc(`${label}: ${text}`)}">${icon('info')}</button>`;

/* ------------------------------------------------------------------ página e moldura */

const doc = (title: string, body: string, bodyClass = '') =>
  `<!doctype html><html lang="pt-BR" class="no-js"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="dark"><meta name="theme-color" content="#090C14"><title>${esc(title)}</title><link rel="preload" href="/admin-fonts/instrument-sans-regular.woff" as="font" type="font/woff" crossorigin><link rel="stylesheet" href="/admin.css"><script src="/admin.js"></script></head><body${bodyClass ? ` class="${bodyClass}"` : ''}>${body}</body></html>`;

export const loginPage = (error?: string) =>
  doc(
    'Pulse — gestão',
    `<main class="login"><div class="login-card"><div class="login-brand">${mark()}<div><strong>Pulse</strong><span>Central de gestão</span></div></div><form method="post" action="/admin" class="login-form" data-busy="Entrando…"><input type="hidden" name="action" value="login"><label for="pw">Senha de acesso</label><div class="field">${icon('lock')}<input id="pw" type="password" name="password" autocomplete="current-password" autofocus required minlength="1"${error ? ' aria-invalid="true" aria-describedby="pw-err"' : ''}></div>${error ? `<p class="field-err" id="pw-err" role="alert">${esc(error)}</p>` : ''}<button type="submit" class="btn primary wide">Entrar</button></form><p class="login-note">Acesso exclusivo do dono do Pulse. A sessão vale 30 dias neste navegador.</p></div></main>`,
    'is-login'
  );

export const plainPage = (title: string, text: string) =>
  doc('Pulse — gestão', `<main class="login"><div class="login-card"><div class="login-brand">${mark()}<div><strong>Pulse</strong><span>Central de gestão</span></div></div><h1 class="plain-title">${esc(title)}</h1><p class="login-note">${esc(text)}</p><p><a class="btn ghost" href="/admin">${icon('refresh')}Tentar de novo</a></p></div></main>`, 'is-login');

type View = 'home' | 'usuarios' | 'ia' | 'problemas' | 'config';
const NAV: [View, string, string, string][] = [
  ['home', '/admin', 'overview', 'Visão geral'],
  ['usuarios', '/admin?v=usuarios', 'users', 'Usuários'],
  ['ia', '/admin?v=ia', 'ai', 'IA e custos'],
  ['problemas', '/admin?v=problemas', 'alert', 'Problemas'],
  ['config', '/admin?v=config', 'settings', 'Configuração'],
];

function shell(view: View, ctx: ViewCtx, head: { title: string; lead?: string; back?: string }, inner: string) {
  const badge = (v: View) =>
    v === 'problemas' && ctx.problems ? `<b class="count bad" aria-label="${ctx.problems} problemas">${ctx.problems}</b>` : v === 'usuarios' && ctx.pending ? `<b class="count warn" aria-label="${ctx.pending} aguardando">${ctx.pending}</b>` : '';
  const links = (cls: string) =>
    NAV.map(([v, href, ic, label]) => `<a class="${cls}" href="${href}"${v === view ? ' aria-current="page"' : ''}>${icon(ic)}<span class="label">${label}</span>${badge(v)}</a>`).join('');
  const here = NAV.find(n => n[0] === view)!;
  const flashBad = ctx.flash && /inválido|não consegui|erro/i.test(ctx.flash);
  const flash = ctx.flash ? `<div class="flash ${flashBad ? 'bad' : 'ok'}" role="status">${icon(flashBad ? 'error' : 'check')}<span>${esc(ctx.flash)}</span></div>` : '';
  return doc(
    `${head.title} · Pulse gestão`,
    `<a class="skip" href="#conteudo">Pular para o conteúdo</a>
<div class="app">
<aside class="side" aria-label="Menu principal">
 <div class="side-top"><a class="logo" href="/admin" aria-label="Pulse, visão geral">${mark()}<span class="label">Pulse<small>gestão</small></span></a><button type="button" class="icon-btn collapse needs-js" data-collapse aria-label="Recolher menu" aria-expanded="true">${icon('panel')}</button></div>
 <nav class="side-nav">${links('nav-link')}</nav>
 <div class="side-foot"><form method="post" action="/admin"><input type="hidden" name="action" value="logout"><button type="submit" class="nav-link as-btn">${icon('logout')}<span class="label">Sair</span></button></form></div>
</aside>
<div class="main">
 <header class="top">
  <div class="top-title">${head.back ? `<a class="back" href="${head.back}">${icon('back')}<span>${esc(here[3])}</span></a>` : ''}<h1>${esc(head.title)}</h1>${head.lead ? `<p>${head.lead}</p>` : ''}</div>
  <div class="top-meta"><span class="stamp">${icon('clock')}Atualizado às ${fmtTime(ctx.now)}</span><a class="icon-btn" href="${here[1]}" aria-label="Atualizar dados">${icon('refresh')}</a><form method="post" action="/admin" class="mobile-only"><input type="hidden" name="action" value="logout"><button type="submit" class="icon-btn" aria-label="Sair">${icon('logout')}</button></form></div>
 </header>
 ${flash}
 <main id="conteudo" tabindex="-1">${inner}</main>
</div>
<nav class="tabbar" aria-label="Seções">${links('tab')}</nav>
</div>
<dialog class="confirm" id="confirm" aria-labelledby="confirm-title"><form method="dialog"><div class="confirm-ico" data-confirm-ico></div><h2 id="confirm-title" data-confirm-title></h2><p data-confirm-text></p><div class="confirm-actions"><button type="submit" value="cancel" class="btn ghost">Cancelar</button><button type="submit" value="ok" class="btn" data-confirm-ok></button></div></form></dialog>
<div class="tip" role="tooltip" id="tip" hidden></div>`
  );
}

/* ------------------------------------------------------------------ gráficos (SVG desenhado no servidor) */

type Day = Summary['daily'][number];
const dayTip = (d: Day, extra: string[] = [], last = false) =>
  d.tracked
    ? [`${weekday(d.day)}, ${dayLabel(d.day)}${last ? ' (hoje, até agora)' : ''}`, plural(d.messages, 'mensagem', 'mensagens'), `${fmtInt(d.input + d.output)} tokens`, ...extra, d.errors ? plural(d.errors, 'erro', 'erros') : 'Sem erros'].join('\n')
    : `${weekday(d.day)}, ${dayLabel(d.day)}\nSem registro: o consumo passou a ser registrado em ${trackingLabel}`;

function axisLabels(days: Day[]) {
  const step = days.length <= 7 ? 1 : days.length <= 14 ? 2 : 5;
  const narrow = days.length <= 7 ? 2 : days.length <= 14 ? 4 : 10;
  return `<div class="x-axis" aria-hidden="true">${days.map((d, i) => { const k = days.length - 1 - i; return `<span${k % narrow === 0 ? ' class="keep"' : ''}>${k % step === 0 ? esc(dayLabel(d.day)) : ''}</span>`; }).join('')}</div>`;
}

function columns(days: Day[], tips: string[]) {
  return `<div class="cols" aria-hidden="true">${days.map((d, i) => `<span class="col${d.tracked ? '' : ' off'}" data-tip="${esc(tips[i])}">${d.errors ? '<i class="err-mark"></i>' : ''}</span>`).join('')}</div>`;
}

function srTable(caption: string, days: Day[], cols: [string, (d: Day) => string][]) {
  return `<table class="sr-only"><caption>${esc(caption)}</caption><thead><tr><th>Dia</th>${cols.map(c => `<th>${esc(c[0])}</th>`).join('')}</tr></thead><tbody>${days.map(d => `<tr><td>${esc(dayLabel(d.day))}</td>${cols.map(c => `<td>${d.tracked ? esc(c[1](d)) : 'sem registro'}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

/** Traço de pulso: mensagens por dia. Dias antes do registro ficam hachurados, sem linha. */
function pulseChart(days: Day[], id: string) {
  const W = days.length * 10, top = 10, base = 94;
  const max = Math.max(1, ...days.filter(d => d.tracked).map(d => d.messages));
  const y = (v: number) => base - (v / max) * (base - top);
  const first = days.findIndex(d => d.tracked);
  const tracked = first < 0 ? [] : days.slice(first);
  const pts = tracked.map((d, i) => `${(first + i) * 10 + 5},${y(d.messages).toFixed(2)}`);
  const line = pts.length ? `M${first * 10},${y(tracked[0]!.messages).toFixed(2)} L${pts.join(' L')} L${W},${y(tracked[tracked.length - 1]!.messages).toFixed(2)}` : '';
  const area = line ? `${line} L${W},${base} L${first * 10},${base} Z` : '';
  const hatch = first !== 0 ? `<rect x="0" y="0" width="${(first < 0 ? days.length : first) * 10}" height="100" fill="url(#h-${id})"/><line x1="0" x2="${(first < 0 ? days.length : first) * 10}" y1="${base}" y2="${base}" class="base-off" vector-effect="non-scaling-stroke"/>` : '';
  return `<div class="chart pulse" data-chart tabindex="0" role="group" aria-label="Mensagens por dia, ${days.length} dias. Use as setas para ver cada dia.">
 <div class="y-axis" aria-hidden="true"><span>${fmtInt(max)}</span><span>${fmtInt(Math.round(max / 2))}</span><span>0</span></div>
 <div class="plot"><svg viewBox="0 0 ${W} 100" preserveAspectRatio="none" aria-hidden="true" focusable="false"><defs><pattern id="h-${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" class="hatch"/></pattern><linearGradient id="g-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="fill-a"/><stop offset="1" class="fill-b"/></linearGradient></defs>
 <line x1="0" x2="${W}" y1="${top}" y2="${top}" class="grid" vector-effect="non-scaling-stroke"/><line x1="0" x2="${W}" y1="${(top + base) / 2}" y2="${(top + base) / 2}" class="grid" vector-effect="non-scaling-stroke"/><line x1="0" x2="${W}" y1="${base}" y2="${base}" class="grid base" vector-effect="non-scaling-stroke"/>
 ${hatch}${area ? `<path d="${area}" fill="url(#g-${id})"/><path d="${line}" class="trace" vector-effect="non-scaling-stroke"/>` : ''}</svg>${first !== 0 ? `<span class="off-note">Sem registro antes de ${esc(trackingLabel)}</span>` : ''}${columns(days, days.map((d, i) => dayTip(d, [], i === days.length - 1)))}</div>
 ${axisLabels(days)}
 ${srTable('Mensagens por dia', days, [['Mensagens', d => fmtInt(d.messages)], ['Erros', d => fmtInt(d.errors)]])}
</div>`;
}

/** Barras empilhadas de tokens (entrada embaixo, saída em cima). */
function tokenChart(days: Day[], id: string, withCost: boolean) {
  const W = days.length * 10, top = 10, base = 94;
  const max = Math.max(1, ...days.filter(d => d.tracked).map(d => d.input + d.output));
  const h = (v: number) => (v / max) * (base - top);
  const first = days.findIndex(d => d.tracked);
  const offW = (first < 0 ? days.length : first) * 10;
  const bars = days
    .map((d, i) => {
      if (!d.tracked || d.input + d.output === 0) return '';
      const hi = h(d.input), ho = h(d.output);
      return `<rect x="${i * 10 + 2}" y="${(base - hi).toFixed(2)}" width="6" height="${hi.toFixed(2)}" class="bar-in"/><rect x="${i * 10 + 2}" y="${(base - hi - ho).toFixed(2)}" width="6" height="${ho.toFixed(2)}" class="bar-out"/>`;
    })
    .join('');
  const tips = days.map((d, i) => dayTip(d, d.tracked ? [`${fmtInt(d.input)} entrada, ${fmtInt(d.output)} saída`, ...(withCost && d.cost !== undefined ? [`Custo estimado ${fmtUsd(d.cost)}`] : [])] : [], i === days.length - 1));
  return `<div class="chart bars" data-chart tabindex="0" role="group" aria-label="Tokens por dia, ${days.length} dias. Use as setas para ver cada dia.">
 <div class="y-axis" aria-hidden="true"><span>${fmtShort(max)}</span><span>${fmtShort(Math.round(max / 2))}</span><span>0</span></div>
 <div class="plot"><svg viewBox="0 0 ${W} 100" preserveAspectRatio="none" aria-hidden="true" focusable="false"><defs><pattern id="h-${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" class="hatch"/></pattern></defs>
 <line x1="0" x2="${W}" y1="${top}" y2="${top}" class="grid" vector-effect="non-scaling-stroke"/><line x1="0" x2="${W}" y1="${(top + base) / 2}" y2="${(top + base) / 2}" class="grid" vector-effect="non-scaling-stroke"/><line x1="0" x2="${W}" y1="${base}" y2="${base}" class="grid base" vector-effect="non-scaling-stroke"/>
 ${first !== 0 ? `<rect x="0" y="0" width="${offW}" height="100" fill="url(#h-${id})"/>` : ''}${bars}</svg>${first !== 0 ? `<span class="off-note">Sem registro antes de ${esc(trackingLabel)}</span>` : ''}${columns(days, tips)}</div>
 ${axisLabels(days)}
 ${srTable('Tokens por dia', days, [['Entrada', d => fmtInt(d.input)], ['Saída', d => fmtInt(d.output)], ['Mensagens', d => fmtInt(d.messages)]])}
</div>`;
}

/** Seletor de período sem JavaScript: rádios + CSS mostram o gráfico do período escolhido. */
function ranged(name: string, render: (days: Day[], id: string) => string, daily: Day[], legend = '') {
  const opts: [number, string][] = [[7, '7 dias'], [14, '14 dias'], [30, '30 dias']];
  const radios = opts.map(([n, label]) => `<input type="radio" class="range-in r${n}" name="${name}" id="${name}-${n}"${n === 14 ? ' checked' : ''}><label for="${name}-${n}">${label}</label>`).join('');
  const charts = opts.map(([n]) => `<div class="range-chart c${n}">${render(daily.slice(-n), `${name}-${n}`)}</div>`).join('');
  return `<div class="ranged"><fieldset class="range"><legend class="sr-only">Período</legend>${radios}</fieldset>${legend}<div class="range-charts">${charts}</div></div>`;
}

/* ------------------------------------------------------------------ peças */

const sev = (t: TurnDetail) => problemKind(t);
const sevIcon: Record<string, string> = { erro: 'error', duvida: 'doubt', recusado: 'ban', outro: 'alert' };

function personName(contacts: Contact[], phone: string, masked = true) {
  const name = who(contacts, phone);
  return name ? esc(name) : esc(masked ? maskPhone(phone) : fmtPhone(phone));
}

function incident(t: TurnDetail, ctx: ViewCtx, compact = false) {
  const [label, tone, key] = sev(t);
  const href = `/admin?v=turno&amp;id=${encodeURIComponent(t.message_id)}`;
  const steps = Array.isArray(t.steps) ? (t.steps as any[]) : [];
  const meta = [t.model ? esc(t.model) : '', `${fmtInt(t.input_tokens + t.output_tokens)} tokens`, t.duration_ms != null ? `${(t.duration_ms / 1000).toFixed(1)} s` : '', t.source === 'audio' ? 'áudio' : ''].filter(Boolean);
  const convo = `<div class="exchange"><p class="said"><span>Usuário</span>${t.user_text ? esc(clip(t.user_text, compact ? 120 : 260)) : '<em>texto não registrado</em>'}</p><p class="reply"><span>Pulse</span>${t.reply_text ? esc(clip(t.reply_text, compact ? 120 : 260)) : '<em>resposta não registrada</em>'}</p></div>`;
  const details = !compact && (steps.length || (t.error_code && ERROR_HELP[t.error_code]))
    ? `<details class="more"><summary>${icon('down')}Detalhes técnicos${steps.length ? ` (${plural(steps.length, 'passo', 'passos')})` : ''}</summary>${t.error_code && ERROR_HELP[t.error_code] ? `<p class="explain">${esc(ERROR_HELP[t.error_code])}</p>` : ''}${steps.length ? `<ol class="mini-steps">${steps.map(x => `<li class="${x?.status === 'success' ? 'ok' : 'bad'}"><code>${esc(x?.name)}</code><span>${esc(x?.status)}</span></li>`).join('')}</ol>` : ''}</details>`
    : '';
  return `<article class="incident ${tone}" data-kind="${key}"><div class="inc-rail" aria-hidden="true">${icon(sevIcon[key] ?? 'alert')}</div><div class="inc-body">
 <header><span class="sev ${tone}">${esc(label)}${t.error_code ? `<code>${esc(t.error_code)}</code>` : ''}</span><time datetime="${esc(t.created_at)}" title="${esc(fmtFull(t.created_at))}">${esc(relTime(t.created_at, ctx.now))}</time></header>
 <h3><a href="${href}">${personName(ctx.contacts, t.phone)}</a></h3>
 ${convo}
 ${compact ? '' : `<footer><span class="meta">${meta.join('<i aria-hidden="true"></i>')}</span><a class="link" href="${href}">Abrir incidente</a></footer>`}
 ${details}
</div></article>`;
}

const emptyState = (ic: string, title: string, text: string) => `<div class="empty">${icon(ic)}<div><strong>${esc(title)}</strong><p>${esc(text)}</p></div></div>`;

/* ------------------------------------------------------------------ visão geral */

export function homePage(s: Summary, problems: TurnDetail[], ctx: ViewCtx) {
  const tone = s.errors1d ? 'bad' : s.errors7d ? 'warn' : 'ok';
  const title = s.errors1d ? 'Erros nas últimas 24 horas' : s.errors7d ? 'Operando, com erros nesta semana' : 'Operando normalmente';
  const people = `${plural(s.activePeople7d, 'pessoa usou', 'pessoas usaram')} o Pulse nos últimos 7 dias, com ${plural(s.messages.d7, 'mensagem', 'mensagens')}.`;
  const errLine = s.errors1d ? ` ${plural(s.errors1d, 'mensagem falhou', 'mensagens falharam')} hoje.` : s.errors7d ? ` ${plural(s.errors7d, 'mensagem falhou', 'mensagens falharam')} na semana.` : '';
  const chips = [
    ctx.pending ? `<a class="chip warn" href="/admin?v=usuarios">${icon('users')}${plural(ctx.pending, 'pessoa aguardando', 'pessoas aguardando')} autorização</a>` : '',
    problems.length ? `<a class="chip ${tone === 'ok' ? '' : tone}" href="/admin?v=problemas">${icon('alert')}${plural(problems.length, 'problema', 'problemas')} em 30 dias</a>` : '',
  ].join('');

  const delta = (() => {
    if (s.messagesPrev7 === undefined || s.messagesPrev7 === 0) return '';
    const pct = Math.round(((s.messages.d7 - s.messagesPrev7) / s.messagesPrev7) * 100);
    return `<span class="delta ${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '+' : ''}${pct}% vs. 7 dias anteriores</span>`;
  })();
  const kpi = (ic: string, label: string, value: string, sub: string, help: string, cls = '') =>
    `<div class="kpi ${cls}"><div class="kpi-head">${icon(ic)}<span>${esc(label)}</span>${tip(help, label)}</div><strong class="figure">${value}</strong><p>${sub}</p></div>`;
  const kpis = [
    kpi('users', 'Usuários autorizados', fmtInt(s.counts.authorized), `${plural(s.activePeople7d, 'ativo', 'ativos')} em 7 dias${s.counts.blocked ? `, ${plural(s.counts.blocked, 'bloqueado', 'bloqueados')}` : ''}`, 'Números liberados para usar o Pulse no WhatsApp. Ativos = mandaram ao menos uma mensagem nos últimos 7 dias.'),
    kpi('message', 'Mensagens em 24 horas', fmtInt(s.messages.d1), `${fmtInt(s.messages.d7)} em 7 dias${delta ? ` ${delta}` : ''}`, 'Mensagens recebidas no WhatsApp e processadas pelo agente nas últimas 24 horas (janela móvel, não o dia do calendário).'),
    kpi('layers', 'Tokens em 30 dias', fmtShort(s.tokens30d), s.messages.d30 ? `média de ${fmtInt(s.avgTokens)} por mensagem` : 'nenhuma mensagem no período', `Soma de tokens de entrada e saída enviados à OpenAI. Registro desde ${trackingLabel}.`),
    s.cost30d === undefined
      ? kpi('coin', 'Custo da IA em 30 dias', '<span class="na">Indisponível</span>', 'Preços não configurados', 'Defina OPENAI_PRICE_IN_PER_MTOK e OPENAI_PRICE_OUT_PER_MTOK na Vercel para ver o custo estimado.', 'muted')
      : kpi('coin', 'Custo da IA em 30 dias', esc(fmtUsd(s.cost30d)), 'estimado pelo preço configurado', 'Tokens de entrada e saída multiplicados pelo preço por milhão configurado na Vercel. É uma estimativa, não a fatura da OpenAI.'),
    kpi('alert', 'Erros em 7 dias', fmtInt(s.errors7d), s.errors7d ? `<a href="/admin?v=problemas">ver problemas</a>` : 'nenhuma falha registrada', 'Mensagens em que o agente falhou (erro técnico, limite de tokens, OpenAI fora do ar…). O usuário recebeu uma mensagem de problema técnico.', s.errors7d ? 'alarm' : ''),
  ].join('');

  const recent = problems.slice(0, 4).map(t => incident(t, ctx, true)).join('');
  const top = s.people.filter(p => p.messages30d).sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)).slice(0, 5);
  const topMax = Math.max(1, ...top.map(p => p.inputTokens + p.outputTokens));
  const topRows = top
    .map(p => {
      const t = p.inputTokens + p.outputTokens;
      return `<li>${avatar(p.contact.name, p.contact.phone)}<div class="rank-body"><div class="rank-line"><span class="rank-name">${esc(p.contact.name || maskPhone(p.contact.phone))}</span><span class="figure-sm">${fmtShort(t)}</span></div><meter min="0" max="${topMax}" value="${t}" aria-label="Tokens de ${esc(p.contact.name || 'contato')}">${t}</meter><span class="rank-sub">${plural(p.messages30d, 'mensagem', 'mensagens')}${p.errors ? `, <b class="txt-bad">${plural(p.errors, 'erro', 'erros')}</b>` : ''}</span></div></li>`;
    })
    .join('');

  const needy = s.people.filter(p => p.contact.status === 'pending' || p.errors);
  const needyRows = needy
    .slice(0, 6)
    .map(p => {
      const c = p.contact;
      const why = c.status === 'pending' ? `<span class="status pending"><i aria-hidden="true"></i>${esc(STATUS.pending)}</span>` : `<span class="err-count">${icon('alert')}${plural(p.errors, 'erro', 'erros')} em 30 dias</span>`;
      return `<li>${avatar(c.name, c.phone)}<div class="rank-body"><span class="rank-name">${esc(c.name || fmtPhone(c.phone))}</span><span class="rank-sub">${why}</span></div>${c.status === 'pending' ? `<div class="actions">${actionForm(p, 'home')}</div>` : `<a class="link" href="/admin?v=usuarios">Ver</a>`}</li>`;
    })
    .join('');
  const needyBlock = needy.length
    ? `<section class="block"><div class="block-head"><h2>Pessoas que precisam de você</h2>${needy.length > 6 ? `<a class="link" href="/admin?v=usuarios">Ver todas (${needy.length})</a>` : ''}</div><ol class="rank people-attn">${needyRows}</ol></section>`
    : '';

  return shell(
    'home',
    ctx,
    { title: 'Visão geral', lead: 'Como o Pulse está funcionando agora' },
    `<section class="signal ${tone}" aria-labelledby="signal-title">
 <div class="signal-head"><div class="signal-state"><span class="beacon" aria-hidden="true"></span><div><h2 id="signal-title">${title}</h2><p>${esc(people + errLine)}</p>${chips ? `<div class="chips">${chips}</div>` : ''}</div></div></div>
 <h3 class="chart-title">Mensagens por dia</h3>
 ${ranged('msg', pulseChart, s.daily, `<p class="legend"><span class="key trace"></span>mensagens<span class="key err"></span>dia com erro<span class="key off"></span>sem registro</p>`)}
</section>
<section class="kpis" aria-label="Indicadores">${kpis}</section>
<div class="split">
 <section class="block"><div class="block-head"><h2>Precisa de atenção</h2>${problems.length ? `<a class="link" href="/admin?v=problemas">Ver todos (${problems.length})</a>` : ''}</div>${recent ? `<div class="incidents compact">${recent}</div>` : emptyState('check', 'Nada pendente', 'Nenhum erro, recusa ou mensagem não entendida nos últimos 30 dias.')}</section>
 <div class="stack">${needyBlock}<section class="block"><div class="block-head"><h2>Quem mais usa</h2><a class="link" href="/admin?v=ia">Consumo por pessoa</a></div>${topRows ? `<ol class="rank">${topRows}</ol>` : emptyState('users', 'Ninguém usou ainda', 'Quando alguém conversar com o Pulse, o consumo aparece aqui.')}<p class="note">Tokens dos últimos 30 dias.</p></section></div>
</div>
<p class="foot">Consumo registrado desde ${trackingLabel}/2026. O texto da conversa só fica guardado nos turnos com problema (erro, não entendeu, recusado), para você depurar.</p>`
  );
}

/* ------------------------------------------------------------------ usuários */

function actionForm(p: Summary['people'][number], view: string) {
  const name = p.contact.name || fmtPhone(p.contact.phone);
  const form = (act: 'authorize' | 'block', label: string, cls: string, title: string, text: string, busy: string) =>
    `<form method="post" action="/admin?v=${view}" data-confirm="${esc(text)}" data-confirm-title="${esc(title)}" data-confirm-ok="${esc(label)}" data-tone="${act === 'block' ? 'danger' : 'primary'}" data-busy="${esc(busy)}"><input type="hidden" name="action" value="${act}"><input type="hidden" name="phone" value="${esc(p.contact.phone)}"><button type="submit" class="btn sm ${cls}" aria-label="${esc(`${label} ${name}`)}">${label}</button></form>`;
  const out: string[] = [];
  if (p.contact.status === 'pending') out.push(form('authorize', 'Autorizar', 'primary', `Autorizar ${name}?`, 'O Pulse cria a conta desse número e manda a mensagem de boas-vindas no WhatsApp.', 'Autorizando…'));
  if (p.contact.status === 'blocked') out.push(form('authorize', 'Desbloquear', 'ghost', `Desbloquear ${name}?`, 'O número volta a ser atendido pelo Pulse, como um usuário autorizado.', 'Desbloqueando…'));
  if (p.contact.status !== 'blocked') out.push(form('block', 'Bloquear', 'danger-ghost', `Bloquear ${name}?`, 'O Pulse deixa de atender esse número até você desbloquear. Os dados financeiros não são apagados.', 'Bloqueando…'));
  return out.join('');
}

export function usersPage(s: Summary, ctx: ViewCtx) {
  const total = s.people.length;
  const withErr = s.people.filter(p => p.errors).length;
  const chip = (f: string, label: string, n: number, on = false) => `<button type="button" class="filter" data-filter="${f}" aria-pressed="${on}">${label}<span>${n}</span></button>`;
  const rows = s.people
    .map(p => {
      const c = p.contact, tk = p.inputTokens + p.outputTokens;
      return `<tr class="${p.errors ? 'has-err' : ''}" data-name="${esc((c.name || '').toLowerCase())} ${esc(c.phone)}" data-status="${esc(c.status)}" data-err="${p.errors ? 1 : 0}" data-s-name="${esc((c.name || '~').toLowerCase())}" data-s-last="${p.lastAt ? Date.parse(p.lastAt) : 0}" data-s-msgs="${p.messages30d}" data-s-tokens="${tk}" data-s-cost="${p.cost ?? 0}" data-s-err="${p.errors}">
<td class="who-cell"><div class="person">${avatar(c.name, c.phone)}<div><span class="pname">${esc(c.name || 'Sem nome')}</span><span class="phone">${esc(fmtPhone(c.phone))}</span></div></div></td>
<td data-l="Status"><span class="status ${esc(c.status)}"><i aria-hidden="true"></i>${esc(STATUS[c.status] ?? c.status)}</span></td>
<td data-l="Última mensagem">${p.lastAt ? `<time datetime="${esc(p.lastAt)}" title="${esc(fmtDate(p.lastAt))}">${esc(relTime(p.lastAt, ctx.now))}</time>` : '<span class="na">sem mensagens</span>'}</td>
<td data-l="Mensagens" class="num">${p.messages30d ? fmtInt(p.messages30d) : '<span class="na">—</span>'}</td>
<td data-l="Tokens" class="num">${tk ? fmtInt(tk) : '<span class="na">—</span>'}</td>
<td data-l="Custo" class="num">${p.cost === undefined ? '<span class="na" title="Preços não configurados">—</span>' : p.messages30d ? esc(fmtUsd(p.cost)) : '<span class="na">—</span>'}</td>
<td data-l="Erros" class="num">${p.errors ? `<span class="err-count">${icon('alert')}${p.errors}</span>` : '<span class="na">—</span>'}</td>
<td class="actions">${actionForm(p, 'usuarios')}</td></tr>`;
    })
    .join('');
  const th = (label: string, key: string, num = false) => `<th scope="col"${num ? ' class="num"' : ''} aria-sort="none"><button type="button" class="sort" data-sort="${key}"${num ? ' data-num="1"' : ''}>${label}${icon('sort')}</button></th>`;
  return shell(
    'usuarios',
    ctx,
    { title: 'Usuários', lead: `${plural(total, 'número', 'números')} que falaram com o Pulse. Consumo dos últimos 30 dias.` },
    total
      ? `<section class="block flush">
 <div class="toolbar needs-js"><label class="search">${icon('search')}<span class="sr-only">Buscar por nome ou telefone</span><input type="search" data-search placeholder="Buscar por nome ou telefone" autocomplete="off"></label>
 <div class="filters" role="group" aria-label="Filtrar por status">${chip('all', 'Todos', total, true)}${chip('authorized', 'Autorizados', s.counts.authorized)}${chip('pending', 'Pendentes', s.counts.pending)}${chip('blocked', 'Bloqueados', s.counts.blocked)}${withErr ? chip('err', 'Com erros', withErr) : ''}</div></div>
 <div class="table-wrap"><table class="data users" data-table><caption class="sr-only">Usuários do Pulse</caption><thead><tr>${th('Pessoa', 'name')}<th scope="col">Status</th>${th('Última mensagem', 'last', true).replace(' class="num"', '')}${th('Mensagens', 'msgs', true)}${th('Tokens', 'tokens', true)}${th('Custo', 'cost', true)}${th('Erros', 'err', true)}<th scope="col"><span class="sr-only">Ações</span></th></tr></thead><tbody>${rows}</tbody></table>
 <div class="empty filtered" data-noresults hidden>${icon('search')}<div><strong>Nenhum usuário encontrado</strong><p>Mude a busca ou o filtro.</p></div></div></div>
</section>
<p class="foot">Autorizar e bloquear têm o mesmo efeito dos comandos do dono no WhatsApp. Custos são estimativas a partir do preço configurado.</p>`
      : emptyState('users', 'Ninguém falou com o Pulse ainda', 'Quando alguém mandar mensagem para o número do Pulse no WhatsApp, a pessoa aparece aqui para você autorizar.')
  );
}

/* ------------------------------------------------------------------ IA e custos */

export function aiPage(s: Summary, ctx: ViewCtx) {
  const has = s.messages.d30 > 0;
  const priced = s.cost30d !== undefined;
  const inPct = s.tokens30d ? Math.round((s.tokensIn30d / s.tokens30d) * 100) : 0;
  const stat = (label: string, value: string, sub: string, cls = '') => `<div class="stat ${cls}"><span class="stat-label">${esc(label)}</span><strong class="figure">${value}</strong><p>${sub}</p></div>`;
  const stats = [
    stat('Tokens em 30 dias', has ? esc(fmtInt(s.tokens30d)) : '<span class="na">—</span>', has ? `<span class="split-bar" aria-hidden="true"><meter min="0" max="100" value="${inPct}"></meter></span>${fmtShort(s.tokensIn30d)} entrada, ${fmtShort(s.tokensOut30d)} saída` : 'nenhuma mensagem no período'),
    stat('Média por mensagem', has ? esc(fmtInt(s.avgTokens)) : '<span class="na">—</span>', has ? `em ${plural(s.messages.d30, 'mensagem', 'mensagens')}` : 'sem mensagens para calcular'),
    priced
      ? stat('Custo estimado em 30 dias', esc(fmtUsd(s.cost30d)), has ? `${esc(fmtUsd((s.cost30d ?? 0) / Math.max(1, s.messages.d30)))} por mensagem` : 'nenhum consumo no período')
      : stat('Custo estimado', '<span class="na">Indisponível</span>', 'Preços não configurados', 'muted'),
    stat('Mensagens em 30 dias', has ? esc(fmtInt(s.messages.d30)) : '<span class="na">—</span>', s.errors30d ? `<b class="txt-bad">${plural(s.errors30d, 'com erro', 'com erro')}</b>` : 'nenhuma com erro'),
  ].join('');

  const people = s.people.filter(p => p.messages30d).sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
  const max = Math.max(1, ...people.map(p => p.inputTokens + p.outputTokens));
  const rows = people
    .map(p => {
      const t = p.inputTokens + p.outputTokens;
      const share = s.tokens30d ? Math.round((t / s.tokens30d) * 100) : 0;
      return `<li>${avatar(p.contact.name, p.contact.phone)}<div class="rank-body"><div class="rank-line"><span class="rank-name">${esc(p.contact.name || maskPhone(p.contact.phone))}</span><span class="figure-sm">${fmtInt(t)}<small>${share}%</small></span></div><meter min="0" max="${max}" value="${t}" aria-label="Tokens">${t}</meter><span class="rank-sub">${plural(p.messages30d, 'mensagem', 'mensagens')}, média ${fmtInt(Math.round(t / p.messages30d))} por mensagem${p.cost !== undefined ? `, ${esc(fmtUsd(p.cost))}` : ''}</span></div></li>`;
    })
    .join('');
  const models = s.models.map(m => `<li><span class="model-name">${icon('cpu')}<code>${esc(m.model)}</code></span><span>${plural(m.messages, 'mensagem', 'mensagens')}</span><span class="figure-sm">${fmtShort(m.tokens)} tokens</span></li>`).join('');

  return shell(
    'ia',
    ctx,
    { title: 'IA e custos', lead: 'Consumo da OpenAI pelo agente do WhatsApp nos últimos 30 dias' },
    `<section class="stats" aria-label="Resumo de consumo">${stats}</section>
${priced ? '' : `<div class="notice">${icon('info')}<p><strong>Custo indisponível — preços não configurados.</strong> Defina <code>OPENAI_PRICE_IN_PER_MTOK</code> e <code>OPENAI_PRICE_OUT_PER_MTOK</code> (dólares por 1 milhão de tokens) na Vercel para o painel estimar o custo.</p></div>`}
<section class="block"><div class="block-head"><h2>Tokens por dia</h2></div>${ranged('tok', (d, id) => tokenChart(d, id, priced), s.daily, `<p class="legend"><span class="key in"></span>entrada<span class="key out"></span>saída<span class="key off"></span>sem registro</p>`)}</section>
<div class="split wide-left">
 <section class="block"><div class="block-head"><h2>Consumo por pessoa</h2></div>${rows ? `<ol class="rank">${rows}</ol>` : emptyState('users', 'Sem consumo', 'Ninguém usou o Pulse nos últimos 30 dias.')}</section>
 <section class="block"><div class="block-head"><h2>Modelos usados</h2></div>${models ? `<ul class="models">${models}</ul>` : emptyState('cpu', 'Sem registros', 'Nenhuma chamada à OpenAI nos últimos 30 dias.')}</section>
</div>
<p class="foot">Consumo registrado desde ${trackingLabel}/2026. Valores de custo são estimativas; a fatura oficial está no painel da OpenAI.</p>`
  );
}

/* ------------------------------------------------------------------ problemas */

export function problemsPage(problems: TurnDetail[], ctx: ViewCtx) {
  const by = (k: string) => problems.filter(t => sev(t)[2] === k).length;
  const chip = (f: string, label: string, n: number, on = false) => (n || f === 'all' ? `<button type="button" class="filter" data-kind-filter="${f}" aria-pressed="${on}">${label}<span>${n}</span></button>` : '');
  const groups = new Map<string, TurnDetail[]>();
  for (const t of problems) {
    const key = new Date(Date.parse(t.created_at) - 3 * 3_600_000).toISOString().slice(0, 10);
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const today = new Date(ctx.now - 3 * 3_600_000).toISOString().slice(0, 10);
  const yesterday = new Date(ctx.now - 27 * 3_600_000).toISOString().slice(0, 10);
  const dayName = (k: string) => (k === today ? 'Hoje' : k === yesterday ? 'Ontem' : `${weekday(k)}, ${dayLabel(k)}`);
  const list = [...groups.entries()].map(([k, items]) => `<section class="day-group" data-group><h2 class="day-title">${esc(dayName(k))}<span>${items.length}</span></h2><div class="incidents">${items.map(t => incident(t, ctx)).join('')}</div></section>`).join('');
  return shell(
    'problemas',
    ctx,
    { title: 'Problemas', lead: 'Mensagens dos últimos 30 dias em que o Pulse deu erro, não entendeu ou recusou uma ação.' },
    problems.length
      ? `<div class="toolbar needs-js"><div class="filters" role="group" aria-label="Filtrar por tipo">${chip('all', 'Todos', problems.length, true)}${chip('erro', 'Erros', by('erro'))}${chip('duvida', 'Não entendeu', by('duvida'))}${chip('recusado', 'Recusado', by('recusado'))}</div></div>${list}<div class="empty filtered" data-noresults hidden>${icon('search')}<div><strong>Nada deste tipo</strong><p>Escolha outro filtro.</p></div></div>`
      : emptyState('check', 'Nenhum problema registrado', 'Nos últimos 30 dias o Pulse não teve erros, recusas nem mensagens que não entendeu.')
  );
}

export function turnPage(t: TurnDetail | null, ctx: ViewCtx) {
  if (!t) return shell('problemas', ctx, { title: 'Incidente não encontrado', back: '/admin?v=problemas' }, emptyState('search', 'Não encontrei essa mensagem', 'Ela pode ter saído da janela de 30 dias. Volte para a lista de problemas.'));
  const [label, tone, key] = sev(t);
  const help = t.error_code ? ERROR_HELP[t.error_code] : undefined;
  const steps = Array.isArray(t.steps) ? (t.steps as any[]) : [];
  const name = who(ctx.contacts, t.phone);
  const fact = (k: string, v: string) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`;
  const stepRows = steps
    .map(
      (x, i) =>
        `<li class="step ${x?.status === 'success' ? 'ok' : 'bad'}"><span class="step-n" aria-hidden="true">${i + 1}</span><div class="step-body"><div class="step-head"><code>${esc(x?.name)}</code><span class="sev ${x?.status === 'success' ? 'ok' : 'bad'}">${esc(x?.status)}</span><small>${esc(x?.durationMs ?? 0)} ms</small></div>${x?.arguments ? `<details><summary>${icon('down')}Argumentos</summary><pre>${esc(JSON.stringify(x.arguments, null, 2))}</pre></details>` : ''}${x?.error ? `<pre class="errtxt">${esc(JSON.stringify(x.error, null, 2))}</pre>` : ''}</div></li>`
    )
    .join('');
  return shell(
    'problemas',
    ctx,
    { title: name || fmtPhone(t.phone), back: '/admin?v=problemas', lead: `<span class="sev ${tone}">${icon(sevIcon[key] ?? 'alert')}${esc(label)}${t.error_code ? `<code>${esc(t.error_code)}</code>` : ''}</span> ${esc(fmtFull(t.created_at))}` },
    `${help ? `<div class="notice ${tone}">${icon('info')}<p><strong>O que significa:</strong> ${esc(help)}</p></div>` : ''}
<div class="split wide-left">
 <section class="block"><div class="block-head"><h2>Conversa</h2><span class="meta">${t.source === 'audio' ? `${icon('mic')}áudio transcrito` : 'texto'}</span></div>
  <div class="thread"><div class="msg in"><span>O usuário mandou</span><p>${esc(t.user_text ?? '(não registrado)')}</p></div><div class="msg out"><span>O Pulse respondeu</span><p>${esc(t.reply_text ?? '(não registrado)')}</p></div></div></section>
 <section class="block"><div class="block-head"><h2>Detalhes</h2></div><dl class="facts">${fact('Telefone', esc(fmtPhone(t.phone)))}${fact('Intenção entendida', esc(t.intent || '—'))}${fact('Confirmação', esc(t.confirmation || '—'))}${fact('Modelo', t.model ? `<code>${esc(t.model)}</code>` : '—')}${fact('Chamadas ao modelo', esc(String(t.model_calls ?? 0)))}${fact('Tokens', `${esc(fmtInt(t.input_tokens))} entrada, ${esc(fmtInt(t.output_tokens))} saída`)}${fact('Tempo total', t.duration_ms != null ? `${(t.duration_ms / 1000).toFixed(1)} s` : '—')}${fact('ID da mensagem', `<code class="wrap">${esc(t.message_id)}</code>`)}</dl></section>
</div>
<section class="block"><div class="block-head"><h2>O que o agente tentou fazer</h2></div>${stepRows ? `<ol class="steps">${stepRows}</ol>` : emptyState('ai', 'Nenhuma ferramenta foi chamada', 'O agente respondeu sem executar ações.')}</section>`
  );
}

/* ------------------------------------------------------------------ configuração (somente leitura) */

export function configPage(ctx: ViewCtx) {
  const row = (ic: string, title: string, state: string, tone: string, text: string) => `<li class="setting">${icon(ic)}<div><div class="setting-head"><strong>${esc(title)}</strong><span class="status ${tone}"><i aria-hidden="true"></i>${esc(state)}</span></div><p>${text}</p></div></li>`;
  const p = ctx.price;
  return shell(
    'config',
    ctx,
    { title: 'Configuração', lead: 'O que está ligado no painel. Para mudar, edite as variáveis na Vercel e faça um novo deploy.' },
    `<section class="block"><ul class="settings">
${row('lock', 'Acesso ao painel', 'Ativo', 'authorized', 'Senha com 16 ou mais caracteres em <code>ADMIN_PASSWORD</code>. A sessão vale 30 dias neste navegador; o botão Sair encerra.')}
${row('coin', 'Preço do modelo', p ? 'Configurado' : 'Não configurado', p ? 'authorized' : 'pending', p ? `US$ ${esc(p.inputPerMTok)} por 1 milhão de tokens de entrada e US$ ${esc(p.outputPerMTok)} de saída (<code>OPENAI_PRICE_IN_PER_MTOK</code>, <code>OPENAI_PRICE_OUT_PER_MTOK</code>).` : 'Sem preço, o painel mostra tokens mas não custo. Defina <code>OPENAI_PRICE_IN_PER_MTOK</code> e <code>OPENAI_PRICE_OUT_PER_MTOK</code> em dólares por 1 milhão de tokens.')}
${row('pulse', 'Registro de consumo', 'Ativo', 'authorized', `Cada mensagem do WhatsApp grava tokens, modelo e status desde ${trackingLabel}/2026. O painel lê os últimos 30 dias.`)}
${row('message', 'Texto das conversas', 'Só em problemas', 'neutral', 'O texto da mensagem e da resposta só é guardado quando o agente erra, não entende ou recusa, para você depurar.')}
</ul></section>
<p class="foot">Lembretes proativos e outras configurações do agente ainda não têm controle por aqui.</p>`
  );
}
