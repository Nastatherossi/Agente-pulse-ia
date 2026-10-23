import {CATEGORIES,storedTransaction,goal,normalize,defaultPreferences,type Session,type Period,type ModelCall,type PendingOperation,type State} from './contracts.js';
export const dateOffset=(date:string,days:number)=>new Date(Date.parse(date+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
export const monthPeriod=(today:string,offset=0):Period=>{const d=new Date(today+'T12:00:00Z');const start=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+offset,1)),end=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+offset+1,0));return {start:start.toISOString().slice(0,10),end:end.toISOString().slice(0,10)};};
/** Deterministic keyword categorization, applied only when the model leaves the category empty. Obvious cases only; anything ambiguous stays uncategorized and the user is asked. */
export function knownCategory(description:string):string|undefined{
 const text=normalize(description);
 // "conta de água/luz" is a bill, not a drink: check bills before food.
 if(/\b(conta de (agua|luz|gas|internet|telefone|celular)|luz|energia|internet|telefone|condominio|iptu|ipva|boleto)\b/.test(text))return /\b(condominio|iptu)\b/.test(text)?'Moradia':'Contas e serviços';
 if(/\b(netflix|spotify|disney|hbo|prime video|youtube premium|chatgpt|assinatura|mensalidade do app|icloud|google one)\b/.test(text))return 'Assinaturas';
 if(/\b(aluguel|financiamento|reforma|moveis|diarista|faxina)\b/.test(text))return 'Moradia';
 if(/\b(farmacia|remedio|medico|consulta|dentista|exame|plano de saude|hospital|psicologo|terapia|academia)\b/.test(text))return 'Saúde';
 if(/\b(curso|faculdade|escola|livro|matricula|apostila|mensalidade escolar)\b/.test(text))return 'Educação';
 if(/\b(transporte|gasolina|combustivel|uber|99|taxi|onibus|metro|passagem|estacionamento|pedagio|oficina|etanol|diesel)\b/.test(text))return 'Transporte';
 if(/\b(supermercado|mercado|restaurante|almoco|jantar|cafe|padaria|lanche|pizza|hamburguer|ifood|acougue|feira|hortifruti|sorvete|marmita|churrasco|refrigerante|suco|agua|cerveja|comida|sobremesa|bolo|pao|doce|salgado|tempero|temperos|condimento|condimentos|especiaria|especiarias)\b/.test(text))return 'Alimentação';
 if(/\b(bar|cinema|lazer|show|ingresso|balada|viagem|festa|jogo|parque|teatro)\b/.test(text))return 'Lazer';
 if(/\b(roupa|camisa|calca|tenis|sapato|notebook|fone|eletronico|shopping)\b/.test(text))return 'Compras';
 if(/\b(salario|freela|freelance|pix recebido|dividendo|rendimento|comissao)\b/.test(text))return 'Renda';
 return undefined;
}
/** A category named in a reply to a pending confirmation ("sim, em alimentação", "lança como lazer"). Exactly one category, or nothing. */
export function categoryInReply(message:string,custom:readonly string[]=[]):string|undefined{
 const t=normalize(message);
 const hits=new Set<string>();
 for(const c of [...CATEGORIES,...custom])if(new RegExp(`\\b${normalize(c).replace(/ /g,'\\s+')}\\b`).test(t))hits.add(c);
 if(/\b(comida|alimento|alimentos)\b/.test(t))hits.add('Alimentação');
 return hits.size===1?[...hits][0]:undefined;
}

/*
 * WRITE POLICY
 * ------------
 * The model interprets the message and PROPOSES a write (tool call with its reading `natureza`
 * and an `evidencia` excerpt). This module decides, deterministically, what happens to it:
 *   execute — clear, grounded, low-risk new record;
 *   confirm — plausible but ambiguous or higher risk: becomes a pending operation the user must confirm;
 *   block   — contradicts the message (invented amount, future date, model itself says it is not a fact…).
 * Mechanical checks only: numbers, dates, substrings, limits. Word lists below never authorize a
 * write; they can only downgrade "execute" to "confirm".
 */
