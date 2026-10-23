import {describe,it,expect,vi} from 'vitest';
import {MemoryStore} from '../server/whatsapp/store';
import {MemoryLedger,type DueItem} from '../server/whatsapp/ledger';
import {runReminders,composeReminder,handleReminderReply,createCronHandler,MAX_ASKS_PER_ITEM,type ReminderDeps} from '../server/whatsapp/reminders';
import {handleInbound,type Deps} from '../server/whatsapp/handler';
import type {Messenger} from '../server/whatsapp/zapi';
const today='2026-10-24',OWNER='5511999990000',ANA='5511988887777',BIA='5511977776666';
const NOW=Date.parse('2026-10-24T12:00:00Z');
class Fake implements Messenger{sent:{phone:string;message:string}[]=[];async sendText(phone:string,message:string){this.sent.push({phone,message});}async downloadAudio(){return new Uint8Array(20000).fill(1);}to(p:string){return this.sent.filter(s=>s.phone===p).map(s=>s.message);}}
const salary:DueItem={id:'3bf64c20-c881-4e91-b2ef-b687ae7662c1',type:'receita',amount:3000,description:'Salário',expectedDate:today,category:'Renda'};
const rent:DueItem={id:'7c48e0ef-3760-410f-9283-6358203dfd65',type:'despesa',amount:1200,description:'Aluguel',expectedDate:'2026-10-22',category:'Moradia'};
const setup=async(items:Record<string,DueItem[]>={[ANA]:[salary]})=>{
 const store=new MemoryStore(),ledger=new MemoryLedger(),messenger=new Fake();
 for(const phone of Object.keys(items)){
  await store.upsertContact({phone,name:phone===ANA?'Ana Souza':'Bia',status:'authorized'});
  const ws=await ledger.resolve(phone);ledger.planned.set(ws.workspaceId,items[phone]);
 }
 const deps:ReminderDeps={store,ledger,messenger,today:()=>today,now:()=>NOW,sleep:async()=>{}};
 return {store,ledger,messenger,deps};
};

describe('mensagem do lembrete',()=>{
 it('receita prevista para hoje, com nome e categoria',()=>{
  const m=composeReminder([salary],'Matheus',today,false);
  expect(m).toMatch(/^Fala, Matheus, blz\? Aqueles R\$\s3\.000,00 de Salário \(Renda\) que estavam previstos pra hoje já caíram\? Me avisa aqui que eu dou baixa pra você\./);
  expect(m).not.toContain('parar lembretes');
 });
 it('primeiro lembrete avisa como parar',()=>{expect(composeReminder([salary],'Ana',today,true)).toContain('parar lembretes');});
 it('despesa atrasada cita a data prevista',()=>{
  const m=composeReminder([rent],'Ana',today,false);
  expect(m).toContain('Aluguel');expect(m).toContain('22/10');expect(m).toContain('Já foi pago?');
 });
 it('vários pendentes viram uma única mensagem',()=>{
  const m=composeReminder([salary,rent],'Ana',today,false);
  expect(m).toContain('• Receber');expect(m).toContain('• Pagar');
 });
});

describe('envio diário',()=>{
 it('manda para quem tem previsto vencido e registra o envio',async()=>{
  const {deps,messenger,store}=await setup();
  const r=await runReminders(deps);
  expect(r.sent).toBe(1);expect(messenger.to(ANA)[0]).toContain('Fala, Ana');
  expect((await store.reminderStates([salary.id]))[0].sent_count).toBe(1);
 });
 it('no máximo uma mensagem por pessoa por dia',async()=>{
  const {deps,messenger}=await setup();
  await runReminders(deps);await runReminders(deps);
  expect(messenger.to(ANA)).toHaveLength(1);
 });
 it('quem pediu para parar não recebe',async()=>{
  const {deps,messenger,store}=await setup();
  await store.setRemindersEnabled(ANA,false);
  const r=await runReminders(deps);
  expect(r.sent).toBe(0);expect(messenger.sent).toHaveLength(0);
 });
 it('número não autorizado nunca recebe',async()=>{
  const {deps,messenger,store}=await setup();
  await store.setStatus(ANA,'blocked');
  await runReminders(deps);expect(messenger.sent).toHaveLength(0);
 });
 it('previsto no futuro não gera lembrete',async()=>{
  const {deps,messenger}=await setup({[ANA]:[{...salary,expectedDate:'2026-10-25'}]});
  await runReminders(deps);expect(messenger.sent).toHaveLength(0);
 });
 it('cada lançamento é perguntado no máximo 3 vezes',async()=>{
  const {deps,messenger}=await setup();
  for(let day=0;day<MAX_ASKS_PER_ITEM+2;day++){
   const d=new Date(NOW+day*86_400_000);
   await runReminders({...deps,now:()=>d.getTime(),today:()=>d.toISOString().slice(0,10)});
  }
  expect(messenger.to(ANA)).toHaveLength(MAX_ASKS_PER_ITEM);
 });
 it('simulação (dry) não envia nada',async()=>{
  const {deps,messenger}=await setup();
  const r=await runReminders(deps,{dry:true});
  expect(r.messages).toHaveLength(1);expect(messenger.sent).toHaveLength(0);
 });
 it('falha com uma pessoa não impede as outras',async()=>{
  const {deps,messenger}=await setup({[ANA]:[salary],[BIA]:[{...salary,id:'11111111-1111-4111-8111-111111111111'}]});
  const orig=messenger.sendText.bind(messenger);
  messenger.sendText=async(p,m)=>{if(p===ANA)throw new Error('ZAPI_DOWN');return orig(p,m);};
  const r=await runReminders(deps);
  expect(r.failed).toBe(1);expect(r.sent).toBe(1);expect(messenger.to(BIA)).toHaveLength(1);
 });
});

