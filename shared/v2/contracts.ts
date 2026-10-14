import {narrativeSchema,createNarrative} from './memory-contracts.js';
import {z} from 'zod';
export const isoDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{const d=new Date(v+'T12:00:00Z');return !isNaN(d.getTime())&&d.toISOString().slice(0,10)===v;});
export const money=z.number().finite().positive().max(1000000).refine(v=>Math.abs(v*100-Math.round(v*100))<0.00001);
export const category=z.string().trim().min(1).max(50);
export const transaction=z.object({type:z.enum(['receita','despesa']),amount:money,description:z.string().trim().min(1).max(120),date:isoDate,category:category.optional()}).strict();
export const period=z.object({start:isoDate,end:isoDate}).strict().refine(p=>p.start<=p.end,'Período invertido');
export const preferences=z.object({style:z.enum(['direto','descontraido','neutro','formal']).default('neutro'),detail:z.enum(['curto','detalhado']).default('curto'),proactivity:z.enum(['discreto','equilibrado','proativo']).default('discreto'),explanation:z.enum(['minima','completa']).default('minima'),examples:z.boolean().default(false),emojis:z.boolean().default(false)}).strict();
export const defaultPreferences=()=>preferences.parse({});
export const goal=z.object({description:z.string().trim().min(1).max(120),amount:money,targetDate:isoDate.optional()}).strict();
export const schemas={
 consultar_saldo:z.object({}).strict(),
 registrar_transacao:transaction,
 listar_transacoes:z.object({type:z.enum(['receita','despesa']).optional(),limit:z.number().int().min(1).max(100).default(20),period:period.optional()}).strict(),
 resumir_financas:z.object({period,type:z.enum(['receita','despesa']).optional()}).strict(),
 comparar_periodos:z.object({periodA:period,periodB:period,metric:z.enum(['receitas','despesas','resultado'])}).strict(),
 consultar_gastos_categoria:z.object({category,period}).strict(),
 projetar_despesas:z.object({period,asOf:isoDate}).strict(),
 atualizar_preferencias:preferences,
 simular_compra:z.object({amount:money,available:money.optional()}).strict(),
 definir_objetivo:goal
};
export type ToolName=keyof typeof schemas;
export type Call={id:string;name:string;arguments:unknown};
export type ValidCall={id:string;name:ToolName;arguments:Record<string,unknown>};
export const financialState=z.object({initialBalanceCents:z.number().int().min(0).max(100000000),transactions:z.array(transaction.extend({id:z.string().uuid()})).max(300),preferences,goal:goal.optional()}).strict();
export type State=z.infer<typeof financialState>;
export type Period=z.infer<typeof period>;
export type Step={order:number;id:string;name:string;arguments?:unknown;status:'success'|'error'|'blocked';result?:unknown;error?:{code:string;message:string;reason?:string;issues?:{field:string;code:string}[]};durationMs:number};
export type Trace={channel?:'web'|'test'|'whatsapp';contextInvalidated?:boolean;retrievedMemoryIds?:string[];memoryMetrics?:{stored:number;retrieved:number;contextCharacters:number;extractionCalls:number};conversationTone?:string;interpretationSource?:'model'|'deterministic_fallback';proactivity?:State['preferences']['proactivity'];pendingOperation?:unknown;confirmation?:'pending'|'confirmed'|'cancelled'|'expired'|'none';requestId:string;mode:'simulation'|'real';intent:string;status:'success'|'clarification'|'error';message:string;steps:Step[];durationMs:number;model?:string;usage?:{inputTokens:number;outputTokens:number;totalTokens:number};errorCode?:string};
export const pendingOperation=z.object({id:z.string().uuid(),kind:z.enum(['edit','delete','goal']),targetId:z.string().uuid().optional(),before:z.union([transaction.extend({id:z.string().uuid()}),goal]),after:z.union([transaction.extend({id:z.string().uuid()}),goal]).optional(),createdAt:z.number().int(),expiresAt:z.number().int()}).strict();
export type PendingOperation=z.infer<typeof pendingOperation>;
export const memory=z.object({topic:z.enum(['saldo','despesas','receitas','analise']).optional(),periods:z.array(period).max(2).default([]),transactionDate:isoDate.optional(),pending:transaction.optional(),operation:pendingOperation.optional()}).strict();
export const historyEntry=z.object({role:z.enum(['user','assistant']),content:z.string().max(1800)}).strict();
export const sessionSchema=z.object({version:z.literal(2),narrative:narrativeSchema.default(createNarrative()),id:z.string().uuid(),state:financialState,memory,history:z.array(historyEntry).max(10),lastRequests:z.array(z.object({id:z.string().uuid(),messageHash:z.string().max(64),trace:z.unknown()})).max(8),expiresAt:z.number().int()}).strict().refine(s=>s.narrative.records.every(r=>r.ownerId===s.id),'MEMORY_OWNER_MISMATCH');
export type Session=z.infer<typeof sessionSchema>;
export type ModelMessage={role:'system'|'user'|'assistant'|'tool';content:string|null;tool_calls?:{id:string;type:'function';function:{name:string;arguments:string}}[];tool_call_id?:string};
export type ModelResult={content?:string;calls?:Call[];model?:string;usage?:Trace['usage']};
export interface Provider {mode:'simulation'|'real';next(messages:ModelMessage[],session:Session,signal:AbortSignal):Promise<ModelResult>}
export const createSession=():Session=>({version:2,narrative:createNarrative(),id:crypto.randomUUID(),state:{initialBalanceCents:250000,transactions:[],preferences:defaultPreferences()},memory:{periods:[]},history:[],lastRequests:[],expiresAt:Date.now()+6*60*60*1000});
export const brl=(cents:number)=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(cents/100);
export const todayBR=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export const normalize=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export function validateCall(call:Call):ValidCall {if(!Object.hasOwn(schemas,call.name))throw new Error('UNKNOWN_TOOL');const name=call.name as ToolName;return {id:call.id,name,arguments:schemas[name].parse(call.arguments) as Record<string,unknown>};}
