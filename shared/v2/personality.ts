import {normalize,transaction,pendingOperation,brl,type Session,type PendingOperation} from './contracts.js';
import {requestedPreferences,requestedGoal} from './policy.js';
export type Intent='execucao'|'consulta'|'orientacao'|'alteracao'|'preferencias'|'confirmacao'|'conversa';
export const isConfirmation=(m:string)=>/^(sim|confirmo|confirmar|confirmar registro ficticio)[.!]*$/.test(normalize(m.trim()));
export const isCancellation=(m:string)=>/^(nao[,! .]*|cancela|cancelar|nao,? deixa como estava)[.!]*$/.test(normalize(m.trim()));
export const isClear=(m:string)=>/^(limpa|limpar|apaga|apagar) (nossa |a )?conversa[.!]*$/.test(normalize(m.trim()));
export function classifyIntent(m:string):Intent {
 const t=normalize(m);
 if(isConfirmation(m)||isCancellation(m))return 'confirmacao';
 if(/sem (perguntar|confirmacao)|nao.*pedir confirmacao/.test(t)||requestedPreferences(m,{style:'neutro',detail:'curto',proactivity:'discreto',explanation:'minima',examples:false,emojis:false})||/preferencias/.test(t))return 'preferencias';
 if(/corrig|corr[eij]|alter|exclu|apagu|apaga|remov|pera[, ]|aquele .* foi|nao era|eram? r?\$|mudar.*meta/.test(t))return 'alteracao';
 if(/o que (voce )?acha|opiniao|orient|ajud|deveria|gastando muito|vale a pena/.test(t))return 'orientacao';
 if(requestedGoal(m))return 'conversa';
 if(/^(eu )?(gastei|paguei|comprei|recebi|ganhei|registra|registre|registrar)\b/.test(t)&&!/[?]|\b(se|talvez|pensando|comprasse)\b/.test(t))return 'execucao';
 if(/[?]|saldo|listar|extrato|quanto|gastos|financas|categoria|projec|ritmo|compar/.test(t))return 'consulta';
 return 'conversa';
}
const number=(s:string)=>Number(s.includes(',')?s.replace(/\./g,'').replace(',','.'): /^\d{1,3}(?:\.\d{3})+$/.test(s)?s.replace(/\./g,''):s);
export function purchaseImpact(message:string){
 const t=normalize(message);if(!/compr|celular/.test(t)||!/[?]|hipot|se eu/.test(t))return undefined;
 const nums=[...message.matchAll(/R\$\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/g)].map(m=>number(m[1]));
 if(nums.length===2&&/tenho/.test(t))return {available:nums[0],amount:nums[1]};
 if(nums.length===1)return {amount:nums[0]};return undefined;
}
export function prepareOperation(message:string,session:Session,now=Date.now()):{operation?:PendingOperation;message:string}{
 const text=normalize(message),base={id:crypto.randomUUID(),createdAt:now,expiresAt:now+5*60000};
 if(/meta|objetivo/.test(text)){
  if(!session.state.goal)return {message:'Não há uma meta existente para alterar.'};
  const requested=requestedGoal(message)||requestedGoal(message.replace(/^(altere|altera|corrige|mude|mudar)\s+(a\s+)?(meta|objetivo)\s*(para)?/i,'minha meta'));
  if(!requested)return {message:'Informe a descrição, o valor e, se desejar, a data da meta que quer alterar.'};
  const operation:PendingOperation={...base,kind:'goal',before:session.state.goal,after:requested};return {operation,message:describeOperation(operation)};
 }
 const amounts=[...message.replace(/\d{4}-\d{2}-\d{2}/g,'').matchAll(/\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/g)].map(m=>number(m[0]));
 const deleting=/exclu|apag|remov/.test(text);
 if(/-\s*\d/.test(message.replace(/\d{4}-\d{2}-\d{2}/g,'')))return {message:'O valor deve ser positivo. Nenhuma alteração foi preparada.'};
 const terms=text.replace(/r\$/g,'').replace(/\d{4}-\d{2}-\d{2}|\d[\d.,]*/g,'').split(/[^a-z]+/).filter(w=>w.length>2&&!['corrige','corrigir','corrija','correcao','altera','alterar','altere','exclui','excluir','exclua','apaga','apagar','apague','remove','remover','remova','aquele','aquela','lancamento','registro','transacao','para','era','eram','foi','nao','pera','valor','descricao','categoria','data','hoje','ontem','com','por','uma','deixa','mude','mudar','troque','troca'].includes(w));
 // Description/category changes identify the old record before the explicit field marker.
 const reference=text.split(/(?:descricao|categoria|data)\s+(?:para|por)/)[0];
 let candidates=session.state.transactions.filter(t=>terms.some(w=>reference.includes(w)&&(normalize(t.description).includes(w)||normalize(t.category||'').includes(w))));
 if(!candidates.length&&!terms.length)candidates=/pera|eram?/.test(text)?session.state.transactions.slice(-1):session.state.transactions;
 const fromTo=/\bde\s+r?\$?\s*\d.*\bpara\s+r?\$?\s*\d/.test(text);
 if(deleting&&amounts.length===1)candidates=candidates.filter(t=>t.amount===amounts[0]);
 if(amounts.length>1)candidates=candidates.filter(t=>t.amount===(fromTo?amounts[0]:amounts.at(-1)));
 const dates=message.match(/\d{4}-\d{2}-\d{2}/g)||[];
 if(dates.length===1&&!/data/.test(text))candidates=candidates.filter(t=>t.date===dates[0]);
 if(candidates.length!==1)return {message:candidates.length?'Há mais de um lançamento possível. Informe a descrição e a data ou o valor original para identificar um único registro.':'Qual lançamento você quer alterar? Informe a descrição e a data ou o valor original.'};
 const before=candidates[0];let after={...before};
 if(!deleting){
  const field=message.match(/(?:descri[cç][aã]o|categoria)\s+(?:para|por)\s+["“]?(.+?)["”]?[.!]?$/i);
  if(field){const value=field[1].replace(/["”]+$/,'').trim();if(/categoria/i.test(field[0]))after.category=value;else after.description=value;}
  else if(/data/.test(text)&&dates.length===1)after.date=dates[0];
  else if(amounts.length)after.amount=fromTo?amounts.at(-1)!:amounts[0];
  else return {message:'Qual valor, descrição, categoria ou data deve substituir o dado atual?'};
  const parsed=transaction.extend({id:pendingOperation.shape.targetId.unwrap()}).safeParse(after); // UUID target is retained, never supplied by the model.
  if(!parsed.success)return {message:'O novo dado é inválido. Informe um valor positivo com até duas casas decimais ou uma data ISO válida.'};
  after=parsed.data;
 }
 const operation:PendingOperation={...base,kind:deleting?'delete':'edit',targetId:before.id,before,after:deleting?undefined:after};
 return {operation,message:describeOperation(operation)};
}
export function describeOperation(op:PendingOperation){
 const display=(v:PendingOperation['before'])=>'type' in v?`${v.description} · ${brl(Math.round(v.amount*100))} · ${v.date} · ${v.category||'sem categoria'}`:`${v.description} · ${brl(Math.round(v.amount*100))}${v.targetDate?' · '+v.targetDate:''}`;
 return `${op.kind==='delete'?'Excluir':'Alterar'} ${op.kind==='goal'?'meta':'lançamento'}?\nAntes: ${display(op.before)}${op.after?'\nDepois: '+display(op.after):'\nDepois: lançamento excluído'}.\nConfirma? Responda “sim” ou “cancelar”. Expira em 5 minutos.`;
}
export function clearContext(session:Session){session.history=[];session.memory={periods:[]};session.lastRequests=[];}