export type WriteDecision={decision:'execute'|'confirm'|'block';reason?:string};
export type PolicyContext={message:string;today:string;session:Session;risk:boolean;repeatedMessage:boolean;writesThisTurn:number;
 /** The user's previous message and whether the current one is a bare yes. Used only when the model asked in plain text
  *  ("quer que eu registre?") and the user said "sim": the values must then come from that previous message, and the
  *  record still goes through a code-written confirmation. */
 previousUserMessage?:string;affirmation?:boolean;
 /** The message is the transcript of a voice note: numbers may be misheard, so records and goals always ask for confirmation. */
 viaAudio?:boolean};
/** Which user message backs a new record: the current one, or the previous one when the current is a bare "sim". */
function backing(ctx:PolicyContext):{text:string;viaPrevious:boolean}{
 if(ctx.affirmation&&ctx.previousUserMessage&&amountsIn(ctx.message).length===0)return {text:ctx.previousUserMessage,viaPrevious:true};
 return {text:ctx.message,viaPrevious:false};
}
export const HIGH_VALUE_REAIS=5000;
const OLDEST_DAYS=366;
const cents=(n:number)=>Math.round(n*100);
const squash=(s:string)=>normalize(s).replace(/[^a-z0-9]+/g,' ').trim();

/** Every monetary-looking number in a text, in reais (BR formats, "3 mil", "2k"). Dates are ignored. */
export function amountsIn(text:string):number[]{
 const t=text.replace(/\d{4}-\d{2}-\d{2}/g,' ').replace(/\b(?:dia|no dia|até o dia|ate o dia)\s+(?:[12]?\d|3[01])\b(?!\s*(?:reais|real|r\$|,\d))/gi,' ').replace(/\b\d{1,2}\s*(?:x|vezes)\b/gi,' ').replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,' ');
 const out:number[]=[];
 for(const m of t.matchAll(/(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(\s*(?:mil\b|k\b))?/gi)){
  const raw=m[1];let v=raw.includes(',')?Number(raw.replace(/\./g,'').replace(',','.')):/^\d{1,3}(?:\.\d{3})+$/.test(raw)?Number(raw.replace(/\./g,'')):Number(raw);
  if(m[2])v*=1000;
  if(Number.isFinite(v))out.push(v);
 }
 return out;
}
const hasAmount=(text:string,amount:number)=>amountsIn(text).some(v=>cents(v)===cents(amount));
/**
 * Does the user's message support the excerpt the model quoted? Models paraphrase a little ("R$ 280" for
 * "280", "foi 280" for "foi 280, não 300"), so this is token coverage, not an exact substring: every number
 * in the excerpt must be in the message (same amount), and most of its words too. Amounts are still checked
 * separately and strictly (hasAmount).
 */
const STOP=new Set(['r','rs','reais','real','de','do','da','no','na','em','o','a','e','um','uma','por','com','pra','para']);
const contains=(message:string,excerpt:string)=>{
 const words=squash(excerpt).split(' ').filter(w=>w&&!STOP.has(w)),msg=squash(message),msgWords=new Set(msg.split(' '));
 if(!words.length)return false;
 const nums=amountsIn(excerpt);if(nums.some(n=>!hasAmount(message,n)))return false;
 const textWords=words.filter(w=>!/^\d/.test(w));if(!textWords.length)return nums.length>0;
 const hits=textWords.filter(w=>msgWords.has(w)||[...msgWords].some(m=>m.length>=4&&w.length>=4&&m.slice(0,4)===w.slice(0,4))).length;
 return hits/textWords.length>=0.6;
};
/** True when at least one meaningful word of `phrase` (by 4-letter stem) appears in the message. */
export function sharesStem(message:string,phrase:string){
 const m=squash(message);const words=squash(phrase).split(' ').filter(w=>w.length>=3);
 return words.some(w=>m.includes(w.slice(0,Math.min(4,w.length))));
}

