import { OpenAIProvider } from '../server/openai';
import { todayBR } from '../shared/contracts';

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
  const decision=await new OpenAIProvider(key,model,true).interpret(message,todayBR());
  return res.status(200).json({decision});
 } catch {
  return res.status(502).json({error:'INTERPRETATION_FAILED'});
 }
}
