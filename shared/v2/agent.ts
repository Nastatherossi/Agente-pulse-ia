import {observeMemory,observeStyle,conversationTone,retrieveMemories,memoryContext,memoryCommand} from './memory-engine.js';
import {z} from 'zod';
import {createSession,sessionSchema,validateModelCall,brl,WRITE_TOOLS,type Session,type Trace,type Step,type Provider,type ModelMessage,type ModelCall,type PendingOperation} from './contracts.js';
import {FinancialCoreV2} from './finance.js';
import {isConfirmation,isCancellation,isClear,clearContext,describeOperation,type Intent} from './personality.js';
import {amountsIn,riskSignal,decideCreate,decidePreferences,decideGoal,prepareChange,goalOperation,createOperation,blockedMessage,confirmLead,type PolicyContext} from './policy.js';
import {groundedText,withoutNumbers,asksToConfirmInText} from './grounding.js';
/** Tool errors the model can fix by itself: the error (with the schema message) goes back to it for another try. */
const RETRYABLE=new Set(['VALIDATION_FAILED','UNKNOWN_TOOL']);
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
  case 'registrar_confirmado':return `${detail==='curto'?'Registrado':'Registro concluído'}: ${r.created.map((t:any)=>`${t.description}, ${brl(Math.round(t.amount*100))}`).join('; ')}.`;
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
/** Tools whose success means data changed this turn: the answer is the code-written receipt, nothing else. */
const DATA_WRITES=new Set(['registrar_transacao','registrar_confirmado','editar_transacao','excluir_transacao','alterar_objetivo','definir_objetivo','atualizar_preferencias']);
/** Plain lookups: the code-written facts answer the question; model commentary is not appended (discreet by default). */
const LOOKUPS=new Set(['consultar_saldo','listar_transacoes','consultar_gastos_categoria']);
export type AnswerContext={message?:string;history?:string[]};
/**
 * Financial values and receipts are rendered by code from validated tool results, never copied from the model.
 * The model's own words are kept for conversation and analysis, sentence by sentence, after grounding (grounding.ts).
 */
export function renderAnswer(steps:Step[],draft:string,session:Session,context:AnswerContext={}):string {
 const success=steps.filter(s=>s.status==='success');
 const facts=success.map(s=>readable(s,session.state.preferences.detail)).join('\n\n');
 const wroteData=success.some(s=>DATA_WRITES.has(s.name));
 const lookupOnly=success.length>0&&success.every(s=>LOOKUPS.has(s.name));
 const grounding={message:context.message||'',history:context.history??session.history.filter(h=>h.role==='user').map(h=>h.content),steps,wroteData};
 if(!success.length)return groundedText(draft,grounding)||'Pode me contar um pouco mais?';
 const commentary=wroteData||lookupOnly?'':withoutNumbers(groundedText(draft,grounding));
 return [facts,commentary].filter(Boolean).join('\n\n');
}
function remember(call:{name:string;arguments:Record<string,unknown>},session:Session){
 if(call.name==='registrar_transacao')session.memory.transactionDate=call.arguments.date as string;
 if(call.name==='consultar_saldo')session.memory.topic='saldo';
 const p=call.arguments.period as {start:string;end:string}|undefined;
 if(p){session.memory.periods=[p,...session.memory.periods.filter(v=>JSON.stringify(v)!==JSON.stringify(p))].slice(0,2);session.memory.topic=call.name==='resumir_financas'&&call.arguments.type==='receita'?'receitas':call.name==='resumir_financas'?'despesas':'analise';}
 if(call.name==='comparar_periodos')session.memory.periods=[call.arguments.periodA,call.arguments.periodB] as Session['memory']['periods'];
}
/**
 * Several registrar_transacao calls in ONE model response describe one user message with several records.
 * They are merged into a single registrar_varios proposal so they are confirmed and applied together (atomic),
 * instead of the first being written and the rest left behind.
 */
