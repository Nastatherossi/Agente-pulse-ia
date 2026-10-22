/*
 * ÁUDIO DO WHATSAPP
 * -----------------
 * O áudio vira texto ANTES de chegar ao agente, e o texto entra no mesmo fluxo de uma mensagem digitada.
 * Nada aqui chama rede: só regras (limites, mensagens ao usuário, custo). O provedor de transcrição fica atrás
 * de uma interface (`TranscriptionProvider`) e a implementação real mora em server/v2/transcription.ts.
 *
 * Por que lançamentos vindos de áudio sempre pedem confirmação: o transcritor pode ouvir "15" quando a
 * pessoa disse "50". A política (policy.ts) trata origem "audio" como um motivo a mais para confirmar.
 */

/** Limite de duração de um áudio. Acima disso o Pulse pede para mandar em partes (evita custo e erro). */
export const MAX_AUDIO_SECONDS = 120;
/** Limite de áudio do WhatsApp Cloud API. */
export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
/** Abaixo disso quase nunca há fala (toque acidental). */
export const MIN_AUDIO_BYTES = 1024;

const ACCEPTED = /^audio\/(ogg|mpeg|mp3|mp4|m4a|aac|amr|wav|webm)\b/i;

export type AudioInput = {
  bytes: Uint8Array;
  /** Ex.: "audio/ogg; codecs=opus" (formato das mensagens de voz do WhatsApp). */
  mimeType: string;
  /** Duração informada pelo canal, quando houver. */
  durationSeconds?: number;
};

export type AudioRejection = 'empty' | 'too_large' | 'too_long' | 'unsupported';

export type TranscriptionProvider = {
  readonly name: string;
  transcribe(
    audio: AudioInput,
    options: { language: string; prompt?: string; signal?: AbortSignal }
  ): Promise<{ text: string; model: string; durationSeconds?: number }>;
};

/** Vocabulário que ajuda o transcritor a acertar valores e nomes comuns de gasto. Não custa nada a mais. */
export const FINANCE_VOCABULARY_PROMPT =
  'Conversa informal sobre finanças pessoais em português do Brasil: reais, centavos, Pix, boleto, cartão, mercado, ' +
  'iFood, Uber, aluguel, salário, mil reais, cinquenta, quinze.';

export function validateAudio(audio: AudioInput): { ok: true } | { ok: false; reason: AudioRejection } {
  if (!audio.bytes || audio.bytes.byteLength < MIN_AUDIO_BYTES) return { ok: false, reason: 'empty' };
  if (!ACCEPTED.test(audio.mimeType || '')) return { ok: false, reason: 'unsupported' };
  if (audio.bytes.byteLength > MAX_AUDIO_BYTES) return { ok: false, reason: 'too_large' };
  if (audio.durationSeconds !== undefined && audio.durationSeconds > MAX_AUDIO_SECONDS)
    return { ok: false, reason: 'too_long' };
  return { ok: true };
}

/** Texto para o usuário quando o áudio não pôde ser usado (escrito pelo código, sem modelo). */
export function audioRejectionMessage(reason: AudioRejection | 'no_speech'): string {
  switch (reason) {
    case 'too_long':
      return 'Esse áudio ficou longo demais pra eu processar. Pode mandar em partes de até 2 minutos, ou escrever?';
    case 'too_large':
      return 'Esse áudio é grande demais. Pode mandar um mais curto ou escrever?';
    case 'unsupported':
      return 'Não consegui abrir esse tipo de áudio. Pode mandar de novo como mensagem de voz ou escrever?';
    case 'empty':
    case 'no_speech':
      return 'Não consegui ouvir nada nesse áudio. Pode tentar de novo ou escrever?';
  }
}

/**
 * Limpa a transcrição para virar a mensagem do usuário. Devolve `undefined` quando não sobrou fala útil
 * (silêncio, ruído, ou só as alucinações típicas de transcritores em áudio vazio).
 */
export function transcriptToMessage(text: string): string | undefined {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length < 2) return undefined;
  const lettersOnly = clean.toLowerCase().replace(/[^a-zà-ú0-9 ]/g, '').trim();
  if (!lettersOnly) return undefined;
  // Respostas que transcritores inventam em áudio sem fala.
  if (/^(legendas pela comunidade amara org|obrigad[oa] por assistir|inscreva-se no canal)\b/.test(lettersOnly))
    return undefined;
  return spokenNumbersToDigits(clean.slice(0, 1000));
}

/**
 * Preço por minuto (US$) conhecido na data desta implementação. CONFIRA na página de preços do provedor
 * antes de usar para cobrança; serve para estimar a margem e para o painel de consumo.
 */
