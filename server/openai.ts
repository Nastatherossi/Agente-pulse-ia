import { decisionSchema, type Decision, type ModelProvider } from '../shared/contracts';
// Esta classe é exclusivamente server-side. Não é importada pelo frontend.
export class OpenAIProvider implements ModelProvider {
 readonly mode='real' as const;
 constructor(private key:string,private model:string,private authorized:boolean) {}
 async interpret(message:string,today:string):Promise<Decision> {
  if(!this.authorized||!this.key) throw new Error('IA real não autorizada');
  const response=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',signal:AbortSignal.timeout(20000),headers:{Authorization:`Bearer ${this.key}`,'Content-Type':'application/json'},body:JSON.stringify({model:this.model,response_format:{type:'json_object'},messages:[{role:'system',content:`Interprete uma única operação financeira. Hoje: ${today}. Retorne JSON com intent e call OU clarification. call é {name,arguments}. Ferramentas: consultar_saldo ({}), listar_transacoes ({limit:20,type opcional receita/despesa}), registrar_transacao ({type:receita/despesa,amount:número positivo com 2 casas,description:texto,date:AAAA-MM-DD}). Peça esclarecimento se faltar valor, descrição ou data; não assuma data. Nunca invente sucesso. Nunca forneça IDs de usuário/workspace, SQL, raciocínio privado ou ferramentas adicionais.`},{role:'user',content:message}]})});
  if(!response.ok) throw new Error('Provedor indisponível');
  const data=await response.json() as {choices?:{message?:{content?:string}}[]};
  return decisionSchema.parse(JSON.parse(data.choices?.[0]?.message?.content||'{}'));
 }
}