function mergeCreates(calls:{id:string;name:string;arguments:unknown}[]){
 const creates=calls.filter(c=>c.name==='registrar_transacao'&&c.arguments&&typeof c.arguments==='object'&&!Array.isArray(c.arguments));
 if(creates.length<2)return calls;
 const args=creates.map(c=>c.arguments as Record<string,unknown>);
 const natureza=args.find(a=>a.natureza!=='fato_ocorrido')?.natureza??'fato_ocorrido';
 const merged={id:creates[0].id,name:'registrar_varios',arguments:{natureza,lancamentos:args.slice(0,5).map(({natureza:_,...item})=>item)}};
 return [merged,...calls.filter(c=>!creates.includes(c))];
}
export async function runConversation(provider:Provider,sessionInput:Session|undefined,message:string,requestId:string,today:string,options:{failTools?:boolean;limits?:Partial<typeof LIMITS>}={}){
 const session=structuredClone(sessionSchema.parse(sessionInput||createSession())),limits={...LIMITS,...options.limits},started=performance.now(),steps:Step[]=[];
 const base={requestId,mode:provider.mode,durationMs:0};
 const hash=await messageHash(message),previous=session.lastRequests.find(r=>r.id===requestId);
 if(previous){if(previous.messageHash!==hash)throw new Error('IDEMPOTENCY_CONFLICT');return {session,trace:previous.trace as Trace};}
 // Auxiliary signal only: in a turn that shows emotional risk no financial machinery runs, and the model answers.
 const risk=riskSignal(message);
 const interpretationSource:Trace['interpretationSource']=provider.mode==='real'?'model':undefined;
 let confirmation:Trace['confirmation']='none',directAnswer:string|undefined,pendingAnswer:string|undefined,blockedAnswer:string|undefined,kind:Intent|undefined;
 const repeatedMessage=session.lastRequests.some(r=>r.messageHash===hash&&(r.trace as Trace)?.steps?.some(s=>(s.name==='registrar_transacao'||s.name==='registrar_confirmado')&&s.status==='success'));
 const priorHistory=session.history.length;const command=memoryCommand(session,message);const contextInvalidated=command!==undefined&&priorHistory>0&&session.history.length===0;
 if(command===undefined&&!risk)observeMemory(session,message);
 const retrieved=retrieveMemories(session,message,'conversa'),tone=conversationTone(session,message);
 const core=new FinancialCoreV2(session.state),usage={inputTokens:0,outputTokens:0,totalTokens:0};
 let model:string|undefined,status:Trace['status']='success',draft='',errorCode:string|undefined,writesThisTurn=0,modelCalls=0,retries=0,nudges=0;
 const hints=new Map<string,string>(); // validation messages for the model only; never logged or returned
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),limits.timeoutMs);const seen=new Set<string>();
 const msgs:ModelMessage[]=[...session.history.slice(-10),{role:'user',content:message}];
 // A bare "sim" may take values from the user's previous message only when that message was NOT already
 // recorded (the model had asked in plain text). Otherwise "sim" after a receipt would propose a duplicate.
 const lastTrace=session.lastRequests.at(-1)?.trace as Trace|undefined;
 const previousTurnWrote=Boolean(lastTrace?.steps?.some(s=>s.status==='success'&&DATA_WRITES.has(s.name)));
 const previousUserMessage=previousTurnWrote?undefined:[...session.history].reverse().find(h=>h.role==='user')?.content;
 const policyContext=():PolicyContext=>({message,today,session:{...session,state:core.snapshot()},risk,repeatedMessage,writesThisTurn,previousUserMessage,affirmation:isConfirmation(message)});
 const hold=(op:PendingOperation,text:string,label:Intent)=>{session.memory.operation=op;pendingAnswer=text;confirmation='pending';status='clarification';kind=label;};
 const refuse=(step:Step,reason:string|undefined)=>{step.status='blocked';step.error={code:'WRITE_NOT_AUTHORIZED',reason,message:blockedMessage(reason)};if(reason==='RISK_CONTEXT')return;
  // "sim" right after a receipt: the model tried to record it again. Nothing to do; say it is already there.
  if(previousTurnWrote&&isConfirmation(message)){blockedAnswer='Já está registrado. Quer anotar mais alguma coisa?';return;}
  blockedAnswer=blockedMessage(reason);status='clarification';};
 const run=(name:string,args:Record<string,unknown>,step:Step,signature:string)=>{step.result=core.execute({id:step.id,name,arguments:args},`${requestId}:${signature}`);step.status='success';remember({name,arguments:args},session);};
 /** Model proposals are validated, then routed by the deterministic policy. Nothing is written because the model asked. */
 function handleWrite(call:ModelCall,step:Step,signature:string){
  const ctx=policyContext();
  if(call.name==='registrar_transacao'||call.name==='registrar_varios'){
   const d=decideCreate(call,ctx);
   if(d.decision==='execute'){run('registrar_transacao',{...d.entries![0]},step,signature);writesThisTurn++;return;}
   if(d.decision==='confirm'){const op=createOperation(d.entries!);hold(op,describeOperation(op,confirmLead(d.reason)),'execucao');step.status='blocked';step.error={code:'CONFIRMATION_REQUIRED',reason:d.reason,message:'Aguardando confirmação explícita; nada foi registrado.'};return;}
   return refuse(step,d.reason);
  }
  if(call.name==='propor_edicao_transacao'||call.name==='propor_exclusao_transacao'){
   const r=prepareChange(call,ctx);
   if(r.operation){hold(r.operation,describeOperation(r.operation),'alteracao');step.status='blocked';step.error={code:'CONFIRMATION_REQUIRED',reason:'CHANGE_EXISTING_RECORD',message:'Aguardando confirmação explícita; nada foi alterado.'};return;}
   return refuse(step,r.reason);
  }
  if(call.name==='atualizar_preferencias'){
   const d=decidePreferences(call,ctx);if(d.decision!=='execute')return refuse(step,d.reason);
   run('atualizar_preferencias',d.preferences!,step,signature);
   if(call.arguments.redefinir)session.narrative.style.explicitStyle=false;else if(call.arguments.style)session.narrative.style.explicitStyle=true;
   return;
  }
  if(call.name==='definir_objetivo'){
   const d=decideGoal(call,ctx);
   if(d.decision==='execute'){run('definir_objetivo',{...d.goal!},step,signature);writesThisTurn++;return;}
   if(d.decision==='confirm'){const op=goalOperation(d.goal!,core.snapshot());hold(op,describeOperation(op),'alteracao');step.status='blocked';step.error={code:'CONFIRMATION_REQUIRED',reason:d.reason,message:'Aguardando confirmação explícita; nada foi alterado.'};return;}
   return refuse(step,d.reason);
  }
 }
 async function execute(raw:{id:string;name:string;arguments:unknown}){
  const start=performance.now(),step:Step={order:steps.length+1,id:raw.id,name:raw.name,status:'error',durationMs:0};
  try {
   if(steps.length>=limits.tools)throw new Error('TOOL_LIMIT');
   if(pendingAnswer)throw new Error('PENDING_OPERATION_EXISTS');
   const call=validateModelCall(raw);
   step.arguments=call.arguments;
   const signature=JSON.stringify({name:call.name,arguments:call.arguments});
   if(seen.has(signature))throw new Error('LOOP_DETECTED');seen.add(signature);
   if(options.failTools)throw new Error('EXECUTION_FAILED');
   // "available" is the user's own money only when the user said it; otherwise the core uses the session balance
   // (the model was filling it with the balance it had looked up and the answer said "valor informado nesta mensagem").
   if(call.name==='simular_compra'&&call.arguments.available!=null&&!amountsIn(message).some(v=>Math.round(v*100)===Math.round(Number(call.arguments.available)*100)))delete call.arguments.available;
   if(WRITE_TOOLS.has(call.name))handleWrite(call,step,signature);
   else run(call.name,call.arguments,step,signature);
  }catch(error){const code=error instanceof Error?error.message:'EXECUTION_FAILED';const safeCodes=['UNKNOWN_TOOL','TOOL_LIMIT','LOOP_DETECTED','EXECUTION_FAILED','IDEMPOTENCY_CONFLICT','SESSION_FULL','INVALID_PROJECTION_DATE','CONFIRMATION_REQUIRED','PENDING_OPERATION_EXISTS'];step.error={code:safeCodes.includes(code)?code:'VALIDATION_FAILED',message:code==='LOOP_DETECTED'?'Chamada repetida bloqueada.':code==='EXECUTION_FAILED'?'Falha simulada; esta ferramenta não foi executada.':'Ferramenta ou argumentos inválidos; esta chamada não alterou dados.'};if(error instanceof z.ZodError)hints.set(step.id,error.issues.slice(0,4).map(i=>`${i.path.join('.')}: ${i.message}`).join('; ').slice(0,400));if(error instanceof z.ZodError)step.error.issues=error.issues.slice(0,8).map(issue=>({field:['type','amount','description','date','category','evidencia','natureza'].includes(String(issue.path[0]))?String(issue.path[0]):'arguments',code:issue.code}));}
  step.durationMs=Math.round(performance.now()-start);steps.push(step);return step;
 }
 try{
  const op=session.memory.operation;session.memory.operation=undefined;session.memory.pending=undefined; // a pending operation lives for exactly one reply
  const live=Boolean(op&&Date.now()>=op.createdAt&&Date.now()<op.expiresAt);
  const yes=!risk&&isConfirmation(message),no=!risk&&isCancellation(message);
  if(command!==undefined){directAnswer=command;}
  else if(isClear(message)){clearContext(session);directAnswer='Conversa limpa. Os dados fictícios foram preservados.';}
  else if(op&&!live&&(yes||no)){confirmation='expired';kind='confirmacao';directAnswer=yes?'A confirmação expirou. Solicite a alteração novamente.':'Tudo bem. Nada foi alterado.';}
  else if(op&&live&&no){confirmation='cancelled';kind='confirmacao';directAnswer='Operação cancelada. Os registros foram preservados.';}
  else if(op&&live&&yes){
   kind='confirmacao';if(options.failTools)throw new Error('EXECUTION_FAILED');
   const result=core.confirm(op!);
   steps.push({order:1,id:op!.id,name:op!.kind==='create'?'registrar_confirmado':op!.kind==='goal'?'alterar_objetivo':op!.kind==='delete'?'excluir_transacao':'editar_transacao',arguments:{operationId:op!.id},status:'success',result,durationMs:0});
   confirmation='confirmed';
  }
  else {
   // No pending operation (or an unrelated reply): yes/no, questions and everything else are interpreted by the model.
   if(op&&!live)confirmation='expired';
   for(let i=0;i<limits.steps;i++){
    if(controller.signal.aborted)throw new Error('OPENAI_TIMEOUT');
    if(msgs.reduce((n,m)=>n+(m.content?.length||0),0)>42000)throw new Error('CONTEXT_LIMIT');
    modelCalls++;
    const next=await Promise.race([provider.next(msgs,session,controller.signal),new Promise<never>((_,reject)=>{const abort=()=>reject(new Error('OPENAI_TIMEOUT'));if(controller.signal.aborted)abort();else controller.signal.addEventListener('abort',abort,{once:true});})]);
    model=next.model||model;for(const key of ['inputTokens','outputTokens','totalTokens'] as const)usage[key]+=next.usage?.[key]||0;
    if(usage.totalTokens>limits.tokens)throw new Error('TOKEN_LIMIT');
    if(!next.calls?.length){
     // The model asked to confirm a write in plain text (or imitated the system's confirmation) instead of
     // proposing it. Only the code may ask for confirmation, so it gets one nudge to use the tool or just answer.
     if(nudges<1&&asksToConfirmInText(next.content||'')&&i<limits.steps-1){nudges++;msgs.push({role:'assistant',content:next.content||''},{role:'system',content:'Não peça confirmação em texto. Se o usuário pediu para registrar, corrigir ou excluir um lançamento que existe, chame a ferramenta agora: o sistema mostra a confirmação. Se não há lançamento correspondente ou nada a fazer, responda normalmente, sem perguntar se deve registrar.'});continue;}
     draft=next.content||'';break;
    }
    if(next.calls.length>limits.tools-steps.length)throw new Error('TOOL_LIMIT');
    msgs.push({role:'assistant',content:null,tool_calls:next.calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.arguments)}}))});
    for(const call of mergeCreates(next.calls)){if(pendingAnswer||blockedAnswer)break;const result=await execute(call);msgs.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(result.status==='success'?{ok:true,result:result.result}:{ok:false,error:{...result.error,...(hints.get(result.id)?{hint:hints.get(result.id)}:{})}})});if(result.status==='error'){if(RETRYABLE.has(result.error?.code||'')){retries++;if(retries>2){errorCode=result.error?.code;status='error';}}else{errorCode=result.error?.code;status='error';}}}
    if(status!=='success'||pendingAnswer||blockedAnswer)break;
    // A completed write is answered by the code-written receipt and the model's follow-up text would be
    // discarded (renderAnswer). Skipping that second call halves the cost of a simple record.
    // Lookups still go back to the model: it may chain another tool (e.g. balance, then a summary).
    const round=steps.slice(-next.calls.length);
    if(round.length&&round.every(s=>s.status==='success'&&DATA_WRITES.has(s.name)))break;
    if(i===limits.steps-1)throw new Error('STEP_LIMIT');
   }
  }
 }catch(error){status='error';const code=error instanceof Error?error.message:'INTERPRETATION_FAILED';errorCode=/^[A-Z_]{3,50}$/.test(code)?code:'INTERPRETATION_FAILED';}
 finally {clearTimeout(timer);}
 session.state=core.snapshot();
 status=status as Trace['status']; // assigned inside closures above; widen for flow analysis
 const success=steps.filter(s=>s.status==='success');
 if(command===undefined&&!risk&&!steps.length&&!pendingAnswer&&!directAnswer)observeStyle(session,message);
 let answer=directAnswer||pendingAnswer||blockedAnswer||renderAnswer(steps,draft,session,{message,history:session.history.filter(h=>h.role==='user').map(h=>h.content)});
 if(status==='error'){answer=[success.map(s=>readable(s,session.state.preferences.detail)).join('\n\n'),errorMessage(errorCode||'EXECUTION_FAILED')].filter(Boolean).join('\n\n');if(session.memory.operation&&!pendingAnswer)session.memory.operation=undefined;}
 // Trace label derived from what actually happened in the turn (no keyword classifier decides anything).
 const analytic=success.some(s=>['resumir_financas','comparar_periodos','projetar_despesas','simular_compra'].includes(s.name));
 kind=kind||(success.some(s=>DATA_WRITES.has(s.name)&&s.name!=='atualizar_preferencias')?'execucao':success.some(s=>s.name==='atualizar_preferencias')?'preferencias':analytic&&answer.length>success.map(s=>readable(s,session.state.preferences.detail)).join('\n\n').length?'orientacao':success.length?'consulta':'conversa');
 const label=steps.length>1?'Análise com múltiplas ferramentas':steps[0]?.name==='registrar_transacao'?'Registro financeiro':steps[0]?.name==='atualizar_preferencias'?'Preferência explícita':steps[0]?.name==='comparar_periodos'?'Comparação de períodos':steps.length?'Consulta financeira':status==='clarification'?'Esclarecimento necessário':'Conversa aberta';
 const trace:Trace={...base,respondedBy:modelCalls>0&&provider.mode==='real'?'model':'code',modelCalls,contextInvalidated,retrievedMemoryIds:retrieved.map(r=>r.id),conversationTone:tone,memoryMetrics:{stored:session.narrative.records.length,retrieved:retrieved.length,contextCharacters:retrieved.length?JSON.stringify(memoryContext(retrieved)).length:0,extractionCalls:0},interpretationSource,intent:kind==='conversa'?label:kind,proactivity:session.state.preferences.proactivity,pendingOperation:session.memory.operation,confirmation,status,message:answer,steps,durationMs:Math.round(performance.now()-started),model,usage:provider.mode==='real'?usage:undefined,errorCode};
 session.history=[...session.history,{role:'user' as const,content:message.slice(0,1800)},{role:'assistant' as const,content:answer.slice(0,1800)}].slice(-10);
 session.lastRequests=[...session.lastRequests,{id:requestId,messageHash:hash,trace}].slice(-4);return {session,trace};
}
