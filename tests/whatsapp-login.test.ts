import {describe,it,expect} from 'vitest';
import {MemoryStore} from '../server/whatsapp/store';
import {MemoryLedger} from '../server/whatsapp/ledger';
import {handleSmsHook,createSmsHook,signStandardWebhook,verifyStandardWebhook,type SmsHookDeps} from '../server/whatsapp/smsHook';
import {handleInbound,type Deps} from '../server/whatsapp/handler';
import type {Messenger} from '../server/whatsapp/zapi';
/* Login do dashboard por código no WhatsApp (Send SMS Hook do Supabase). Sem rede. */
const OWNER='5511999990000',GUEST='5511988887777',STRANGER='5511977776666';
class Fake implements Messenger{
 sent:{phone:string;message:string}[]=[];fail=false;
 async sendText(phone:string,message:string){if(this.fail)throw new Error('ZAPI_SEND_500');this.sent.push({phone,message});}
 async downloadAudio(){return new Uint8Array(1);}
}
const setup=async()=>{
 const store=new MemoryStore(),messenger=new Fake();
 await store.upsertContact({phone:GUEST,name:'Ana',status:'authorized'});
 await store.upsertContact({phone:STRANGER,status:'pending'});
 const deps:SmsHookDeps={ownerPhone:OWNER,store,messenger,log:()=>{}};
 return {store,messenger,deps};
};
const payload=(phone:string,otp='123456')=>({user:{id:'u',phone:'+'+phone},sms:{otp}});

describe('envio do código',()=>{
 it('número autorizado recebe o código no WhatsApp',async()=>{
  const {deps,messenger}=await setup();
  const r=await handleSmsHook(deps,payload(GUEST));
  expect(r).toEqual({status:200,body:{}});
  expect(messenger.sent).toHaveLength(1);
  expect(messenger.sent[0].phone).toBe(GUEST);
  expect(messenger.sent[0].message).toContain('123456');
 });
 it('o dono recebe mesmo sem estar na lista',async()=>{
  const {deps,messenger}=await setup();
  expect((await handleSmsHook(deps,payload(OWNER))).status).toBe(200);
  expect(messenger.sent[0].phone).toBe(OWNER);
 });
 it('número pendente, desconhecido ou bloqueado não recebe nada e vê a instrução',async()=>{
  const {deps,messenger,store}=await setup();
  await store.upsertContact({phone:'5511966665555',status:'blocked'});
  for(const p of [STRANGER,'5511955554444','5511966665555']){
   const r=await handleSmsHook(deps,payload(p));
   expect(r.status).toBe(403);
   expect(JSON.stringify(r.body)).toContain('não foi liberado');
  }
  expect(messenger.sent).toHaveLength(0);
 });
 it('pedido malformado é recusado',async()=>{
  const {deps,messenger}=await setup();
  expect((await handleSmsHook(deps,{})).status).toBe(400);
  expect((await handleSmsHook(deps,payload(GUEST,'abc'))).status).toBe(400);
  expect((await handleSmsHook(deps,{user:{phone:'123'},sms:{otp:'123456'}})).status).toBe(400);
  expect(messenger.sent).toHaveLength(0);
 });
 it('falha do Z-API vira erro claro, sem vazar o código',async()=>{
  const {deps,messenger}=await setup();
  messenger.fail=true;
  const r=await handleSmsHook(deps,payload(GUEST));
  expect(r.status).toBe(502);
  expect(JSON.stringify(r.body)).not.toContain('123456');
 });
});

