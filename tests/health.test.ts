import {it,expect,vi,afterEach} from 'vitest';
import handler from '../api/health';
afterEach(()=>{vi.unstubAllEnvs();});
const call=()=>{let body:any;handler(undefined,{status:()=>({json:(d:unknown)=>{body=d;}})});return body;};
it('health mostra simulação quando a IA real não está configurada',()=>{vi.stubEnv('ENABLE_REAL_AI','true');vi.stubEnv('OPENAI_API_KEY','');vi.stubEnv('OPENAI_MODEL','m');expect(call()).toMatchObject({status:'ok',mode:'simulation',realAIEnabled:false});});
it('health mostra o estado real, o modelo e o commit, sem expor a chave',()=>{vi.stubEnv('ENABLE_REAL_AI','true');vi.stubEnv('OPENAI_API_KEY','sk-secret-health');vi.stubEnv('OPENAI_MODEL','gpt-4.1-mini');vi.stubEnv('VERCEL_GIT_COMMIT_SHA','abcdef1234567');vi.stubEnv('VERCEL_GIT_COMMIT_REF','feat/x');const b=call();expect(b).toMatchObject({mode:'real',realAIEnabled:true,model:'gpt-4.1-mini',commit:'abcdef1',branch:'feat/x'});expect(JSON.stringify(b)).not.toContain('sk-secret');});
