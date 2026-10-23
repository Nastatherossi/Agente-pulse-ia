import {findCard,invoiceFor,dm,type Card} from './cards.js';
import {normalize,brl,type Session,type PendingOperation} from './contracts.js';
/** Trace label only. Since the semantic refactor it is derived from what happened in the turn, never used to decide. */
export type Intent='execucao'|'consulta'|'orientacao'|'alteracao'|'preferencias'|'confirmacao'|'conversa';
/*
 * Yes/no replies. These are consulted ONLY while a valid pending operation exists (see agent.ts).
 * Without one, "sim", "não", "pode", "cancela"… are ordinary conversation and go to the model.
 */
export const isConfirmation=(m:string)=>/^(sim|s|isso|isso mesmo|pode|pode sim|pode registrar|pode confirmar|pode alterar|pode excluir|claro|confirmo|confirma|confirmar|confirmado|ok|beleza|certo|fechado|manda ver|confirmar registro ficticio)[.! ]*$/.test(normalize(m.trim()));
/** "só registre", "anota isso", "nada ainda, só registra por favor": pedido de registrar o que acabou de ser dito. */
export const isRecordRequest=(m:string)=>/^(nada( ainda)?[,.! ]+)?(so |apenas |entao |pode )?(registra|registre|registrar|anota|anote|anotar|lanca|lance|lancar)( isso| ai| a compra| esse gasto| por favor| pf| pfv)*[.! ]*$/.test(normalize(m.trim()));
export const isCancellation=(m:string)=>/^(nao|n|cancela|cancelar|cancelado|deixa|deixa pra la|deixa quieto|melhor nao|nao quero|esquece|nao,? deixa como estava|nao,? cancela)[.!, ]*$/.test(normalize(m.trim()));
export const isClear=(m:string)=>/^(limpa|limpar|apaga|apagar) (nossa |a )?conversa[.!]*$/.test(normalize(m.trim()));
type Shown=NonNullable<PendingOperation['before']>|NonNullable<PendingOperation['items']>[number];
const display=(v:Shown)=>'type' in v?`${v.description} · ${brl(Math.round(v.amount*100))} · ${v.date} · ${v.category||'sem categoria'}`:`${v.description} · ${brl(Math.round(v.amount*100))}${v.targetDate?' · '+v.targetDate:''}`;
type Say={name?:string;today?:string;cards?:readonly Card[]};
type CardItem={amount:number;date:string;card?:{name?:string;installments?:number}};
/** " no cartão Nubank, em 3x de R$ 100,00 (a primeira parcela cai na fatura que vence 10/11)" */
export function cardPhrase(i:CardItem,cards?:readonly Card[]):string{
 if(!i.card)return '';
 const n=i.card.installments??1,known=findCard(cards,i.card.name);
 const where=`no cartão${i.card.name?' '+i.card.name:''}`;
 const parts=n>1?` em ${n}x de ${brl(Math.round(i.amount/n*100))}`:'';
 const due=known?` (${n>1?'a primeira parcela cai':'cai'} na fatura que vence ${dm(invoiceFor(known,i.date).dueDate)})`:'';
 return ` ${where}${parts}${due}`;
}
const cap=(t:string)=>t.charAt(0).toUpperCase()+t.slice(1);
/** "Matheus, confirma pra mim…" when the name is known; otherwise the same sentence starting with a capital letter. */
const addressed=(name:string|undefined,sentence:string)=>name?`${name}, ${sentence}`:cap(sentence);
const dayOf=(date:string,today?:string)=>{
 if(today&&date===today)return 'hoje';
 if(today){const y=new Date(Date.parse(today+'T12:00:00Z')-86400000).toISOString().slice(0,10);if(date===y)return 'ontem';}
 return `${date.slice(8,10)}/${date.slice(5,7)}`;
};
const when=(date:string,today?:string)=>{const d=dayOf(date,today);return d==='hoje'?'':`, ${d==='ontem'?'ontem':'dia '+d}`;};
const bullet=(i:NonNullable<PendingOperation['items']>[number],today?:string,cards?:readonly Card[])=>`• ${i.type==='receita'?'Receita':'Despesa'} · ${i.description} · ${brl(Math.round(i.amount*100))} · ${dayOf(i.date,today)} · ${i.category||'sem categoria'}${cardPhrase(i,cards).replace(/^ no cartão/,' · cartão')}`;
const showRecord=(v:Shown,today?:string)=>'type' in v?`${v.description} (${brl(Math.round(v.amount*100))}${when(v.date,today)})`:`${v.description} (${brl(Math.round(v.amount*100))})`;
/** Confirmation message. Conversational, calls the user by name, never shows internal formatting or timers. */
export function describeOperation(op:PendingOperation,lead?:string,say:Say={}){
 const {name,today}=say;
 if(op.kind==='create'){
  const items=op.items!;
  const needsCategory=items.some(i=>i.type==='despesa'&&!i.category);
  const hint=needsCategory?' Se quiser, já me diz a categoria junto com o sim (ex.: "sim, em Lazer").':'';
  if(items.length===1){
   const i=items[0],value=brl(Math.round(i.amount*100)),cat=(i.category?` na categoria ${i.category}`:'')+cardPhrase(i as CardItem,say.cards);
   const body=addressed(name,i.type==='receita'?`${lead?'':'confirma pra mim: '}vou registrar a receita "${i.description}" de ${value}${cat}${when(i.date,today)}. Pode ser?`:`${lead?'':'confirma pra mim: '}vou lançar "${i.description}" no valor de ${value}${cat}${when(i.date,today)}. Pode ser?`);
   const joined=lead&&lead.endsWith(':')&&!name?body.charAt(0).toLowerCase()+body.slice(1):body;
   return `${lead?lead+' ':''}${joined}${hint}`;
  }
  return `${lead?lead+' ':''}${addressed(name,`vou lançar estes ${items.length} aqui, pode ser?`)}\n${items.map(i=>bullet(i,today,say.cards)).join('\n')}${hint?'\n'+hint.trim():''}`;
 }
 if(op.kind==='debt'){
  const d=op.debt!,i=(n:number)=>brl(Math.round(n*100));
  const rate=`${String(d.rate).replace('.',',')}% ${d.ratePeriod==='annual'?'ao ano':'ao mês'}`;
  const day=`${d.firstDue.slice(8,10)}/${d.firstDue.slice(5,7)}`;
  return `${addressed(name,`confirma pra mim: vou registrar nas suas dívidas o ${d.description} de ${i(d.principal)}, ${rate}, em ${d.termMonths}x de ${i(d.installment)}, com a primeira parcela em ${day}${d.receivedInAccount?` e lançar a entrada de ${i(d.principal)} na sua conta`:''}. Pode ser?`)}`;
 }
 if(op.kind==='goal'&&!op.before)return addressed(name,`vou criar a meta "${op.after!.description}" de ${brl(Math.round(op.after!.amount*100))}${'targetDate' in op.after!&&op.after!.targetDate?' para '+op.after!.targetDate:''}. Pode ser?`);
 if(op.kind==='edit'&&op.before&&op.after&&'type' in op.before&&'type' in op.after&&op.after.category&&op.before.category!==op.after.category&&op.before.amount===op.after.amount&&op.before.description===op.after.description&&op.before.date===op.after.date)
  return `${lead?lead+' ':''}${addressed(name,`quer que eu coloque ${showRecord(op.before,today)} na categoria ${op.after.category}?`)}`;
 if(op.kind==='delete')return addressed(name,`confirma que é pra apagar ${showRecord(op.before!,today)}?`);
 const what=op.kind==='goal'?'a meta':'esse lançamento';
 return `${addressed(name,`quer que eu altere ${what}?`)}\nAntes: ${display(op.before!)}\nDepois: ${op.after?display(op.after):'lançamento excluído'}`;
}
export function clearContext(session:Session){session.history=[];session.memory={periods:[]};session.lastRequests=[];}
