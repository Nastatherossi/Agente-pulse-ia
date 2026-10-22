import {
  FINANCE_VOCABULARY_PROMPT,
  type AudioInput,
  type TranscriptionProvider,
} from '../../shared/v2/audio.js';

/**
 * Transcrição pela API da OpenAI (mesma chave do agente). `fetchImpl` é injetável: os testes usam um
 * falso e nunca chamam a rede nem geram custo.
 */
export class OpenAITranscriptionProvider implements TranscriptionProvider {
  readonly name = 'openai';
  constructor(
    private readonly apiKey: string,
    private readonly model = 'gpt-4o-mini-transcribe',
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = 'https://api.openai.com/v1'
  ) {
    if (!apiKey) throw new Error('OPENAI_API_KEY ausente para transcrição.');
  }

  async transcribe(
    audio: AudioInput,
    options: { language: string; prompt?: string; signal?: AbortSignal }
  ) {
    const form = new FormData();
    const extension = /ogg/i.test(audio.mimeType) ? 'ogg' : /mp4|m4a|aac/i.test(audio.mimeType) ? 'm4a' : /mpeg|mp3/i.test(audio.mimeType) ? 'mp3' : 'audio';
    // Copia para um ArrayBuffer próprio: Blob não aceita views sobre buffers compartilhados em todas as versões.
    const bytes = audio.bytes.slice().buffer as ArrayBuffer;
    form.append('file', new Blob([bytes], { type: audio.mimeType.split(';')[0] }), `audio.${extension}`);
    form.append('model', this.model);
    form.append('language', options.language);
    form.append('response_format', 'json');
    form.append('prompt', options.prompt ?? FINANCE_VOCABULARY_PROMPT);

    const response = await this.fetchImpl(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: options.signal,
    });
    if (!response.ok) throw new Error(`TRANSCRIPTION_HTTP_${response.status}`);
    const data = (await response.json()) as { text?: string };
    return { text: String(data.text ?? ''), model: this.model, durationSeconds: audio.durationSeconds };
  }
}