describe('resposta ao lembrete',()=>{
 it('"caiu" dá baixa e comemora',async()=>{
  const {deps,ledger}=await setup();
  await runReminders(deps);
  const r=await handleReminderReply(deps,ANA,'Ana Souza','Caiu!');
  expect(ledger.confirmed).toEqual([{id:salary.id,date:today}]);
  expect(r).toContain('Boa, Ana!');expect(r).toContain('Salário');
 });
 it('"ainda não" não dá baixa e promete perguntar de novo',async()=>{
  const {deps,ledger}=await setup();
  await runReminders(deps);
  const r=await handleReminderReply(deps,ANA,'Ana','ainda não');
  expect(ledger.confirmed).toHaveLength(0);expect(r).toContain('Amanhã eu te pergunto');
 });
 it('"sim" sem lembrete pendente segue o fluxo normal',async()=>{
  const {deps}=await setup();
  expect(await handleReminderReply(deps,ANA,'Ana','sim')).toBeUndefined();
 });
 it('lembrete muito antigo (mais de 48h) não vale',async()=>{
  const {deps}=await setup();
  await runReminders(deps);
  expect(await handleReminderReply({...deps,now:()=>NOW+49*3600_000},ANA,'Ana','caiu')).toBeUndefined();
 });
 it('"parar lembretes" desliga e "ativar lembretes" religa',async()=>{
  const {deps,store}=await setup();
  expect(await handleReminderReply(deps,ANA,'Ana','parar lembretes')).toContain('Não te mando mais');
  expect((await store.getContact(ANA))?.reminders_enabled).toBe(false);
  await handleReminderReply(deps,ANA,'Ana','Ativar lembretes');
  expect((await store.getContact(ANA))?.reminders_enabled).toBe(true);
 });
 it('falha ao dar baixa avisa sem fingir que deu certo',async()=>{
  const {deps,ledger}=await setup();
  await runReminders(deps);
  ledger.confirm=async()=>{throw new Error('SUPABASE_500');};
  const r=await handleReminderReply(deps,ANA,'Ana','caiu');
  expect(r).toContain('Não consegui dar baixa');
 });
 it('pelo WhatsApp: "caiu sim" é tratado antes do agente e não chama a IA',async()=>{
  const {store,ledger,messenger,deps}=await setup();
  await runReminders(deps);
  const next=vi.fn().mockResolvedValue({content:'ia'});
  const d:Deps={ownerPhone:OWNER,store,ledger,messenger,provider:()=>({mode:'real',next}),transcriber:()=>({name:'f',transcribe:async()=>({text:'',model:'f'})}),today:()=>today,now:()=>NOW,log:()=>{}};
  await handleInbound(d,{kind:'text',phone:ANA,messageId:'W1',text:'caiu'});
  expect(next).not.toHaveBeenCalled();
  expect(ledger.confirmed).toHaveLength(1);
  expect(messenger.to(ANA).at(-1)).toContain('Dei baixa');
 });
});

describe('cron',()=>{
 const res=()=>{const r:any={code:0,body:null,h:{}};r.status=(n:number)=>{r.code=n;return r;};r.json=(b:unknown)=>{r.body=b;};r.setHeader=(k:string,v:string)=>{r.h[k]=v;};return r;};
 const SECRET='segredo-do-cron-bem-longo';
 it('sem o cabeçalho certo responde 401 e não envia',async()=>{
  const {deps,messenger}=await setup();const r=res();
  await createCronHandler({secret:SECRET},()=>deps)({method:'GET',headers:{}},r);
  expect(r.code).toBe(401);expect(messenger.sent).toHaveLength(0);
 });
 it('sem CRON_SECRET configurado fica desligado',async()=>{
  const {deps}=await setup();const r=res();
  await createCronHandler({secret:''},()=>deps)({method:'GET',headers:{authorization:'Bearer '}},r);
  expect(r.code).toBe(503);
 });
 it('com o segredo envia; com dry=1 só mostra',async()=>{
  const {deps,messenger}=await setup();
  const dry=res();await createCronHandler({secret:SECRET},()=>deps)({method:'GET',url:'/api/reminders?dry=1',headers:{authorization:`Bearer ${SECRET}`}},dry);
  expect(dry.body.messages).toHaveLength(1);expect(messenger.sent).toHaveLength(0);
  const real=res();await createCronHandler({secret:SECRET},()=>deps)({method:'GET',headers:{authorization:`Bearer ${SECRET}`}},real);
  expect(real.body.sent).toBe(1);expect(messenger.sent).toHaveLength(1);
 });
});
