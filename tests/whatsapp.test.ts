import {describe,it,expect,vi} from 'vitest';
import type {Provider,ModelResult} from '../shared/v2/contracts';
import {normalizePhone,parseOwnerCommand,decideAccess,formatPhone} from '../shared/whatsapp/access';
import {parseInbound,isSafeMediaUrl,type Inbound,type Messenger} from '../server/whatsapp/zapi';
import {MemoryStore} from '../server/whatsapp/store';
import {handleInbound,createHandler,requestIdFor,type Deps} from '../server/whatsapp/handler';
/*
 * Canal WhatsApp: formato do webhook da Z-API, autorização de números, comandos do dono,
 * deduplicação, persistência da conversa e regra de áudio. Nenhum teste usa rede.
 */
const today='2026-10-20';
const OWNER='5511999990000',GUEST='5511988887777';
let n=0;const tc=(name:string,args:unknown)=>({id:`call_${++n}`,name,arguments:args});
const model=(...turns:ModelResult[]):Provider=>({mode:'real',next:vi.fn().mockImplementation(async()=>turns.shift()||{content:'ok'})});
const expense=(amount:number,description:string,evidencia:string)=>({type:'despesa',amount,description,date:today,evidencia,natureza:'fato_ocorrido'});

class FakeMessenger implements Messenger{
 sent:{phone:string;message:string}[]=[];
 audio=new Uint8Array(20000).fill(1);
 async sendText(phone:string,message:string){this.sent.push({phone,message});}
 async downloadAudio(){return this.audio;}
 to(phone:string){return this.sent.filter(s=>s.phone===phone).map(s=>s.message);}
}
const setup=(provider:()=>Provider=()=>model({content:'Olá!'}),transcript='gastei 50 no mercado')=>{
 const store=new MemoryStore(),messenger=new FakeMessenger();
 const deps:Deps={ownerPhone:OWNER,store,messenger,provider,transcriber:()=>({name:'fake',transcribe:async()=>({text:transcript,model:'fake'})}),today:()=>today,log:()=>{}};
 return {store,messenger,deps};
};
const text=(phone:string,messageId:string,t:string):Extract<Inbound,{kind:'text'}>=>({kind:'text',phone,messageId,text:t});
const audio=(phone:string,messageId:string,seconds=5):Inbound=>({kind:'audio',phone,messageId,audioUrl:'https://exemplo.com/a.ogg',mimeType:'audio/ogg; codecs=opus',seconds});

describe('telefones e comandos do dono',()=>{
 it('normaliza só dígitos e completa o DDI do Brasil',()=>{
  expect(normalizePhone('(11) 98888-7777')).toBe('5511988887777');
  expect(normalizePhone('+55 11 98888-7777')).toBe('5511988887777');
  expect(normalizePhone('5511988887777')).toBe('5511988887777');
  expect(normalizePhone('123')).toBeUndefined();
  expect(normalizePhone(undefined)).toBeUndefined();
 });
 it('formata para leitura',()=>{expect(formatPhone('5511988887777')).toBe('+55 11 98888-7777');});
 it('entende autorizar com e sem número, com nome',()=>{
  expect(parseOwnerCommand('autorizar')).toEqual({kind:'authorize',phone:undefined,name:undefined});
  expect(parseOwnerCommand('Autorizar 5511988887777')).toEqual({kind:'authorize',phone:'5511988887777',name:undefined});
  expect(parseOwnerCommand('*autorizar* 11 98888-7777 João Silva')).toEqual({kind:'authorize',phone:'5511988887777',name:'João Silva'});
  expect(parseOwnerCommand('liberar 5511988887777')).toMatchObject({kind:'authorize'});
 });
 it('entende bloquear, remover, listar e ajuda',()=>{
  expect(parseOwnerCommand('bloquear')).toEqual({kind:'block',phone:undefined});
  expect(parseOwnerCommand('negar 5511988887777')).toEqual({kind:'block',phone:'5511988887777'});
  expect(parseOwnerCommand('remover 5511988887777')).toEqual({kind:'remove',phone:'5511988887777'});
  expect(parseOwnerCommand('listar')).toEqual({kind:'list'});
  expect(parseOwnerCommand('ajuda')).toEqual({kind:'help'});
 });
 it('número ilegível vira erro, e conversa comum não é comando',()=>{
  expect(parseOwnerCommand('autorizar abc')).toEqual({kind:'invalid',reason:'bad_phone'});
  expect(parseOwnerCommand('remover')).toEqual({kind:'invalid',reason:'bad_phone'});
  expect(parseOwnerCommand('gastei 30 no almoço')).toBeUndefined();
  expect(parseOwnerCommand('lista de compras do mês')).toBeUndefined();
  expect(parseOwnerCommand('autorizado')).toBeUndefined();
 });
 it('decide acesso: dono sempre, autorizado sim, bloqueado ignora, desconhecido fica pendente',()=>{
  expect(decideAccess(null,true)).toBe('agent');
  expect(decideAccess({phone:GUEST,status:'authorized'},false)).toBe('agent');
  expect(decideAccess({phone:GUEST,status:'blocked'},false)).toBe('ignore');
  expect(decideAccess({phone:GUEST,status:'pending'},false)).toBe('pending');
  expect(decideAccess(null,false)).toBe('pending');
 });
});

