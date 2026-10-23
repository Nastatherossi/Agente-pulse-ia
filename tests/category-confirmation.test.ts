import {describe,it,expect,vi} from 'vitest';
import {runConversation} from '../shared/v2/agent';
import {knownCategory,categoryInReply} from '../shared/v2/policy';
import type {Provider,ModelResult,Session} from '../shared/v2/contracts';
/* Categoria automática para o óbvio, pergunta para o ambíguo, e "sim, em lazer" confirma já com a categoria. */
const today='2026-10-22';
let n=0;const tc=(name:string,args:unknown)=>({id:`call_${++n}`,name,arguments:args});
const model=(...turns:ModelResult[]):Provider=>({mode:'real',next:vi.fn().mockImplementation(async()=>turns.shift()||{content:'ok'})});
const expense=(amount:number,description:string,evidencia:string,category?:string)=>({type:'despesa',amount,description,date:today,evidencia,natureza:'fato_ocorrido',...(category?{category}:{})});
const send=(p:Provider,s:Session|undefined,m:string,source:'text'|'audio'='text')=>runConversation(p,s,m,crypto.randomUUID(),today,{source,realData:true});
const noModel=()=>model({content:'x'});

describe('categoria automática',()=>{
 it.each([['água','Alimentação'],['café','Alimentação'],['padaria','Alimentação'],['Uber','Transporte'],['farmácia','Saúde'],['Netflix','Assinaturas'],['conta de água','Contas e serviços'],['conta de luz','Contas e serviços'],['aluguel','Moradia'],['curso de inglês','Educação'],['cinema','Lazer'],['tênis','Compras']])('%s → %s',(d,c)=>{expect(knownCategory(d)).toBe(c);});
 it.each(['presente','celular','coisas','outros'])('ambíguo (%s) fica sem categoria',d=>{expect(knownCategory(d)).toBeUndefined();});
 it('pelo áudio, "água" sai com Alimentação já na confirmação',async()=>{
  const msg='comprei uma água no posto, gastei R$ 3,50 no débito';
  const r=await send(model({calls:[tc('registrar_transacao',expense(3.5,'água',msg))]}),undefined,msg,'audio');
  expect(r.trace.confirmation).toBe('pending');
  expect(r.trace.message).toContain('Alimentação');
  expect(r.trace.message).not.toContain('sem categoria');
 });
 it('categoria do modelo é respeitada',async()=>{
  const msg='gastei 40 no cinema';
  const r=await send(model({calls:[tc('registrar_transacao',expense(40,'cinema',msg,'Lazer'))]}),undefined,msg);
  expect(r.session.state.transactions[0].category).toBe('Lazer');
 });
});

describe('categoria dita na confirmação',()=>{
 const pending=async(desc='presente')=>{
  const msg=`gastei R$ 3,50 em ${desc}`;
  const r=await send(model({calls:[tc('registrar_transacao',expense(3.5,desc,msg))]}),undefined,msg,'audio');
  expect(r.trace.confirmation).toBe('pending');
  return r.session;
 };
 it('item ambíguo pergunta a categoria',async()=>{
  const s=await pending();
  const r=await send(model({calls:[tc('registrar_transacao',expense(3.5,'presente','gastei R$ 3,50 em presente'))]}),undefined,'gastei R$ 3,50 em presente','audio');
  expect(r.trace.message).toContain('já me diz a categoria');
 });
 it('"confirmo! mas lança como alimentação" confirma e grava com a categoria',async()=>{
  const s=await pending();
  const m=noModel();
  const r=await send(m,s,'confirmo! mas lanca como alimentação por favor meu querido');
  expect(r.session.state.transactions).toHaveLength(1);
  expect(r.session.state.transactions[0]).toMatchObject({amount:3.5,category:'Alimentação'});
  expect((m.next as any).mock.calls.length).toBe(0);
  expect(r.trace.message).not.toContain('Não entendi');
 });
 it('"sim, em lazer" também',async()=>{
  const s=await pending();
  const r=await send(noModel(),s,'sim, em lazer');
  expect(r.session.state.transactions[0].category).toBe('Lazer');
 });
 it('só a categoria ("lança como transporte") atualiza o pedido e pergunta de novo, sem gravar',async()=>{
  const s=await pending();
  const r=await send(noModel(),s,'lança como transporte');
  expect(r.session.state.transactions).toHaveLength(0);
  expect(r.trace.confirmation).toBe('pending');
  expect(r.trace.message).toContain('Transporte');
  const r2=await send(noModel(),r.session,'sim');
  expect(r2.session.state.transactions[0].category).toBe('Transporte');
 });
 it('duas categorias na mesma frase não escolhem nenhuma',()=>{
  expect(categoryInReply('sim, lazer ou transporte')).toBeUndefined();
  expect(categoryInReply('sim')).toBeUndefined();
  expect(categoryInReply('em alimentação')).toBe('Alimentação');
  expect(categoryInReply('foi comida')).toBe('Alimentação');
 });
 it('"sim" puro continua confirmando como antes',async()=>{
  const s=await pending();
  const r=await send(noModel(),s,'sim');
  expect(r.session.state.transactions).toHaveLength(1);
 });
 it('"cancelar" não grava nem aplica categoria',async()=>{
  const s=await pending();
  const r=await send(noModel(),s,'cancelar, era lazer');
  expect(r.session.state.transactions).toHaveLength(0);
 });
});
