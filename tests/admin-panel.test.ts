import {describe,it,expect,vi} from 'vitest';
import entry,{createAdmin,summarize,sessionToken,esc,COOKIE,backTo,type AdminDeps} from '../server/admin/panel';
import {parsePrice,envPrice} from '../server/admin/prices';
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
/** Segue o redirecionamento depois de uma ação (POST/Redirect/GET), levando o cookie de aviso. */
const follow=async(handler:any,r:any)=>{const flash=String(r.headers['Set-Cookie']??'').split(';')[0];const r2=res();await handler({method:'GET',url:r.headers.Location,headers:{cookie:`${authed.cookie}; ${flash}`}},r2);return r2;};

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
  expect(run).toHaveBeenCalledWith('autorizar 5511922220000');expect(r.code).toBe(303);expect((await follow(handler,r)).body).toContain('Autorizado.');
 });
 it('telefone inválido não executa',async()=>{
  const {handler,run}=setup();const r=res();await handler({method:'POST',headers:authed,body:{action:'block',phone:'12'}},r);
  expect(run).not.toHaveBeenCalled();expect((await follow(handler,r)).body).toContain('Número inválido');
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

describe('central de gestão (redesign)',()=>{
 const get=async(url:string,over:Partial<AdminDeps>={})=>{const {handler}=setup(over);const r=res();await handler({method:'GET',url,headers:authed},r);return r;};
 it('todas as telas abrem, sem estilo inline e com o mesmo menu',async()=>{
  for(const v of ['/admin','/admin?v=usuarios','/admin?v=ia','/admin?v=problemas','/admin?v=config','/admin?v=turno&id=T1']){
   const r=await get(v);expect(r.code).toBe(200);expect(r.body).not.toMatch(/style=/);expect(r.body).toContain('aria-label="Menu principal"');expect(r.body).toContain('src="/admin.js"');
  }
 });
 it('usuários: bloquear pede confirmação e volta para a mesma tela',async()=>{
  const r=await get('/admin?v=usuarios');
  expect(r.body).toContain('data-confirm=');expect(r.body).toContain('action="/admin?v=usuarios"');expect(r.body).toContain('Bloquear');expect(r.body).toContain('Autorizar');
 });
 it('ação feita na tela de usuários mostra o resultado nela',async()=>{
  const {handler,run}=setup();const r=res();await handler({method:'POST',url:'/admin?v=usuarios',headers:authed,body:{action:'block',phone:'5511911110000'}},r);
  expect(run).toHaveBeenCalledWith('bloquear 5511911110000');expect(r.headers.Location).toBe('/admin?v=usuarios');const r2=await follow(handler,r);expect(r2.body).toContain('Autorizado.');expect(r2.body).toContain('data-table');
 });
 it('sem preço: custo aparece como indisponível, nunca como zero',async()=>{
  const r=await get('/admin?v=ia');
  expect(r.body).toContain('Custo indisponível — preços não configurados.');expect(r.body).not.toContain('US$ 0');
 });
 it('com preço: mostra custo estimado',async()=>{
  const r=await get('/admin?v=ia',{price:{inputPerMTok:2,outputPerMTok:8}});
  expect(r.body).toContain('Custo estimado em 30 dias');expect(r.body).not.toContain('preços não configurados');
 });
 it('dias antes do registro aparecem como "sem registro"',async()=>{
  const r=await get('/admin');
  expect(r.body).toContain('Sem registro');expect(r.body).toContain('sem registro');
 });
 it('visão geral destaca erros recentes e quem está pendente',async()=>{
  const r=await get('/admin');
  expect(r.body).toContain('Operando, com erros nesta semana');expect(r.body).toContain('Pessoas que precisam de você');expect(r.body).toContain('aguardando');
 });
 it('problemas: filtros por tipo e detalhes técnicos expansíveis',async()=>{
  const r=await get('/admin?v=problemas');
  expect(r.body).toContain('data-kind-filter="erro"');expect(r.body).toContain('<details');expect(r.body).toContain('registrar_transacao');
 });
 it('lista de problemas não mostra o telefone inteiro de quem não tem nome',async()=>{
  const r=await get('/admin?v=problemas',{source:{contacts:async()=>[],usageSince:async()=>[],problemTurns:async()=>[turn('T1')],turn:async()=>null}});
  expect(r.body).toContain('•••••-0000');expect(r.body).not.toContain('91111-0000');
 });
 it('configuração mostra o estado real, sem segredos',async()=>{
  const r=await get('/admin?v=config');
  expect(r.body).toContain('Não configurado');expect(r.body).not.toContain(PASS);
 });
});

describe('resumo diário',()=>{
 it('30 dias, marcando o que veio antes do registro',()=>{
  const s=summarize([c('1','authorized')],[u('1',1),u('1',2,{status:'error',error_code:'X'})],NOW);
  expect(s.daily).toHaveLength(30);
  expect(s.daily.filter(d=>!d.tracked).length).toBeGreaterThan(0);
  const today=s.daily[s.daily.length-1]!;expect(today.messages).toBe(2);expect(today.errors).toBe(1);expect(today.input).toBe(2000);
  expect(s.messagesPrev7).toBeUndefined();
  expect(s.activePeople7d).toBe(1);expect(s.errors1d).toBe(1);
 });
 it('compara com a semana anterior só quando o registro cobre o período',()=>{
  const later=Date.parse('2026-11-20T12:00:00Z');
  const s=summarize([c('1','authorized')],[u('1',1),{...u('1',1),created_at:new Date(later-10*86_400_000).toISOString()}],later);
  expect(s.messagesPrev7).toBe(1);
 });
 it('agrupa por modelo',()=>{
  const s=summarize([],[u('1',1,{model:'a'}),u('1',2,{model:'a'}),u('1',3,{model:null})],NOW);
  expect(s.models[0]).toMatchObject({model:'a',messages:2,tokens:2200});
 });
});

describe('ajustes de backend do painel',()=>{
 const full=(over:Partial<AdminDeps['source']>={})=>{
  const setResolved=vi.fn().mockResolvedValue(undefined),setReminders=vi.fn().mockResolvedValue(undefined);
  const turns=[turn('T1'),turn('T2',{status:'clarification',error_code:null,resolved_at:new Date(NOW-600_000).toISOString(),user_text:'aquele lá'})];
  const source:AdminDeps['source']={contacts:async()=>[c('5511911110000','authorized','Ana'),{...c('5511933330000','authorized','Bia'),reminders_enabled:false}],usageSince:async()=>[u('5511911110000',1)],problemTurns:async()=>turns,turn:async id=>turns.find(t=>t.message_id===id)??null,setResolved,setReminders,
   reminders:async()=>[{transaction_id:'x1',workspace_id:'w',phone:'5511911110000',sent_count:1,last_sent_at:new Date(NOW-3600_000).toISOString(),answered_at:null}],
   reminderPreview:async()=>[{phone:'5511911110000',text:'Ana, você tinha R$ 50,00 de <luz> previsto pra hoje.'}],...over};
  const run=vi.fn().mockResolvedValue('ok');
  return {setResolved,setReminders,run,handler:createAdmin({password:PASS},{source,run,now:()=>NOW})};
 };
 const get=async(h:any,url:string,cookie=authed.cookie)=>{const r=res();await h({method:'GET',url,headers:{cookie}},r);return r;};
 it('ação redireciona (atualizar a página não repete) e o aviso aparece uma vez só',async()=>{
  const {handler,run}=setup();const r=res();await handler({method:'POST',url:'/admin?v=usuarios',headers:authed,body:{action:'block',phone:'5511911110000'}},r);
  expect(r.code).toBe(303);expect(r.headers['Set-Cookie']).toMatch(/pulse_admin_flash=.*HttpOnly; Secure; SameSite=Strict/);
  const r2=await follow(handler,r);expect(r2.body).toContain('Autorizado.');expect(r2.headers['Set-Cookie']).toMatch(/pulse_admin_flash=; .*Max-Age=0/);
  expect(run).toHaveBeenCalledTimes(1);
 });
 it('o retorno depois da ação nunca sai do /admin',()=>{
  expect(backTo('https://evil.example/x')).toBe('/admin');expect(backTo('/admin?v=//evil')).toBe('/admin');
  expect(backTo('/admin?v=turno&id=T1&x=1')).toBe('/admin?v=turno&id=T1');expect(backTo('/admin?v=problemas&estado=resolvidos')).toBe('/admin?v=problemas&estado=resolvidos');
 });
 it('resolver e reabrir gravam a data (ou nulo) e voltam para a mesma tela',async()=>{
  const {handler,setResolved}=full();const r=res();await handler({method:'POST',url:'/admin?v=turno&id=T1',headers:authed,body:{action:'resolve',id:'T1'}},r);
  expect(setResolved).toHaveBeenCalledWith('T1',new Date(NOW).toISOString());expect(r.headers.Location).toBe('/admin?v=turno&id=T1');
  expect((await follow(handler,r)).body).toContain('Problema marcado como resolvido.');
  const r3=res();await handler({method:'POST',url:'/admin?v=problemas&estado=resolvidos',headers:authed,body:{action:'reopen',id:'T2'}},r3);
  expect(setResolved).toHaveBeenCalledWith('T2',null);
 });
 it('problemas: abertos por padrão, resolvidos na outra aba, contador só dos abertos',async()=>{
  const {handler}=full();
  const open=await get(handler,'/admin?v=problemas');expect(open.body).toContain('gastei 50 no mercado');expect(open.body).not.toContain('aquele lá');expect(open.body).toContain('aria-label="1 problemas abertos"');expect(open.body).toContain('Marcar como resolvido');
  const done=await get(handler,'/admin?v=problemas&estado=resolvidos');expect(done.body).toContain('aquele lá');expect(done.body).toContain('Reabrir');
  const home=await get(handler,'/admin');expect(home.body).not.toContain('aquele lá');
 });
 it('sem suporte a resolver no banco, os botões não aparecem',async()=>{
  const {handler}=setup();const r=await get(handler,'/admin?v=problemas');expect(r.body).not.toContain('Marcar como resolvido');
 });
 it('liga e desliga lembretes por pessoa; telefone inválido não chama nada',async()=>{
  const {handler,setReminders}=full();
  const r=res();await handler({method:'POST',url:'/admin?v=lembretes',headers:authed,body:{action:'reminders',phone:'5511911110000',enabled:'0'}},r);
  expect(setReminders).toHaveBeenCalledWith('5511911110000',false);expect((await follow(handler,r)).body).toContain('Lembretes desligados');
  const r2=res();await handler({method:'POST',headers:authed,body:{action:'reminders',phone:'12',enabled:'1'}},r2);expect(setReminders).toHaveBeenCalledTimes(1);
 });
 it('tela de lembretes: prévia escapada, histórico e chave por pessoa',async()=>{
  const {handler}=full();const r=await get(handler,'/admin?v=lembretes');
  expect(r.code).toBe(200);expect(r.body).toContain('&lt;luz&gt;');expect(r.body).not.toContain('<luz>');expect(r.body).toContain('nada é enviado');
  expect(r.body).toContain('role="switch" aria-checked="true"');expect(r.body).toContain('role="switch" aria-checked="false"');expect(r.body).not.toMatch(/style=/);
 });
 it('prévia com falha não derruba a tela',async()=>{
  const {handler}=full({reminderPreview:async()=>{throw new Error('boom');}});const r=await get(handler,'/admin?v=lembretes');
  expect(r.code).toBe(200);expect(r.body).toContain('Não consegui montar a prévia');expect(r.body).not.toContain('boom');
 });
 it('na Vercel, sem senha o painel fica desativado em vez de quebrar',async()=>{
  vi.stubEnv('ADMIN_PASSWORD','');vi.stubEnv('SUPABASE_URL','');vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','');
  const r=res();await entry({method:'GET',url:'/admin',headers:{}},r);expect(r.code).toBe(503);expect(r.body).toContain('Painel desativado');
  vi.stubEnv('ADMIN_PASSWORD',PASS);const r2=res();await entry({method:'GET',url:'/admin',headers:{}},r2);
  expect(r2.code).toBe(503);expect(r2.body).toContain('SUPABASE_URL');expect(r2.body).not.toContain(PASS);
  vi.unstubAllEnvs();
 });
});

describe('preços por modelo',()=>{
 it('aceita vírgula ou ponto e recusa o resto',()=>{
  expect(parsePrice('1,6')).toBe(1.6);expect(parsePrice(' 0,40 ')).toBe(0.4);expect(parsePrice('1.6')).toBe(1.6);expect(parsePrice('US$ 2')).toBe(2);
  expect(parsePrice('abc')).toBeUndefined();expect(parsePrice('-1')).toBeUndefined();expect(parsePrice('1,2,3')).toBeUndefined();expect(parsePrice('')).toBeUndefined();
  expect(envPrice({OPENAI_PRICE_IN_PER_MTOK:'0,4',OPENAI_PRICE_OUT_PER_MTOK:'1,6'})).toEqual({inputPerMTok:0.4,outputPerMTok:1.6});
 });
 it('custo por modelo; modelo sem preço fica fora e aparece como pendente',()=>{
  const usage=[u('1',1,{model:'mini',input_tokens:1_000_000,output_tokens:1_000_000}),u('1',2,{model:'grande',input_tokens:1_000_000,output_tokens:0})];
  const s=summarize([c('1','authorized')],usage,NOW,{models:{mini:{inputPerMTok:0.4,outputPerMTok:1.6}}});
  expect(s.cost30d).toBe(2);expect(s.unpriced).toEqual([{model:'grande',messages:1}]);
  const s2=summarize([c('1','authorized')],usage,NOW,{default:{inputPerMTok:3,outputPerMTok:10},models:{mini:{inputPerMTok:0.4,outputPerMTok:1.6}}});
  expect(s2.cost30d).toBe(5);expect(s2.unpriced).toEqual([]);
 });
 const make=(over:Partial<AdminDeps['source']>={},price?:AdminDeps['price'])=>{
  let saved:any=null;const setPrices=vi.fn().mockImplementation(async(t:any)=>{saved=t;});
  const source:AdminDeps['source']={contacts:async()=>[c('5511911110000','authorized','Ana')],usageSince:async()=>[u('5511911110000',1,{model:'gpt-x',input_tokens:1_000_000,output_tokens:1_000_000})],problemTurns:async()=>[],turn:async()=>null,prices:async()=>saved,setPrices,...over};
  return {setPrices,handler:createAdmin({password:PASS},{source,run:vi.fn(),now:()=>NOW,price})};
 };
 const post=async(h:any,body:any)=>{const r=res();await h({method:'POST',url:'/admin?v=ia',headers:authed,body},r);return r;};
 it('salva pelo painel e o custo passa a usar o valor salvo',async()=>{
  const {handler,setPrices}=make();
  const r=await post(handler,{action:'prices',model_0:'gpt-x',in_0:'1,5',out_0:'2.5',default_in:'',default_out:''});
  expect(setPrices).toHaveBeenCalledWith({default:undefined,models:{'gpt-x':{inputPerMTok:1.5,outputPerMTok:2.5}}});
  const page=await follow(handler,r);expect(page.body).toContain('Preços salvos');expect(page.body).toContain('US$ 4.00');expect(page.body).toContain('Definidos aqui no painel');expect(page.body).toContain('value="1,5"');
 });
 it('valor inválido não salva e explica',async()=>{
  const {handler,setPrices}=make();const r=await post(handler,{action:'prices',model_0:'gpt-x',in_0:'abc',out_0:'1'});
  expect(setPrices).not.toHaveBeenCalled();expect((await follow(handler,r)).body).toContain('Preço inválido em gpt-x');
 });
 it('painel vale por cima da Vercel',async()=>{
  const {handler}=make({prices:async()=>({models:{'gpt-x':{inputPerMTok:1,outputPerMTok:1}}})},{inputPerMTok:100,outputPerMTok:100});
  const r=res();await handler({method:'GET',url:'/admin?v=ia',headers:authed},r);expect(r.body).toContain('US$ 2.00');expect(r.body).toContain('Definidos aqui no painel');
 });
 it('sem a tabela no banco: edição desligada e vale a Vercel',async()=>{
  const {handler}=make({prices:async()=>{throw new Error('SUPABASE_404');}},{inputPerMTok:1,outputPerMTok:1});
  const r=res();await handler({method:'GET',url:'/admin?v=ia',headers:authed},r);
  expect(r.code).toBe(200);expect(r.body).toContain('admin_settings');expect(r.body).toContain('Vindos da Vercel');expect(r.body).not.toContain('Salvar preços');expect(r.body).toContain('US$ 2.00');
 });
 it('tabela ausente ao salvar vira aviso claro',async()=>{
  const {handler}=make({setPrices:async()=>{throw new Error('SUPABASE_404');}});const r=await post(handler,{action:'prices',default_in:'1',default_out:'2'});
  expect((await follow(handler,r)).body).toContain('ainda não existe no banco');
 });
});
