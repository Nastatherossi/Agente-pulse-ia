// Self-contained Vercel entrypoint: no extensionless local runtime imports.
import { z } from 'zod';

export const todayBR = () => new Intl.DateTimeFormat('en-CA', {
 timeZone:'America/Sao_Paulo', year:'numeric', month:'2-digit', day:'2-digit'
}).format(new Date());
const transactionArgs = z.object({
 type:z.enum(['receita','despesa']),
 amount:z.number().finite().positive().max(1000000).refine(v=>Math.abs(v*100-Math.round(v*100))<0.00001),
 description:z.string().trim().min(1).max(120),
 // A regex literal needs \d, not \\d (which matches a literal backslash).
 date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{
  const d=new Date(v+'T12:00:00Z');
  return !isNaN(d.getTime())&&d.toISOString().slice(0,10)===v;
 })
}).strict();
const toolCall = z.discriminatedUnion('name',[
 z.object({name:z.literal('consultar_saldo'),arguments:z.object({}).strict()}).strict(),
 z.object({name:z.literal('registrar_transacao'),arguments:transactionArgs}).strict(),
 z.object({name:z.literal('listar_transacoes'),arguments:z.object({type:z.enum(['receita','despesa']).optional(),limit:z.number().int().min(1).max(100).default(20)}).strict()}).strict()
]);
export const decisionSchema = z.object({intent:z.string().trim().min(1).max(100),call:toolCall.optional(),clarification:z.string().trim().min(1).max(500).optional()}).strict().refine(v=>Boolean(v.call)!==Boolean(v.clarification));

export type InterpretationErrorCode = 'OPENAI_AUTH_FAILED'|'OPENAI_QUOTA_EXCEEDED'|'OPENAI_RATE_LIMITED'|'MODEL_INCOMPATIBLE'|'INVALID_MODEL_JSON'|'SCHEMA_VALIDATION_FAILED'|'OPENAI_TIMEOUT'|'OPENAI_NETWORK_FAILED'|'OPENAI_UNAVAILABLE'|'PROVIDER_BAD_REQUEST'|'MODEL_OUTPUT_TRUNCATED'|'MODEL_REFUSED'|'INTERPRETATION_FAILED';
export class InterpretationError extends Error {
 constructor(readonly code:InterpretationErrorCode,readonly httpStatus=502,readonly retryable=false,readonly upstreamStatus?:number) {super(code);this.name='InterpretationError';}
}
function upstreamError(status:number,payload:unknown):InterpretationError {
 const error=z.object({error:z.object({code:z.string().nullish(),type:z.string().nullish(),param:z.string().nullish()}).passthrough()}).safeParse(payload);
 const code=error.success?error.data.error.code:undefined;
 const type=error.success?error.data.error.type:undefined;
 const param=error.success?error.data.error.param:undefined;
 if(code==='insufficient_quota'||type==='insufficient_quota'||code==='billing_hard_limit_reached'||code==='billing_not_active') return new InterpretationError('OPENAI_QUOTA_EXCEEDED',503,false,status);
 if(status===401||status===403) return new InterpretationError('OPENAI_AUTH_FAILED',503,false,status);
 if(status===429) return new InterpretationError('OPENAI_RATE_LIMITED',429,true,status);
 if(status===408||status===504) return new InterpretationError('OPENAI_TIMEOUT',504,true,status);
 if(status===404||code==='model_not_found'||(status===400&&(code==='unsupported_parameter'||code==='unsupported_value'||['model','response_format','max_completion_tokens'].includes(param||'')))) return new InterpretationError('MODEL_INCOMPATIBLE',503,false,status);
 if(status>=500) return new InterpretationError('OPENAI_UNAVAILABLE',502,true,status);
 return new InterpretationError('PROVIDER_BAD_REQUEST',502,false,status);
}
function normalizedError(error:unknown):InterpretationError {
 if(error instanceof InterpretationError) return error;
 if(error instanceof Error&&(error.name==='TimeoutError'||error.name==='AbortError')) return new InterpretationError('OPENAI_TIMEOUT',504,true);
 return new InterpretationError('INTERPRETATION_FAILED');
}

