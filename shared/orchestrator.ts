import { brl, decisionSchema, type ModelProvider, type ToolAdapter, type Trace } from './contracts';
export async function runAgent(provider:ModelProvider,adapter:ToolAdapter,message:string,today:string):Promise<Trace> {
 const start=performance.now(),requestId=crypto.randomUUID();
 const base={requestId,mode:provider.mode};
 try {
  const decision=decisionSchema.parse(await provider.interpret(message,today));
  if(!decision.call) return {...base,intent:decision.intent,status:'clarification',message:decision.clarification!,durationMs:Math.round(performance.now()-start)};
  const response=await adapter.execute({version:'1',requestId,call:decision.call});
  if(response.requestId!==requestId) throw new Error('Resposta sem correlação');
  let reply:string;
  if(!response.ok) reply=response.error.message;
  else {
   const result=response.result as {balance?:number;transaction?:{type:string;amount:number;description:string};transactions?:{type:string;amount:number;description:string;date:string}[]};
   if(decision.call.name==='consultar_saldo') { if(typeof result.balance!=='number') throw new Error(); reply=`Seu saldo fictício é ${brl(result.balance)}.`; }
   else if(decision.call.name==='registrar_transacao') { if(!result.transaction||typeof result.balance!=='number') throw new Error(); reply=`${result.transaction.type==='receita'?'Receita':'Despesa'} de ${brl(result.transaction.amount)} registrada: ${result.transaction.description}. Saldo fictício: ${brl(result.balance)}.`; }
   else { if(!Array.isArray(result.transactions)) throw new Error(); reply=result.transactions.length?result.transactions.map(t=>`${t.date} · ${t.description} · ${t.type==='receita'?'+':'−'} ${brl(t.amount)}`).join('\n'):'Nenhuma transação nesta sessão. Registre sua primeira receita ou despesa.'; }
  }
  return {...base,intent:decision.intent,call:decision.call,response,status:response.ok?'success':'error',message:reply,durationMs:Math.round(performance.now()-start)};
 } catch {return {...base,intent:'Execução interrompida',status:'error',message:'Não foi possível concluir a execução. Nenhum sucesso foi confirmado. Confira o saldo antes de tentar novamente.',durationMs:Math.round(performance.now()-start)};}
}
