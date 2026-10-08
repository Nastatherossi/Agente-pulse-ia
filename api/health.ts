export default function handler(_req:unknown,res:{status:(code:number)=>{json:(data:unknown)=>void}}) { res.status(200).json({status:'ok',mode:'simulation',realAIEnabled:false}); }
