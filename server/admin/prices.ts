/* Preço da OpenAI por modelo, em US$ por 1 milhão de tokens. Puro: sem banco, sem rede. */

export type Price = { inputPerMTok: number; outputPerMTok: number };
/** `default` vale para qualquer modelo sem preço próprio. */
export type PriceTable = { default?: Price; models: Record<string, Price> };
/** Formato guardado em admin_settings (key = openai_prices). */
export type StoredPrices = { default?: { in: number; out: number }; models?: Record<string, { in: number; out: number }> };

export const PRICES_KEY = 'openai_prices';
export const MAX_PRICE = 10_000;

/** Aceita "1.6", "1,6", " 0,40 ". Devolve undefined se não for um número válido entre 0 e MAX_PRICE. */
export function parsePrice(raw: unknown): number | undefined {
  const s = String(raw ?? '').trim().replace(/\s/g, '').replace(/^US\$/i, '').replace(/^\$/, '');
  if (!s || !/^\d+([.,]\d+)?$/.test(s)) return undefined;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 && n <= MAX_PRICE ? n : undefined;
}

/** Aceita o formato antigo (um preço só) ou a tabela. */
export function toTable(p?: Price | PriceTable | null): PriceTable | undefined {
  if (!p) return undefined;
  if ('inputPerMTok' in p) return { default: p, models: {} };
  return { default: p.default, models: { ...(p.models ?? {}) } };
}

export function fromStored(v: unknown): PriceTable | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const s = v as StoredPrices;
  const conv = (x?: { in: unknown; out: unknown }): Price | undefined => {
    const i = parsePrice(x?.in), o = parsePrice(x?.out);
    return i !== undefined && o !== undefined ? { inputPerMTok: i, outputPerMTok: o } : undefined;
  };
  const models: Record<string, Price> = {};
  for (const [m, x] of Object.entries(s.models ?? {})) {
    const p = conv(x);
    if (p && m.length <= 100) models[m] = p;
  }
  return { default: conv(s.default), models };
}

export function toStored(t: PriceTable): StoredPrices {
  const c = (p: Price) => ({ in: p.inputPerMTok, out: p.outputPerMTok });
  return { ...(t.default ? { default: c(t.default) } : {}), models: Object.fromEntries(Object.entries(t.models).map(([m, p]) => [m, c(p)])) };
}

/** Preços do painel valem por cima dos da Vercel. */
export function mergePrices(base?: PriceTable, over?: PriceTable): PriceTable | undefined {
  if (!base && !over) return undefined;
  return { default: over?.default ?? base?.default, models: { ...(base?.models ?? {}), ...(over?.models ?? {}) } };
}

export const isEmpty = (t?: PriceTable) => !t || (!t.default && Object.keys(t.models).length === 0);

export function priceFor(t: PriceTable | undefined, model: string | null | undefined): Price | undefined {
  if (!t) return undefined;
  return (model ? t.models[model] : undefined) ?? t.default;
}

/** Variáveis da Vercel (aceitando vírgula). */
export function envPrice(env: Record<string, string | undefined>): Price | undefined {
  const i = parsePrice(env.OPENAI_PRICE_IN_PER_MTOK), o = parsePrice(env.OPENAI_PRICE_OUT_PER_MTOK);
  return i !== undefined && o !== undefined ? { inputPerMTok: i, outputPerMTok: o } : undefined;
}

/** Lê o formulário do painel: default_in/default_out e linhas model_N/in_N/out_N. Linha vazia = sem preço próprio. */
export function pricesFromForm(form: Record<string, string>): { table: PriceTable } | { error: string } {
  const pair = (label: string, a?: string, b?: string): Price | null | { error: string } => {
    const blankA = !String(a ?? '').trim(), blankB = !String(b ?? '').trim();
    if (blankA && blankB) return null;
    const i = parsePrice(a), o = parsePrice(b);
    if (i === undefined || o === undefined) return { error: `Preço inválido em ${label}: preencha entrada e saída com números, como 0,40 e 1,60.` };
    return { inputPerMTok: i, outputPerMTok: o };
  };
  const d = pair('Padrão', form.default_in, form.default_out);
  if (d && 'error' in d) return d;
  const models: Record<string, Price> = {};
  for (let n = 0; n < 50; n++) {
    const m = (form[`model_${n}`] ?? '').trim();
    if (!m) continue;
    if (m.length > 100) return { error: 'Nome de modelo grande demais.' };
    const p = pair(m, form[`in_${n}`], form[`out_${n}`]);
    if (p && 'error' in p) return p;
    if (p) models[m] = p;
  }
  return { table: { default: d ?? undefined, models } };
}