describe('webhook da Z-API',()=>{
 const base={type:'ReceivedCallback',instanceId:'INST1',messageId:'M1',phone:GUEST,fromMe:false,isGroup:false,momment:1,senderName:'Ana'};
 it('lê texto',()=>{
  expect(parseInbound({...base,text:{message:' gastei 30 '}},'INST1')).toEqual({kind:'text',messageId:'M1',phone:GUEST,name:'Ana',text:'gastei 30'});
 });
 it('lê áudio de voz',()=>{
  const r=parseInbound({...base,audio:{ptt:true,seconds:7,audioUrl:'https://x.exemplo.com/a.ogg',mimeType:'audio/ogg; codecs=opus'}},'INST1');
  expect(r).toMatchObject({kind:'audio',audioUrl:'https://x.exemplo.com/a.ogg',seconds:7});
 });
 it('mídia que não é texto nem áudio vira "unsupported"',()=>{expect(parseInbound({...base,image:{imageUrl:'https://x.exemplo.com/i.jpg'}},'INST1').kind).toBe('unsupported');});
 it('ignora o que não é conversa privada de outra pessoa',()=>{
  const ignored=(extra:object,inst='INST1')=>parseInbound({...base,text:{message:'oi'},...extra},inst).kind==='ignore';
  expect(ignored({fromMe:true})).toBe(true);
  expect(ignored({isGroup:true})).toBe(true);
  expect(ignored({participantPhone:'5511900000000'})).toBe(true);
  expect(ignored({isStatusReply:true})).toBe(true);
  expect(ignored({isEdit:true})).toBe(true);
  expect(ignored({type:'DeliveryCallback'})).toBe(true);
  expect(ignored({},'OUTRA')).toBe(true);
  expect(ignored({messageId:''})).toBe(true);
  expect(parseInbound(null).kind).toBe('ignore');
  expect(parseInbound('texto').kind).toBe('ignore');
 });
 it('só baixa mídia por HTTPS de host público',()=>{
  expect(isSafeMediaUrl('https://f004.backblazeb2.com/file/a.ogg')).toBe(true);
  for(const u of ['http://x.com/a.ogg','https://localhost/a','https://127.0.0.1/a','https://10.0.0.5/a','https://[::1]/a','https://user:pw@x.com/a','file:///etc/passwd','nao-e-url','https://servico.internal/a'])expect(isSafeMediaUrl(u)).toBe(false);
 });
});

