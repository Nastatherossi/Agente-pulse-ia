// Reports the real configuration (never secret values) and which commit is deployed.
export default function handler(_req:unknown,res:{status:(code:number)=>{json:(data:unknown)=>void}}) {
 const realAIEnabled=process.env.ENABLE_REAL_AI==='true'&&Boolean(process.env.OPENAI_API_KEY?.trim())&&Boolean(process.env.OPENAI_MODEL?.trim());
 const commit=process.env.VERCEL_GIT_COMMIT_SHA?.slice(0,7);
 res.status(200).json({status:'ok',mode:realAIEnabled?'real':'simulation',realAIEnabled,...(realAIEnabled?{model:process.env.OPENAI_MODEL!.trim()}:{}),...(commit?{commit,branch:process.env.VERCEL_GIT_COMMIT_REF}:{})});
}
