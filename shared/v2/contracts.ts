import {narrativeSchema,createNarrative} from './memory-contracts.js';
import {z} from 'zod';
export const isoDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{const d=new Date(v+'T12:00:00Z');return !isNaN(d.getTime())&&d.toISOString().slice(0,10)===v;});
export const money=z.number().finite().positive().max(1000000).refine(v=>Math.abs(v*100-Math.round(v*100))<0.00001);
export const category=z.string().trim().min(1).max(50);
export const transaction=z.object({type:z.enum(['receita','despesa']),amount:money,description:z.string().trim().min(1).max(120),date:isoDate,category:category.optional()}).strict();
export const storedTransaction=transaction.extend({id:z.string().uuid()});
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
/** Closed category taxonomy the model may choose from. Anything else is dropped, never invented. */
export const CATEGORIES=['Alimentação','Transporte','Lazer','Moradia','Saúde','Educação','Compras','Contas e serviços','Assinaturas','Renda'] as const;
/** How the model read the user's statement. Only 'fato_ocorrido' can lead to a new record. */
export const nature=z.enum(['fato_ocorrido','hipotese','plano','desejo','duvida']);
/** Exact excerpt of the CURRENT user message that supports a proposal. Checked by code, never trusted. */
export const evidence=z.string().trim().min(1).max(300);
const modelCategory=z.string().trim().max(50).nullable().optional();
const entryFields={type:z.enum(['receita','despesa']),amount:money,description:z.string().trim().min(1).max(120),date:isoDate,category:modelCategory};
const target=z.object({transacao_id:z.string().uuid().optional(),descricao:z.string().trim().min(1).max(120).optional(),valor:money.optional(),data:isoDate.optional()}).strict().refine(t=>Object.keys(t).length>0,'TARGET_REQUIRED');
/**
 * Model-facing tools: the model interprets and PROPOSES. Write proposals carry the model's reading
 * (nature) and evidence so the deterministic policy can check them; the core never sees these fields.
 */
