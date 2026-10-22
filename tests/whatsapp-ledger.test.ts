import {describe,it,expect,vi} from 'vitest';
import type {Provider,ModelResult} from '../shared/v2/contracts';
import {MemoryStore} from '../server/whatsapp/store';
import {MemoryLedger,SupabaseLedger,diffEntries,initialBalanceFor,agentCanSee,type Entry} from '../server/whatsapp/ledger';
import {handleInbound,type Deps} from '../server/whatsapp/handler';
import type {Inbound,Messenger} from '../server/whatsapp/zapi';
/*
 * Ligação do agente com o Financial Core: o que o agente grava aparece no banco (dashboard),
 * o que está no banco manda no saldo e nas listagens, e falha de banco nunca vira "registrado".
 * Nenhum teste usa rede.
 */
const today='2026-10-20';
const OWNER='5511999990000',GUEST='5511988887777';
let n=0;const tc=(name:string,args:unknown)=>({id:`call_${++n}`,name,arguments:args});
const model=(...turns:ModelResult[]):Provider=>({mode:'real',next:vi.fn().mockImplementation(async()=>turns.shift()||{content:'ok'})});
const expense=(amount:number,description:string,evidencia:string)=>({type:'despesa',amount,description,date:today,evidencia,natureza:'fato_ocorrido'});
class FakeMessenger implements Messenger{
 sent:{phone:string;message:string}[]=[];
 async sendText(phone:string,message:string){this.sent.push({phone,message});}
 async downloadAudio(){return new Uint8Array(20000).fill(1);}
 to(phone:string){return this.sent.filter(s=>s.phone===phone).map(s=>s.message);}
}
const text=(phone:string,messageId:string,t:string):Extract<Inbound,{kind:'text'}>=>({kind:'text',phone,messageId,text:t});
const setup=(provider:()=>Provider)=>{
 const store=new MemoryStore(),messenger=new FakeMessenger(),ledger=new MemoryLedger();
 const deps:Deps={ownerPhone:OWNER,store,ledger,messenger,provider,transcriber:()=>({name:'fake',transcribe:async()=>({text:'',model:'fake'})}),today:()=>today,log:()=>{}};
 return {store,messenger,ledger,deps};
};
const authorized=async(provider:()=>Provider)=>{const s=setup(provider);await handleInbound(s.deps,text(OWNER,'O0',`autorizar ${GUEST} Ana`));s.messenger.sent.length=0;return s;};
const e=(id:string,over:Partial<Entry>={}):Entry=>({id,type:'despesa',amount:10,description:'x',date:today,...over});

describe('diferença entre o banco e o que o agente fez',()=>{
 it('detecta criação, edição e exclusão',()=>{
  const before=[e('1'),e('2'),e('3')];
  const after=[e('1'),e('2',{amount:99}),e('4',{description:'novo'})];
  const d=diffEntries(before,after);
  expect(d.create.map(x=>x.id)).toEqual(['4']);
  expect(d.update.map(x=>x.id)).toEqual(['2']);
  expect(d.remove).toEqual(['3']);
 });
 it('sem mudança não há o que gravar',()=>{expect(diffEntries([e('1')],[e('1')])).toEqual({create:[],update:[],remove:[]});});
 it('mudar só a categoria conta como edição',()=>{expect(diffEntries([e('1')],[e('1',{category:'Lazer'})]).update).toHaveLength(1);});
});

describe('saldo inicial do agente bate com o do dashboard',()=>{
 it('abertura + resultado de tudo - o que o agente enxerga',()=>{
  // abertura R$100, banco confirmado: +R$500 -R$50 = +R$450; agente enxerga só a despesa de 50
  expect(initialBalanceFor(10000,45000,[e('1',{amount:50})])).toBe(10000+45000+5000);
 });
 it('nunca fica negativo nem passa do limite do contrato',()=>{
  expect(initialBalanceFor(0,-5000,[])).toBe(0);
  expect(initialBalanceFor(0,999_999_999_99,[])).toBe(100_000_000);
 });
 it('lançamento que o contrato do agente rejeitaria fica fora da lista (mas dentro do saldo)',()=>{
  expect(agentCanSee({amount:2_000_000,date:today,description:'x'})).toBe(false);
  expect(agentCanSee({amount:10.123,date:today,description:'x'})).toBe(false);
  expect(agentCanSee({amount:10,date:null,description:'x'})).toBe(false);
  expect(agentCanSee({amount:10,date:today,description:'  '})).toBe(false);
  expect(agentCanSee({amount:10.5,date:today,description:'ok'})).toBe(true);
 });
});

