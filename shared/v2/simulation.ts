import {conversationalReply} from './conversation.js';
import {normalize,type Provider,type ModelMessage,type Session,type ModelResult,todayBR} from './contracts.js';
import {monthPeriod} from './policy.js';
import {explicitTransaction,resolvePeriod,requestedGoal,requestedPreferences,purchaseImpact,prepareOperation} from './simulation-nlu.js';
const call=(name:string,args:unknown)=>({id:crypto.randomUUID(),name,arguments:args});
const asksOpinion=(text:string)=>/o que (voce )?acha|opiniao|orient|deveria|gastando muito|vale a pena/.test(text);
/**
 * Deterministic stand-in for the model, used offline and in tests. It behaves like the model is
 * expected to: it PROPOSES tool calls (with its reading and evidence) and writes the conversational
 * text. It has no privileges: every write it proposes goes through the same policy as the real model.
 */
export class SimulationProviderV2 implements Provider {
 readonly mode='simulation' as const;
 constructor(private today=todayBR()){}
 async next(messages:ModelMessage[],session:Session):Promise<ModelResult>{
  const last=[...messages].reverse().find(m=>m.role!=='system'); // internal nudges are not user messages
  if(last?.role==='tool')return {content:this.commentary(messages,session)};
  const message=last?.content||'',text=normalize(message);
  // Communication preferences and questions about them.
  if(/sem (perguntar|confirmacao)|nao.*pedir confirmacao/.test(text))return {content:'Posso ser breve, mas alterações e exclusões continuam exigindo confirmação explícita.'};
  if(/(quais|minhas|consultar).*preferencias/.test(text))return {content:'Preferências: '+JSON.stringify(session.state.preferences)};
  if(/(redefin|restaur|reset).*(preferenc|comunicac)/.test(text))return {calls:[call('atualizar_preferencias',{redefinir:true,evidencia:message})]};
  const pref=requestedPreferences(message,session.state.preferences);
  if(pref){const changes=Object.fromEntries(Object.entries(pref).filter(([k,v])=>session.state.preferences[k as keyof typeof pref]!==v));return {calls:[call('atualizar_preferencias',{...changes,evidencia:message})]};}
  // Hypothetical purchase: simulate, never register.
  const impact=purchaseImpact(message);if(impact)return {calls:[call('simular_compra',impact)]};
  // Changes to existing records or to an existing goal: propose, the code prepares a confirmation.
  const goalRequest=requestedGoal(message);
  if(/corrig|corr[eij]|alter|exclu|apagu|apaga|remov|pera[, ]|aquele .* foi|nao era|eram? r?\$|mudar.*meta/.test(text)||(session.state.goal&&goalRequest)){
   const prepared=prepareOperation(message,session);const op=prepared.operation;
   if(!op)return {content:prepared.message};
   if(op.kind==='goal')return {calls:[call('definir_objetivo',{...op.after,evidencia:message})]};
   if(op.kind==='delete')return {calls:[call('propor_exclusao_transacao',{alvo:{transacao_id:op.targetId},evidencia:message})]};
   const before=op.before as Record<string,unknown>,after=op.after as Record<string,unknown>;
   const novo=Object.fromEntries(['amount','description','category','date'].filter(k=>after[k]!==undefined&&after[k]!==before[k]).map(k=>[k,after[k]]));
   return {calls:[call('propor_edicao_transacao',{alvo:{transacao_id:op.targetId},novo,evidencia:message})]};
  }
  const open=conversationalReply(message,session);if(open&&!goalRequest&&!/^(gastei|paguei|comprei|recebi|registra|registre|defina|minha meta|meu objetivo)\b/.test(text))return {content:open};
  const write=explicitTransaction(message,this.today,session);if(write)return {calls:[call('registrar_transacao',{...write,evidencia:message,natureza:'fato_ocorrido'})]};
  if(/^(eu )?(gastei|paguei|comprei|recebi|ganhei|registre)\b/.test(text)&&!text.includes('?'))return {content:'Qual o valor, a descrição e a data? Se for uma hipótese, posso conversar sem registrar.'};
  const p=resolvePeriod(message,this.today,session.memory)||session.memory.periods[0]||monthPeriod(this.today);
  if(/diferenca|aumentaram|mais que|compar/.test(text))return {calls:[call('comparar_periodos',{periodA:session.memory.periods.length===2?session.memory.periods[1]:monthPeriod(this.today),periodB:session.memory.periods.length===2?session.memory.periods[0]:monthPeriod(this.today,-1),metric:'despesas'})]};
  if(/ritmo|projec|fim do mes/.test(text))return {calls:[call('projetar_despesas',{period:monthPeriod(this.today),asOf:this.today})]};
  if(/onde|categoria|como estao|financas|deveria fazer|o que.*acha|gastando muito|opiniao|orientacao/.test(text))return {calls:[call('consultar_saldo',{}),call('listar_transacoes',{type:'despesa',limit:20,period:p}),call('resumir_financas',{period:p})]};
  if(/saldo/.test(text))return {calls:[call('consultar_saldo',{})]};
  if(/listar|extrato|transacoes/.test(text))return {calls:[call('listar_transacoes',{limit:20,...(/despesas/.test(text)?{type:'despesa'}:/receitas/.test(text)?{type:'receita'}:{})})]};
  if(goalRequest)return {calls:[call('definir_objetivo',{...goalRequest,evidencia:message})]};
  if(/gastei|gastos|gaste|despesas|quanto|e no|e na/.test(text)||(/^e\b/.test(text)&&session.memory.topic))return {calls:[call('resumir_financas',{period:p,type:/receita|recebi/.test(text)||session.memory.topic==='receitas'?'receita':'despesa'})]};
  if(/ola|oi|bom dia/.test(text))return {content:'Oi! Posso registrar seus lançamentos fictícios, comparar períodos e ajudar a entender o que aparece nos dados. Por onde começamos?'};
  return {content:'Me conta o que você quer entender ou registrar. Se a referência não estiver clara, vou pedir um detalhe antes de agir.'};
 }
 /** Qualitative comment after tool results, only when the user asked for an opinion. Never repeats numbers. */
 private commentary(messages:ModelMessage[],session:Session):string{
  const userIndex=messages.map(m=>m.role).lastIndexOf('user');const question=normalize(messages[userIndex]?.content||'');
  if(!asksOpinion(question))return '';
  const results=messages.slice(userIndex+1).filter(m=>m.role==='tool').map(m=>{try{return JSON.parse(m.content||'{}');}catch{return {};}}).filter(r=>r.ok).map(r=>r.result as Record<string,any>);
  const prefs=session.state.preferences;let advice='';
  const summary=results.find(r=>r&&'expenseCents' in r&&'categories' in r);
  if(summary?.expenseCents){const top=summary.categories?.find((c:any)=>c.expenseCents>0);if(top)advice=prefs.detail==='curto'?`${top.category} lidera estes registros. Vale separar o essencial do ajustável. A amostra é pequena; sem renda e necessidades, não dá para julgar seu gasto.`:`${top.category} concentra a maior parcela destes registros. Antes de cortar gastos, vale separar o essencial do que você quer ajustar. Qual é sua prioridade financeira? Não dá para dizer que você gasta demais sem conhecer sua renda e suas necessidades.`;}
  if(results.some(r=>r&&'purchaseCents' in r))advice='A compra reduz o dinheiro disponível. Pode fazer sentido se for importante agora; se esse valor for sua reserva para imprevistos, eu consideraria preservar mais caixa. Quais despesas essenciais ainda precisam ser cobertas?';
  if(advice&&prefs.explanation==='completa')advice+=' Essa perspectiva considera apenas os valores informados ou registrados; renda, compromissos futuros e necessidades pessoais podem mudar a decisão.';
  if(advice&&prefs.examples)advice+=' Por exemplo, adiar a compra ou buscar uma alternativa pode preservar caixa para despesas essenciais.';
  return advice;
 }
}
