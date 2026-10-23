/* Formatação e textos do painel de gestão. Puro: sem banco, sem rede. */

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const TZ = 'America/Sao_Paulo';
/** Primeiro dia com consumo registrado (whatsapp_usage). Dias anteriores são "sem registro", não zero. */
export const TRACKING_SINCE = '2026-10-22';
export const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }) : '—');
export const fmtFull = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: TZ, dateStyle: 'full', timeStyle: 'medium' }) : '—');
export const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
export const fmtInt = (n: number) => n.toLocaleString('pt-BR');
export const fmtUsd = (n?: number) => (n === undefined ? '—' : `US$ ${n.toFixed(n < 1 ? 3 : 2)}`);
/** Números grandes em forma curta: 12,4 mil · 1,2 mi. */
export const fmtShort = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi` : n >= 10_000 ? `${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : fmtInt(n);

export const fmtPhone = (p: string) => (/^55\d{2}9\d{8}$/.test(p) ? `+55 (${p.slice(2, 4)}) ${p.slice(4, 9)}-${p.slice(9)}` : `+${p}`);
/** Telefone com o meio escondido, para listas em que o número inteiro não é necessário. */
export const maskPhone = (p: string) => (/^55\d{2}9\d{8}$/.test(p) ? `+55 (${p.slice(2, 4)}) •••••-${p.slice(9)}` : `+•••${p.slice(-4)}`);

/** "há 5 min", "há 3 h", "ontem", "há 4 dias"; acima de uma semana, a data. */
export function relTime(iso: string | null | undefined, nowMs: number) {
  if (!iso) return '—';
  const diff = Math.max(0, nowMs - Date.parse(iso));
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  if (d === 1) return 'ontem';
  if (d < 7) return `há ${d} dias`;
  return new Date(iso).toLocaleDateString('pt-BR', { timeZone: TZ, day: '2-digit', month: 'short' });
}

/** Rótulo de dia para eixos e agrupamentos: "23 out". */
export const dayLabel = (key: string) => new Date(`${key}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC', day: 'numeric', month: 'short' }).replace('.', '');
export const weekday = (key: string) => new Date(`${key}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC', weekday: 'short' }).replace('.', '');

export const STATUS: Record<string, string> = { authorized: 'Autorizado', pending: 'Pendente', blocked: 'Bloqueado' };

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

/** Tipo de problema: rótulo, tom (bad/warn) e chave estável para filtros. */
const KIND: Record<string, [string, string, string]> = {
  error: ['Erro', 'bad', 'erro'],
  clarification: ['Não entendeu', 'warn', 'duvida'],
  blocked: ['Recusado', 'warn', 'recusado'],
};
export function problemKind(t: { status: string; error_code: string | null; steps?: unknown }): [string, string, string] {
  if (t.status === 'error' || t.error_code) return KIND.error;
  if (Array.isArray(t.steps) && t.steps.some((x: any) => x?.status === 'blocked')) return KIND.blocked;
  return KIND[t.status] ?? ['Atenção', 'warn', 'outro'];
}
export function turnKind(t: { status: string; error_code: string | null; steps?: unknown }): [string, string] {
  const [label, tone] = problemKind(t);
  return [label, tone];
}
