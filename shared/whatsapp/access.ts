/**
 * Controle de acesso do canal WhatsApp: lógica pura (sem rede, sem banco).
 *
 * Regras:
 *  - só números AUTORIZADOS falam com o agente;
 *  - número desconhecido não recebe resposta (responder a estranhos aumenta o risco de banimento);
 *    o dono é avisado e decide;
 *  - só o número do dono (OWNER_PHONE) executa comandos.
 */

export type ContactStatus = 'pending' | 'authorized' | 'blocked';

export type Contact = {
  phone: string;
  name?: string | null;
  status: ContactStatus;
  owner_notified_at?: string | null;
};

/** Só dígitos. Número brasileiro sem DDI (10 ou 11 dígitos) ganha o 55. Retorna undefined se não parecer um telefone. */
export function normalizePhone(input: string | undefined | null): string | undefined {
  const digits = String(input ?? '').replace(/\D/g, '');
  if (!digits) return undefined;
  const full = digits.length === 10 || digits.length === 11 ? `55${digits}` : digits;
  return /^\d{12,15}$/.test(full) ? full : undefined;
}

export type OwnerCommand =
  | { kind: 'authorize'; phone?: string; name?: string }
  | { kind: 'block'; phone?: string }
  | { kind: 'remove'; phone: string }
  | { kind: 'list' }
  | { kind: 'help' }
  | { kind: 'invalid'; reason: 'bad_phone' };

const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * Interpreta uma mensagem do dono. Retorna undefined quando NÃO é um comando
 * (aí a mensagem segue para o agente como conversa normal).
 */
export function parseOwnerCommand(text: string): OwnerCommand | undefined {
  const clean = text.trim().replace(/^[*_~`]+|[*_~`]+$/g, '');
  const [head = '', ...rest] = clean.split(/\s+/);
  const word = strip(head.replace(/[*_~`]/g, ''));
  const tail = rest.join(' ').trim();
  const phoneMatch = tail.match(/^(\+?[\d\s().-]{8,})(?:\s+(.*))?$/);

  const withPhone = () => {
    if (!tail) return { phone: undefined, name: undefined };
    if (!phoneMatch) return null;
    // O telefone pode ter espaços ("11 99999-0000"); o nome começa na primeira palavra com letras.
    const m = tail.match(/^([\d\s+().-]+?)(?:\s+([^\d\s+().-].*))?$/);
    const phone = normalizePhone(m?.[1]);
    return phone ? { phone, name: m?.[2]?.trim() || undefined } : null;
  };

  switch (word) {
    case 'autorizar':
    case 'liberar':
    case 'aprovar': {
      const r = withPhone();
      return r ? { kind: 'authorize', phone: r.phone, name: r.name } : { kind: 'invalid', reason: 'bad_phone' };
    }
    case 'bloquear':
    case 'negar':
    case 'recusar': {
      const r = withPhone();
      return r ? { kind: 'block', phone: r.phone } : { kind: 'invalid', reason: 'bad_phone' };
    }
    case 'remover': {
      const r = withPhone();
      return r?.phone ? { kind: 'remove', phone: r.phone } : { kind: 'invalid', reason: 'bad_phone' };
    }
    case 'listar':
    case 'lista':
      return tail ? undefined : { kind: 'list' };
    case 'ajuda':
    case 'comandos':
      return tail ? undefined : { kind: 'help' };
    default:
      return undefined;
  }
}

export type AccessDecision = 'agent' | 'ignore' | 'pending';

/** O dono sempre passa. Fora isso, só 'authorized' chega ao agente. */
export function decideAccess(contact: Contact | null | undefined, isOwner: boolean): AccessDecision {
  if (isOwner) return 'agent';
  if (!contact) return 'pending';
  if (contact.status === 'authorized') return 'agent';
  if (contact.status === 'blocked') return 'ignore';
  return 'pending';
}

export const formatPhone = (phone: string) => {
  const m = phone.match(/^55(\d{2})(9?\d{4})(\d{4})$/);
  return m ? `+55 ${m[1]} ${m[2]}-${m[3]}` : `+${phone}`;
};

export const messages = {
  ownerNewContact: (phone: string, name?: string | null) =>
    `🔔 ${name ? `${name} (${formatPhone(phone)})` : formatPhone(phone)} tentou falar com o Pulse.\n\nResponda *autorizar* para liberar (ou *autorizar ${phone}*) ou *bloquear* para negar.`,
  ownerAuthorized: (phone: string, name?: string | null) => `✅ ${name ? `${name} — ` : ''}${formatPhone(phone)} liberado. Mandei as boas-vindas.`,
  ownerBlocked: (phone: string) => `🚫 ${formatPhone(phone)} bloqueado. Não vou responder a esse número.`,
  ownerRemoved: (phone: string) => `🗑️ ${formatPhone(phone)} removido, junto com a conversa e os lançamentos de teste dele.`,
  ownerNoPending: 'Não há nenhum número esperando autorização. Para liberar um específico, mande *autorizar 5511999999999*.',
  ownerBadPhone: 'Não entendi o número. Use o formato *autorizar 5511999999999* ou só *autorizar* para liberar o último que pediu.',
  ownerEmptyList: 'Ainda não há nenhum contato.',
  ownerHelp:
    '*Comandos do dono*\n• *autorizar* — libera o último número que pediu acesso\n• *autorizar 5511999999999 Nome* — libera um número\n• *bloquear* ou *bloquear 5511…* — nega\n• *remover 5511…* — apaga o contato e a conversa\n• *listar* — mostra todos os contatos',
  welcome: (name?: string | null) =>
    `Oi${name ? `, ${name.split(/\s+/)[0]}` : ''}! Você foi liberado para testar o *Pulse*, um assistente de finanças pelo WhatsApp.\n\nConte um gasto (ex.: "gastei 32 no almoço"), pergunte seu saldo ou mande um áudio. Antes de gravar algo, eu confirmo com você.\n\nÉ uma versão de teste, então me avise se algo não funcionar bem. 🙂`,
  technicalProblem: 'Tive um problema técnico agora e não consegui responder. Pode mandar de novo em instantes?',
  unsupported: 'Por enquanto eu entendo texto e áudio. Pode me contar por um deles?',
};

export function renderContactList(contacts: Contact[]): string {
  if (!contacts.length) return messages.ownerEmptyList;
  const label: Record<ContactStatus, string> = { authorized: '✅', pending: '⏳', blocked: '🚫' };
  return contacts.map(c => `${label[c.status]} ${c.name ? `${c.name} — ` : ''}${formatPhone(c.phone)}`).join('\n');
}
