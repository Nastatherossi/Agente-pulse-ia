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
      session.state.invoices = before.invoices ?? [];
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
    // Outra mensagem do mesmo número gravou primeiro: relê e refaz.
  }
  throw new Error('SESSION_CONFLICT');
}

const clip = (t: string | undefined, n: number) => (t && t.length > n ? `${t.slice(0, n)}…` : t);

/** Turno com problema: erro, agente não entendeu, ou ferramenta recusada. Só nesses casos o texto fica guardado. */
export function isProblemTurn(t: Trace): boolean {
  return Boolean(t.errorCode) || (t.status !== 'success' && t.confirmation !== 'pending') || t.steps.some(st => st.status !== 'success');
}

/** Melhor esforço: falha ao registrar consumo nunca atrapalha a resposta ao usuário. */
async function recordTurn(deps: Deps, info: { phone: string; messageId: string; source: 'text' | 'audio'; userText?: string; replyText: string; trace?: Trace; errorCode?: string; durationMs?: number }) {
  const t = info.trace;
  const problem = t ? isProblemTurn(t) : true;
  const row: UsageRow = {
    phone: info.phone,
    messageId: info.messageId,
    source: info.source,
    model: t?.model,
    modelCalls: t?.modelCalls ?? 0,
    inputTokens: t?.usage?.inputTokens ?? 0,
    outputTokens: t?.usage?.outputTokens ?? 0,
    status: t ? (t.errorCode ? 'error' : t.status) : 'error',
    errorCode: t?.errorCode ?? info.errorCode,
    ...(problem
      ? {
          userText: clip(info.userText, 2000),
          replyText: clip(info.replyText, 2000),
          intent: t?.intent,
          durationMs: t?.durationMs ?? info.durationMs,
          confirmation: t?.confirmation,
          steps: t?.steps.map(st => ({ name: st.name, status: st.status, durationMs: st.durationMs, arguments: st.arguments, error: st.error })),
        }
      : {}),
  };
  await deps.store.recordUsage(row).catch(() => undefined);
}

export async function execOwnerCommand(deps: Deps, cmd: OwnerCommand): Promise<string> {
  if (cmd.kind === 'help') return messages.ownerHelp;
  if (cmd.kind === 'invalid') return messages.ownerBadPhone;
  if (cmd.kind === 'list') return renderContactList(await deps.store.listContacts());
  if (cmd.kind === 'remove') {
    await deps.store.deleteContact(cmd.phone);
    return messages.ownerRemoved(cmd.phone);
  }
  const phone = cmd.phone ?? (await deps.store.latestPending())?.phone;
  if (!phone) return messages.ownerNoPending;
  if (cmd.kind === 'block') {
    await deps.store.upsertContact({ phone });
    await deps.store.setStatus(phone, 'blocked');
    return messages.ownerBlocked(phone);
  }
  const contact = await deps.store.upsertContact({ phone, name: cmd.name, status: 'authorized' });
  // Já cria a conta (usuário + workspace) do número: é ela que o login do dashboard por código do WhatsApp usa.
  try {
    await deps.ledger?.resolve(phone, contact.name ?? undefined);
  } catch (e) {
    deps.log?.({ event: 'whatsapp_provision_failed', message: e instanceof Error ? e.message : 'unknown' });
  }
  await deps.messenger.sendText(phone, messages.welcome(contact.name));
  return messages.ownerAuthorized(phone, contact.name);
}

async function transcribe(deps: Deps, input: Extract<Inbound, { kind: 'audio' }>): Promise<{ ok: true; text: string } | { ok: false; reply: string }> {
  if (input.seconds && input.seconds > MAX_AUDIO_SECONDS) return { ok: false, reply: audioRejectionMessage('too_long') };
  const bytes = await deps.messenger.downloadAudio(input.audioUrl, MAX_AUDIO_BYTES);
  const audio = { bytes, mimeType: input.mimeType, durationSeconds: input.seconds };
  const check = validateAudio(audio);
  if (!check.ok) return { ok: false, reply: audioRejectionMessage(check.reason) };
  const result = await deps.transcriber().transcribe(audio, { language: 'pt', prompt: FINANCE_VOCABULARY_PROMPT, signal: AbortSignal.timeout(30000) });
  const text = transcriptToMessage(result.text);
  return text ? { ok: true, text } : { ok: false, reply: audioRejectionMessage('no_speech') };
}

