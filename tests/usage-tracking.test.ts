import {describe,it,expect,vi} from 'vitest';
import type {Provider,ModelResult} from '../shared/v2/contracts';
import {MemoryStore} from '../server/whatsapp/store';
import {MemoryLedger} from '../server/whatsapp/ledger';
import {handleInbound,type Deps} from '../server/whatsapp/handler';
import type {Inbound,Messenger} from '../server/whatsapp/zapi';
const today='2026-10-22',OWNER='5511999990000';
const model=(...turns:ModelResult[]):Provider=>({mode:'real',next:vi.fn().mockImplementation(async()=>turns.shift()||{content:'ok'})});
class Fake implements Messenger{sent:string[]=[];async sendText(_p:string,m:string){this.sent.push(m);}async downloadAudio(){return new Uint8Array(20000).fill(1);}}
const text=(messageId:string,t:string):Extract<Inbound,{kind:'text'}>=>({kind:'text',phone:OWNER,messageId,text:t});
const setup=(provider:Provider,store=new MemoryStore())=>{
 const deps:Deps={ownerPhone:OWNER,store,ledger:new MemoryLedger(),messenger:new Fake(),provider:()=>provider,transcriber:()=>({name:'fake',transcribe:async()=>({text:'',model:'fake'})}),today:()=>today,log:()=>{}};
 return {store,deps};
};
describe('registro de consumo de IA',()=>{
 it('guarda tokens, modelo e status por mensagem, sem o texto',async()=>{
  const {store,deps}=setup(model({content:'Oi! Como posso ajudar?',model:'gpt-x',usage:{inputTokens:900,outputTokens:40,totalTokens:940}}));
  await handleInbound(deps,text('M1','olá, tudo bem?'));
  expect(store.usage).toHaveLength(1);
  expect(store.usage[0]).toMatchObject({phone:OWNER,messageId:'M1',source:'text',model:'gpt-x',inputTokens:900,outputTokens:40});
  expect(JSON.stringify(store.usage[0])).not.toContain('tudo bem');
 });
 it('falha ao registrar consumo não atrapalha a resposta',async()=>{
  const store=new MemoryStore();store.recordUsage=async()=>{throw new Error('SUPABASE_DOWN');};
  const {deps}=setup(model({content:'Oi!',usage:{inputTokens:10,outputTokens:5,totalTokens:15}}),store);
  await handleInbound(deps,text('M2','olá'));
  expect((deps.messenger as Fake).sent.length).toBeGreaterThan(0);
 });
});

describe('texto só em turnos com problema',()=>{
 const rowsOf=(store:MemoryStore)=>store.usage;
 it('turno normal não guarda o texto',async()=>{
  const {store,deps}=setup(model({content:'Oi!',usage:{inputTokens:10,outputTokens:5,totalTokens:15}}));
  await handleInbound(deps,text('M3','bom dia'));
  expect(rowsOf(store)[0].userText).toBeUndefined();
 });
 it('erro do agente guarda o que o usuário mandou e o que o Pulse respondeu',async()=>{
  const {store,deps}=setup({mode:'real',next:vi.fn().mockRejectedValue(new Error('OPENAI_TIMEOUT'))});
  await handleInbound(deps,text('M4','gastei 50 no mercado'));
  const r=rowsOf(store)[0];
  expect(r.status).toBe('error');expect(r.userText).toBe('gastei 50 no mercado');expect(r.replyText).toBeTruthy();
 });
});
