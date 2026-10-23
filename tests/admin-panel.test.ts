import {describe,it,expect,vi} from 'vitest';
import {createAdmin,summarize,sessionToken,esc,COOKIE,type AdminDeps} from '../server/admin/panel';
import type {UsageRecord,TurnDetail} from '../server/whatsapp/store';
import {fmtPhone} from '../server/admin/panel';
import type {Contact} from '../shared/whatsapp/access';
const PASS='uma-senha-bem-longa-123';
const NOW=Date.parse('2026-10-22T12:00:00Z');
const c=(phone:string,status:Contact['status'],name?:string):Contact=>({phone,status,name});
const u=(phone:string,hoursAgo:number,over:Partial<UsageRecord>={}):UsageRecord=>({phone,model:'m',input_tokens:1000,output_tokens:100,status:'success',error_code:null,created_at:new Date(NOW-hoursAgo*3600_000).toISOString(),...over});
const turn=(id:string,over:Partial<TurnDetail>={}):TurnDetail=>({message_id:id,phone:'5511911110000',model:'gpt-x',input_tokens:14945,output_tokens:98,status:'error',error_code:'TOKEN_LIMIT',created_at:new Date(NOW-3600_000).toISOString(),source:'text',model_calls:3,user_text:'gastei 50 no mercado e 30 na farmácia',reply_text:'Tive um problema técnico agora.',intent:'registrar',duration_ms:4200,confirmation:'none',steps:[{name:'registrar_transacao',status:'blocked',durationMs:3,arguments:{amount:50},error:{code:'POLICY',message:'x'}}],...over});
const res=()=>{const r:any={code:0,headers:{} as Record<string,string>,body:''};r.status=(n:number)=>{r.code=n;return r;};r.setHeader=(k:string,v:string)=>{r.headers[k]=v;};r.send=(b:string)=>{r.body=b;};r.end=()=>{};return r;};
const setup=(over:Partial<AdminDeps>={})=>{
 const run=vi.fn().mockResolvedValue('Autorizado.');
 const deps:AdminDeps={source:{contacts:async()=>[c('5511911110000','authorized','Ana'),c('5511922220000','pending')],usageSince:async()=>[u('5511911110000',1),u('5511911110000',30,{status:'error',error_code:'OPENAI_TIMEOUT'})],problemTurns:async()=>[turn('T1')],turn:async(id)=>id==='T1'?turn('T1'):null},run,now:()=>NOW,...over};
 return {run,handler:createAdmin({password:PASS},deps)};
};
const authed={cookie:`${COOKIE}=${sessionToken(PASS)}`};

describe('painel de gestão',()=>{
 it('sem senha configurada fica desativado',async()=>{
  const r=res();await createAdmin({password:''},setup().run as any)({method:'GET',headers:{}},r);
  expect(r.code).toBe(503);
 });
 it('sem cookie mostra só o login e nenhum dado',async()=>{
  const {handler}=setup();const r=res();await handler({method:'GET',headers:{}},r);
  expect(r.code).toBe(200);expect(r.body).toContain('type="password"');expect(r.body).not.toContain('5511911110000');
 });
 it('POST de ação sem login é recusado e não executa nada',async()=>{
  const {handler,run}=setup();const r=res();await handler({method:'POST',headers:{},body:{action:'authorize',phone:'5511922220000'}},r);
  expect(r.code).toBe(401);expect(run).not.toHaveBeenCalled();
 });
 it('cookie errado não entra',async()=>{
  const {handler}=setup();const r=res();await handler({method:'GET',headers:{cookie:`${COOKIE}=abc`}},r);
  expect(r.body).toContain('type="password"');
 });
 it('senha certa redireciona com cookie HttpOnly/Secure/Strict',async()=>{
  const {handler}=setup();const r=res();await handler({method:'POST',headers:{},body:`action=login&password=${PASS}`},r);
  expect(r.code).toBe(303);expect(r.headers['Set-Cookie']).toMatch(/HttpOnly; Secure; SameSite=Strict/);
 });
 it('senha errada responde 401',async()=>{
  const sleep=vi.fn().mockResolvedValue(undefined);const {handler}=setup({sleep});const r=res();await handler({method:'POST',headers:{},body:{action:'login',password:'errada'}},r);
  expect(sleep).toHaveBeenCalled();
  expect(r.code).toBe(401);expect(r.body).toContain('Senha incorreta');
 });
 it('logado, mostra usuários, consumo e erros',async()=>{
  const {handler}=setup();const r=res();await handler({method:'GET',headers:authed},r);
  expect(r.code).toBe(200);expect(r.body).toContain('Ana');expect(r.body).toContain('Pendente');expect(r.body).toContain('Precisa de atenção');expect(r.body).toContain('gastei 50 no mercado');
 });
 it('autorizar chama o mesmo comando do dono e mostra o resultado',async()=>{
  const {handler,run}=setup();const r=res();await handler({method:'POST',headers:authed,body:{action:'authorize',phone:'+55 11 92222-0000'}},r);
  expect(run).toHaveBeenCalledWith('autorizar 5511922220000');expect(r.body).toContain('Autorizado.');
 });
 it('telefone inválido não executa',async()=>{
  const {handler,run}=setup();const r=res();await handler({method:'POST',headers:authed,body:{action:'block',phone:'12'}},r);
  expect(run).not.toHaveBeenCalled();expect(r.body).toContain('Número inválido');
 });
 it('erro do banco vira mensagem, sem vazar detalhe',async()=>{
  const {handler}=setup({source:{contacts:async()=>{throw new Error('SUPABASE_500 secret');},usageSince:async()=>[],problemTurns:async()=>[],turn:async()=>null}});const r=res();await handler({method:'GET',headers:authed},r);
  expect(r.code).toBe(502);expect(r.body).not.toContain('secret');
 });
 it('escapa HTML vindo de nome de contato',async()=>{
  const {handler}=setup({source:{contacts:async()=>[c('5511900000000','pending','<script>alert(1)</script>')],usageSince:async()=>[],problemTurns:async()=>[],turn:async()=>null}});const r=res();await handler({method:'GET',headers:authed},r);
  expect(r.body).not.toContain('<script>alert');expect(esc('<b>')).toBe('&lt;b&gt;');
 });
});