export const TRANSCRIPTION_PRICE_PER_MINUTE_USD: Record<string, number> = {
  'gpt-4o-mini-transcribe': 0.003,
  'gpt-transcribe': 0.0045,
  'gpt-4o-transcribe': 0.006,
};

export function estimateTranscriptionCostUSD(durationSeconds: number, model: string): number | undefined {
  const perMinute = TRANSCRIPTION_PRICE_PER_MINUTE_USD[model];
  if (perMinute === undefined || !Number.isFinite(durationSeconds) || durationSeconds < 0) return undefined;
  return (durationSeconds / 60) * perMinute;
}

/*
 * Valores falados viram dígitos antes de o agente ler a mensagem: o transcritor escreve "três e cinquenta",
 * e a política só confere valores em dígitos. Áudio sempre pede confirmação, então um erro aqui aparece
 * para o usuário ("R$ 3,50?") antes de qualquer registro.
 */
const fold = (w: string) => w.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const UNITS: Record<string, number> = { zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, catorze: 14, quatorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19 };
const TENS: Record<string, number> = { vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90 };
const HUNDREDS: Record<string, number> = { cem: 100, cento: 100, duzentos: 200, duzentas: 200, trezentos: 300, trezentas: 300, quatrocentos: 400, quatrocentas: 400, quinhentos: 500, quinhentas: 500, seiscentos: 600, seiscentas: 600, setecentos: 700, setecentas: 700, oitocentos: 800, oitocentas: 800, novecentos: 900, novecentas: 900 };
const CURRENCY = new Set(['real', 'reais', 'conto', 'contos', 'pila', 'pilas', 'pau', 'paus']);

type Parsed = { value: number; next: number; big: boolean };

/** Número por extenso (< 1 milhão) começando em w[i]. */
function parseGroup(w: string[], i: number): { value: number; next: number } | undefined {
  let v = 0, j = i, found = false;
  if (w[j] in HUNDREDS) {
    v += HUNDREDS[w[j]]; j++; found = true;
    if (w[j] === 'e' && (w[j + 1] in TENS || w[j + 1] in UNITS)) j++;
  }
  if (w[j] in TENS) {
    v += TENS[w[j]]; j++; found = true;
    if (w[j] === 'e' && w[j + 1] in UNITS && UNITS[w[j + 1]] >= 1 && UNITS[w[j + 1]] <= 9) { v += UNITS[w[j + 1]]; j += 2; }
  } else if (w[j] in UNITS && !(found && UNITS[w[j]] === 0)) {
    v += UNITS[w[j]]; j++; found = true;
  }
  return found ? { value: v, next: j } : undefined;
}
function parseCardinal(w: string[], i: number): Parsed | undefined {
  const g = parseGroup(w, i);
  if (w[g?.next ?? i] === 'mil') {
    const base = g ? g.value : 1, j = (g?.next ?? i) + 1;
    let total = base * 1000, next = j;
    const rest = w[j] === 'e' ? parseGroup(w, j + 1) : parseGroup(w, j);
    if (rest) { total += rest.value; next = rest.next; }
    return { value: total, next, big: true };
  }
  return g ? { value: g.value, next: g.next, big: false } : undefined;
}
const brl2 = (reais: number, centavos?: number) => (centavos === undefined ? String(reais) : `${reais},${String(centavos).padStart(2, '0')}`);

export function spokenNumbersToDigits(text: string): string {
  const tokens = text.split(' ');
  const w = tokens.map(fold);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const n = parseCardinal(w, i);
    if (!n) { out.push(tokens[i]); i++; continue; }
    let next = n.next, cents: number | undefined, currency = false;
    if (CURRENCY.has(w[next])) { currency = true; next++; }
    // "três e cinquenta", "três reais e cinquenta (centavos)": a segunda parte são os centavos.
    if (w[next] === 'e') {
      const c = parseCardinal(w, next + 1);
      if (c && c.value >= 1 && c.value <= 99 && !c.big) {
        cents = c.value; next = c.next;
        if (w[next] === 'centavos' || w[next] === 'centavo') next++;
      }
    }
    // Só vira dígito o que parece valor: moeda, centavos, número grande. "uma água" e "duas vezes" ficam como estão.
    if (!(currency || cents !== undefined || n.value >= 10 || n.big)) { out.push(tokens[i]); i++; continue; }
    const tail = tokens[next - 1].match(/[.,;:!?]+$/)?.[0] ?? '';
    out.push(`${currency || cents !== undefined ? 'R$ ' : ''}${brl2(n.value, cents)}${tail}`);
    i = next;
  }
  return out.join(' ');
}
