import {describe,it,expect,vi} from 'vitest';
import {runConversation} from '../shared/v2/agent';
import {amountsIn,knownCategory} from '../shared/v2/policy';
import {messages} from '../shared/whatsapp/access';
import type {Provider,ModelResult,Session} from '../shared/v2/contracts';
const today='2026-10-22';
let n=0;const tc=(name:string,args:unknown)=>({id:`call_${++n}`,name,arguments:args});
const model=(...turns:ModelResult[]):Provider=>({mode:'real',next:vi.fn().mockImplementation(async()=>turns.shift()||{content:'ok'})});
const send=(p:Provider,s:Session|undefined,m:string,userName?:string,source:'text'|'audio'='text')=>runConversation(p,s,m,crypto.randomUUID(),today,{realData:true,userName,source});
const expense=(amount:number,description:string,evidencia:string,category?:string)=>({type:'despesa',amount,description,date:today,evidencia,natureza:'fato_ocorrido',...(category?{category}:{})});

describe('confirmação em tom de conversa',()=>{
 it('chama o usuário pelo nome e fala o que vai lançar',async()=>{
  const msg='gastei 130 no mercado';
  const r=await send(model({calls:[tc('registrar_transacao',expense(130,'mercado','130 no mercado','Alimentação'))]}),undefined,msg,'Matheus','audio');
  expect(r.trace.confirmation).toBe('pending');
  expect(r.trace.message).toContain('Matheus, vou lançar');
  expect(r.trace.message).toMatch(/R\$\s130,00/);
  expect(r.trace.message).toContain('Alimentação');
  expect(r.trace.message).toContain('Pode ser?');
  expect(r.trace.message).not.toMatch(/Expira|Responda “sim”|Despesa ·/);
 });
 it('sem nome, a frase continua natural',async()=>{
  const msg='gastei 130 no mercado';
  const r=await send(model({calls:[tc('registrar_transacao',expense(130,'mercado','130 no mercado','Alimentação'))]}),undefined,msg,undefined,'audio');
  expect(r.trace.message.startsWith('Entendi pelo áudio. Vou lançar')).toBe(true);
 });
 it('data de ontem e de outro dia saem em palavras',async()=>{
  const msg='ontem gastei 130 no mercado';
  const r=await send(model({calls:[tc('registrar_transacao',{...expense(130,'mercado','130 no mercado','Alimentação'),date:'2026-10-21'})]}),undefined,msg,'Ana','audio');
  expect(r.trace.message).toContain('ontem');
 });
 it('exclusão pergunta de forma direta, com o nome',async()=>{
  const m1='gastei 50 no mercado';
  const a=await send(model({calls:[tc('registrar_transacao',expense(50,'mercado',m1,'Alimentação'))]}),undefined,m1,'Ana');
  const r=await send(model({calls:[tc('propor_exclusao_transacao',{alvo:{descricao:'mercado'},evidencia:'apaga o mercado'})]}),a.session,'apaga o mercado','Ana');
  expect(r.trace.message).toContain('Ana, confirma que é pra apagar');
  expect(r.trace.message).toContain('mercado');
 });
 it('"sim" continua confirmando',async()=>{
  const msg='gastei 130 no mercado e 20 na padaria';
  const r=await send(model({calls:[tc('registrar_transacao',expense(130,'mercado','130 no mercado','Alimentação'))]}),undefined,msg,'Ana');
  const r2=await send(model({content:'x'}),r.session,'sim','Ana');
  expect(r2.session.state.transactions).toHaveLength(1);
 });
});

describe('o que não é valor em reais',()=>{
 it('"dia 27" e "3x" não contam como valor',()=>{
  expect(amountsIn('tive um custo de 50 reais com temperos hoje. fecha no dia 27')).toEqual([50]);
  expect(amountsIn('comprei em 3x de 100')).toEqual([100]);
  expect(amountsIn('paguei 27 reais')).toEqual([27]);
 });
 it('a mensagem do cartão não gera "mais de um valor"',async()=>{
  const msg='tive um custo de 50 reais com temperos hoje.\nLeve em conta que faço todas as compras no crédito e meu mês fecha no dia 27';
  const r=await send(model({calls:[tc('registrar_transacao',expense(50,'temperos','50 reais com temperos'))]}),undefined,msg,'Gustavo');
  expect(r.trace.message).not.toContain('mais de um valor');
 });
 it('tempero é alimentação',()=>{
  expect(knownCategory('temperos')).toBe('Alimentação');
 });
});

describe('boas-vindas',()=>{
 it('usa o nome quando há, no tom pedido',()=>{
  expect(messages.welcome('Gustavo Penteado')).toContain('Ei, Gustavo! Seja muito bem-vindo! 💜');
  expect(messages.welcome()).toContain('Ei! Seja muito bem-vindo!');
  expect(messages.welcome()).toContain('me contar um pouquinho sobre você');
 });
});