describe('WhatsApp → Financial Core',()=>{
 it('o gasto registrado na conversa vai para o banco',async()=>{
  const msg='gastei 50 no mercado';
  const {deps,ledger,messenger}=await authorized(()=>model({calls:[tc('registrar_transacao',expense(50,'mercado',msg))]}));
  await handleInbound(deps,text(GUEST,'M1',msg));
  expect(messenger.to(GUEST)[0]).toContain('50,00');
  const w=ledger.workspaces.get(GUEST)!;
  expect(w.entries).toHaveLength(1);
  expect(w.entries[0]).toMatchObject({type:'despesa',amount:50,description:'mercado',date:today});
 });
 it('cada número tem o seu próprio workspace',async()=>{
  const msg='gastei 50 no mercado';
  const {deps,ledger}=await authorized(()=>model({calls:[tc('registrar_transacao',expense(50,'mercado',msg))]}));
  await handleInbound(deps,text(GUEST,'M1',msg));
  await handleInbound(deps,text(OWNER,'M2',msg));
  const a=ledger.workspaces.get(GUEST)!,b=ledger.workspaces.get(OWNER)!;
  expect(a.ws.workspaceId).not.toBe(b.ws.workspaceId);
  expect(a.entries).toHaveLength(1);
  expect(b.entries).toHaveLength(1);
 });
 it('o saldo respondido vem do banco, inclusive o que foi lançado no dashboard',async()=>{
  const m=model({calls:[tc('consultar_saldo',{})]},{content:'x'});
  const {deps,ledger,messenger}=await authorized(()=>m);
  await ledger.resolve(GUEST);
  const w=ledger.workspaces.get(GUEST)!;
  w.opening=100000; // R$ 1.000,00 de abertura
  w.entries.push(e('d1d1d1d1-0000-4000-8000-000000000001',{type:'receita',amount:250,description:'freela'}));
  await handleInbound(deps,text(GUEST,'M1','qual meu saldo?'));
  expect(messenger.to(GUEST)[0]).toContain('1.250,00');
  expect(messenger.to(GUEST)[0]).not.toContain('fictício');
 });
 it('lançamento feito no dashboard depois da última conversa aparece na próxima',async()=>{
  const m=model({calls:[tc('consultar_saldo',{})]},{content:'x'},{calls:[tc('consultar_saldo',{})]},{content:'x'});
  const {deps,ledger,messenger}=await authorized(()=>m);
  await handleInbound(deps,text(GUEST,'M1','saldo?'));
  expect(messenger.to(GUEST)[0]).toContain('0,00');
  ledger.workspaces.get(GUEST)!.entries.push(e('d1d1d1d1-0000-4000-8000-000000000001',{type:'receita',amount:300,description:'salário'}));
  await handleInbound(deps,text(GUEST,'M2','saldo agora?'));
  expect(messenger.to(GUEST)[1]).toContain('300,00');
 });
 it('banco fora do ar: o usuário recebe aviso de problema, não um "registrado" falso, e a mensagem pode ser reenviada',async()=>{
  const msg='gastei 50 no mercado';
  const {deps,ledger,messenger,store}=await authorized(()=>model({calls:[tc('registrar_transacao',expense(50,'mercado',msg))]},{calls:[tc('registrar_transacao',expense(50,'mercado',msg))]}));
  await ledger.resolve(GUEST);
  ledger.failNextApply=true;
  await handleInbound(deps,text(GUEST,'M1',msg));
  expect(messenger.to(GUEST)[0]).toContain('problema técnico');
  expect(ledger.workspaces.get(GUEST)!.entries).toHaveLength(0);
  expect((await store.getSession(GUEST))).toBeNull();
 });
 it('sem ledger o agente continua funcionando só com a sessão (laboratório)',async()=>{
  const msg='gastei 50 no mercado';
  const s=setup(()=>model({calls:[tc('registrar_transacao',expense(50,'mercado',msg))]}));
  const deps:Deps={...s.deps,ledger:undefined};
  await handleInbound(deps,text(OWNER,'M1',msg));
  expect(s.messenger.to(OWNER)[0]).toContain('50,00');
  expect(s.ledger.workspaces.size).toBe(0);
 });
});