/** Processa uma mensagem já validada. Separado do HTTP para poder ser testado sem rede. */
export async function handleInbound(deps: Deps, input: Inbound): Promise<void> {
  if (input.kind === 'ignore') return;
  const { phone, messageId } = input;
  const isOwner = Boolean(deps.ownerPhone) && phone === deps.ownerPhone;
  const kind = input.kind === 'text' ? 'text' : input.kind === 'audio' ? 'audio' : 'other';

  // 1. Mensagem repetida (a Z-API pode reenviar o mesmo webhook): não processa de novo.
  if (!(await deps.store.claimMessage(messageId, phone, kind))) return;

  // 2. Comandos do dono.
  if (isOwner && input.kind === 'text') {
    const cmd = parseOwnerCommand(input.text);
    if (cmd) {
      await deps.messenger.sendText(phone, await execOwnerCommand(deps, cmd));
      return;
    }
  }

  // 3. Quem pode falar com o agente.
  let contact = await deps.store.getContact(phone);
  const decision = decideAccess(contact, isOwner);
  if (decision === 'ignore') return;
  if (decision === 'pending') {
    contact = contact ?? (await deps.store.upsertContact({ phone, name: input.name, status: 'pending' }));
    // Estranho não recebe resposta. O dono é avisado uma única vez por número.
    if (!contact.owner_notified_at) {
      if (!deps.ownerPhone) {
        deps.log?.({ event: 'whatsapp_owner_not_configured' });
        return;
      }
      await deps.messenger.sendText(deps.ownerPhone, messages.ownerNewContact(phone, contact.name ?? input.name));
      await deps.store.markOwnerNotified(phone);
    }
    return;
  }
  if (isOwner) contact = await deps.store.upsertContact({ phone, name: input.name, status: 'authorized' });

  // 4. Freio de custo: ritmo anormal de mensagens de um mesmo número.
  if (!isOwner) {
    const [lastMinute, lastHour] = await Promise.all([deps.store.recentMessageCount(phone, 60_000), deps.store.recentMessageCount(phone, 3_600_000)]);
    if (lastMinute > RATE_PER_MINUTE || lastHour > RATE_PER_HOUR) {
      deps.log?.({ event: 'whatsapp_rate_limited', phone });
      return;
    }
  }

  if (input.kind === 'unsupported') {
    await deps.messenger.sendText(phone, messages.unsupported);
    return;
  }

  // 5. Agente.
  let userText: string | undefined;
  try {
    let text: string;
    let heard: string | undefined;
    if (input.kind === 'audio') {
      const t = await transcribe(deps, input);
      if (!t.ok) {
        await deps.messenger.sendText(phone, t.reply);
        return;
      }
      text = t.text;
      heard = t.text;
    } else text = input.text.slice(0, 2000);

    // Resposta a um lembrete do Pulse ("caiu sim", "ainda não") ou pedido para parar os lembretes.
    if (deps.ledger) {
      const reminderReply = await handleReminderReply({ store: deps.store, ledger: deps.ledger, messenger: deps.messenger, today: deps.today, now: deps.now, log: deps.log }, phone, contact?.name || input.name, text).catch(() => undefined);
      if (reminderReply) {
        await deps.messenger.sendText(phone, reminderReply);
        return;
      }
    }
    const source = input.kind === 'audio' ? 'audio' : 'text';
    userText = text;
    const out = await runAgent(deps, phone, text, messageId, source, contact?.name || input.name);
    if (out.trace.errorCode) {
      deps.log?.({ event: 'whatsapp_agent_error', code: out.trace.errorCode });
      await recordTurn(deps, { phone, messageId, source, userText: text, replyText: messages.technicalProblem, trace: out.trace });
      await deps.messenger.sendText(phone, messages.technicalProblem);
      return;
    }
    // Não repete o áudio inteiro ao usuário. A transcrição só aparece quando o agente não conseguiu agir sobre ela.
    const understood = out.trace.status === 'success' || out.trace.confirmation === 'pending';
    const heardLine = heard && !understood ? `🎤 "${heard.length > 200 ? `${heard.slice(0, 200)}…` : heard}"\n\n` : '';
    await recordTurn(deps, { phone, messageId, source, userText: text, replyText: out.trace.message, trace: out.trace });
    await deps.messenger.sendText(phone, `${heardLine}${out.trace.message}`);
  } catch (e) {
    deps.log?.({ event: 'whatsapp_error', message: e instanceof Error ? e.message : 'unknown' });
    await recordTurn(deps, { phone, messageId, source: input.kind === 'audio' ? 'audio' : 'text', userText, replyText: messages.technicalProblem, errorCode: e instanceof Error ? e.message.slice(0, 80) : 'UNKNOWN' });
    try {
      await deps.messenger.sendText(phone, messages.technicalProblem);
    } catch {
      /* sem mais o que fazer */
    }
  }
}

