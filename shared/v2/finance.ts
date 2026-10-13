import {financialState,validateCall,normalize,type State,type Call,type Period} from './contracts.js';
const cents=(n:number)=>Math.round(n*100);
export const initialState=():State=>({initialBalanceCents:250000,transactions:[],preferences:{style:'descontraido',detail:'curto'}});
export const balanceCents=(state:State)=>state.initialBalanceCents+state.transactions.reduce((n,t)=>n+cents(t.amount)*(t.type==='receita'?1:-1),0);
export function summary(state:State,period:Period,type?:'receita'|'despesa'){
 const transactions=state.transactions.filter(t=>t.date>=period.start&&t.date<=period.end&&(!type||type===t.type));
 const incomeCents=transactions.filter(t=>t.type==='receita').reduce((n,t)=>n+cents(t.amount),0),expenseCents=transactions.filter(t=>t.type==='despesa').reduce((n,t)=>n+cents(t.amount),0);
 const groups=new Map<string,{category:string;expenseCents:number;incomeCents:number;count:number}>();
 for(const t of transactions){const label=t.category||'sem categoria',key=normalize(label),g=groups.get(key)||{category:label,expenseCents:0,incomeCents:0,count:0};g[t.type==='receita'?'incomeCents':'expenseCents']+=cents(t.amount);g.count++;groups.set(key,g);}
 const categories=[...groups.values()].sort((a,b)=>b.expenseCents-a.expenseCents).map(g=>({...g,expenseSharePercent:expenseCents?Math.round(g.expenseCents/expenseCents*10000)/100:null}));
 return {period,incomeCents,expenseCents,netCents:incomeCents-expenseCents,count:transactions.length,categories,limitedData:transactions.length<10};
}
export function compare(state:State,a:Period,b:Period,metric:'receitas'|'despesas'|'resultado'){
 const sa=summary(state,a),sb=summary(state,b),key=metric==='receitas'?'incomeCents':metric==='despesas'?'expenseCents':'netCents';const valueACents=sa[key],valueBCents=sb[key];
 return {periodA:a,periodB:b,metric,valueACents,valueBCents,differenceCents:valueACents-valueBCents,absoluteDifferenceCents:Math.abs(valueACents-valueBCents),percentChange:valueBCents!==0?Math.round((valueACents-valueBCents)/Math.abs(valueBCents)*10000)/100:null,countA:sa.count,countB:sb.count,limitedData:sa.limitedData||sb.limitedData};
}
export function projection(state:State,period:Period,asOf:string){
 if(asOf<period.start||asOf>period.end)throw new Error('INVALID_PROJECTION_DATE');
 const days=(a:string,b:string)=>Math.round((Date.parse(b+'T12:00:00Z')-Date.parse(a+'T12:00:00Z'))/86400000)+1;
 const elapsedDays=days(period.start,asOf),totalDays=days(period.start,period.end);if(totalDays>3660)throw new Error('INVALID_PROJECTION_DATE');const s=summary(state,{start:period.start,end:asOf},'despesa');
 return {period,asOf,observedExpenseCents:s.expenseCents,projectedExpenseCents:Math.round(s.expenseCents/elapsedDays*totalDays),elapsedDays,totalDays,count:s.count,estimate:true,assumption:'Média diária desde o início do período, mantida até o fim; inclui dias sem registros.',limitedData:s.count<10};
}
export class FinancialCoreV2 {
 private state:State;private completed=new Map<string,{payload:string;result:unknown}>();
 constructor(state:State=initialState()){this.state=structuredClone(financialState.parse(state));}
 snapshot(){return structuredClone(this.state);}
 execute(raw:Call,executionId:string):unknown {
  const call=validateCall(raw),payload=JSON.stringify({name:call.name,arguments:call.arguments}),existing=this.completed.get(executionId);
  if(existing){if(existing.payload!==payload)throw new Error('IDEMPOTENCY_CONFLICT');return structuredClone(existing.result);}
  const a=call.arguments;let result:unknown;
  switch(call.name){
   case 'consultar_saldo':result={balanceCents:balanceCents(this.state),currency:'BRL'};break;
   case 'registrar_transacao':{if(this.state.transactions.length>=300)throw new Error('SESSION_FULL');const transaction={...a,id:crypto.randomUUID()} as State['transactions'][number];this.state.transactions.push(transaction);result={transaction,balanceCents:balanceCents(this.state)};break;}
   case 'listar_transacoes':{const p=a.period as Period|undefined;const items=this.state.transactions.filter(t=>(!a.type||t.type===a.type)&&(!p||(t.date>=p.start&&t.date<=p.end)));result={transactions:items.slice(-(a.limit as number)).reverse(),totalCount:items.length,returnedCount:Math.min(items.length,a.limit as number)};break;}
   case 'resumir_financas':result=summary(this.state,a.period as Period,a.type as 'receita'|'despesa'|undefined);break;
   case 'comparar_periodos':result=compare(this.state,a.periodA as Period,a.periodB as Period,a.metric as 'receitas'|'despesas'|'resultado');break;
   case 'consultar_gastos_categoria':{const p=a.period as Period,transactions=this.state.transactions.filter(t=>t.type==='despesa'&&normalize(t.category||'sem categoria')===normalize(a.category as string)&&t.date>=p.start&&t.date<=p.end);result={category:a.category,period:p,totalCents:transactions.reduce((n,t)=>n+cents(t.amount),0),count:transactions.length,transactions};break;}
   case 'projetar_despesas':result=projection(this.state,a.period as Period,a.asOf as string);break;
   case 'atualizar_preferencias':this.state.preferences=a as State['preferences'];result={preferences:this.state.preferences};break;
   case 'definir_objetivo':this.state.goal=a as State['goal'];result={goal:this.state.goal};break;
  }
  this.completed.set(executionId,{payload,result:structuredClone(result)});return result;
 }
}
