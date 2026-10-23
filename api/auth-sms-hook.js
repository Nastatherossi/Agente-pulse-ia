// server/whatsapp/smsHook.ts
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// shared/whatsapp/access.ts
function normalizePhone(input) {
  const digits = String(input ?? "").replace(/\D/g, "");
  if (!digits) return void 0;
  const full = digits.length === 10 || digits.length === 11 ? `55${digits}` : digits;
  return /^\d{12,15}$/.test(full) ? full : void 0;
}
var formatPhone = (phone) => {
  const m = phone.match(/^55(\d{2})(9?\d{4})(\d{4})$/);
  return m ? `+55 ${m[1]} ${m[2]}-${m[3]}` : `+${phone}`;
};
var messages = {
  ownerNewContact: (phone, name) => `\u{1F514} ${name ? `${name} (${formatPhone(phone)})` : formatPhone(phone)} tentou falar com o Pulse.

Responda *autorizar* para liberar (ou *autorizar ${phone}*) ou *bloquear* para negar.`,
  ownerAuthorized: (phone, name) => `\u2705 ${name ? `${name} \u2014 ` : ""}${formatPhone(phone)} liberado. Mandei as boas-vindas.`,
  ownerBlocked: (phone) => `\u{1F6AB} ${formatPhone(phone)} bloqueado. N\xE3o vou responder a esse n\xFAmero.`,
  ownerRemoved: (phone) => `\u{1F5D1}\uFE0F ${formatPhone(phone)} removido, junto com a conversa e os lan\xE7amentos de teste dele.`,
  ownerNoPending: "N\xE3o h\xE1 nenhum n\xFAmero esperando autoriza\xE7\xE3o. Para liberar um espec\xEDfico, mande *autorizar 5511999999999*.",
  ownerBadPhone: "N\xE3o entendi o n\xFAmero. Use o formato *autorizar 5511999999999* ou s\xF3 *autorizar* para liberar o \xFAltimo que pediu.",
  ownerEmptyList: "Ainda n\xE3o h\xE1 nenhum contato.",
  ownerHelp: "*Comandos do dono*\n\u2022 *autorizar* \u2014 libera o \xFAltimo n\xFAmero que pediu acesso\n\u2022 *autorizar 5511999999999 Nome* \u2014 libera um n\xFAmero\n\u2022 *bloquear* ou *bloquear 5511\u2026* \u2014 nega\n\u2022 *remover 5511\u2026* \u2014 apaga o contato e a conversa\n\u2022 *listar* \u2014 mostra todos os contatos",
  welcome: (name) => `Oi${name ? `, ${name.split(/\s+/)[0]}` : ""}! Voc\xEA foi liberado para testar o *Pulse*, um assistente de finan\xE7as pelo WhatsApp.

Conte um gasto (ex.: "gastei 32 no almo\xE7o"), pergunte seu saldo ou mande um \xE1udio. Antes de gravar algo, eu confirmo com voc\xEA.

\xC9 uma vers\xE3o de teste, ent\xE3o me avise se algo n\xE3o funcionar bem. \u{1F642}`,
  loginCode: (code) => `Seu c\xF3digo de acesso ao Pulse \xE9 *${code}*.

Digite na tela de login. Ele vale por poucos minutos e n\xE3o deve ser compartilhado. Se n\xE3o foi voc\xEA, \xE9 s\xF3 ignorar esta mensagem.`,
  loginNotAuthorized: "Esse n\xFAmero ainda n\xE3o foi liberado. Mande um oi para o Pulse no WhatsApp e aguarde a libera\xE7\xE3o.",
  technicalProblem: "Tive um problema t\xE9cnico agora e n\xE3o consegui responder. Pode mandar de novo em instantes?",
  unsupported: "Por enquanto eu entendo texto e \xE1udio. Pode me contar por um deles?"
};