type Req = { method?: string; url?: string; body?: unknown };
type Res = { status: (n: number) => Res; json: (x: unknown) => void; setHeader: (k: string, v: string) => void };

const same = (a: string, b: string) => {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
};

export function createHandler(config: { secret: string; instanceId?: string }, deps: Deps) {
  return async function handler(req: Req, res: Res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    }
    let key = '';
    try {
      key = new URL(req.url ?? '', 'https://x.invalid').searchParams.get('k') ?? '';
    } catch {
      /* url inválida: key vazia */
    }
    if (!config.secret || !same(key, config.secret)) return res.status(401).json({ error: 'UNAUTHORIZED' });
    const input = parseInbound(req.body, config.instanceId);
    try {
      await handleInbound(deps, input);
    } catch (e) {
      deps.log?.({ event: 'whatsapp_handler_error', message: e instanceof Error ? e.message : 'unknown' });
    }
    // Sempre 200 para mensagem válida: erro nosso não deve virar reenvio infinito pela Z-API.
    return res.status(200).json({ ok: true });
  };
}

const log = (event: Record<string, unknown>) => console.warn(JSON.stringify({ ...event, at: new Date().toISOString() }));

/** Entrada do Vercel: monta as dependências a partir das variáveis de ambiente. */
export default async function handler(req: Req, res: Res) {
  const e = process.env;
  const need = ['WHATSAPP_WEBHOOK_SECRET', 'ZAPI_INSTANCE_ID', 'ZAPI_TOKEN', 'ZAPI_CLIENT_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OWNER_PHONE'];
  const missing = need.filter(k => !e[k]?.trim());
  res.setHeader('Cache-Control', 'no-store');
  if (e.ENABLE_REAL_AI !== 'true') return res.status(403).json({ error: 'REAL_AI_LOCKED' });
  if (missing.length) {
    log({ event: 'whatsapp_not_configured', missing });
    return res.status(503).json({ error: 'NOT_CONFIGURED', missing });
  }
  if ((e.WHATSAPP_WEBHOOK_SECRET as string).length < 24) return res.status(503).json({ error: 'WEAK_SECRET' });
  const ownerPhone = normalizePhone(e.OWNER_PHONE);
  if (!ownerPhone) return res.status(503).json({ error: 'BAD_OWNER_PHONE' });
  const key = e.OPENAI_API_KEY as string;
  const deps: Deps = {
    ownerPhone,
    store: new SupabaseStore(e.SUPABASE_URL as string, e.SUPABASE_SERVICE_ROLE_KEY as string),
    ledger: new SupabaseLedger(e.SUPABASE_URL as string, e.SUPABASE_SERVICE_ROLE_KEY as string),
    messenger: new ZApiClient(e.ZAPI_INSTANCE_ID as string, e.ZAPI_TOKEN as string, e.ZAPI_CLIENT_TOKEN as string),
    provider: () => new OpenAIConversationProvider(key, e.OPENAI_MODEL as string),
    transcriber: () => new OpenAITranscriptionProvider(key, e.OPENAI_TRANSCRIBE_MODEL?.trim() || undefined),
    log,
  };
  return createHandler({ secret: e.WHATSAPP_WEBHOOK_SECRET as string, instanceId: e.ZAPI_INSTANCE_ID }, deps)(req, res);
}
