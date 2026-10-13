import { stateSchema, toolCallSchema, type State, type ToolCall, type ToolAdapter, type ToolRequest, type ToolResponse } from './contracts';
export const initialState = ():State => ({initialBalanceCents:250000,transactions:[]});
export const balanceCents = (s:State) => s.initialBalanceCents + s.transactions.reduce((sum,t)=>sum + Math.round(t.amount*100)*(t.type==='receita'?1:-1),0);
export class FinancialCore {
  private state:State;
  constructor(state:State=initialState()) { this.state=structuredClone(stateSchema.parse(state)); }
  snapshot():State { return structuredClone(this.state); }
  execute(input:unknown):unknown {
    const call:ToolCall=toolCallSchema.parse(input);
    if(call.name==='consultar_saldo') return {balance:balanceCents(this.state)/100,currency:'BRL'};
    if(call.name==='listar_transacoes') return {transactions:this.state.transactions.filter(t=>!call.arguments.type||t.type===call.arguments.type).slice(-call.arguments.limit).reverse()};
    if(this.state.transactions.length>=1000) throw new Error('Limite da sessão');
    const transaction={...call.arguments,id:crypto.randomUUID()};
    this.state.transactions.push(transaction);
    return {transaction,balance:balanceCents(this.state)/100};
  }
}
export class SimulatedCloudflareAdapter implements ToolAdapter {
  private completed=new Map<string,{payload:string;response:ToolResponse}>();
  constructor(readonly core:FinancialCore,private fail=false) {}
  async execute(request:ToolRequest):Promise<ToolResponse> {
    if(request.version!=='1'||!/^[-a-f0-9]{36}$/.test(request.requestId)) return {requestId:request.requestId,ok:false,error:{code:'INVALID_REQUEST',message:'Contrato inválido',retryable:false}};
    const payload=JSON.stringify(request.call),previous=this.completed.get(request.requestId);
    if(previous) return previous.payload===payload?previous.response:{requestId:request.requestId,ok:false,error:{code:'IDEMPOTENCY_CONFLICT',message:'Identificador reutilizado com argumentos diferentes',retryable:false}};
    let response:ToolResponse;
    try { if(this.fail) throw new Error('Falha simulada'); response={requestId:request.requestId,ok:true,result:this.core.execute(request.call)}; }
    catch { response={requestId:request.requestId,ok:false,error:{code:this.fail?'EXECUTION_FAILED':'VALIDATION_FAILED',message:this.fail?'Falha de execução simulada. Nenhuma transação foi registrada.':'Ferramenta ou argumentos inválidos. Nada foi alterado.',retryable:this.fail}}; }
    this.completed.set(request.requestId,{payload,response}); return response;
  }
}
