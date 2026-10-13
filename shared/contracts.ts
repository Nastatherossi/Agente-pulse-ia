import { z } from 'zod';
export const transactionArgs = z.object({ type: z.enum(['receita', 'despesa']), amount: z.number().finite().positive().max(1000000).refine(v => Math.abs(v * 100 - Math.round(v * 100)) < 0.00001, 'Use no máximo duas casas decimais'), description: z.string().trim().min(1).max(120), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(v + 'T12:00:00Z'); return !isNaN(d.getTime()) && d.toISOString().slice(0,10) === v; }, 'Data inválida') }).strict();
export const toolCallSchema = z.discriminatedUnion('name', [z.object({name:z.literal('consultar_saldo'),arguments:z.object({}).strict()}).strict(),z.object({name:z.literal('registrar_transacao'),arguments:transactionArgs}).strict(),z.object({name:z.literal('listar_transacoes'),arguments:z.object({type:z.enum(['receita','despesa']).optional(),limit:z.number().int().min(1).max(100).default(20)}).strict()}).strict()]);
export type ToolCall = z.infer<typeof toolCallSchema>;
export type Transaction = z.infer<typeof transactionArgs> & {id:string};
export type State = { initialBalanceCents:number; transactions:Transaction[] };
export const stateSchema = z.object({initialBalanceCents:z.number().int().min(0).max(100000000),transactions:z.array(transactionArgs.extend({id:z.string().uuid()})).max(1000)}).strict();
export const decisionSchema = z.object({intent:z.string().max(100),call:toolCallSchema.optional(),clarification:z.string().max(500).optional()}).strict().refine(v => Boolean(v.call) !== Boolean(v.clarification),'Informe chamada OU esclarecimento');
export type Decision = z.infer<typeof decisionSchema>;
export type ToolRequest = {version:'1';requestId:string;call:ToolCall};
export type ToolResponse = {requestId:string;ok:true;result:unknown} | {requestId:string;ok:false;error:{code:string;message:string;retryable:boolean}};
export type Trace = {requestId:string;mode:'simulation'|'real';intent:string;call?:ToolCall;response?:ToolResponse;status:'success'|'clarification'|'error';durationMs:number;message:string};
export interface ModelProvider { readonly mode:'simulation'|'real'; interpret(message:string, today:string):Promise<Decision> }
export interface ToolAdapter { execute(request:ToolRequest):Promise<ToolResponse> }
export const brl = (value:number) => new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(value);
export const todayBR = () => new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