export const toolSchemas={
 consultar_saldo:schemas.consultar_saldo,
 listar_transacoes:schemas.listar_transacoes,
 resumir_financas:schemas.resumir_financas,
 comparar_periodos:schemas.comparar_periodos,
 consultar_gastos_categoria:schemas.consultar_gastos_categoria,
 projetar_despesas:schemas.projetar_despesas,
 simular_compra:schemas.simular_compra,
 registrar_transacao:z.object({...entryFields,evidencia:evidence,natureza:nature}).strict(),
 registrar_varios:z.object({lancamentos:z.array(z.object({...entryFields,evidencia:evidence}).strict()).min(2).max(5),natureza:nature}).strict(),
 propor_edicao_transacao:z.object({alvo:target,novo:z.object({amount:money.optional(),description:z.string().trim().min(1).max(120).optional(),category:z.string().trim().min(1).max(50).optional(),date:isoDate.optional()}).strict().refine(n=>Object.keys(n).length>0,'CHANGE_REQUIRED'),evidencia:evidence}).strict(),
 propor_exclusao_transacao:z.object({alvo:target,evidencia:evidence}).strict(),
 atualizar_preferencias:z.object({style:z.enum(['direto','descontraido','neutro','formal']).optional(),detail:z.enum(['curto','detalhado']).optional(),proactivity:z.enum(['discreto','equilibrado','proativo']).optional(),explanation:z.enum(['minima','completa']).optional(),examples:z.boolean().optional(),emojis:z.boolean().optional(),redefinir:z.boolean().optional(),evidencia:evidence}).strict(),
 definir_objetivo:goal.extend({evidencia:evidence}).strict()
};
export type ModelToolName=keyof typeof toolSchemas;
export const WRITE_TOOLS:ReadonlySet<string>=new Set(['registrar_transacao','registrar_varios','propor_edicao_transacao','propor_exclusao_transacao','atualizar_preferencias','definir_objetivo']);
export type Call={id:string;name:string;arguments:unknown};
export type ValidCall={id:string;name:ToolName;arguments:Record<string,unknown>};
export type ModelCall={id:string;name:ModelToolName;arguments:Record<string,unknown>};
export const financialState=z.object({initialBalanceCents:z.number().int().min(0).max(100000000),transactions:z.array(transaction.extend({id:z.string().uuid()})).max(300),preferences,goal:goal.optional()}).strict();
export type State=z.infer<typeof financialState>;
export type Period=z.infer<typeof period>;
export type Step={order:number;id:string;name:string;arguments?:unknown;status:'success'|'error'|'blocked';result?:unknown;error?:{code:string;message:string;reason?:string;issues?:{field:string;code:string}[]};durationMs:number};
export type Trace={channel?:'web'|'test'|'whatsapp';/** Who wrote the answer: the language model, or deterministic code without any model call. */respondedBy?:'model'|'code';modelCalls?:number;contextInvalidated?:boolean;retrievedMemoryIds?:string[];memoryMetrics?:{stored:number;retrieved:number;contextCharacters:number;extractionCalls:number};conversationTone?:string;interpretationSource?:'model'|'deterministic_fallback';proactivity?:State['preferences']['proactivity'];pendingOperation?:unknown;confirmation?:'pending'|'confirmed'|'cancelled'|'expired'|'none';requestId:string;mode:'simulation'|'real';intent:string;status:'success'|'clarification'|'error';message:string;steps:Step[];durationMs:number;model?:string;usage?:{inputTokens:number;outputTokens:number;totalTokens:number};errorCode?:string};
// 'create' holds new records the policy would not write directly (ambiguous, multiple, high value…); applied atomically on confirmation.
export const pendingOperation=z.object({id:z.string().uuid(),kind:z.enum(['edit','delete','goal','create']),targetId:z.string().uuid().optional(),before:z.union([transaction.extend({id:z.string().uuid()}),goal]).optional(),after:z.union([transaction.extend({id:z.string().uuid()}),goal]).optional(),items:z.array(transaction).min(1).max(5).optional(),createdAt:z.number().int(),expiresAt:z.number().int()}).strict().refine(op=>op.kind==='create'?Boolean(op.items)&&!op.before:op.kind==='goal'?Boolean(op.after)&&!op.items:Boolean(op.before)&&!op.items,'OPERATION_SHAPE');
export type PendingOperation=z.infer<typeof pendingOperation>;
export const memory=z.object({topic:z.enum(['saldo','despesas','receitas','analise']).optional(),periods:z.array(period).max(2).default([]),transactionDate:isoDate.optional(),pending:transaction.optional(),operation:pendingOperation.optional()}).strict();
export const historyEntry=z.object({role:z.enum(['user','assistant']),content:z.string().max(1800)}).strict();
export const sessionSchema=z.object({version:z.literal(2),narrative:narrativeSchema.default(()=>createNarrative()),id:z.string().uuid(),state:financialState,memory,history:z.array(historyEntry).max(10),lastRequests:z.array(z.object({id:z.string().uuid(),messageHash:z.string().max(64),trace:z.unknown()})).max(8),expiresAt:z.number().int()}).strict().refine(s=>s.narrative.records.every(r=>r.ownerId===s.id),'MEMORY_OWNER_MISMATCH');
export type Session=z.infer<typeof sessionSchema>;
export type ModelMessage={role:'system'|'user'|'assistant'|'tool';content:string|null;tool_calls?:{id:string;type:'function';function:{name:string;arguments:string}}[];tool_call_id?:string};
export type ModelResult={content?:string;calls?:Call[];model?:string;usage?:Trace['usage']};
export interface Provider {mode:'simulation'|'real';next(messages:ModelMessage[],session:Session,signal:AbortSignal):Promise<ModelResult>}
export const createSession=():Session=>({version:2,narrative:createNarrative(),id:crypto.randomUUID(),state:{initialBalanceCents:250000,transactions:[],preferences:defaultPreferences()},memory:{periods:[]},history:[],lastRequests:[],expiresAt:Date.now()+6*60*60*1000});
export const brl=(cents:number)=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(cents/100);
export const todayBR=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export const normalize=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export function validateCall(call:Call):ValidCall {if(!Object.hasOwn(schemas,call.name))throw new Error('UNKNOWN_TOOL');const name=call.name as ToolName;return {id:call.id,name,arguments:schemas[name].parse(call.arguments) as Record<string,unknown>};}
/** Validates a call proposed by the model against the model-facing contract (unknown tools and extra fields are rejected). */
export function validateModelCall(call:Call):ModelCall {if(!Object.hasOwn(toolSchemas,call.name))throw new Error('UNKNOWN_TOOL');const name=call.name as ModelToolName;return {id:call.id,name,arguments:toolSchemas[name].parse(call.arguments) as Record<string,unknown>};}
