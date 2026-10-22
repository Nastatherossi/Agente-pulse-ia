import {normalize,brl,type Session,type PendingOperation} from './contracts.js';
/** Trace label only. Since the semantic refactor it is derived from what happened in the turn, never used to decide. */
export type Intent='execucao'|'consulta'|'orientacao'|'alteracao'|'preferencias'|'confirmacao'|'conversa';
/*
 * Yes/no replies. These are consulted ONLY while a valid pending operation exists (see agent.ts).
 * Without one, "sim", "não", "pode", "cancela"… are ordinary conversation and go to the model.
 */
export const isConfirmation=(m:string)=>/^(sim|s|isso|isso mesmo|pode|pode sim|pode registrar|pode confirmar|pode alterar|pode excluir|claro|confirmo|confirma|confirmar|confirmado|ok|beleza|certo|fechado|manda ver|confirmar registro ficticio)[.! ]*$/.test(normalize(m.trim()));
export const isCancellation=(m:string)=>/^(nao|n|cancela|cancelar|cancelado|deixa|deixa pra la|deixa quieto|melhor nao|nao quero|esquece|nao,? deixa como estava|nao,? cancela)[.!, ]*$/.test(normalize(m.trim()));
export const isClear=(m:string)=>/^(limpa|limpar|apaga|apagar) (nossa |a )?conversa[.!]*$/.test(normalize(m.trim()));
type Shown=NonNullable<PendingOperation['before']>|NonNullable<PendingOperation['items']>[number];
const display=(v:Shown)=>'type' in v?`${v.description} · ${brl(Math.round(v.amount*100))} · ${v.date} · ${v.category||'sem categoria'}`:`${v.description} · ${brl(Math.round(v.amount*100))}${v.targetDate?' · '+v.targetDate:''}`;
const closing='Confirma? Responda “sim” ou “cancelar”. Expira em 5 minutos.';
export function describeOperation(op:PendingOperation,lead?:string){
 if(op.kind==='create'){
  const items=op.items!.map(i=>`• ${i.type==='receita'?'Receita':'Despesa'} · ${display(i)}`).join('\n');
  const hint=op.items!.some(i=>i.type==='despesa'&&!i.category)?'\nQual categoria? Pode dizer junto com o sim (ex.: "sim, em Lazer").':'';
  return `${lead||'Confirma antes de registrar?'}\n${items}${hint}\n${closing}`;
 }
 if(op.kind==='goal'&&!op.before)return `Criar meta?\nMeta: ${display(op.after!)}.\n${closing}`;
 if(op.kind==='edit'&&op.before&&op.after&&'type' in op.before&&'type' in op.after&&op.after.category&&op.before.category!==op.after.category&&op.before.amount===op.after.amount&&op.before.description===op.after.description&&op.before.date===op.after.date)
  return `${lead||'Perfeito!'} Quer que eu coloque este lançamento na categoria ${op.after.category}?\n• ${op.before.type==='receita'?'Receita':'Despesa'} · ${op.before.description} · ${brl(Math.round(op.before.amount*100))} · ${op.before.date}\n${closing}`;
 return `${op.kind==='delete'?'Excluir':'Alterar'} ${op.kind==='goal'?'meta':'lançamento'}?\nAntes: ${display(op.before!)}${op.after?'\nDepois: '+display(op.after):'\nDepois: lançamento excluído'}.\n${closing}`;
}
export function clearContext(session:Session){session.history=[];session.memory={periods:[]};session.lastRequests=[];}
