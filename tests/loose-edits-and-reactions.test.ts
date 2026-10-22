import {describe,it,expect,vi} from 'vitest';
import {runConversation} from '../shared/v2/agent';
import {parseInbound,isEmojiOnly} from '../server/whatsapp/zapi';
import type {Provider,ModelResult,Session} from '../shared/v2/contracts';
const today='2026-10-22';
let n=0;const tc=(name:string,args:unknown)=>({id:`call_${++n}`,name,arguments:args});
const model=(...turns:ModelResult[]):Provider=>({mode:'real',next:vi.fn().mockImplementation(async()=>turns.shift()||{content:'ok'})});
const send=(p:Provider,s:Session|undefined,m:string)=>runConversation(p,s,m,crypto.randomUUID(),today,{realData:true});
const register=async(s:Session|undefined,amount:number,desc:string)=>{const m=`${desc} ${String(amount).replace('.',',')}`;return (await send(model({calls:[tc('registrar_transacao',{type:'despesa',amount,description:desc,date:today,evidencia:m,natureza:'fato_ocorrido'})]}),s,m)).session;};

describe('mensagem solta de alteração/exclusão vale para o último lançamento',()=>{
 it('edição sem "isso/último": o modelo cita uma descrição inexistente e mesmo assim cai no último',async()=>{
  let s=await register(undefined,50,'mercado');
  s=await register(s,7.9,'cerveja');
  const r=await send(model({calls:[tc('propor_edicao_transacao',{alvo:{descricao:'aquilo la'},novo:{category:'Lazer'},evidencia:'põe em lazer'})]}),s,'põe em lazer');
  expect(r.trace.confirmation).toBe('pending');
  expect(r.trace.message).toContain('cerveja');
  expect(r.trace.message).not.toContain('mercado');
 });
 it('"apaga" apaga o último, pedindo confirmação com o lançamento citado',async()=>{
  let s=await register(undefined,7.9,'cerveja');
  const r=await send(model({calls:[tc('propor_exclusao_transacao',{alvo:{descricao:'esse registro'},evidencia:'apaga'})]}),s,'apaga');
  expect(r.trace.confirmation).toBe('pending');
  expect(r.trace.message).toContain('cerveja');
  expect(s.state.transactions.length).toBe(1);
  const r2=await send(model({content:'x'}),r.session,'sim');
  expect(r2.session.state.transactions.length).toBe(0);
 });
 it('citando outro lançamento existente não cai no último',async()=>{
  let s=await register(undefined,50,'mercado');
  s=await register(s,7.9,'cerveja');
  const r=await send(model({calls:[tc('propor_exclusao_transacao',{alvo:{descricao:'mercado'},evidencia:'apaga o mercado'})]}),s,'apaga o mercado');
  expect(r.trace.message).toContain('mercado');
  expect(r.trace.message).not.toContain('cerveja');
 });
});

describe('reações e emojis não geram resposta',()=>{
 const base={type:'ReceivedCallback',instanceId:'I',messageId:'M1',phone:'5519999990000',fromMe:false,isGroup:false,momment:1,senderName:'Ana'};
 it('reação do WhatsApp é ignorada',()=>{
  expect(parseInbound({...base,reaction:{value:'👍',time:1,reactionBy:'5519999990000',referencedMessage:{messageId:'X'}}},'I')).toMatchObject({kind:'ignore',reason:'reaction'});
 });
 it('texto só com emoji é ignorado',()=>{
  for(const t of ['👍','❤️❤️','🙏 😂','👍🏽','🇧🇷'])expect(parseInbound({...base,text:{message:t}},'I')).toMatchObject({kind:'ignore',reason:'emoji_only'});
 });
 it('texto com palavras ou números junto do emoji continua valendo',()=>{
  for(const t of ['gastei 30 👍','ok 👍','30','sim'])expect(parseInbound({...base,text:{message:t}},'I')).toMatchObject({kind:'text'});
  expect(isEmojiOnly('1️⃣')).toBe(false);
 });
});
