import {describe,it,expect,vi} from 'vitest';
import {runConversation} from '../shared/v2/agent';
import {pmt,addMonths} from '../shared/v2/debts';
import {createSession,type Provider,type ModelResult,type Session} from '../shared/v2/contracts';
import {MemoryStore} from '../server/whatsapp/store';
import {MemoryLedger} from '../server/whatsapp/ledger';
import {runReminders,composeDebtNotices,handleReminderReply,type ReminderDeps} from '../server/whatsapp/reminders';
import type {Messenger} from '../server/whatsapp/zapi';
const today='2026-10-23';
let n=0;const tc=(name:string,args:unknown)=>({id:`fc_${++n}`,name,arguments:args});
const model=(...turns:ModelResult[]):Provider=>({mode:'real',next:vi.fn().mockImplementation(async()=>turns.shift()||{content:'ok'})});
const send=(p:Provider,s:Session|undefined,m:string)=>runConversation(p,s,m,crypto.randomUUID(),today,{realData:true,userName:'Gustavo'});
const fin=(extra:Record<string,unknown>={})=>({descricao:'financiamento',valor:150000,juros_percentual:5,periodo_juros:'anual',prazo_meses:420,entrou_na_conta:true,evidencia:'financiamento de 150 mil em 420 meses a 5% ao ano',natureza:'fato_ocorrido',...extra});
const MSG='fiz um financiamento de 150 mil em 420 meses a 5% ao ano';
const start=()=>{const s=createSession();s.state.initialBalanceCents=0;return s;};

describe('cálculo da parcela (Price)',()=>{
 it('150 mil, 420 meses, 5% a.a. fica perto de R$ 780',()=>{
  const p=pmt(150000,5,'annual',420);
  expect(p).toBeGreaterThan(700);expect(p).toBeLessThan(850);
 });
 it('sem juros divide o valor pelo prazo',()=>{expect(Math.round(pmt(1200,0,"annual",12)*100)).toBe(10000);});
 it('soma meses respeitando o fim do mês',()=>{
  expect(addMonths('2026-01-31',1)).toBe('2026-02-28');
  expect(addMonths('2026-02-28',1,31)).toBe('2026-03-31');
 });
});

describe('financiamento pelo agente',()=>{
 it('sem o primeiro vencimento, calcula a parcela e pergunta quando vence',async()=>{
  const a=await send(model({calls:[tc('registrar_financiamento',fin())]}),start(),MSG);
  expect(a.trace.message).toMatch(/parcela fica em R\$/);
  expect(a.trace.message).toMatch(/quando vence a primeira/i);
 });
 it('com o vencimento, pede confirmação e depois registra como dívida',async()=>{
  const a=await send(model({calls:[tc('registrar_financiamento',fin({primeiro_vencimento:'2026-11-10'}))]}),start(),`${MSG}, primeira parcela dia 10/11`);
  expect(a.trace.confirmation).toBe('pending');
  const b=await send(model({content:'x'}),a.session,'sim');
  expect(b.session.state.newDebts).toHaveLength(1);
  expect(b.session.state.newDebts![0].receivedInAccount).toBe(true);
  expect(b.session.state.newDebts![0].principal).toBe(150000);
  expect(b.trace.message).toContain('nas suas dívidas');
  expect(b.trace.message).toContain('Quando vencer, eu te pergunto');
 });
 it('não julga o valor',async()=>{
  const a=await send(model({calls:[tc('registrar_financiamento',fin({primeiro_vencimento:'2026-11-10'}))]}),start(),`${MSG}, primeira parcela dia 10/11`);
  const b=await send(model({content:'x'}),a.session,'sim');
  for(const t of [a.trace.message,b.trace.message])expect(t).not.toMatch(/valor alto|grande|muito dinheiro|bastante dinheiro/i);
 });
 it('prazo que o usuário não disse é bloqueado',async()=>{
  const a=await send(model({calls:[tc('registrar_financiamento',fin({prazo_meses:360,primeiro_vencimento:'2026-11-10'}))]}),start(),`${MSG}, primeira parcela dia 10/11`);
  expect(a.session.state.newDebts??[]).toHaveLength(0);
  expect(a.trace.confirmation).not.toBe('pending');
 });
 it('financiamento não vira despesa recorrente',async()=>{
  const a=await send(model({calls:[tc('registrar_financiamento',fin({primeiro_vencimento:'2026-11-10'}))]}),start(),`${MSG}, primeira parcela dia 10/11`);
  const b=await send(model({content:'x'}),a.session,'sim');
  expect(b.session.state.transactions).toHaveLength(0);
 });
});

class Fake implements Messenger{sent:{phone:string;message:string}[]=[];async sendText(phone:string,message:string){this.sent.push({phone,message});}async downloadAudio(){return new Uint8Array(20000).fill(1);}}
const ANA='5511988887777',NOW=Date.parse('2026-11-10T12:00:00Z'),day='2026-11-10';
const parcela={debtId:'33333333-3333-4333-8333-333333333333',description:'financiamento',installment:780.5,dueDate:day};
const setup=async()=>{
 const store=new MemoryStore(),ledger=new MemoryLedger(),messenger=new Fake();
 await store.upsertContact({phone:ANA,name:'Ana Souza',status:'authorized'});
 const w=await ledger.resolve(ANA);ledger.debtDue.set(w.workspaceId,[parcela]);
 const deps:ReminderDeps={store,ledger,messenger,today:()=>day,now:()=>NOW,sleep:async()=>{}};
 return {store,ledger,messenger,deps};
};
describe('lembrete da parcela',()=>{
 it('avisa no dia, com o valor da parcela',async()=>{
  expect(composeDebtNotices([parcela],'Ana',day)).toContain('hoje vence a parcela do financiamento');
  const {deps,messenger}=await setup();
  await runReminders(deps);
  expect(messenger.sent).toHaveLength(1);
  expect(messenger.sent[0].message).toMatch(/780,50/);
 });
 it('"paguei" dá baixa com o valor da parcela',async()=>{
  const {deps,ledger}=await setup();
  await runReminders(deps);
  const r=await handleReminderReply(deps,ANA,'Ana','paguei');
  expect(ledger.debtPayments).toEqual([{debtId:parcela.debtId,amount:780.5,date:day}]);
  expect(r).toContain('parcela do financiamento');
 });
 it('"paguei 790" usa o valor dito',async()=>{
  const {deps,ledger}=await setup();
  await runReminders(deps);
  await handleReminderReply(deps,ANA,'Ana','paguei 790');
  expect(ledger.debtPayments[0].amount).toBe(790);
 });
 it('"ainda não" não paga nada',async()=>{
  const {deps,ledger}=await setup();
  await runReminders(deps);
  await handleReminderReply(deps,ANA,'Ana','ainda não');
  expect(ledger.debtPayments).toHaveLength(0);
 });
});