/** Auxiliary signal of emotional risk. Never used to answer; only to keep financial machinery out of the turn. */
export const riskSignal=(message:string)=>/(quero (me )?matar|me matar|suicid|tirar (a )?minha (propria )?vida|quero morrer|me machucar|acabar com tudo|nao aguento mais|nao quero mais viver)/.test(normalize(message));
/** Language that suggests the statement may not be a completed fact. Downgrades to confirmation only. */
const tentative=(message:string)=>/\?/.test(message)||/\b(se eu|e se|caso eu|talvez|gastaria|compraria|pagaria|quero comprar|quero gastar|vou comprar|vou gastar|vou pagar|pretendo|pensando em|planejo|preciso pagar|tenho que pagar|amanha|semana que vem|mes que vem|proxima semana|proximo mes|ia gastar|quase gastei|nao gastei|nao paguei|nao comprei|nem gastei|brincadeira|zoeira|nao (registra|registre|registrar|anota|anote|lanca|lance|precisa registrar))\b/.test(normalize(message));
const expenseCue=(t:string)=>/\b(gastei|paguei|comprei|torrei|custou|deu)\b/.test(t);
const incomeCue=(t:string)=>/\b(recebi|ganhei|caiu|entrou|vendi|me pagaram|salario)\b/.test(t);