export async function interpret(message:string,today:string,key:string,model:string) {
 let response:globalThis.Response;
 try {
  response=await fetch('https://api.openai.com/v1/chat/completions',{
   method:'POST',signal:AbortSignal.timeout(20000),
   headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
   body:JSON.stringify({model,max_completion_tokens:350,response_format:{type:'json_object'},messages:[
    {role:'system',content:`Você é o interpretador financeiro do Pulse. Interprete uma única operação financeira. Hoje em America/Sao_Paulo: ${today}. Retorne apenas JSON com intent e exatamente UM de call ou clarification. Omita o campo não utilizado; não envie null. call é {name,arguments}. Ferramentas: consultar_saldo ({}), listar_transacoes ({limit:20,type opcional receita/despesa}), registrar_transacao ({type:receita/despesa,amount:número positivo com até 2 casas,description:texto curto,date:AAAA-MM-DD}). Converta valores brasileiros como R$ 47,90 em 47.9. Use a data acima se a mensagem disser hoje; se não informar data, valor ou descrição, peça esclarecimento. Exemplo para um gasto com gasolina hoje: {"intent":"Registrar despesa","call":{"name":"registrar_transacao","arguments":{"type":"despesa","amount":47.9,"description":"gasolina","date":"${today}"}}}. Para saldo: {"intent":"Consultar saldo","call":{"name":"consultar_saldo","arguments":{}}}. Se faltam dados: {"intent":"Esclarecimento necessário","clarification":"Qual o valor e a data?"}. Nunca invente sucesso, saldos ou operações executadas. Nunca forneça IDs de usuário/workspace, SQL, raciocínio privado ou ferramentas adicionais.`},
    {role:'user',content:message}
   ]})
  });
 } catch(error) {
  if(error instanceof Error&&(error.name==='TimeoutError'||error.name==='AbortError')) throw new InterpretationError('OPENAI_TIMEOUT',504,true);
  throw new InterpretationError('OPENAI_NETWORK_FAILED',502,true);
 }
 let payload:unknown;
 try {payload=await response.json();} catch(error) {
  if(error instanceof Error&&(error.name==='TimeoutError'||error.name==='AbortError')) throw new InterpretationError('OPENAI_TIMEOUT',504,true);
  if(!response.ok) throw upstreamError(response.status,undefined);
  throw new InterpretationError('INVALID_MODEL_JSON');
 }
 if(!response.ok) throw upstreamError(response.status,payload);
 const envelope=z.object({choices:z.array(z.object({finish_reason:z.string().nullish(),message:z.object({content:z.string().nullish(),refusal:z.string().nullish()})})).min(1)}).safeParse(payload);
 if(!envelope.success) throw new InterpretationError('INVALID_MODEL_JSON');
 const choice=envelope.data.choices[0];
 if(choice.finish_reason==='length') throw new InterpretationError('MODEL_OUTPUT_TRUNCATED');
 if(choice.message.refusal) throw new InterpretationError('MODEL_REFUSED');
 let decision:unknown;
 try {decision=JSON.parse(choice.message.content||'');} catch {throw new InterpretationError('INVALID_MODEL_JSON');}
 const parsed=decisionSchema.safeParse(decision);
 if(!parsed.success) throw new InterpretationError('SCHEMA_VALIDATION_FAILED');
 return parsed.data;
}

// Local instance guard only; not a global serverless quota. Vercel Authentication
// protects this endpoint at the deployment boundary in all environments.
const requests = new Map<string, number[]>();
type Request = {method?:string;body?:unknown;headers?:Record<string,string|string[]|undefined>;socket?:{remoteAddress?:string}};
type Response = {status:(code:number)=>Response;json:(data:unknown)=>void;setHeader:(name:string,value:string)=>void};
export default async function handler(req:Request,res:Response) {
 res.setHeader('Cache-Control','no-store');
 const requestId=crypto.randomUUID();
 res.setHeader('X-Request-Id',requestId);
 if(req.method!=='POST') {res.setHeader('Allow','POST');return res.status(405).json({error:'METHOD_NOT_ALLOWED',requestId});}
 if(process.env.ENABLE_REAL_AI!=='true') return res.status(403).json({error:'REAL_AI_LOCKED',requestId});
 const key=process.env.OPENAI_API_KEY?.trim(),model=process.env.OPENAI_MODEL?.trim();
 if(!key||!model) return res.status(503).json({error:'PROVIDER_NOT_CONFIGURED',requestId});
 const body=z.object({message:z.string().trim().min(1).max(2000)}).strict().safeParse(req.body);
 if(!body.success) return res.status(400).json({error:'INVALID_MESSAGE',requestId});
 const ip=String(req.headers?.['x-real-ip']||req.socket?.remoteAddress||'unknown');
 const now=Date.now(),recent=(requests.get(ip)||[]).filter(t=>now-t<60000);
 if(recent.length>=10) return res.status(429).json({error:'RATE_LIMITED',requestId,retryable:true});
 recent.push(now);requests.set(ip,recent);
 if(requests.size>1000) requests.clear();
 try {return res.status(200).json({decision:await interpret(body.data.message,todayBR(),key,model)});}
 catch(error) {
  const safe=normalizedError(error);
  // Allowlisted metadata only. Never log raw errors, provider bodies, prompts or keys.
  console.warn(JSON.stringify({event:'pulse_ai_interpretation_failed',requestId,code:safe.code,upstreamStatus:safe.upstreamStatus,retryable:safe.retryable}));
  return res.status(safe.httpStatus).json({error:safe.code,requestId,retryable:safe.retryable});
 }
}
