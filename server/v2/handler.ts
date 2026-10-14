import {clearContext} from '../../shared/v2/personality.js';
import {z} from 'zod';
import {runConversation,errorMessage} from '../../shared/v2/agent.js';
import {todayBR,createSession} from '../../shared/v2/contracts.js';
import {OpenAIConversationProvider} from './openai.js';
import {encodeSession,decodeSession} from './session.js';
const input=z.object({message:z.string().trim().min(1).max(2000).optional(),clearConversation:z.boolean().optional(),requestId:z.string().uuid(),sessionToken:z.string().max(100000).optional(),failTools:z.boolean().optional()}).strict().refine(v=>Boolean(v.message)!==Boolean(v.clearConversation));
const rate=new Map<string,number[]>();
type Request={method?:string;body?:unknown;headers?:Record<string,string|string[]|undefined>;socket?:{remoteAddress?:string}};
type Response={status:(n:number)=>Response;json:(x:unknown)=>void;setHeader:(k:string,v:string)=>void};
export default async function handler(req:Request,res:Response){
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).json({error:'METHOD_NOT_ALLOWED'});}
 if(process.env.ENABLE_REAL_AI!=='true')return res.status(403).json({error:'REAL_AI_LOCKED'});
 const key=process.env.OPENAI_API_KEY?.trim(),model=process.env.OPENAI_MODEL?.trim();if(!key||!model)return res.status(503).json({error:'PROVIDER_NOT_CONFIGURED'});
 const body=input.safeParse(req.body);if(!body.success)return res.status(400).json({error:'INVALID_REQUEST'});
 const ip=String(req.headers?.['x-real-ip']||req.socket?.remoteAddress||'unknown'),now=Date.now(),recent=(rate.get(ip)||[]).filter(t=>now-t<60000);if(recent.length>=6)return res.status(429).json({error:'RATE_LIMITED'});recent.push(now);rate.set(ip,recent);if(rate.size>1000)rate.clear();
 try{
  // No unsigned client history, financial state, tool results or identity accepted.
  const session=body.data.sessionToken?decodeSession(body.data.sessionToken,key):undefined;
  if(body.data.clearConversation){const cleared=session||createSession();clearContext(cleared);return res.status(200).json({state:cleared.state,sessionToken:encodeSession(cleared,key),trace:{requestId:body.data.requestId,mode:'real',intent:'Limpar conversa',status:'success',message:'Conversa limpa. Os dados fictícios foram preservados.',steps:[],durationMs:0}});}
  const output=await runConversation(new OpenAIConversationProvider(key,model),session,body.data.message!,body.data.requestId,todayBR(),{failTools:body.data.failTools});
  const sessionToken=encodeSession(output.session,key);
  if(output.trace.errorCode)console.warn(JSON.stringify({event:'pulse_v2_error',requestId:output.trace.requestId,code:output.trace.errorCode,diagnostics:output.trace.steps.flatMap(step=>step.error?[{code:step.error.code,reason:step.error.reason,issues:step.error.issues}]:[])}));
  // A trace may contain earlier successful fictitious writes even if a later stage failed.
  // Return the signed state alongside the error so retries cannot hide a completed write.
  const code=output.trace.errorCode;const status=output.trace.status==='error'?(code==='OPENAI_TIMEOUT'?504:code==='OPENAI_RATE_LIMITED'?429:code==='OPENAI_AUTH_FAILED'||code==='OPENAI_QUOTA_EXCEEDED'||code==='MODEL_INCOMPATIBLE'?503:502):200;
  return res.status(status).json({trace:output.trace,state:output.session.state,sessionToken,preferences:output.session.state.preferences});
 }catch(e){const code=e instanceof Error&&['INVALID_SESSION','SESSION_FULL','IDEMPOTENCY_CONFLICT'].includes(e.message)?e.message:'INTERPRETATION_FAILED';console.warn(JSON.stringify({event:'pulse_v2_error',requestId:body.data.requestId,code}));return res.status(code==='INVALID_SESSION'?401:code==='IDEMPOTENCY_CONFLICT'?409:502).json({error:code,message:errorMessage(code)});}
}
