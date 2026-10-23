import {describe,it,expect,vi} from 'vitest';
import {runConversation} from '../shared/v2/agent';
import {amountsIn} from '../shared/v2/policy';
import {invoiceFor,installmentsIn,findCard} from '../shared/v2/cards';
import {createSession,type Provider,type ModelResult,type Session} from '../shared/v2/contracts';
import {MemoryStore} from '../server/whatsapp/store';
import {MemoryLedger,diffCards,type InvoiceNotice} from '../server/whatsapp/ledger';
import {runReminders,composeNotices,handleReminderReply,type ReminderDeps} from '../server/whatsapp/reminders';
import type {Messenger} from '../server/whatsapp/zapi';
const today='2026-10-22';
let n=0;const tc=(name:string,args:unknown)=>({id:`cc_${++n}`,name,arguments:args});
const model=(...turns:ModelResult[]):Provider=>({mode:'real',next:vi.fn().mockImplementation(async()=>turns.shift()||{content:'ok'})});
const send=(p:Provider,s:Session|undefined,m:string,userName='Matheus')=>runConversation(p,s,m,crypto.randomUUID(),today,{realData:true,userName});
const withCards=(...cards:{name:string;closingDay:number;dueDay:number}[]):Session=>{const s=createSession();s.state.initialBalanceCents=0;s.state.cards=cards;return s;};
const nubank={name:'Nubank',closingDay:28,dueDay:10};
const buy=(amount:number,description:string,evidencia:string,cartao?:unknown,category='Alimentação')=>({type:'despesa',amount,description,date:today,category,evidencia,natureza:'fato_ocorrido',...(cartao?{cartao}:{})});

describe('fatura: qual fatura recebe a compra',()=>{
 it('fecha 28 e vence 10: vence no mês seguinte',()=>{
  expect(invoiceFor(nubank,'2026-10-20')).toEqual({competence:'2026-10-01',closingDate:'2026-10-28',dueDate:'2026-11-10'});
  expect(invoiceFor(nubank,'2026-10-30')).toEqual({competence:'2026-11-01',closingDate:'2026-11-28',dueDate:'2026-12-10'});
 });
 it('fecha 5 e vence 12: vence no mesmo mês do fechamento',()=>{
  const c={closingDay:5,dueDay:12};
  expect(invoiceFor(c,'2026-10-03')).toEqual({competence:'2026-10-01',closingDate:'2026-10-05',dueDate:'2026-10-12'});
  expect(invoiceFor(c,'2026-10-20')).toEqual({competence:'2026-11-01',closingDate:'2026-11-05',dueDate:'2026-11-12'});
 });
 it('parcelas seguem os meses seguintes e dia 31 respeita o fim do mês',()=>{
  expect(invoiceFor(nubank,'2026-10-20',2)).toEqual({competence:'2026-12-01',closingDate:'2026-12-28',dueDate:'2027-01-10'});
  expect(invoiceFor({closingDay:31,dueDay:10},'2026-02-10').closingDate).toBe('2026-02-28');
 });
 it('acha o cartão por nome parecido, ou o único cadastrado',()=>{
  expect(findCard([nubank],'cartão nubank')?.name).toBe('Nubank');
  expect(findCard([nubank])?.name).toBe('Nubank');
  expect(findCard([nubank,{name:'Itaú',closingDay:1,dueDay:8}])).toBeUndefined();
  expect(findCard([nubank],'Inter')).toBeUndefined();
 });
 it('lê parcelas e não as confunde com valor',()=>{
  expect(installmentsIn('2,4k em 5 parcelas no crédito')).toBe(5);
  expect(installmentsIn('2400 parcelado em 5 vezes')).toBe(5);
  expect(installmentsIn('comprei em 3x de 100')).toBe(3);
  expect(installmentsIn('gastei 50 no mercado')).toBeUndefined();
  expect(amountsIn('2,4k em 5 parcelas no crédito')).toEqual([2400]);
 });
});