describe('autorização de números',()=>{
 it('estranho não recebe resposta; o dono é avisado uma vez só',async()=>{
  const {deps,messenger,store}=setup();
  await handleInbound(deps,{...text(GUEST,'A1','oi, posso testar?'),name:'Ana'});
  await handleInbound(deps,text(GUEST,'A2','alô?'));
  expect(messenger.to(GUEST)).toEqual([]);
  expect(messenger.to(OWNER)).toHaveLength(1);
  expect(messenger.to(OWNER)[0]).toContain('Ana');
  expect(messenger.to(OWNER)[0]).toContain('autorizar');
  expect((await store.getContact(GUEST))?.status).toBe('pending');
 });
 it('"autorizar" sozinho libera o último pendente e manda boas-vindas',async()=>{
  const {deps,messenger,store}=setup();
  await handleInbound(deps,{...text(GUEST,'A1','oi'),name:'Ana Souza'});
  await handleInbound(deps,text(OWNER,'O1','autorizar'));
  expect((await store.getContact(GUEST))?.status).toBe('authorized');
  expect(messenger.to(GUEST)[0]).toContain('Oi, Ana!');
  expect(messenger.to(OWNER).at(-1)).toContain('liberado');
 });
 it('"autorizar" sem ninguém esperando explica o que fazer',async()=>{
  const {deps,messenger}=setup();
  await handleInbound(deps,text(OWNER,'O1','autorizar'));
  expect(messenger.to(OWNER)[0]).toContain('Não há nenhum número esperando');
 });
 it('só o dono executa comandos: de outro número, "autorizar" é só texto de um estranho',async()=>{
  const {deps,messenger,store}=setup();
  await handleInbound(deps,text(GUEST,'A1','autorizar 5511977776666'));
  expect(await store.getContact('5511977776666')).toBeNull();
  expect(messenger.to(GUEST)).toEqual([]);
 });
 it('bloqueado fica em silêncio, mesmo que insista',async()=>{
  const {deps,messenger}=setup();
  await handleInbound(deps,text(GUEST,'A1','oi'));
  await handleInbound(deps,text(OWNER,'O1',`bloquear ${GUEST}`));
  messenger.sent.length=0;
  await handleInbound(deps,text(GUEST,'A2','por favor'));
  expect(messenger.sent).toEqual([]);
 });
 it('remover apaga contato e conversa',async()=>{
  const {deps,store}=setup();
  await handleInbound(deps,text(OWNER,'O1',`autorizar ${GUEST}`));
  await handleInbound(deps,text(GUEST,'A1','gastei 10'));
  expect(await store.getSession(GUEST)).not.toBeNull();
  await handleInbound(deps,text(OWNER,'O2',`remover ${GUEST}`));
  expect(await store.getContact(GUEST)).toBeNull();
  expect(await store.getSession(GUEST)).toBeNull();
 });
 it('listar mostra os contatos com o estado de cada um',async()=>{
  const {deps,messenger}=setup();
  await handleInbound(deps,{...text(GUEST,'A1','oi'),name:'Ana'});
  await handleInbound(deps,text(OWNER,'O1','listar'));
  expect(messenger.to(OWNER).at(-1)).toContain('⏳');
  expect(messenger.to(OWNER).at(-1)).toContain('+55 11 98888-7777');
 });
});

