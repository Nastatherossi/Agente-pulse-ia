import express from 'express';
export const app=express();
app.disable('x-powered-by');
app.use(express.json({limit:'8kb'}));
app.get('/api/health',(_req,res)=>res.json({status:'ok',mode:'simulation',realAIEnabled:false}));
// Fail closed: nem credenciais nem flags substituem autenticação/autorização.
// Conectar middleware de sessão verificada antes de disponibilizar o provider real.
app.post('/api/agent',(_req,res)=>res.status(403).json({error:{code:'REAL_AI_LOCKED',message:'Modo IA real bloqueado até autenticação e autorização explícitas.'}}));
app.use((_req,res)=>res.status(404).json({error:{code:'NOT_FOUND',message:'Rota não encontrada'}}));