describe('SupabaseLedger (requisições)',()=>{
 type Call={url:string;method:string;body?:any};
 const fake=(routes:(c:Call)=>{status?:number;body?:unknown})=>{
  const calls:Call[]=[];
  const f=(async(url:string,init:any={})=>{
   const c:Call={url:String(url),method:init.method||'GET',body:init.body?JSON.parse(init.body):undefined};
   calls.push(c);
   const r=routes(c);
   return {ok:(r.status??200)<400,status:r.status??200,text:async()=>r.body===undefined?'':JSON.stringify(r.body)} as any;
  }) as unknown as typeof fetch;
  return {calls,ledger:new SupabaseLedger('https://x.supabase.co','svc',f)};
 };
 const WS={userId:'u',workspaceId:'11111111-1111-4111-8111-111111111111',accountId:'22222222-2222-4222-8222-222222222222'};
 const row={user_id:'u',workspace_id:WS.workspaceId,account_id:WS.accountId};

 it('número novo: cria o usuário pelo Auth Admin, semeia categorias e devolve o workspace',async()=>{
  let found=false;
  const {calls,ledger}=fake(c=>{
   if(c.url.includes('/auth/v1/admin/users')){found=true;return {body:{id:'u'}};}
   if(c.url.includes('rpc/whatsapp_workspace_for_phone'))return {body:found?[row]:[]};
   if(c.url.includes('finance_categories')&&c.method==='GET')return {body:[{id:'c1',name:'Renda'}]};
   return {body:[]};
  });
  const ws=await ledger.resolve('5511988887777','Ana');
  expect(ws).toEqual(WS);
  const create=calls.find(c=>c.url.includes('/auth/v1/admin/users'))!;
  expect(create.body).toEqual({phone:'5511988887777',phone_confirm:true,user_metadata:{name:'Ana'}});
  const seed=calls.find(c=>c.method==='POST'&&c.url.includes('finance_categories'))!;
  expect(seed.body.map((r:any)=>r.name)).not.toContain('Renda');
  expect(seed.body).toHaveLength(9);
  expect(seed.body.every((r:any)=>r.workspace_id===WS.workspaceId)).toBe(true);
 });
 it('corrida na criação (422): busca de novo em vez de falhar',async()=>{
  let n=0;
  const {ledger}=fake(c=>{
   if(c.url.includes('/auth/v1/admin/users'))return {status:422,body:{}};
   if(c.url.includes('rpc/whatsapp_workspace_for_phone'))return {body:++n>1?[row]:[]};
   if(c.url.includes('finance_categories')&&c.method==='GET')return {body:[]};
   return {body:[]};
  });
  expect(await ledger.resolve('5511988887777')).toEqual(WS);
 });
 it('erro de verdade na criação do usuário não é engolido',async()=>{
  const {ledger}=fake(c=>c.url.includes('/auth/v1/admin/users')?{status:500}:{body:[]});
  let err='';try{await ledger.resolve('5511988887777');}catch(x){err=(x as Error).message;}
  expect(err).toBe('SUPABASE_500');
 });
 it('carrega confirmados, mapeia tipos e calcula o saldo inicial',async()=>{
  const {calls,ledger}=fake(c=>{
   if(c.url.includes('whatsapp_ledger_summary'))return {body:[{opening_cents:10000,net_cents:45000}]};
   if(c.url.includes('finance_categories'))return {body:[{id:'cat-food',name:'Alimentação'}]};
   return {body:[
    {id:'t2',type:'expense',amount:'50.00',description:'mercado',effective_date:today,category_id:'cat-food'},
    {id:'t1',type:'income',amount:'500',description:'freela',effective_date:'2026-10-01',category_id:null},
    {id:'big',type:'income',amount:'9999999',description:'estranho',effective_date:'2026-09-01',category_id:null},
   ]};
  });
  const s=await ledger.load(WS);
  expect(s.transactions.map(t=>t.id)).toEqual(['t1','t2']); // do mais antigo ao mais novo; o inválido fica de fora
  expect(s.transactions[1]).toEqual({id:'t2',type:'despesa',amount:50,description:'mercado',date:today,category:'Alimentação'});
  expect(s.initialBalanceCents).toBe(10000+45000-(50000-5000));
  const q=calls.find(c=>c.url.includes('finance_transactions'))!.url;
  expect(q).not.toContain('finance_categories(');
  expect(q).toContain(`workspace_id=eq.${WS.workspaceId}`);
  expect(q).toContain('status=eq.confirmed');
 });
 it('grava criação com chave idempotente, edição e exclusão sempre filtrando pelo workspace',async()=>{
  const {calls,ledger}=fake(c=>c.url.includes('finance_categories')?{body:[{id:'cat-food',name:'Alimentação'}]}:{body:[]});
  await ledger.apply(WS,{
   create:[e('n1',{amount:12.5,description:'padaria',category:'Alimentação'}),e('n2',{type:'receita',amount:100,description:'pix'})],
   update:[e('old1',{amount:20,description:'lanche'})],
   remove:['old2']
  },'wa:MSG1');
  const rpcs=calls.filter(c=>c.url.includes('rpc/finance_create_transaction'));
  expect(rpcs).toHaveLength(2);
  expect(rpcs[0].body).toMatchObject({target_workspace_id:WS.workspaceId,target_account_id:WS.accountId,target_category_id:'cat-food',target_amount:12.5,target_type:'expense',target_status:'confirmed',target_origin:'ai',target_effective_date:today,target_idempotency_key:'wa:MSG1:0'});
  expect(rpcs[1].body).toMatchObject({target_type:'income',target_category_id:null,target_idempotency_key:'wa:MSG1:1'});
  const patch=calls.find(c=>c.method==='PATCH')!;
  expect(patch.url).toContain(`id=eq.old1&workspace_id=eq.${WS.workspaceId}`);
  expect(patch.body).toMatchObject({amount:20,description:'lanche',type:'expense'});
  const del=calls.find(c=>c.method==='DELETE')!;
  expect(del.url).toContain(`id=eq.old2&workspace_id=eq.${WS.workspaceId}`);
 });
 it('sem mudanças não faz nenhuma requisição',async()=>{
  const {calls,ledger}=fake(()=>({body:[]}));
  await ledger.apply(WS,{create:[],update:[],remove:[]},'wa:X');
  expect(calls).toHaveLength(0);
 });
});
