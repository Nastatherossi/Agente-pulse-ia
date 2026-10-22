import {describe,it,expect,vi} from 'vitest';
import {runConversation} from '../shared/v2/agent';
import {normalizeCategory,cleanCategoryName,categoryInReply} from '../shared/v2/policy';
import {MemoryStore} from '../server/whatsapp/store';
import {MemoryLedger,SupabaseLedger} from '../server/whatsapp/ledger';
import {handleInbound,type Deps} from '../server/whatsapp/handler';
import type {Provider,ModelResult} from '../shared/v2/contracts';
import type {Messenger} from '../server/whatsapp/zapi';
/* O usuário pode criar categorias novas quando pedir; o agente nunca inventa uma por conta própria. */
const today='2026-10-22';
let n=0;const tc=(name:string,args:unknown)=>({id:`call_${++n}`,name,arguments:args});
const model=(...turns:ModelResult[]):Provider=>({mode:'real',next:vi.fn().mockImplementation(async()=>turns.shift()||{content:'ok'})});
const expense=(amount:number,description:string,evidencia:string,category?:string)=>({type:'despesa',amount,description,date:today,evidencia,natureza:'fato_ocorrido',...(category?{category}:{})});

describe('regras da categoria nova',()=>{
 it('aceita quando o usuário pede com a palavra "categoria" e o nome aparece na mensagem',()=>{
  expect(normalizeCategory('namorado','gastei 80 de presente, cria uma categoria namorado','presente','despesa')).toBe('Namorado');
  expect(normalizeCategory('Pets','coloca na categoria Pets','ração','despesa')).toBe('Pets');
 });
 it('não aceita categoria que o modelo inventou',()=>{
  expect(normalizeCategory('Namorado','gastei 80 de presente','presente','despesa')).toBeUndefined();
  expect(normalizeCategory('Pets','cria uma categoria cachorro','ração','despesa')).toBeUndefined(); // nome não bate com o que foi pedido
 });
 it('categoria que o usuário já tem vale sem repetir o pedido',()=>{
  expect(normalizeCategory('namorado','gastei 30 com ele','jantar','despesa',['Namorado'])).toBe('Namorado');
 });
 it('rótulos neutros e nomes inválidos não viram categoria',()=>{
  for(const raw of ['outros','Sem categoria','geral','x','   '])expect(normalizeCategory(raw,`cria uma categoria ${raw}`,'coisa','despesa')).toBeUndefined();
  expect(cleanCategoryName('<script>alert(1)</script>')).toBe('Script alert 1 script');
  expect(cleanCategoryName('a'.repeat(80))!.length).toBe(30);
 });
 it('limite de categorias próprias',()=>{
  const many=Array.from({length:40},(_,i)=>`Cat${i}`);
  expect(normalizeCategory('Nova','cria uma categoria nova','x','despesa',many)).toBeUndefined();
 });
 it('"sim, em pets" reconhece categoria própria',()=>{expect(categoryInReply('sim, em pets',['Pets'])).toBe('Pets');});
});

describe('conversa: "cria uma categoria namorado e registra isso"',()=>{
 it('registra já na categoria nova',async()=>{
  const msg='gastei 80 de presente pro meu namorado, cria uma categoria namorado e registra isso la';
  const r=await runConversation(model({calls:[tc('registrar_transacao',expense(80,'presente',msg,'namorado'))]}),undefined,msg,crypto.randomUUID(),today,{realData:true});
  expect(r.session.state.transactions[0]).toMatchObject({amount:80,category:'Namorado'});
 });
 it('sem o pedido, o modelo não consegue inventar a categoria',async()=>{
  const msg='gastei 80 de presente pro meu namorado';
  const r=await runConversation(model({calls:[tc('registrar_transacao',expense(80,'presente',msg,'Namorado'))]}),undefined,msg,crypto.randomUUID(),today,{realData:true});
  const t=r.session.state.transactions[0];
  expect(t?.category).toBeUndefined();
 });
});

class Fake implements Messenger{sent:{phone:string;message:string}[]=[];async sendText(phone:string,message:string){this.sent.push({phone,message});}async downloadAudio(){return new Uint8Array(1);}}
describe('no WhatsApp com o banco',()=>{
 it('a categoria criada fica no banco e é lembrada nas próximas mensagens',async()=>{
  const OWNER='5511999990000';
  const m1='gastei 80 de presente pro meu namorado, cria uma categoria namorado';
  const m2='gastei 30 no jantar com ele';
  let prov=model({calls:[tc('registrar_transacao',expense(80,'presente',m1,'namorado'))]});
  const store=new MemoryStore(),messenger=new Fake(),ledger=new MemoryLedger();
  const deps:Deps={ownerPhone:OWNER,store,ledger,messenger,provider:()=>prov,transcriber:()=>({name:'f',transcribe:async()=>({text:'',model:'f'})}),today:()=>today,log:()=>{}};
  await handleInbound(deps,{kind:'text',phone:OWNER,messageId:'a1',text:m1});
  const w=ledger.workspaces.get(OWNER)!;
  expect(w.entries[0]).toMatchObject({category:'Namorado'});
  expect([...(w.categories??[])]).toEqual(['Namorado']);
  prov=model({calls:[tc('registrar_transacao',expense(30,'jantar',m2,'Namorado'))]});
  await handleInbound(deps,{kind:'text',phone:OWNER,messageId:'a2',text:m2}); // sem repetir o pedido
  expect(w.entries.map(e=>e.category)).toEqual(['Namorado','Namorado']);
 });
 it('SupabaseLedger cria a categoria antes de gravar o lançamento',async()=>{
  const calls:{url:string;method:string;body?:any}[]=[];
  let created=false;
  const f=(async(url:string,init:any={})=>{
   const c={url:String(url),method:init.method||'GET',body:init.body?JSON.parse(init.body):undefined};calls.push(c);
   if(c.method==='POST'&&c.url.includes('finance_categories'))created=true;
   const body=c.url.includes('finance_categories')&&c.method==='GET'?(created?[{id:'cat-new',name:'Namorado'}]:[]):[];
   return {ok:true,status:200,text:async()=>JSON.stringify(body)} as any;
  }) as unknown as typeof fetch;
  const ledger=new SupabaseLedger('https://x.supabase.co','svc',f);
  const WS={userId:'u',workspaceId:'11111111-1111-4111-8111-111111111111',accountId:'22222222-2222-4222-8222-222222222222'};
  await ledger.apply(WS,{create:[{id:'n1',type:'despesa',amount:80,description:'presente',date:today,category:'Namorado'}],update:[],remove:[]},'wa:M');
  const seed=calls.find(c=>c.method==='POST'&&c.url.includes('finance_categories'))!;
  expect(seed.body).toEqual([{workspace_id:WS.workspaceId,name:'Namorado',kind:'both'}]);
  const rpc=calls.find(c=>c.url.includes('rpc/finance_create_transaction'))!;
  expect(rpc.body.target_category_id).toBe('cat-new');
  expect(calls.indexOf(seed)).toBeLessThan(calls.indexOf(rpc));
 });
});
