import {z} from 'zod';
import {createSession,sessionSchema,validateCall,brl,normalize,type Session,type Trace,type Step,type Provider,type ModelMessage,type ValidCall} from './contracts.js';
import {FinancialCoreV2} from './finance.js';
import {classifyIntent,isConfirmation,isCancellation,isClear,prepareOperation,purchaseImpact,clearContext} from './personality.js';
import {authorizeWrite,explicitTransaction,requestedPreferences,requestedGoal,normalizeTransactionCall,transactionAuthorizationFailure} from './policy.js';
export const LIMITS={steps:4,tools:8,timeoutMs:35000,tokens:14000};
export const messageHash=async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(n=>n.toString(16).padStart(2,'0')).join('');
export const errorMessage=(code:string)=>({OPENAI_AUTH_FAILED:'A chave OpenAI não foi aceita. Verifique a configuração do laboratório.',OPENAI_QUOTA_EXCEEDED:'A OpenAI informou falta de créditos ou limite de uso.',OPENAI_RATE_LIMITED:'A OpenAI está limitando requisições. Aguarde antes de tentar de novo.',MODEL_INCOMPATIBLE:'O modelo não aceitou o contrato de ferramentas.',OPENAI_TIMEOUT:'A OpenAI não respondeu no prazo.',REAL_AI_LOCKED:'IA real bloqueada na configuração do laboratório.',INVALID_SESSION:'Esta sessão perdeu a validade. Inicie uma nova sessão.',STEP_LIMIT:'Parei no limite de etapas. Tente uma pergunta mais específica.',TOKEN_LIMIT:'Parei no limite de consumo desta interação.',LOOP_DETECTED:'A consulta se repetiu. Parei para evitar um loop.'} as Record<string,string>)[code]||'Não consegui concluir esta interação. Nenhum sucesso de ferramenta foi inventado.';
function readable(step:Step,detail:Session['state']['preferences']['detail']):string {
 if(step.status!=='success')return step.error?.message||'Ferramenta não executada.';
 const r=step.result as Record<string,any>;
 switch(step.name){
  case 'consultar_saldo':return `Seu saldo fictício é ${brl(r.balanceCents)}.`;
  case 'simular_compra':return `Simulação: ${brl(r.availableCents)} disponíveis (${r.basis}) − ${brl(r.purchaseCents)} da compra = ${brl(r.remainingCents)} restantes. Nenhuma despesa registrada.`;
  case 'editar_transacao':return 'Pronto. Lançamento corrigido conforme confirmado.';
  case 'excluir_transacao':return 'Pronto. Lançamento excluído conforme confirmado.';
  case 'alterar_objetivo':return 'Pronto. Meta alterada conforme confirmado.';
  case 'registrar_transacao':return `${detail==='curto'?'Registrado':'Registro concluído'}: ${r.transaction.description}, ${brl(Math.round(r.transaction.amount*100))}.`;
  case 'listar_transacoes':return r.totalCount?`${r.totalCount} transações no filtro.\n`+r.transactions.map((t:any)=>`${t.date} · ${t.description} · ${t.type==='receita'?'+':'−'} ${brl(Math.round(t.amount*100))} · ${t.category||'sem categoria'}`).join('\n'):'Nenhuma transação neste filtro.';
  case 'resumir_financas':return `${r.period.start} a ${r.period.end}: receitas ${brl(r.incomeCents)}, despesas ${brl(r.expenseCents)} e resultado ${brl(r.netCents)} (${r.count} registros).`+(r.categories.length?'\n'+r.categories.filter((c:any)=>c.expenseCents).map((c:any)=>`${c.category}: ${brl(c.expenseCents)} (${c.expenseSharePercent}%).`).join('\n'):'')+(r.limitedData?'\nOs dados registrados ainda são limitados; isso não descreve toda a sua vida financeira.':'');
  case 'comparar_periodos':return `Comparando ${r.metric}: ${r.periodA.start}–${r.periodA.end}: ${brl(r.valueACents)}; ${r.periodB.start}–${r.periodB.end}: ${brl(r.valueBCents)}. Diferença (A − B): ${brl(r.differenceCents)}. ${r.percentChange===null?'Variação percentual indefinida porque o valor de B é zero.':`Variação: ${r.percentChange}%.`}`+(r.limitedData?' A amostra registrada é limitada.':'');
  case 'consultar_gastos_categoria':return `${r.category}: ${brl(r.totalCents)} em ${r.count} despesas, de ${r.period.start} a ${r.period.end}.`;
  case 'projetar_despesas':return `Estimativa até ${r.period.end}: ${brl(r.projectedExpenseCents)}. Base: ${brl(r.observedExpenseCents)} registrados em ${r.elapsedDays} dias de um período de ${r.totalDays} dias. Premissa: ${r.assumption}${r.limitedData?' Poucos registros: a projeção pode não representar seu ritmo real.':''}`;
  case 'atualizar_preferencias':return `Preferências atualizadas: ${r.preferences.style} · ${r.preferences.detail} · ${r.preferences.proactivity}.`;
  case 'definir_objetivo':return `Objetivo fictício definido: ${r.goal.description}, ${brl(Math.round(r.goal.amount*100))}${r.goal.targetDate?` até ${r.goal.targetDate}`:''}.`;
  default:return detail==='curto'?'Consulta concluída.':'Ferramenta simulada concluída com sucesso.';
 }
}
export function renderAnswer(steps:Step[],draft:string,session:Session,intent=classifyIntent('')):string {
 const success=steps.filter(s=>s.status==='success');
 // Financial values/facts are rendered by the system, never copied from model prose.
 const facts=success.map(s=>readable(s,session.state.preferences.detail)).join('\n\n');
 const analysis=success.find(s=>s.name==='resumir_financas');
 const expenseSummary=analysis?.result as {categories?:{category:string;expenseCents:number}[];expenseCents?:number}|undefined;
 let advice='';
 if(intent==='orientacao'&&expenseSummary?.expenseCents){const top=expenseSummary.categories?.find(c=>c.expenseCents>0);if(top)advice=session.state.preferences.detail==='curto'?`${top.category} lidera estes registros. Vale separar o essencial do ajustável. A amostra é pequena; sem renda e necessidades, não dá para julgar seu gasto.`:`${top.category} concentra a maior parcela destes registros. Antes de cortar gastos, vale separar o essencial do que você quer ajustar. Qual é sua prioridade financeira? Não dá para dizer que você gasta demais sem conhecer sua renda e suas necessidades.`;}
 if(success.some(s=>s.name==='simular_compra')&&intent==='orientacao')advice='A compra reduz o dinheiro disponível. Pode fazer sentido se for importante agora; se esse valor for sua reserva para imprevistos, eu consideraria preservar mais caixa. Quais despesas essenciais ainda precisam ser cobertas?';
 if(intent==='orientacao'&&advice&&session.state.preferences.explanation==='completa')advice+=' Essa perspectiva considera apenas os valores informados ou registrados; renda, compromissos futuros e necessidades pessoais podem mudar a decisão.';
 if(intent==='orientacao'&&advice&&session.state.preferences.examples)advice+=' Por exemplo, adiar a compra ou buscar uma alternativa pode preservar caixa para despesas essenciais.';
 const sanitized=/\d|R\$|por cento|porcento|reais|centavos|saldo|(despesas|gastos) (aument|cresc|diminu)|voce (gastou|recebeu|tem)|registrei|registrad[oa]|registramos|lancei|salvei|recorded|registered|pagamento (efetuado|concluido)/i.test(normalize(draft))?'':draft.trim().slice(0,900);
 if(!success.length&&intent==='execucao')return 'Informe um valor positivo e uma descrição para registrar. A data padrão é a data de hoje indicada no laboratório.';
 if(!success.length)return sanitized||'Preciso de mais contexto para responder com segurança. O que você quer consultar ou registrar?';
 // Recommendations are grounded in computed summary; LLM wording remains useful for general conversation.
 return [facts,advice||(['execucao','consulta','confirmacao'].includes(intent)?'':session.state.preferences.style==='direto'?'':sanitized)].filter(Boolean).join('\n\n');
}
function remember(call:ValidCall,session:Session){
 if(call.name==='registrar_transacao')session.memory.transactionDate=call.arguments.date as string;
 if(call.name==='consultar_saldo')session.memory.topic='saldo';
 const p=call.arguments.period as {start:string;end:string}|undefined;
 if(p){session.memory.periods=[p,...session.memory.periods.filter(v=>JSON.stringify(v)!==JSON.stringify(p))].slice(0,2);session.memory.topic=call.name==='resumir_financas'&&call.arguments.type==='receita'?'receitas':call.name==='resumir_financas'?'despesas':'analise';}
 if(call.name==='comparar_periodos')session.memory.periods=[call.arguments.periodA,call.arguments.periodB] as Session['memory']['periods'];
}
export async function runConversation(provider:Provider,sessionInput:Session|undefined,message:string,requestId:string,today:string,options:{failTools?:boolean;limits?:Partial<typeof LIMITS>}={}){
 const session=structuredClone(sessionSchema.parse(sessionInput||createSession())),limits={...LIMITS,...options.limits},started=performance.now(),steps:Step[]=[];
 const personalityIntent=classifyIntent(message);let interpretationSource:Trace['interpretationSource']=provider.mode==='real'?'model':undefined;let confirmation:Trace['confirmation']='none',directAnswer:string|undefined;
 const base={requestId,mode:provider.mode,intent:'Conversa financeira',durationMs:0};
 const hash=await messageHash(message),previous=session.lastRequests.find(r=>r.id===requestId);
 if(previous){if(previous.messageHash!==hash)throw new Error('IDEMPOTENCY_CONFLICT');return {session,trace:previous.trace as Trace};}
 const core=new FinancialCoreV2(session.state),usage={inputTokens:0,outputTokens:0,totalTokens:0};let model:string|undefined,status:Trace['status']='success',draft='',errorCode:string|undefined;
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),limits.timeoutMs);const seen=new Set<string>();
 const msgs:ModelMessage[]=[...session.history.slice(-10),{role:'user',content:message}];
 async function execute(raw:{id:string;name:string;arguments:unknown}){
  const start=performance.now(),step:Step={order:steps.length+1,id:raw.id,name:raw.name,status:'error',durationMs:0};
  try {
   if(steps.length>=limits.tools)throw new Error('TOOL_LIMIT');
   const call=validateCall(normalizeTransactionCall(raw,message,today,session));

   step.arguments=call.arguments;
   if(personalityIntent==='execucao'&&call.name!=='registrar_transacao'){step.status='blocked';throw new Error('INTENT_TOOL_NOT_ALLOWED');}
   if((personalityIntent!=='execucao'&&call.name==='registrar_transacao')||!authorizeWrite(call,message,today,session)){step.status='blocked';step.error={code:'WRITE_NOT_AUTHORIZED',reason:call.name==='registrar_transacao'?transactionAuthorizationFailure(call,message,today,session)||'INTENT_MISMATCH':'WRITE_SCOPE_MISMATCH',message:'Os argumentos da ferramenta não correspondem ao pedido atual. Nenhuma transação foi registrada.'};throw new Error('WRITE_NOT_AUTHORIZED');}
   const signature=JSON.stringify({name:call.name,arguments:call.arguments});
   if(seen.has(signature))throw new Error('LOOP_DETECTED');seen.add(signature);
   if(options.failTools)throw new Error('EXECUTION_FAILED');
   step.result=core.execute(call,`${requestId}:${signature}`);step.status='success';remember(call,session);
  }catch(error){const code=error instanceof Error?error.message:'EXECUTION_FAILED';const safeCodes=['INTENT_TOOL_NOT_ALLOWED','UNKNOWN_TOOL','TOOL_LIMIT','WRITE_NOT_AUTHORIZED','LOOP_DETECTED','EXECUTION_FAILED','IDEMPOTENCY_CONFLICT','SESSION_FULL','INVALID_PROJECTION_DATE'];step.error=step.error||{code:safeCodes.includes(code)?code:'VALIDATION_FAILED',message:code==='WRITE_NOT_AUTHORIZED'?'O pedido atual não autoriza estes argumentos. Nenhuma transação foi registrada.':code==='LOOP_DETECTED'?'Chamada repetida bloqueada.':code==='EXECUTION_FAILED'?'Falha simulada; esta ferramenta não foi executada.':'Ferramenta ou argumentos inválidos; esta chamada não alterou dados.'};if(error instanceof z.ZodError)step.error.issues=error.issues.slice(0,8).map(issue=>({field:['type','amount','description','date','category'].includes(String(issue.path[0]))?String(issue.path[0]):'arguments',code:issue.code}));}
  step.durationMs=Math.round(performance.now()-start);steps.push(step);return step;
 }
 try{
  const confirm=isConfirmation(message);
  const op=session.memory.operation;
  if(!confirm)session.memory.operation=undefined;
  if(op&&Date.now()>=op.expiresAt){session.memory.operation=undefined;confirmation='expired';}
  if(isClear(message)){clearContext(session);directAnswer='Conversa limpa. Os dados fictícios foram preservados.';}
  else if(isCancellation(message)){session.memory.operation=undefined;session.memory.pending=undefined;confirmation='cancelled';directAnswer='Operação cancelada. Os registros foram preservados.';}
  else if(confirm&&op){session.memory.operation=undefined;session.memory.pending=undefined;if(confirmation==='expired'){directAnswer='A confirmação expirou. Solicite a alteração novamente.';}else{if(options.failTools)throw new Error('EXECUTION_FAILED');const result=core.confirm(op);steps.push({order:1,id:op.id,name:op.kind==='goal'?'alterar_objetivo':op.kind==='delete'?'excluir_transacao':'editar_transacao',arguments:{operationId:op.id},status:'success',result,durationMs:0});confirmation='confirmed';}}
  else if(confirm&&!session.memory.pending){directAnswer='Não há operação pendente válida para confirmar.';}
  else if(personalityIntent==='alteracao'||(session.state.goal&&requestedGoal(message))){session.memory.pending=undefined;session.memory.operation=undefined;const prepared=prepareOperation(message,session);session.memory.operation=prepared.operation;directAnswer=prepared.message;status='clarification';confirmation=prepared.operation?'pending':'none';}
  else if(personalityIntent==='preferencias'&&/sem (perguntar|confirmacao)|nao.*pedir confirmacao/.test(normalize(message))){directAnswer='Posso ser breve, mas alterações e exclusões continuam exigindo confirmação explícita.';}
  else if(/(quais|minhas|consultar).*preferencias/.test(normalize(message))){directAnswer='Preferências: '+JSON.stringify(session.state.preferences);}
  else if(purchaseImpact(message)){await execute({id:crypto.randomUUID(),name:'simular_compra',arguments:purchaseImpact(message)});}
  else if(confirm&&session.memory.pending){const expected=session.memory.pending;session.memory.pending=undefined;const current=`${expected.type==='despesa'?'Gastei':'Recebi'} ${expected.amount.toFixed(2)} em ${expected.description} ${expected.date}`;const parsed=explicitTransaction(current,today,session);if(!parsed)throw new Error('VALIDATION_FAILED');const call=validateCall({id:crypto.randomUUID(),name:'registrar_transacao',arguments:parsed});if(options.failTools)throw new Error('EXECUTION_FAILED');const result=core.execute(call,`${requestId}:confirmed`);steps.push({order:1,...call,result,status:'success',durationMs:0});remember(call,session);}
  else {
   session.memory.pending=undefined;session.memory.operation=undefined;
   const expected=explicitTransaction(message,today,session);
   const duplicate=expected&&session.lastRequests.some(r=>r.messageHash===hash&&(r.trace as Trace)?.steps?.some(s=>s.name==='registrar_transacao'&&s.status==='success'));
   if(duplicate){session.memory.pending=expected;status='clarification';directAnswer='Esta mensagem já foi registrada nesta sessão. Quer confirmar que é uma segunda despesa/receita igual? Responda “confirmar” para um novo registro fictício.';}
   else {
    const pref=requestedPreferences(message,session.state.preferences);
    if(pref){await execute({id:crypto.randomUUID(),name:'atualizar_preferencias',arguments:pref});}
    else for(let i=0;i<limits.steps;i++){
     if(controller.signal.aborted)throw new Error('OPENAI_TIMEOUT');
     if(msgs.reduce((n,m)=>n+(m.content?.length||0),0)>42000)throw new Error('CONTEXT_LIMIT');
     const next=await Promise.race([provider.next(msgs,session,controller.signal),new Promise<never>((_,reject)=>{const abort=()=>reject(new Error('OPENAI_TIMEOUT'));if(controller.signal.aborted)abort();else controller.signal.addEventListener('abort',abort,{once:true});})]);
     model=next.model||model;for(const key of ['inputTokens','outputTokens','totalTokens'] as const)usage[key]+=next.usage?.[key]||0;
     if(usage.totalTokens>limits.tokens)throw new Error('TOKEN_LIMIT');
     if(!next.calls?.length){if(personalityIntent==='execucao'&&expected&&!steps.length){interpretationSource='deterministic_fallback';const result=await execute({id:crypto.randomUUID(),name:'registrar_transacao',arguments:expected});if(result.status!=='success'){status='error';errorCode=result.error?.code;}break;}draft=next.content||'';if(!steps.length&&/[?]|preciso|qual /i.test(draft))status='clarification';break;}
     if(next.calls.length>limits.tools-steps.length)throw new Error('TOOL_LIMIT');
     msgs.push({role:'assistant',content:null,tool_calls:next.calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.arguments)}}))});
     for(const call of next.calls){const result=await execute(call);msgs.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(result.status==='success'?{ok:true,result:result.result}:{ok:false,error:result.error})});if(result.status!=='success'){errorCode=result.error?.code;status=errorCode==='WRITE_NOT_AUTHORIZED'?'clarification':'error';}}
     if(status!=='success')break;
     if(i===limits.steps-1)throw new Error('STEP_LIMIT');
    }
   }
  }
 }catch(error){status='error';const code=error instanceof Error?error.message:'INTERPRETATION_FAILED';errorCode=/^[A-Z_]{3,50}$/.test(code)?code:'INTERPRETATION_FAILED';}
 finally {clearTimeout(timer);}
 session.state=core.snapshot();
 if(personalityIntent==='execucao'&&!steps.length&&!errorCode)status='clarification';
 let answer=directAnswer||renderAnswer(steps,draft,session,personalityIntent);
 if(status==='error')answer=[steps.filter(s=>s.status==='success').map(s=>readable(s,session.state.preferences.detail)).join('\n\n'),errorMessage(errorCode||'EXECUTION_FAILED')].filter(Boolean).join('\n\n');
 if(status==='clarification'&&steps.some(s=>s.status==='blocked'))answer=steps.find(s=>s.status==='blocked')!.error!.message;
 const intent=steps.length>1?'Análise com múltiplas ferramentas':steps[0]?.name==='registrar_transacao'?'Registro financeiro':steps[0]?.name==='atualizar_preferencias'?'Preferência explícita':steps[0]?.name==='comparar_periodos'?'Comparação de períodos':steps.length?'Consulta financeira':status==='clarification'?'Esclarecimento necessário':'Conversa';
 const trace:Trace={...base,interpretationSource,intent:personalityIntent==='conversa'?intent:personalityIntent,proactivity:session.state.preferences.proactivity,pendingOperation:session.memory.operation,confirmation,status,message:answer,steps,durationMs:Math.round(performance.now()-started),model,usage:provider.mode==='real'?usage:undefined,errorCode};
 session.history=[...session.history,{role:'user' as const,content:message.slice(0,1800)},{role:'assistant' as const,content:answer.slice(0,1800)}].slice(-10);
 session.lastRequests=[...session.lastRequests,{id:requestId,messageHash:hash,trace}].slice(-4);return {session,trace};
}
