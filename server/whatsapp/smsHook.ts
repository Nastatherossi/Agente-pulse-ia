import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { messages, normalizePhone } from '../../shared/whatsapp/access.js';
import { ZApiClient, type Messenger } from './zapi.js';
import { SupabaseStore, type Store } from './store.js';

/**
 * "Send SMS Hook" do Supabase Auth: em vez de mandar SMS, o Supabase chama este endereço com o código
 * (user.phone, sms.otp) e o Pulse entrega o código pelo WhatsApp. O login do dashboard continua igual.
 *
 * Só recebe código quem já falou com o Pulse e foi autorizado pelo dono (ou o próprio dono): mandar
 * mensagem para quem nunca falou com o número é o que mais leva a bloqueio, e evita que alguém peça
 * código para o telefone de um desconhecido.
 */
export type SmsHookDeps = { ownerPhone?: string; store: Store; messenger: Messenger; log?: (event: Record<string, unknown>) => void };

const same = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

/** Assinatura "standard webhooks" que o Supabase usa nos hooks (secret no formato "v1,whsec_<base64>"). */
export function signStandardWebhook(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.replace(/^v1,/, '').replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

export function verifyStandardWebhook(secret: string, headers: Record<string, string | string[] | undefined>, rawBody: string, nowMs = Date.now(), toleranceSeconds = 300): boolean {
  const h = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const id = h('webhook-id'), ts = h('webhook-timestamp'), sig = h('webhook-signature');
  if (!id || !ts || !sig) return false;
  if (!/^\d+$/.test(ts) || Math.abs(nowMs / 1000 - Number(ts)) > toleranceSeconds) return false;
  const expected = signStandardWebhook(secret, id, ts, rawBody);
  return sig.split(' ').some(candidate => candidate.length === expected.length && same(candidate, expected));
}

export type SmsHookResult = { status: number; body: unknown };
const failure = (status: number, message: string): SmsHookResult => ({ status, body: { error: { http_code: status, message } } });

export async function handleSmsHook(deps: SmsHookDeps, payload: unknown): Promise<SmsHookResult> {
  const p = (payload && typeof payload === 'object' ? payload : {}) as { user?: { phone?: unknown }; sms?: { otp?: unknown } };
  const phone = normalizePhone(typeof p.user?.phone === 'string' ? p.user.phone : undefined);
  const otp = typeof p.sms?.otp === 'string' ? p.sms.otp : '';
  if (!phone || !/^\d{4,8}$/.test(otp)) return failure(400, 'Pedido de código inválido.');
  const isOwner = Boolean(deps.ownerPhone) && phone === deps.ownerPhone;
  if (!isOwner) {
    const contact = await deps.store.getContact(phone);
    if (contact?.status !== 'authorized') {
      deps.log?.({ event: 'login_code_refused', status: contact?.status ?? 'unknown' });
      return failure(403, messages.loginNotAuthorized);
    }
  }
  try {
    await deps.messenger.sendText(phone, messages.loginCode(otp));
  } catch (e) {
    deps.log?.({ event: 'login_code_send_failed', message: e instanceof Error ? e.message : 'unknown' });
    return failure(502, 'Não consegui enviar o código pelo WhatsApp agora. Tente de novo em instantes.');
  }
  return { status: 200, body: {} };
}

type Req = { method?: string; url?: string; body?: unknown; headers?: Record<string, string | string[] | undefined>; rawBody?: string | Buffer };
type Res = { status: (n: number) => Res; json: (x: unknown) => void; setHeader: (k: string, v: string) => void };

async function readRaw(req: Req): Promise<string | undefined> {
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');
  if (typeof req.body === 'string') return req.body;
  return undefined;
}

export function createSmsHook(config: { key: string; signingSecret?: string }, deps: SmsHookDeps) {
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
      /* url inválida */
    }
    if (!config.key || !same(key, config.key)) return res.status(401).json({ error: 'UNAUTHORIZED' });
    if (config.signingSecret) {
      const raw = (await readRaw(req)) ?? (req.body && typeof req.body === 'object' ? JSON.stringify(req.body) : '');
      if (!verifyStandardWebhook(config.signingSecret, req.headers ?? {}, raw)) return res.status(401).json({ error: 'BAD_SIGNATURE' });
    }
    const out = await handleSmsHook(deps, req.body);
    return res.status(out.status).json(out.body);
  };
}

const log = (event: Record<string, unknown>) => console.warn(JSON.stringify({ ...event, at: new Date().toISOString() }));

/** Entrada do Vercel. Não precisa da OpenAI, só do Z-API e do Supabase. */
export default async function handler(req: Req, res: Res) {
  const e = process.env;
  const need = ['WHATSAPP_WEBHOOK_SECRET', 'ZAPI_INSTANCE_ID', 'ZAPI_TOKEN', 'ZAPI_CLIENT_TOKEN', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OWNER_PHONE'];
  const missing = need.filter(k => !e[k]?.trim());
  res.setHeader('Cache-Control', 'no-store');
  if (missing.length) {
    log({ event: 'login_hook_not_configured', missing });
    return res.status(503).json({ error: 'NOT_CONFIGURED', missing });
  }
  if ((e.WHATSAPP_WEBHOOK_SECRET as string).length < 24) return res.status(503).json({ error: 'WEAK_SECRET' });
  const deps: SmsHookDeps = {
    ownerPhone: normalizePhone(e.OWNER_PHONE),
    store: new SupabaseStore(e.SUPABASE_URL as string, e.SUPABASE_SERVICE_ROLE_KEY as string),
    messenger: new ZApiClient(e.ZAPI_INSTANCE_ID as string, e.ZAPI_TOKEN as string, e.ZAPI_CLIENT_TOKEN as string),
    log,
  };
  return createSmsHook({ key: e.WHATSAPP_WEBHOOK_SECRET as string, signingSecret: e.SUPABASE_SMS_HOOK_SECRET?.trim() || undefined }, deps)(req, res);
}