describe('telas de problemas',()=>{
 it('lista mostra o que o usuário mandou e como o Pulse respondeu',async()=>{
  const {handler}=setup();const r=res();await handler({method:'GET',url:'/admin?v=problemas',headers:authed},r);
  expect(r.body).toContain('gastei 50 no mercado');expect(r.body).toContain('Tive um problema técnico');expect(r.body).toContain('TOKEN_LIMIT');
 });
 it('detalhe mostra quando, quem, erro explicado, tokens e ferramentas',async()=>{
  const {handler}=setup();const r=res();await handler({method:'GET',url:'/admin?v=turno&id=T1',headers:authed},r);
  expect(r.body).toContain('O que significa');expect(r.body).toContain('limite de tokens');expect(r.body).toContain('registrar_transacao');
  expect(r.body).toContain('14.945');expect(r.body).toContain('+55 (11) 91111-0000');expect(r.body).toContain('4.2 s');
 });
 it('detalhe de id inexistente não quebra',async()=>{
  const {handler}=setup();const r=res();await handler({method:'GET',url:'/admin?v=turno&id=nada',headers:authed},r);
  expect(r.code).toBe(200);expect(r.body).toContain('Não encontrei');
 });
 it('detalhe sem login não vaza nada',async()=>{
  const {handler}=setup();const r=res();await handler({method:'GET',url:'/admin?v=turno&id=T1',headers:{}},r);
  expect(r.body).not.toContain('gastei 50');
 });
 it('sem estilos inline (a CSP bloquearia)',async()=>{
  const {handler}=setup();const r=res();await handler({method:'GET',headers:authed},r);
  expect(r.body).not.toMatch(/style=/);
 });
 it('formata telefone brasileiro',()=>{expect(fmtPhone('5519996009701')).toBe('+55 (19) 99600-9701');});
});

describe('resumo de consumo',()=>{
 const contacts=[c('1','authorized','A'),c('2','authorized','B'),c('3','blocked')];
 const usage=[u('1',2),u('1',50),u('2',24*10,{status:'error',error_code:'X'}),u('1',24*40)];
 it('conta por período e por pessoa',()=>{
  const s=summarize(contacts,usage.slice(0,3),NOW);
  expect(s.counts).toEqual({authorized:2,pending:0,blocked:1});
  expect(s.messages).toEqual({d1:1,d7:2,d30:3});
  expect(s.errors7d).toBe(0);expect(s.perDay).toHaveLength(14);
  expect(s.people.find(p=>p.contact.phone==='1')?.messages30d).toBe(2);
 });
 it('calcula custo só com preço definido',()=>{
  expect(summarize(contacts,usage,NOW).cost30d).toBeUndefined();
  const s=summarize(contacts,[u('1',1,{input_tokens:1_000_000,output_tokens:1_000_000})],NOW,{inputPerMTok:2,outputPerMTok:8});
  expect(s.cost30d).toBe(10);
 });
});