describe('compra no cartão pelo agente',()=>{
 it('o caso real: ar-condicionado de 2,4k em 5 parcelas',async()=>{
  const msg='acabei de comprar um ar condicionado de 2,4k em 5 parcelas no crédito';
  const a=await send(model({calls:[tc('registrar_transacao',buy(2400,'ar condicionado','2,4k em 5 parcelas',{nome:null,parcelas:5},'Compras'))]}),undefined,msg);
  expect(a.trace.confirmation).toBe('pending');
  expect(a.trace.message).toContain('em 5x de R$');
  expect(a.trace.message).toMatch(/480,00/);
  expect(a.trace.message).not.toContain('mais de um valor');
  const b=await send(model({content:'x'}),a.session,'sim');
  expect(b.session.state.cardPurchases).toHaveLength(1);
  expect(b.session.state.cardPurchases![0].card?.installments).toBe(5);
  expect(b.session.state.transactions).toHaveLength(0); // não mexe no saldo
  expect(b.trace.message).toContain('Anotei');
  expect(b.trace.message).toContain('Vamos cadastrar esse cartão?');
 });
 it('"3x de 100": o total é parcela vezes número de parcelas',async()=>{
  const r=await send(model({calls:[tc('registrar_transacao',buy(300,'cadeira','3x de 100',{nome:null,parcelas:3},'Compras'))]}),undefined,'comprei uma cadeira em 3x de 100 no cartão');
  expect(r.trace.confirmation).toBe('pending');
  expect(r.trace.message).toMatch(/300,00/);
 });
 it('parcelas que o usuário não disse são recusadas',async()=>{
  const r=await send(model({calls:[tc('registrar_transacao',buy(300,'cadeira','300 na cadeira',{nome:null,parcelas:6},'Compras'))]}),undefined,'paguei 300 na cadeira no cartão');
  expect(r.trace.confirmation).toBe('none');
  expect(r.trace.message).toContain('quantas parcelas');
 });
 it('cartão cadastrado: lança direto e diz em qual fatura caiu',async()=>{
  const r=await send(model({calls:[tc('registrar_transacao',buy(120,'mercado','120 no mercado',{nome:'nubank',parcelas:null}))]}),withCards(nubank),'gastei 120 no mercado no cartão nubank');
  expect(r.session.state.cardPurchases).toHaveLength(1);
  expect(r.session.state.transactions).toHaveLength(0);
  expect(r.trace.message).toContain('no cartão Nubank');
  expect(r.trace.message).toContain('fatura que vence 10/11');
  expect(r.trace.message).not.toContain('Vamos cadastrar');
 });
 it('mais de um cartão e nenhum citado: pergunta qual',async()=>{
  const r=await send(model({calls:[tc('registrar_transacao',buy(120,'mercado','120 no mercado',{nome:null,parcelas:null}))]}),withCards(nubank,{name:'Itaú',closingDay:1,dueDay:8}),'gastei 120 no mercado no crédito');
  expect(r.trace.message).toContain('Em qual cartão');
  expect(r.trace.message).toContain('Nubank, Itaú');
  expect(r.session.state.cardPurchases??[]).toHaveLength(0);
 });
 it('débito não vira cartão',async()=>{
  const r=await send(model({calls:[tc('registrar_transacao',buy(40,'padaria','40 na padaria'))]}),undefined,'gastei 40 na padaria no débito');
  expect(r.session.state.transactions).toHaveLength(1);
  expect(r.session.state.cardPurchases??[]).toHaveLength(0);
 });
 it('"nada ainda, só registre" usa a compra da mensagem anterior (com confirmação)',async()=>{
  const m1='acabei de comprar um ar condicionado de 2,4k em 5 parcelas no crédito';
  const a=await send(model({content:'Quer que eu simule?'}),undefined,m1);
  const b=await send(model({content:'ok'}),a.session,'sim');
  const c=await send(model({calls:[tc('registrar_transacao',buy(2400,'ar condicionado','2,4k em 5 parcelas',{nome:null,parcelas:5},'Compras'))]}),b.session,'nada ainda, só registre por favor');
  expect(c.trace.confirmation).toBe('pending');
  expect(c.trace.message).toContain('em 5x');
 });
});

describe('cadastro leve do cartão',()=>{
 it('o usuário conta nome e dias e o cartão fica cadastrado',async()=>{
  const r=await send(model({calls:[tc('cadastrar_cartao',{nome:'Nubank',dia_fechamento:5,dia_vencimento:12,evidencia:'fecha dia 5 e vence dia 12'})]}),undefined,'Nubank, fecha dia 5 e vence dia 12');
  expect(r.session.state.cards).toEqual([{name:'Nubank',closingDay:5,dueDay:12}]);
  expect(r.trace.message).toContain('Cartão Nubank cadastrado: fecha dia 5 e vence dia 12');
 });
 it('dias que não estão na mensagem são recusados',async()=>{
  const r=await send(model({calls:[tc('cadastrar_cartao',{nome:'Nubank',dia_fechamento:7,dia_vencimento:15,evidencia:'fecha dia 5 e vence dia 12'})]}),undefined,'Nubank, fecha dia 5 e vence dia 12');
  expect(r.session.state.cards??[]).toHaveLength(0);
 });
 it('nome que ninguém falou é recusado',async()=>{
  const r=await send(model({calls:[tc('cadastrar_cartao',{nome:'Itaú',dia_fechamento:5,dia_vencimento:12,evidencia:'fecha dia 5 e vence dia 12'})]}),undefined,'fecha dia 5 e vence dia 12');
  expect(r.session.state.cards??[]).toHaveLength(0);
 });
 it('diffCards só devolve o novo ou alterado',()=>{
  expect(diffCards([nubank],[nubank,{name:'Itaú',closingDay:1,dueDay:8}])).toEqual([{name:'Itaú',closingDay:1,dueDay:8}]);
  expect(diffCards([nubank],[{...nubank,dueDay:12}])).toHaveLength(1);
  expect(diffCards([nubank],[nubank])).toEqual([]);
 });
});

