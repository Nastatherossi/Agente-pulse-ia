// Serverless entrypoint self-contained: avoid runtime ESM resolution of extensionless local imports.
import { z } from 'zod';

const todayBR=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const transactionArgs=z.object({type:z.enum(['receita','despesa']),amount:z.number().finite().positive().max(1000000).refine(v=>Math.abs(v*100-Math.round(v*100))<0.00001),description:z.string().trim().min(1).max(120),date:z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/).refine(v=>{const d=new Date(v+'T12:00:00Z');return !isNaN(d.getTime())&&d.toISOString().slice(0,10)===v})}).strict();
const toolCall=z.discriminatedUnion('name',[
 z.object({name:z.literal('consultar_saldo'),arguments:z.object({}).strict()}).strict(),
 z.object({name:z.literal('registrar_transacao'),arguments:transactionArgs}).strict(),
 z.object({name:z.literal('listar_transacoes'),arguments:z.object({type:z.enum(['receita','despesa']).optional(),limit:z.number().int().min(1).max(100).default(20)}).strict()}).strict()
]);
const decisionSchema=z.object({intent:z.string().max(100),call:toolCall.optional(),clarification:z.string().max(500).optional()}).strict().refine(v=>Boolean(v.call)!==Boolean(v.clarification));

async function interpret(message:string,today:string,key:string,model:string){
 const response=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',signal:AbortSignal.timeout(20000),headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,max_completion_tokens:350,response_format:{type:'json_object'},messages:[{role:'system',content:`Interprete uma única operação financeira. Hoje: ${today}. Retorne JSON com intent e call OU clarification. call é {name,arguments}. Ferramentas: consultar_saldo ({}), listar_transacoes ({limit:20,type opcional receita/despesa}), registrar_transacao ({type:receita/despesa,amount:número positivo com 2 casas,description:texto,date:AAAA-MM-DD}). Peça esclarecimento se faltar valor, descrição ou data; não assuma data. Nunca invente sucesso. Nunca forneça IDs de usuário/workspace, SQL, raciocínio privado ou ferramentas adicionais.`},{role:'user',content:message}]})});
 if(!response.ok) throw new Error('Provedor indisponível');
 const data=await response.json() as {choices?:{message?:{content?:string}}[]};
 return decisionSchema.parse(JSON.parse(data.choices?.[0]?.message?.content||'{}'));
}

// Limite simples por instância: útil contra acidentes, NÃO é quota global em serverless.
const requests = new Map<string, number[]>();
type Request = {method?:string;body?:unknown;headers?:Record<string,string|string[]|undefined>;socket?:{remoteAddress?:string}};
type Response = {status:(code:number)=>Response;json:(data:unknown)=>void;setHeader:(name:string,value:string)=>void};

export default async function handler(req:Request,res:Response) {
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='POST') return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
 if(process.env.ENABLE_REAL_AI!=='true') return res.status(403).json({error:'REAL_AI_LOCKED'});
 const key=process.env.OPENAI_API_KEY,model=process.env.OPENAI_MODEL;
 if(!key||!model) return res.status(503).json({error:'PROVIDER_NOT_CONFIGURED'});
 const body=req.body;
 if(!body||typeof body!=='object'||Array.isArray(body)) return res.status(400).json({error:'INVALID_REQUEST'});
 const message=(body as Record<string,unknown>).message;
 if(typeof message!=='string'||!message.trim()||message.length>2000) return res.status(400).json({error:'INVALID_MESSAGE'});
 const ip=String(req.headers?.['x-real-ip']||req.socket?.remoteAddress||'unknown');
 const now=Date.now(),recent=(requests.get(ip)||[]).filter(t=>now-t<60000);
 if(recent.length>=10) return res.status(429).json({error:'RATE_LIMITED'});
 recent.push(now);requests.set(ip,recent);
 if(requests.size>1000) requests.clear();
 try {
  const decision=await interpret(message,todayBR(),key,model);
  return res.status(200).json({decision});
 } catch {
  return res.status(502).json({error:'INTERPRETATION_FAILED'});
 }
}