/** Maps whatever the model sent to the closed taxonomy. Unknown or neutral labels are dropped, never invented. */
const NEUTRAL_LABELS=new Set(['outros','outras','outro','outra','sem categoria','geral','diversos','nenhuma','null','undefined','n/a']);
/** Clean display name for a category the user asked for: letters, digits, spaces and a few symbols; first letter upper-case. */
export function cleanCategoryName(raw:string):string|undefined{
 const t=raw.replace(/[^\p{L}\p{N} &'\-]/gu,' ').replace(/\s+/g,' ').trim().slice(0,30).trim();
 if(t.length<2||NEUTRAL_LABELS.has(normalize(t)))return undefined;
 return t.charAt(0).toUpperCase()+t.slice(1);
}
/**
 * Maps whatever the model sent to a category. Built-in categories and the user's own are accepted by name.
 * A NEW category is accepted only when the user asked for it in this very message ("cria uma categoria namorado"):
 * its name must appear in the message together with the word "categoria". Anything else the model invents is dropped.
 */
export function normalizeCategory(raw:unknown,message:string,description:string,type?:'receita'|'despesa',custom:readonly string[]=[]):string|undefined{
 const msg=normalize(message);
 if(/nao sei (a |qual )?(e a )?categoria|sem categoria/.test(msg))return undefined; // explicit user statement wins
 if(typeof raw==='string'&&raw.trim()){
  const want=normalize(raw.trim());
  const hit=CATEGORIES.find(c=>normalize(c)===want)??custom.find(c=>normalize(c)===want);
  if(hit)return hit;
  const name=cleanCategoryName(raw);
  if(name&&custom.length<40&&/\bcategoria\b/.test(msg)&&msg.includes(normalize(name)))return name;
 }
 // Keyword guesses are only for the right kind of record: "Renda" is for income, never for an expense.
 const guess=knownCategory(description);
 if(guess==='Renda'&&type==='despesa')return undefined;
 if(type==='receita'&&guess!=='Renda')return undefined;
 return guess;
}
export type NewEntry={type:'receita'|'despesa';amount:number;description:string;date:string;category?:string};
function entryFrom(a:Record<string,unknown>,message:string,custom:readonly string[]=[]):NewEntry{
 const e:NewEntry={type:a.type as NewEntry['type'],amount:a.amount as number,description:String(a.description),date:String(a.date)};
 const category=normalizeCategory(a.category,message,e.description,e.type,custom);if(category)e.category=category;
 return e;
}
function blockForEntry(e:NewEntry,evidence:string,ctx:PolicyContext):string|undefined{
 if(e.date>ctx.today)return 'FUTURE_DATE';
 if(e.date<dateOffset(ctx.today,-OLDEST_DAYS))return 'DATE_TOO_OLD';
 const {text}=backing(ctx);
 if(!hasAmount(text,e.amount))return 'AMOUNT_NOT_IN_MESSAGE';
 if(!contains(text,evidence))return 'EVIDENCE_NOT_IN_MESSAGE';
 return undefined;
}
function confirmForEntry(e:NewEntry,ctx:PolicyContext):string|undefined{
 const {text,viaPrevious}=backing(ctx),t=normalize(text),values=amountsIn(text);
 if(viaPrevious)return 'CONFIRM_FROM_PREVIOUS_MESSAGE';
 if(ctx.repeatedMessage)return 'REPEATED_MESSAGE';
 if(tentative(text))return 'TENTATIVE_LANGUAGE';
 if(values.length>1)return 'MULTIPLE_AMOUNTS'; // counts repeats too: "50 no mercado e 50 na farmácia" is two records
 if(e.amount>HIGH_VALUE_REAIS)return 'HIGH_VALUE';
 if(e.date!==ctx.today&&e.date!==dateOffset(ctx.today,-1)&&!text.includes(e.date))return 'RELATIVE_DATE';
 if((e.type==='receita'&&expenseCue(t)&&!incomeCue(t))||(e.type==='despesa'&&incomeCue(t)&&!expenseCue(t)))return 'TYPE_UNCLEAR';
 if(!sharesStem(text,e.description))return 'DESCRIPTION_NOT_IN_MESSAGE';
 if(ctx.writesThisTurn>0)return 'SECOND_WRITE_IN_TURN';
 return undefined;
}
export type CreateDecision=WriteDecision&{entries?:NewEntry[]};
/** registrar_transacao / registrar_varios */
export function decideCreate(call:ModelCall,ctx:PolicyContext):CreateDecision{
 const a=call.arguments;
 if(ctx.risk)return {decision:'block',reason:'RISK_CONTEXT'};
 if(a.natureza!=='fato_ocorrido')return {decision:'block',reason:'NOT_A_FACT'};
 const items=call.name==='registrar_varios'?(a.lancamentos as Record<string,unknown>[]):[a];
 const entries=items.map(i=>entryFrom(i,backing(ctx).text,ctx.session.state.categories??[]));
 for(let i=0;i<entries.length;i++){const reason=blockForEntry(entries[i],String(items[i].evidencia),ctx);if(reason)return {decision:'block',reason};}
 if(entries.length>1)return {decision:'confirm',reason:'MULTIPLE_ENTRIES',entries};
 const reason=confirmForEntry(entries[0],ctx);
 if(reason)return {decision:'confirm',reason,entries};
 return ctx.viaAudio?{decision:'confirm',reason:'FROM_AUDIO',entries}:{decision:'execute',entries};
}
/** atualizar_preferencias: communication style only, low risk; requires the user's own words as evidence. */
export function decidePreferences(call:ModelCall,ctx:PolicyContext):WriteDecision&{preferences?:State['preferences']}{
 const {evidencia,redefinir,...changes}=call.arguments;
 if(!contains(ctx.message,String(evidencia)))return {decision:'block',reason:'EVIDENCE_NOT_IN_MESSAGE'};
 const preferences=redefinir?defaultPreferences():{...ctx.session.state.preferences,...changes} as State['preferences'];
 return {decision:'execute',preferences};
}
/** definir_objetivo: a new goal can be created directly when explicitly asked; replacing one always needs confirmation. */
export function decideGoal(call:ModelCall,ctx:PolicyContext):WriteDecision&{goal?:State['goal']}{
 const {evidencia,...g}=call.arguments;const parsed=goal.parse(g);
 if(ctx.risk)return {decision:'block',reason:'RISK_CONTEXT'};
 if(!hasAmount(ctx.message,parsed.amount))return {decision:'block',reason:'AMOUNT_NOT_IN_MESSAGE'};
 if(!contains(ctx.message,String(evidencia)))return {decision:'block',reason:'EVIDENCE_NOT_IN_MESSAGE'};
 if(ctx.session.state.goal)return {decision:'confirm',reason:'REPLACES_GOAL',goal:parsed};
 if(ctx.viaAudio)return {decision:'confirm',reason:'FROM_AUDIO',goal:parsed};
 if(!/\b(meta|objetivo|defina|definir|crie|criar|registre|registrar)\b/.test(normalize(ctx.message))||tentative(ctx.message))return {decision:'confirm',reason:'GOAL_NOT_EXPLICIT',goal:parsed};
 return {decision:'execute',goal:parsed};
}
/** Resolves the record an edit/deletion refers to. Exactly one match, or nothing is prepared. */
/** The record the user most likely means by "isso", "esse valor", "o último": the one registered most recently. */
export function lastRecord(state:State):State['transactions'][number]|undefined{
 return state.transactions.find(t=>t.id===state.lastRecordId)??state.transactions[state.transactions.length-1];
}
/** Words that point at the previous record instead of describing one. */
const DEICTIC=/\b(isso|esse|essa|esse valor|esse gasto|esse lancamento|ultimo|ultima|aquele|aquela|acabei de|agora ha pouco|anterior|mesmo)\b/;
export function resolveTarget(alvo:Record<string,unknown>,state:State,message=''):{target?:State['transactions'][number];reason?:string}{
 let c=state.transactions;
 if(alvo.transacao_id)c=c.filter(t=>t.id===alvo.transacao_id);
 if(alvo.descricao)c=c.filter(t=>sharesStem(`${t.description} ${t.category||''}`,String(alvo.descricao)));
 if(alvo.valor!==undefined)c=c.filter(t=>cents(t.amount)===cents(alvo.valor as number));
 if(alvo.data)c=c.filter(t=>t.date===alvo.data);
 if(c.length===1)return {target:c[0]};
 // "coloca em lazer", "muda isso para 30": no record was described, so the user means the last one.
 const last=lastRecord(state);
 const deictic=DEICTIC.test(normalize(message))||/^(ultimo|ultima|esse|essa|isso)\b/.test(normalize(String(alvo.descricao??'')));
 const described=Boolean(alvo.transacao_id)||alvo.valor!==undefined&&state.transactions.some(t=>cents(t.amount)===cents(alvo.valor as number))||(Boolean(alvo.descricao)&&!deictic&&c.length>0);
 if(last&&deictic&&!described)return {target:last};
 return {reason:c.length?'TARGET_AMBIGUOUS':'TARGET_NOT_FOUND'};
}
/** Short and not naming any existing record: the user is talking about the previous one. */
export function isLooseMessage(message:string,state:State):boolean{
 return normalize(message).trim().length<=70&&!state.transactions.some(t=>sharesStem(message,t.description));
}
/** propor_edicao_transacao / propor_exclusao_transacao: never executed, at most turned into a pending operation. */
export function prepareChange(call:ModelCall,ctx:PolicyContext,now=Date.now()):{operation?:PendingOperation;reason?:string}{
 const a=call.arguments;
 if(ctx.risk)return {reason:'RISK_CONTEXT'};
 if(!contains(ctx.message,String(a.evidencia)))return {reason:'CHANGE_NOT_IN_MESSAGE'};
 let {target,reason}=resolveTarget(a.alvo as Record<string,unknown>,ctx.session.state,ctx.message);
 // A loose, short message that describes no record ("coloca em lazer", "muda pra 30", "apaga") is about the last one.
 // The confirmation always shows which record it is, so a wrong guess is caught by the user.
 if(!target&&reason==='TARGET_NOT_FOUND'&&isLooseMessage(ctx.message,ctx.session.state)){target=lastRecord(ctx.session.state);}
 if(!target)return {reason};
 const base={id:crypto.randomUUID(),createdAt:now,expiresAt:now+5*60000,targetId:target.id,before:target};
 if(call.name==='propor_exclusao_transacao')return {operation:{...base,kind:'delete'}};
 const novo=a.novo as Record<string,unknown>;
 if(novo.category!==undefined){const cat=normalizeCategory(novo.category,ctx.message,'',undefined,ctx.session.state.categories??[]);if(!cat)return {reason:'INVALID_CHANGE'};novo.category=cat;}
 if(novo.amount!==undefined&&!hasAmount(ctx.message,novo.amount as number))return {reason:'CHANGE_NOT_IN_MESSAGE'};
 if(novo.date!==undefined&&(novo.date as string)>ctx.today)return {reason:'FUTURE_DATE'};
 const after=storedTransaction.safeParse({...target,...novo});if(!after.success)return {reason:'INVALID_CHANGE'};
 return {operation:{...base,kind:'edit',after:after.data}};
}
/** Goal change awaiting confirmation. `before` is absent when the goal would be created rather than replaced. */
export function goalOperation(next:NonNullable<State['goal']>,state:State,now=Date.now()):PendingOperation{
 return {id:crypto.randomUUID(),kind:'goal',...(state.goal?{before:state.goal}:{}),after:next,createdAt:now,expiresAt:now+5*60000};
}
export function createOperation(entries:NewEntry[],now=Date.now()):PendingOperation{
 return {id:crypto.randomUUID(),kind:'create',items:entries.map(e=>({...e})),createdAt:now,expiresAt:now+5*60000};
}
/** What the user sees when a proposal is refused. Written by code, so it never claims a write. */
export function blockedMessage(reason:string|undefined):string{
 switch(reason){
  case 'NOT_A_FACT':return 'Entendi isso como hipótese ou plano, então não registrei nada. Se já aconteceu, é só me dizer.';
  case 'FUTURE_DATE':return 'Não registro lançamentos com data futura. Se já aconteceu, me diga quando foi.';
  case 'DATE_TOO_OLD':return 'Essa data está muito no passado para registrar por aqui. Pode conferir a data?';
  case 'CHANGE_NOT_IN_MESSAGE':return 'Não entendi a correção com segurança, então não alterei nada. Me diz qual lançamento e o valor ou dado certo?';
  case 'TARGET_AMBIGUOUS':return 'Há mais de um lançamento possível. Informe a descrição e a data ou o valor original para identificar um único registro.';
  case 'TARGET_NOT_FOUND':return 'Não encontrei esse lançamento. Pode me dizer a descrição e a data ou o valor original?';
  case 'INVALID_CHANGE':return 'O novo dado é inválido. Informe um valor positivo com até duas casas decimais ou uma data ISO válida.';
  default:return 'Não consegui confirmar o valor e o lançamento pela sua mensagem, então não registrei nada. Pode me dizer o valor e o que foi?';
 }
}
/** Lead line shown above a pending new-record confirmation. */
export function confirmLead(reason:string|undefined):string{
 switch(reason){
  case 'REPEATED_MESSAGE':return 'Essa mensagem é igual a uma que você já mandou, então vou confirmar antes de registrar de novo.';
  case 'FROM_AUDIO':return 'Entendi pelo áudio.';
  case 'MULTIPLE_ENTRIES':return '';
  case 'CONFIRM_FROM_PREVIOUS_MESSAGE':return 'Entendi!';
  case 'TENTATIVE_LANGUAGE':return 'Só pra ter certeza de que isso já aconteceu:';
  case 'MULTIPLE_AMOUNTS':return 'Vi mais de um valor na sua mensagem, então quero ter certeza:';
  case 'HIGH_VALUE':return 'É um valor alto, então confirmo com você:';
  case 'RELATIVE_DATE':return 'Só confirmando a data:';
  default:return '';
 }
}