describe('gravação no banco',()=>{
 const ws=async(l:MemoryLedger)=>l.resolve('5511900000001');
 const purchase={id:crypto.randomUUID(),amount:120,description:'mercado',date:today,installments:1};
 it('compra sem cartão cadastrado espera; ao cadastrar, é encaixada na fatura',async()=>{
  const l=new MemoryLedger(),w=await ws(l);
  const first=await l.apply(w,{create:[],update:[],remove:[],cardPurchases:[purchase]},'k1');
  expect(first&&first.waitingCard).toBe(1);expect(l.cardPlaced).toHaveLength(0);
  const second=await l.apply(w,{create:[],update:[],remove:[],cardUpserts:[nubank]},'k2');
  expect(second&&second.placed).toMatchObject({count:1,total:120,cardName:'Nubank',dueDates:['2026-11-10']});
  expect(l.cardPlaced).toHaveLength(1);
  expect((await l.load(w)).cards).toHaveLength(1);
 });
 it('compra com cartão já cadastrado vai direto',async()=>{
  const l=new MemoryLedger(),w=await ws(l);
  await l.apply(w,{create:[],update:[],remove:[],cardUpserts:[nubank]},'k1');
  await l.apply(w,{create:[],update:[],remove:[],cardPurchases:[{...purchase,cardName:'Nubank'}]},'k2');
  expect(l.cardPlaced).toHaveLength(1);expect(l.cardWaiting).toHaveLength(0);
 });
});

class Fake implements Messenger{sent:{phone:string;message:string}[]=[];async sendText(phone:string,message:string){this.sent.push({phone,message});}async downloadAudio(){return new Uint8Array(20000).fill(1);}}
const ANA='5511988887777',NOW=Date.parse('2026-10-28T12:00:00Z'),day='2026-10-28';
const closed:InvoiceNotice={invoiceId:'11111111-1111-4111-8111-111111111111',kind:'closed',cardName:'Nubank',amount:850.5,closingDate:day,dueDate:'2026-11-10'};
const due:InvoiceNotice={invoiceId:'22222222-2222-4222-8222-222222222222',kind:'due',cardName:'Nubank',amount:850.5,closingDate:'2026-10-28',dueDate:day};
const setup=async(...notices:InvoiceNotice[])=>{
 const store=new MemoryStore(),ledger=new MemoryLedger(),messenger=new Fake();
 await store.upsertContact({phone:ANA,name:'Ana Souza',status:'authorized'});
 const w=await ledger.resolve(ANA);ledger.invoices.set(w.workspaceId,notices);
 const deps:ReminderDeps={store,ledger,messenger,today:()=>day,now:()=>NOW,sleep:async()=>{}};
 return {store,ledger,messenger,deps};
};
describe('avisos de fatura',()=>{
 it('texto de fatura fechada e de fatura que vence hoje',()=>{
  expect(composeNotices([closed],'Ana',day)).toMatch(/^Ana, a fatura do Nubank fechou hoje: R\$\s850,50\. Ela vence dia 10\/11\./);
  expect(composeNotices([due],'Ana',day)).toContain('hoje vence a fatura do Nubank');
  expect(composeNotices([due],'Ana',day)).toContain('Já pagou?');
 });
 it('fatura fechada é avisada uma única vez',async()=>{
  const {deps,messenger}=await setup(closed);
  await runReminders(deps);
  expect(messenger.sent).toHaveLength(1);
  const next={...deps,now:()=>NOW+86_400_000,today:()=>'2026-10-29'};
  await runReminders(next);
  expect(messenger.sent).toHaveLength(1);
 });
 it('"paguei" dá baixa na fatura',async()=>{
  const {deps,ledger,messenger}=await setup(due);
  await runReminders(deps);
  expect(messenger.sent[0].message).toContain('Já pagou?');
  const reply=await handleReminderReply(deps,ANA,'Ana Souza','paguei');
  expect(ledger.paidInvoices).toEqual([{id:due.invoiceId,date:day}]);
  expect(reply).toContain('fatura do Nubank');
 });
 it('"ainda não" não paga nada',async()=>{
  const {deps,ledger}=await setup(due);
  await runReminders(deps);
  await handleReminderReply(deps,ANA,'Ana','ainda não');
  expect(ledger.paidInvoices).toHaveLength(0);
 });
});
