import {describe,it,expect,vi} from 'vitest';
import {runConversation} from '../shared/v2/agent';
import {resolveTarget,lastRecord} from '../shared/v2/policy';
import {MemoryStore} from '../server/whatsapp/store';
import {MemoryLedger} from '../server/whatsapp/ledger';
import {handleInbound,type Deps} from '../server/whatsapp/handler';
import type {Provider,ModelResult,Session} from '../shared/v2/contracts';
import type {Messenger} from '../server/whatsapp/zapi';
/* "coloca em lazer" logo depois de registrar algo: o usuário fala do último lançamento, e o Pulse entende. */
const today='2026-10-22';
let n=0;const tc=(name:string,args:unknown)=>({id:`call_${++n}`,name,arguments:args});
const model=(...turns:ModelResult[]):Provider=>({mode:'real',next:vi.fn().mockImplementation(async()=>turns.shift()||{content:'ok'})});
const expense=(amount:number,description:string,evidencia:string,category?:string)=>({type:'despesa',amount,description,date:today,evidencia,natureza:'fato_ocorrido',...(category?{category}:{})});
const send=(p:Provider,s:Session|undefined,m:string)=>runConversation(p,s,m,crypto.randomUUID(),today,{realData:true});
const register=async(s:Session|undefined,amount:number,desc:string)=>{const m=`${desc} ${String(amount).replace('.',',')}`;return (await send(model({calls:[tc('registrar_transacao',expense(amount,desc,m))]}),s,m)).session;};

describe('"isso" é o último lançamento',()=>{
 it('"coloca em lazer" pergunta de forma clara e, com "sim", altera o último',async()=>{
  let s=await register(undefined,7.9,'cerveja');
  const r=await send(model({calls:[tc('propor_edicao_transacao',{alvo:{descricao:'último'},novo:{category:'Lazer'},evidencia:'coloca em lazer'})]}),s,'coloca em lazer');
  expect(r.trace.confirmation).toBe('pending');
  expect(r.trace.message).toContain('Quer que eu coloque');
  expect(r.trace.message).toContain('cerveja');
  expect(r.trace.message).toContain('Lazer');
  expect(r.trace.message).not.toContain('Não entendi');
  const r2=await send(model({content:'x'}),r.session,'sim');
  expect(r2.session.state.transactions[0].category).toBe('Lazer');
 });
 it('com vários lançamentos, "isso" é o mais recente, não o primeiro',async()=>{
  let s=await register(undefined,50,'mercado');
  s=await register(s,7.9,'cerveja');
  const r=await send(model({calls:[tc('propor_edicao_transacao',{alvo:{descricao:'esse'},novo:{category:'Lazer'},evidencia:'põe esse em lazer'})]}),s,'põe esse em lazer');
  expect(r.trace.message).toContain('cerveja');
  expect(r.trace.message).not.toContain('mercado');
 });
 it('"muda isso para 9" corrige o valor do último',async()=>{
  let s=await register(undefined,7.9,'cerveja');
  const r=await send(model({calls:[tc('propor_edicao_transacao',{alvo:{descricao:'isso'},novo:{amount:9},evidencia:'muda isso para 9'})]}),s,'muda isso para 9');
  expect(r.trace.confirmation).toBe('pending');
  const r2=await send(model({content:'x'}),r.session,'sim');
  expect(r2.session.state.transactions[0].amount).toBe(9);
 });
 it('quando o modelo já manda o id do último, também funciona',async()=>{
  let s=await register(undefined,7.9,'cerveja');
  const id=s.state.transactions[0].id;
  const r=await send(model({calls:[tc('propor_edicao_transacao',{alvo:{transacao_id:id},novo:{category:'Lazer'},evidencia:'coloca em lazer'})]}),s,'coloca em lazer');
  expect(r.trace.confirmation).toBe('pending');
 });
 it('citar outro lançamento pela descrição não vira "o último"',async()=>{
  let s=await register(undefined,50,'mercado');
  s=await register(s,7.9,'cerveja');
  const r=await send(model({calls:[tc('propor_edicao_transacao',{alvo:{descricao:'mercado'},novo:{category:'Alimentação'},evidencia:'mercado foi alimentação'})]}),s,'o mercado foi alimentação');
  expect(r.trace.message).toContain('mercado');
  expect(r.trace.message).not.toContain('cerveja');
 });
 it('sem nenhum lançamento, não inventa alvo',async()=>{
  const r=await send(model({calls:[tc('propor_edicao_transacao',{alvo:{descricao:'último'},novo:{category:'Lazer'},evidencia:'coloca em lazer'})]}),undefined,'coloca em lazer');
  expect(r.trace.confirmation).not.toBe('pending');
 });
 it('categoria inventada na edição é recusada',async()=>{
  let s=await register(undefined,7.9,'cerveja');
  const r=await send(model({calls:[tc('propor_edicao_transacao',{alvo:{descricao:'último'},novo:{category:'Bebidas Finas'},evidencia:'coloca em lazer'})]}),s,'coloca em lazer');
  expect(r.trace.confirmation).not.toBe('pending');
 });
 it('resolveTarget: regra pura',()=>{
  const base={initialBalanceCents:0,preferences:{style:'neutro',detail:'curto',proactivity:'discreto',explanation:'minima',examples:false,emojis:false}} as any;
  const a={id:'11111111-1111-4111-8111-111111111111',type:'despesa',amount:10,description:'mercado',date:today};
  const b={...a,id:'22222222-2222-4222-8222-222222222222',description:'cerveja'};
  const st={...base,transactions:[a,b]};
  expect(lastRecord(st)?.id).toBe(b.id);
  expect(resolveTarget({descricao:'esse'},st,'coloca esse em lazer').target?.id).toBe(b.id);
  expect(resolveTarget({descricao:'mercado'},st,'o mercado foi lazer').target?.id).toBe(a.id);
  expect(resolveTarget({descricao:'xyz'},st,'o xyz foi lazer').reason).toBe('TARGET_NOT_FOUND');
 });
});

class Fake implements Messenger{sent:{phone:string;message:string}[]=[];async sendText(phone:string,message:string){this.sent.push({phone,message});}async downloadAudio(){return new Uint8Array(1);}}
describe('no WhatsApp, com os lançamentos vindos do banco',()=>{
 it('registra, depois "coloca em lazer", depois "sim": o banco fica com a categoria',async()=>{
  const OWNER='5511999990000';
  let prov=model({calls:[tc('registrar_transacao',expense(7.9,'cerveja','cerveja 7,90'))]});
  const store=new MemoryStore(),messenger=new Fake(),ledger=new MemoryLedger();
  const deps:Deps={ownerPhone:OWNER,store,ledger,messenger,provider:()=>prov,transcriber:()=>({name:'f',transcribe:async()=>({text:'',model:'f'})}),today:()=>today,log:()=>{}};
  await handleInbound(deps,{kind:'text',phone:OWNER,messageId:'m1',text:'cerveja 7,90'});
  prov=model({calls:[tc('propor_edicao_transacao',{alvo:{descricao:'último'},novo:{category:'Lazer'},evidencia:'coloca em lazer'})]});
  await handleInbound(deps,{kind:'text',phone:OWNER,messageId:'m2',text:'coloca em lazer'});
  expect(messenger.sent.at(-1)!.message).toContain('Quer que eu coloque');
  prov=model({content:'x'});
  await handleInbound(deps,{kind:'text',phone:OWNER,messageId:'m3',text:'sim'});
  expect(ledger.workspaces.get(OWNER)!.entries[0].category).toBe('Lazer');
 });
});
