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
  return clean.slice(0, 1000);
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