describe('conversa com o agente',()=>{
 const authorized=async(provider?:()=>Provider,transcript?:string)=>{const s=setup(provider,transcript);await handleInbound(s.deps,text(OWNER,'O0',`autorizar ${GUEST} Ana`));s.messenger.sent.length=0;return s;};
 it('responde e guarda a conversa; a próxima mensagem continua dela',async()=>{
  const {deps,messenger,store}=await authorized(()=>model({content:'Oi Ana!'}));
  await handleInbound(deps,text(GUEST,'M1','oi'));
  expect(messenger.to(GUEST)).toEqual(['Oi Ana!']);
  expect((await store.getSession(GUEST))?.version).toBe(1);
  await handleInbound(deps,text(GUEST,'M2','tudo bem?'));
  expect((await store.getSession(GUEST))?.version).toBe(2);
 });
 it('conversa de WhatsApp começa com saldo zero, não com o saldo fictício do laboratório',async()=>{
  const {deps,store}=await authorized(()=>model({content:'ok'}));
  await handleInbound(deps,text(GUEST,'M1','oi'));
  expect(((await store.getSession(GUEST))?.session as any).state.initialBalanceCents).toBe(0);
 });
 it('registra um gasto digitado e confirma com o valor certo',async()=>{
  const msg='gastei 50 no mercado';
  const {deps,messenger,store}=await authorized(()=>model({calls:[tc('registrar_transacao',expense(50,'mercado',msg))]}));
  await handleInbound(deps,text(GUEST,'M1',msg));
  expect(messenger.to(GUEST)[0]).toContain('50,00');
  expect(((await store.getSession(GUEST))?.session as any).state.transactions).toHaveLength(1);
 });
 it('cada número tem a sua própria conversa e os seus próprios lançamentos',async()=>{
  const OTHER='5511966665555',msg='gastei 50 no mercado';
  const {deps,store}=await authorized(()=>model({calls:[tc('registrar_transacao',expense(50,'mercado',msg))]}));
  await handleInbound(deps,text(OWNER,'O1',`autorizar ${OTHER}`));
  await handleInbound(deps,text(GUEST,'M1',msg));
  expect(((await store.getSession(OTHER)))).toBeNull();
  expect(((await store.getSession(GUEST))?.session as any).state.transactions).toHaveLength(1);
 });
 it('o mesmo webhook reenviado não processa nem responde duas vezes',async()=>{
  const {deps,messenger}=await authorized(()=>model({content:'Oi!'}));
  await handleInbound(deps,text(GUEST,'M1','oi'));
  await handleInbound(deps,text(GUEST,'M1','oi'));
  expect(messenger.to(GUEST)).toHaveLength(1);
 });
 it('mesmo ID de mensagem gera sempre o mesmo requestId (UUID válido)',()=>{
  expect(requestIdFor('M1')).toBe(requestIdFor('M1'));
  expect(requestIdFor('M1')).not.toBe(requestIdFor('M2'));
  expect(requestIdFor('M1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
 });
 it('o dono também conversa com o agente quando não é comando',async()=>{
  const {deps,messenger}=setup(()=>model({content:'Oi, chefe!'}));
  await handleInbound(deps,text(OWNER,'O1','bom dia'));
  expect(messenger.to(OWNER)).toEqual(['Oi, chefe!']);
 });
 it('falha técnica vira mensagem simples, sem vazar detalhe nem erro do laboratório',async()=>{
  const {deps,messenger}=await authorized(()=>({mode:'real',next:async()=>{throw new Error('OPENAI_RATE_LIMITED');}}));
  await handleInbound(deps,text(GUEST,'M1','oi'));
  expect(messenger.to(GUEST)).toHaveLength(1);
  expect(messenger.to(GUEST)[0]).toContain('problema técnico');
  expect(messenger.to(GUEST)[0]).not.toMatch(/OpenAI|OPENAI/);
 });
 it('freio de ritmo: passou de 15 por minuto, deixa de responder',async()=>{
  const {deps,messenger}=await authorized(()=>model({content:'ok'}));
  for(let i=0;i<20;i++)await handleInbound(deps,text(GUEST,`R${i}`,'oi'));
  expect(messenger.to(GUEST).length).toBeLessThanOrEqual(15);
  expect(messenger.to(GUEST).length).toBeGreaterThan(10);
 });
 it('imagem ou figurinha: avisa que só entende texto e áudio',async()=>{
  const {deps,messenger}=await authorized();
  await handleInbound(deps,{kind:'unsupported',phone:GUEST,messageId:'I1'});
  expect(messenger.to(GUEST)[0]).toContain('texto e áudio');
 });
});

describe('áudio no WhatsApp',()=>{
 const msg='gastei 50 no mercado';
 const authorized=async(transcript=msg)=>{const s=setup(()=>model({calls:[tc('registrar_transacao',expense(50,'mercado',msg))]}),transcript);await handleInbound(s.deps,text(OWNER,'O0',`autorizar ${GUEST}`));s.messenger.sent.length=0;return s;};
 it('valor falado por extenso ("três e cinquenta") chega como R$ 3,50 e pede confirmação curta',async()=>{
  const s=setup(()=>model({calls:[tc('registrar_transacao',expense(3.5,'água','comprei uma água, gastei R$ 3,50 no débito'))]}),'Pô, comprei uma água no posto, gastei três e cinquenta no débito.');
  await handleInbound(s.deps,text(OWNER,'O0',`autorizar ${GUEST}`));s.messenger.sent.length=0;
  await handleInbound(s.deps,audio(GUEST,'V9'));
  const reply=s.messenger.to(GUEST)[0];
  expect(reply).toContain('3,50');
  expect(reply).toContain('Entendi pelo áudio');
  expect(reply).not.toContain('Pô');
  expect(reply).not.toContain('não registrei nada');
 });
 it('transcreve e pede confirmação antes de gravar, sem repetir o áudio todo',async()=>{
  const {deps,messenger,store}=await authorized();
  await handleInbound(deps,audio(GUEST,'V1'));
  const reply=messenger.to(GUEST)[0];
  expect(reply).not.toContain('🎤'); // não repete o áudio inteiro quando o agente entendeu
  expect(reply).toContain('Entendi pelo áudio');
  expect(reply).toContain('50,00');
  expect(((await store.getSession(GUEST))?.session as any).state.transactions).toHaveLength(0);
 });
 it('áudio longo demais é recusado sem nem baixar',async()=>{
  const {deps,messenger}=await authorized();
  const download=vi.spyOn(messenger,'downloadAudio');
  await handleInbound(deps,audio(GUEST,'V1',999));
  expect(download).not.toHaveBeenCalled();
  expect(messenger.to(GUEST)[0]).toMatch(/áudio/);
 });
 it('áudio sem fala entendível pede para repetir',async()=>{
  const {deps,messenger}=await authorized('   ');
  await handleInbound(deps,audio(GUEST,'V1'));
  expect(messenger.to(GUEST)[0]).toMatch(/áudio|ouvir/);
 });
 it('áudio de número não autorizado nem é baixado',async()=>{
  const {deps,messenger}=setup();
  const download=vi.spyOn(messenger,'downloadAudio');
  await handleInbound(deps,audio('5511955554444','V9'));
  expect(download).not.toHaveBeenCalled();
 });
});

describe('endereço do webhook',()=>{
 const res=()=>{const r:any={code:0,body:undefined,headers:{}};r.status=(c:number)=>{r.code=c;return r;};r.json=(b:unknown)=>{r.body=b;};r.setHeader=(k:string,v:string)=>{r.headers[k]=v;};return r;};
 const body={type:'ReceivedCallback',instanceId:'INST1',messageId:'W1',phone:GUEST,fromMe:false,text:{message:'oi'}};
 const mk=()=>{const s=setup();return {...s,handler:createHandler({secret:'segredo-bem-longo-0123456789abcdef',instanceId:'INST1'},s.deps)};};
 it('sem o segredo na URL: 401 e nada é processado',async()=>{
  const {handler,store}=mk();const r=res();
  await handler({method:'POST',url:'/api/whatsapp',body},r);
  expect(r.code).toBe(401);
  expect(await store.getContact(GUEST)).toBeNull();
 });
 it('segredo errado: 401',async()=>{
  const {handler}=mk();const r=res();
  await handler({method:'POST',url:'/api/whatsapp?k=errado',body},r);
  expect(r.code).toBe(401);
 });
 it('segredo certo: 200 e o número fica pendente',async()=>{
  const {handler,store}=mk();const r=res();
  await handler({method:'POST',url:'/api/whatsapp?k=segredo-bem-longo-0123456789abcdef',body},r);
  expect(r.code).toBe(200);
  expect((await store.getContact(GUEST))?.status).toBe('pending');
 });
 it('GET não é aceito',async()=>{
  const {handler}=mk();const r=res();
  await handler({method:'GET',url:'/api/whatsapp?k=segredo-bem-longo-0123456789abcdef'},r);
  expect(r.code).toBe(405);
 });
 it('instância diferente da configurada é ignorada com 200 (não gera reenvio)',async()=>{
  const {handler,store}=mk();const r=res();
  await handler({method:'POST',url:'/api/whatsapp?k=segredo-bem-longo-0123456789abcdef',body:{...body,instanceId:'OUTRA'}},r);
  expect(r.code).toBe(200);
  expect(await store.getContact(GUEST)).toBeNull();
 });
});