describe('autenticação do endpoint',()=>{
 const res=()=>{const r:any={code:0,out:undefined,headers:{}};r.status=(n:number)=>{r.code=n;return r;};r.json=(x:unknown)=>{r.out=x;};r.setHeader=(k:string,v:string)=>{r.headers[k]=v;};return r;};
 const KEY='k'.repeat(32);
 it('sem a chave da URL: 401 e nada enviado',async()=>{
  const {deps,messenger}=await setup();
  const h=createSmsHook({key:KEY},deps);
  const r=res();await h({method:'POST',url:'/api/auth-sms-hook?k=errada',body:payload(GUEST)},r);
  expect(r.code).toBe(401);expect(messenger.sent).toHaveLength(0);
  const r2=res();await h({method:'POST',url:'/api/auth-sms-hook',body:payload(GUEST)},r2);
  expect(r2.code).toBe(401);
 });
 it('só aceita POST',async()=>{
  const {deps}=await setup();
  const r=res();await createSmsHook({key:KEY},deps)({method:'GET',url:`/?k=${KEY}`},r);
  expect(r.code).toBe(405);
 });
 it('com a chave certa envia',async()=>{
  const {deps,messenger}=await setup();
  const r=res();await createSmsHook({key:KEY},deps)({method:'POST',url:`/api/auth-sms-hook?k=${KEY}&x-vercel-protection-bypass=abc`,body:payload(GUEST)},r);
  expect(r.code).toBe(200);expect(messenger.sent).toHaveLength(1);
 });
 const SECRET='v1,whsec_'+Buffer.from('segredo-de-teste-123456').toString('base64');
 const signed=(body:string,ts=String(Math.floor(Date.now()/1000)))=>({'webhook-id':'msg_1','webhook-timestamp':ts,'webhook-signature':signStandardWebhook(SECRET,'msg_1',ts,body)});
 it('assinatura do Supabase: válida passa, adulterada ou antiga não',()=>{
  const body=JSON.stringify(payload(GUEST));
  expect(verifyStandardWebhook(SECRET,signed(body),body)).toBe(true);
  expect(verifyStandardWebhook(SECRET,signed(body),body+' ')).toBe(false);
  expect(verifyStandardWebhook(SECRET,{},body)).toBe(false);
  const old=String(Math.floor(Date.now()/1000)-3600);
  expect(verifyStandardWebhook(SECRET,signed(body,old),body)).toBe(false);
  expect(verifyStandardWebhook('v1,whsec_'+Buffer.from('outro').toString('base64'),signed(body),body)).toBe(false);
 });
 it('com segredo de assinatura configurado, exige a assinatura',async()=>{
  const {deps,messenger}=await setup();
  const body=JSON.stringify(payload(GUEST));
  const h=createSmsHook({key:KEY,signingSecret:SECRET},deps);
  const bad=res();await h({method:'POST',url:`/?k=${KEY}`,body:payload(GUEST),rawBody:body,headers:{}},bad);
  expect(bad.code).toBe(401);expect(messenger.sent).toHaveLength(0);
  const ok=res();await h({method:'POST',url:`/?k=${KEY}`,body:payload(GUEST),rawBody:body,headers:signed(body)},ok);
  expect(ok.code).toBe(200);expect(messenger.sent).toHaveLength(1);
 });
});

describe('autorizar já cria a conta do número',()=>{
 it('o login por código precisa de um usuário existente, então o dono liberar cria o usuário',async()=>{
  const store=new MemoryStore(),messenger=new Fake(),ledger=new MemoryLedger();
  const deps:Deps={ownerPhone:OWNER,store,ledger,messenger,provider:()=>({mode:'real',next:async()=>({content:'ok'})}),transcriber:()=>({name:'f',transcribe:async()=>({text:'',model:'f'})}),today:()=>'2026-10-20',log:()=>{}};
  await handleInbound(deps,{kind:'text',phone:OWNER,messageId:'O1',text:`autorizar ${GUEST} Ana`});
  expect(ledger.workspaces.has(GUEST)).toBe(true);
  expect(messenger.sent.some(s=>s.phone===GUEST&&s.message.includes('liberado'))).toBe(true);
 });
 it('falha ao criar a conta não impede a liberação',async()=>{
  const store=new MemoryStore(),messenger=new Fake(),ledger=new MemoryLedger();
  ledger.resolve=async()=>{throw new Error('SUPABASE_500');};
  const deps:Deps={ownerPhone:OWNER,store,ledger,messenger,provider:()=>({mode:'real',next:async()=>({content:'ok'})}),transcriber:()=>({name:'f',transcribe:async()=>({text:'',model:'f'})}),today:()=>'2026-10-20',log:()=>{}};
  await handleInbound(deps,{kind:'text',phone:OWNER,messageId:'O1',text:`autorizar ${GUEST}`});
  expect((await store.getContact(GUEST))?.status).toBe('authorized');
 });
});
