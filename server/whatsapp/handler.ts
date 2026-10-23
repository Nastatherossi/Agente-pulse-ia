import { createHash, timingSafeEqual } from 'node:crypto';
import { processMessage, whatsappContext } from '../../shared/v2/channel.js';
import { brl, createSession, sessionSchema, todayBR, type Provider, type Session, type Trace } from '../../shared/v2/contracts.js';
import {
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  audioRejectionMessage,
  transcriptToMessage,
  validateAudio,
  FINANCE_VOCABULARY_PROMPT,
  type TranscriptionProvider,
} from '../../shared/v2/audio.js';
import { decideAccess, messages, normalizePhone, parseOwnerCommand, renderContactList, type OwnerCommand } from '../../shared/whatsapp/access.js';
import { OpenAIConversationProvider } from '../v2/openai.js';
import { OpenAITranscriptionProvider } from '../v2/transcription.js';
import { handleReminderReply } from './reminders.js';
import { parseInbound, ZApiClient, type Inbound, type Messenger } from './zapi.js';
import { SupabaseStore, type Store, type UsageRow } from './store.js';
import { SupabaseLedger, diffEntries, diffCards, type ApplyResult, type Ledger } from './ledger.js';
import { dm } from '../../shared/v2/cards.js';

export type Deps = {
  ownerPhone?: string;
  store: Store;
  /** Liga a conversa ao Financial Core (dashboard). Sem ele o agente roda só com a memória da sessão. */
  ledger?: Ledger;
  messenger: Messenger;
  provider: () => Provider;
  transcriber: () => TranscriptionProvider;
  now?: () => number;
  today?: () => string;
  log?: (event: Record<string, unknown>) => void;
};

const DAY = 365 * 24 * 60 * 60 * 1000;
const RATE_PER_MINUTE = 15;
const RATE_PER_HOUR = 200;

/** UUID v4 determinístico a partir do ID da mensagem: se a Z-API reenviar o webhook, o agente reconhece a repetição. */
export function requestIdFor(messageId: string): string {
  const b = createHash('sha256').update(`whatsapp:${messageId}`).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Buffer.from(b).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function freshSession(): Session {
  const s = createSession();
  // Sessão de WhatsApp começa zerada: sem o saldo fictício do laboratório.
  s.state.initialBalanceCents = 0;
  return s;
}

async function loadSession(deps: Deps, phone: string) {
  const stored = await deps.store.getSession(phone);
  if (!stored) return { session: freshSession(), version: null as number | null };
  const parsed = sessionSchema.safeParse(stored.session);
  if (!parsed.success) {
    deps.log?.({ event: 'whatsapp_session_invalid', phone });
    return { session: freshSession(), version: stored.version };
  }
  return { session: parsed.data, version: stored.version };
}

const userNameOf = (name?: string) => name?.trim().split(/\s+/)[0] || undefined;

async function runAgent(deps: Deps, phone: string, message: string, messageId: string, source: 'text' | 'audio', name?: string) {
  const now = deps.now?.() ?? Date.now();
  const ws = deps.ledger ? await deps.ledger.resolve(phone, name) : undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { session, version } = await loadSession(deps, phone);
    // O banco manda: lançamentos e saldo vêm do Financial Core, não do que a sessão guardou.
    const before = ws && deps.ledger ? await deps.ledger.load(ws) : undefined;
    if (before) {
      session.state.initialBalanceCents = before.initialBalanceCents;
      session.state.transactions = structuredClone(before.transactions);
      session.state.categories = before.customCategories;
      session.state.lastRecordId = before.lastRecordId;
      session.state.cards = before.cards?.map(c => ({ name: c.name, closingDay: c.closingDay, dueDay: c.dueDay })) ?? [];
    }
    session.state.cardPurchases = []; // compras no cartão valem só para a mensagem atual
    const out = await processMessage(deps.provider(), session, message, requestIdFor(messageId), deps.today?.() ?? todayBR(), whatsappContext(session), { source, realData: Boolean(ws), userName: name?.trim().split(/\s+/)[0] || undefined });
    out.session.expiresAt = now + DAY; // a sessão de WhatsApp não expira como a do laboratório
    // Grava no banco ANTES de responder e de salvar a sessão: se falhar, o usuário não recebe um "registrado" que não aconteceu.
    if (ws && deps.ledger && before && !out.trace.errorCode) {
      const after = out.session.state;
      const changes = diffEntries(before.transactions, after.transactions);
      changes.cardUpserts = diffCards(before.cards ?? [], after.cards ?? []);
      changes.cardPurchases = (after.cardPurchases ?? []).map(t => ({ id: t.id, amount: t.amount, description: t.description, date: t.date, category: t.category, installments: t.card?.installments ?? 1, cardName: t.card?.name }));
      const applied = (await deps.ledger.apply(ws, changes, `wa:${messageId}`)) as ApplyResult | undefined;
      if (applied?.placed) {
        const p = applied.placed;
        const who = userNameOf(name);
        const extra = `${p.count === 1 ? 'Já encaixei a compra' : `Já encaixei as ${p.count} compras`} (${brl(Math.round(p.total * 100))}) na fatura do ${p.cardName}${p.dueDates.length === 1 ? ` que vence ${dm(p.dueDates[0])}` : ''}. 💜`;
        out.trace.message = `${out.trace.message}\n\n${who ? `${who}, ` : ''}${who ? extra.charAt(0).toLowerCase() + extra.slice(1) : extra}`;
        const last = out.session.history.length - 1;
        if (last >= 0 && out.session.history[last].role === 'assistant') out.session.history[last] = { ...out.session.history[last], content: out.trace.message.slice(0, 1800) };
      }
    }
    out.session.state.cardPurchases = [];
    if (await deps.store.saveSession(phone, out.session, version)) return out;
