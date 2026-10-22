import { normalizePhone } from '../../shared/whatsapp/access.js';

export type Inbound =
  | { kind: 'ignore'; reason: string }
  | { kind: 'text'; messageId: string; phone: string; name?: string; text: string }
  | { kind: 'audio'; messageId: string; phone: string; name?: string; audioUrl: string; mimeType: string; seconds?: number }
  | { kind: 'unsupported'; messageId: string; phone: string; name?: string };

type Raw = Record<string, any>;

/**
 * Converte o corpo do webhook "mensagem recebida" da Z-API (ReceivedCallback) numa entrada simples.
 * Tudo que não for conversa privada de texto/áudio vindo de outra pessoa é ignorado.
 */
export function parseInbound(body: unknown, expectedInstanceId?: string): Inbound {
  const b = (body && typeof body === 'object' ? body : {}) as Raw;
  if (b.type !== 'ReceivedCallback') return { kind: 'ignore', reason: 'not_received_callback' };
  if (expectedInstanceId && String(b.instanceId ?? '') !== expectedInstanceId) return { kind: 'ignore', reason: 'wrong_instance' };
  if (b.fromMe === true) return { kind: 'ignore', reason: 'from_me' };
  if (b.isGroup === true || b.participantPhone || b.participantLid) return { kind: 'ignore', reason: 'group' };
  if (b.isNewsletter === true || b.broadcast === true || b.isStatusReply === true) return { kind: 'ignore', reason: 'not_direct' };
  if (b.isEdit === true || b.waitingMessage === true) return { kind: 'ignore', reason: 'edit_or_waiting' };
  const messageId = typeof b.messageId === 'string' ? b.messageId.slice(0, 120) : '';
  const phone = normalizePhone(typeof b.phone === 'string' ? b.phone : undefined);
  if (!messageId || !phone) return { kind: 'ignore', reason: 'missing_id_or_phone' };
  const name = typeof b.senderName === 'string' && b.senderName.trim() ? b.senderName.trim().slice(0, 80) : undefined;
  const text = typeof b.text?.message === 'string' ? b.text.message.trim() : '';
  if (text) return { kind: 'text', messageId, phone, name, text };
  const audio = b.audio;
  if (audio && typeof audio.audioUrl === 'string') {
    const seconds = Number(audio.seconds);
    return { kind: 'audio', messageId, phone, name, audioUrl: audio.audioUrl, mimeType: String(audio.mimeType || 'audio/ogg; codecs=opus'), seconds: Number.isFinite(seconds) ? seconds : undefined };
  }
  return { kind: 'unsupported', messageId, phone, name };
}

/** Só baixa mídia por HTTPS e de um host público (evita que um payload forjado aponte para a rede interna). */
export function isSafeMediaUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return false; // IP literal
    return h.includes('.');
  } catch {
    return false;
  }
}

export interface Messenger {
  sendText(phone: string, message: string): Promise<void>;
  downloadAudio(url: string, maxBytes: number): Promise<Uint8Array>;
}

export class ZApiClient implements Messenger {
  constructor(
    private readonly instanceId: string,
    private readonly token: string,
    private readonly clientToken: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    if (!instanceId || !token || !clientToken) throw new Error('ZAPI_NOT_CONFIGURED');
  }

  async sendText(phone: string, message: string) {
    const res = await this.fetchImpl(`https://api.z-api.io/instances/${encodeURIComponent(this.instanceId)}/token/${encodeURIComponent(this.token)}/send-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Client-Token': this.clientToken },
      // delayTyping: mostra "digitando…" por 2s, mais natural e mais seguro contra detecção de robô.
      body: JSON.stringify({ phone, message: message.slice(0, 3800), delayTyping: 2 }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`ZAPI_SEND_${res.status}`);
  }

  async downloadAudio(url: string, maxBytes: number) {
    if (!isSafeMediaUrl(url)) throw new Error('AUDIO_URL_NOT_ALLOWED');
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(20000), redirect: 'error' });
    if (!res.ok) throw new Error(`AUDIO_DOWNLOAD_${res.status}`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error('AUDIO_TOO_LARGE');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('AUDIO_TOO_LARGE');
    return bytes;
  }
}
