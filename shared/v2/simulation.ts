import {normalize,type Provider,type ModelMessage,type Session,type ModelResult,todayBR} from './contracts.js';
import {explicitTransaction,resolvePeriod,monthPeriod,requestedGoal} from './policy.js';
const call=(name:string,args:unknown)=>({id:crypto.randomUUID(),name,arguments:args});
export class SimulationProviderV2 implements Provider {
 readonly mode='simulation' as const;
 constructor(private today=todayBR()){}
 async next(messages:ModelMessage[],session:Session):Promise<ModelResult>{
  const last=messages.at(-1);if(last?.role==='tool')return {content:'Podemos olhar o próximo passo juntos, sem julgar seus gastos.'};
  const message=last?.content||'',text=normalize(message);
  const write=explicitTransaction(message,this.today,session);if(write)return {calls:[call('registrar_transacao',write)]};
  if(/^(eu )?(gastei|paguei|recebi|ganhei|registre)\b/.test(text)&&!text.includes('?'))return {content:'Qual o valor, a descrição e a data? Se for uma hipótese, posso conversar sem registrar.'};
  const p=resolvePeriod(message,this.today,session.memory)||session.memory.periods[0]||monthPeriod(this.today);
  if(/diferenca|aumentaram|mais que|compar/.test(text))return {calls:[call('comparar_periodos',{periodA:session.memory.periods.length===2?session.memory.periods[1]:monthPeriod(this.today),periodB:session.memory.periods.length===2?session.memory.periods[0]:monthPeriod(this.today,-1),metric:'despesas'})]};
  if(/ritmo|projec|fim do mes/.test(text))return {calls:[call('projetar_despesas',{period:monthPeriod(this.today),asOf:this.today})]};
  if(/onde|categoria|como estao|financas|deveria fazer/.test(text))return {calls:[call('consultar_saldo',{}),call('listar_transacoes',{type:'despesa',limit:20,period:p}),call('resumir_financas',{period:p})]};
  if(/saldo/.test(text))return {calls:[call('consultar_saldo',{})]};
  if(/listar|extrato|transacoes/.test(text))return {calls:[call('listar_transacoes',{limit:20,...(/despesas/.test(text)?{type:'despesa'}:/receitas/.test(text)?{type:'receita'}:{})})]};
  const goal=requestedGoal(message);if(goal)return {calls:[call('definir_objetivo',goal)]};
  if(/gastei|gastos|gastei|gaste|despesas|quanto|e no|e na/.test(text)||(/^e\b/.test(text)&&session.memory.topic))return {calls:[call('resumir_financas',{period:p,type:/receita|recebi/.test(text)||session.memory.topic==='receitas'?'receita':'despesa'})]};
  if(/ola|oi|bom dia/.test(text))return {content:'Oi! Posso registrar seus lançamentos fictícios, comparar períodos e ajudar a entender o que aparece nos dados. Por onde começamos?'};
  return {content:'Me conta o que você quer entender ou registrar. Se a referência não estiver clara, vou pedir um detalhe antes de agir.'};
 }
}
