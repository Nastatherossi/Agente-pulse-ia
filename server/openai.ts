import { interpret } from '../api/agent.js';
import type { Decision, ModelProvider } from '../shared/contracts';
// Server-only wrapper; shares the exact validation/error handling of Vercel.
export class OpenAIProvider implements ModelProvider {
 readonly mode='real' as const;
 constructor(private key:string,private model:string,private authorized:boolean) {}
 async interpret(message:string,today:string):Promise<Decision> {
  if(!this.authorized||!this.key) throw new Error('IA real não autorizada');
  if(!message.trim()||message.length>2000) throw new Error('Mensagem inválida');
  return interpret(message,today,this.key,this.model);
 }
}