// server/whatsapp/zapi.ts
function isSafeMediaUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) return false;
    return h.includes(".");
  } catch {
    return false;
  }
}
var ZApiClient = class {
  constructor(instanceId, token, clientToken, fetchImpl = fetch) {
    this.instanceId = instanceId;
    this.token = token;
    this.clientToken = clientToken;
    this.fetchImpl = fetchImpl;
    if (!instanceId || !token || !clientToken) throw new Error("ZAPI_NOT_CONFIGURED");
  }
  instanceId;
  token;
  clientToken;
  fetchImpl;
  async sendText(phone, message) {
    const res = await this.fetchImpl(`https://api.z-api.io/instances/${encodeURIComponent(this.instanceId)}/token/${encodeURIComponent(this.token)}/send-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Client-Token": this.clientToken },
      // delayTyping: mostra "digitando…" por 2s, mais natural e mais seguro contra detecção de robô.
      body: JSON.stringify({ phone, message: message.slice(0, 3800), delayTyping: 2 }),
      signal: AbortSignal.timeout(15e3)
    });
    if (!res.ok) throw new Error(`ZAPI_SEND_${res.status}`);
  }
  async downloadAudio(url, maxBytes) {
    if (!isSafeMediaUrl(url)) throw new Error("AUDIO_URL_NOT_ALLOWED");
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(2e4), redirect: "error" });
    if (!res.ok) throw new Error(`AUDIO_DOWNLOAD_${res.status}`);
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error("AUDIO_TOO_LARGE");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("AUDIO_TOO_LARGE");
    return bytes;
  }
};

// server/whatsapp/store.ts
var SupabaseStore = class {
  constructor(url, serviceKey, fetchImpl = fetch) {
    this.url = url;
    this.serviceKey = serviceKey;
    this.fetchImpl = fetchImpl;
    if (!url || !serviceKey) throw new Error("SUPABASE_NOT_CONFIGURED");
  }
  url;
  serviceKey;
  fetchImpl;
  async rest(path, init = {}) {
    const { prefer, ...rest } = init;
    const res = await this.fetchImpl(`${this.url.replace(/\/$/, "")}/rest/v1/${path}`, {
      ...rest,
      headers: {
        apikey: this.serviceKey,
        // Chave nova (sb_secret_…) vai só em apikey; a chave antiga (JWT service_role) também em Authorization.
        ...this.serviceKey.startsWith("eyJ") ? { Authorization: `Bearer ${this.serviceKey}` } : {},
        "Content-Type": "application/json",
        ...prefer ? { Prefer: prefer } : {}
      },
      signal: AbortSignal.timeout(1e4)
    });
    if (!res.ok) throw new Error(`SUPABASE_${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  }
  async getContact(phone) {
    const rows = await this.rest(`whatsapp_contacts?phone=eq.${encodeURIComponent(phone)}&select=*&limit=1`);
    return rows[0] ?? null;
  }
  async upsertContact(c) {
    const existing = await this.getContact(c.phone);
    if (existing) {
      const patch = {};
      if (c.name && !existing.name) patch.name = c.name;
      if (c.status && c.status !== existing.status) patch.status = c.status;
      if (c.status === "authorized") patch.authorized_at = (/* @__PURE__ */ new Date()).toISOString();
      if (Object.keys(patch).length) {
        const rows2 = await this.rest(`whatsapp_contacts?phone=eq.${encodeURIComponent(c.phone)}`, { method: "PATCH", body: JSON.stringify(patch), prefer: "return=representation" });
        return rows2[0] ?? existing;
      }
      return existing;
    }
    const row = { phone: c.phone, name: c.name ?? null, status: c.status ?? "pending", ...c.status === "authorized" ? { authorized_at: (/* @__PURE__ */ new Date()).toISOString() } : {} };
    const rows = await this.rest("whatsapp_contacts", { method: "POST", body: JSON.stringify(row), prefer: "resolution=ignore-duplicates,return=representation" });
    return rows[0] ?? await this.getContact(c.phone) ?? { phone: c.phone, status: row.status };
  }
  async setStatus(phone, status) {
    const patch = { status, ...status === "authorized" ? { authorized_at: (/* @__PURE__ */ new Date()).toISOString() } : {} };
    const rows = await this.rest(`whatsapp_contacts?phone=eq.${encodeURIComponent(phone)}`, { method: "PATCH", body: JSON.stringify(patch), prefer: "return=representation" });
    return rows[0] ?? null;
  }
  async markOwnerNotified(phone) {
    await this.rest(`whatsapp_contacts?phone=eq.${encodeURIComponent(phone)}`, { method: "PATCH", body: JSON.stringify({ owner_notified_at: (/* @__PURE__ */ new Date()).toISOString() }) });
  }
  listContacts() {
    return this.rest("whatsapp_contacts?select=*&order=first_seen_at.asc&limit=200");
  }
  async latestPending() {
    const rows = await this.rest("whatsapp_contacts?status=eq.pending&select=*&order=first_seen_at.desc&limit=1");
    return rows[0] ?? null;
  }
  async deleteContact(phone) {
    await this.rest(`whatsapp_contacts?phone=eq.${encodeURIComponent(phone)}`, { method: "DELETE" });
  }
  async claimMessage(messageId, phone, kind) {
    const rows = await this.rest("whatsapp_messages", { method: "POST", body: JSON.stringify({ message_id: messageId, phone, kind }), prefer: "resolution=ignore-duplicates,return=representation" });
    return rows.length > 0;
  }
  async recentMessageCount(phone, sinceMs) {
    const since = new Date(Date.now() - sinceMs).toISOString();
    const rows = await this.rest(`whatsapp_messages?phone=eq.${encodeURIComponent(phone)}&received_at=gte.${encodeURIComponent(since)}&select=message_id&limit=500`);
    return rows.length;
  }
  async recordUsage(r) {
    await this.rest("whatsapp_usage", { method: "POST", body: JSON.stringify({ message_id: r.messageId, phone: r.phone, source: r.source, model: r.model ?? null, model_calls: r.modelCalls, input_tokens: r.inputTokens, output_tokens: r.outputTokens, status: r.status, error_code: r.errorCode ?? null }), prefer: "resolution=ignore-duplicates,return=minimal" });
  }
  async getSession(phone) {
    const rows = await this.rest(`whatsapp_sessions?phone=eq.${encodeURIComponent(phone)}&select=session,version&limit=1`);
    return rows[0] ?? null;
  }
  async saveSession(phone, session, expectedVersion) {
    if (expectedVersion === null) {
      const rows2 = await this.rest("whatsapp_sessions", { method: "POST", body: JSON.stringify({ phone, session, version: 1 }), prefer: "resolution=ignore-duplicates,return=representation" });
      return rows2.length > 0;
    }
    const rows = await this.rest(`whatsapp_sessions?phone=eq.${encodeURIComponent(phone)}&version=eq.${expectedVersion}`, {
      method: "PATCH",
      body: JSON.stringify({ session, version: expectedVersion + 1, updated_at: (/* @__PURE__ */ new Date()).toISOString() }),
      prefer: "return=representation"
    });
    return rows.length > 0;
  }
};

// server/whatsapp/smsHook.ts
var same = (a, b) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
function signStandardWebhook(secret, id, timestamp, body) {
  const key = Buffer.from(secret.replace(/^v1,/, "").replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}
function verifyStandardWebhook(secret, headers, rawBody, nowMs = Date.now(), toleranceSeconds = 300) {
  const h = (k) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const id = h("webhook-id"), ts = h("webhook-timestamp"), sig = h("webhook-signature");
  if (!id || !ts || !sig) return false;
  if (!/^\d+$/.test(ts) || Math.abs(nowMs / 1e3 - Number(ts)) > toleranceSeconds) return false;
  const expected = signStandardWebhook(secret, id, ts, rawBody);
  return sig.split(" ").some((candidate) => candidate.length === expected.length && same(candidate, expected));
}
var failure = (status, message) => ({ status, body: { error: { http_code: status, message } } });
async function handleSmsHook(deps, payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const phone = normalizePhone(typeof p.user?.phone === "string" ? p.user.phone : void 0);
  const otp = typeof p.sms?.otp === "string" ? p.sms.otp : "";
  if (!phone || !/^\d{4,8}$/.test(otp)) return failure(400, "Pedido de c\xF3digo inv\xE1lido.");
  const isOwner = Boolean(deps.ownerPhone) && phone === deps.ownerPhone;
  if (!isOwner) {
    const contact = await deps.store.getContact(phone);
    if (contact?.status !== "authorized") {
      deps.log?.({ event: "login_code_refused", status: contact?.status ?? "unknown" });
      return failure(403, messages.loginNotAuthorized);
    }
  }
  try {
    await deps.messenger.sendText(phone, messages.loginCode(otp));
  } catch (e) {
    deps.log?.({ event: "login_code_send_failed", message: e instanceof Error ? e.message : "unknown" });
    return failure(502, "N\xE3o consegui enviar o c\xF3digo pelo WhatsApp agora. Tente de novo em instantes.");
  }
  return { status: 200, body: {} };
}
async function readRaw(req) {
  if (typeof req.rawBody === "string") return req.rawBody;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString("utf8");
  if (typeof req.body === "string") return req.body;
  return void 0;
}
function createSmsHook(config, deps) {
  return async function handler2(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
    }
    let key = "";
    try {
      key = new URL(req.url ?? "", "https://x.invalid").searchParams.get("k") ?? "";
    } catch {
    }
    if (!config.key || !same(key, config.key)) return res.status(401).json({ error: "UNAUTHORIZED" });
    if (config.signingSecret) {
      const raw = await readRaw(req) ?? (req.body && typeof req.body === "object" ? JSON.stringify(req.body) : "");
      if (!verifyStandardWebhook(config.signingSecret, req.headers ?? {}, raw)) return res.status(401).json({ error: "BAD_SIGNATURE" });
    }
    const out = await handleSmsHook(deps, req.body);
    return res.status(out.status).json(out.body);
  };
}
var log = (event) => console.warn(JSON.stringify({ ...event, at: (/* @__PURE__ */ new Date()).toISOString() }));
async function handler(req, res) {
  const e = process.env;
  const need = ["WHATSAPP_WEBHOOK_SECRET", "ZAPI_INSTANCE_ID", "ZAPI_TOKEN", "ZAPI_CLIENT_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OWNER_PHONE"];
  const missing = need.filter((k) => !e[k]?.trim());
  res.setHeader("Cache-Control", "no-store");
  if (missing.length) {
    log({ event: "login_hook_not_configured", missing });
    return res.status(503).json({ error: "NOT_CONFIGURED", missing });
  }
  if (e.WHATSAPP_WEBHOOK_SECRET.length < 24) return res.status(503).json({ error: "WEAK_SECRET" });
  const deps = {
    ownerPhone: normalizePhone(e.OWNER_PHONE),
    store: new SupabaseStore(e.SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY),
    messenger: new ZApiClient(e.ZAPI_INSTANCE_ID, e.ZAPI_TOKEN, e.ZAPI_CLIENT_TOKEN),
    log
  };
  return createSmsHook({ key: e.WHATSAPP_WEBHOOK_SECRET, signingSecret: e.SUPABASE_SMS_HOOK_SECRET?.trim() || void 0 }, deps)(req, res);
}
export {
  createSmsHook,
  handler as default,
  handleSmsHook,
  signStandardWebhook,
  verifyStandardWebhook
};
