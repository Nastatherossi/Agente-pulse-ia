import {describe,it,expect,vi} from 'vitest';
import {createSession,type Provider,type ModelResult} from '../shared/v2/contracts';
import {runConversation} from '../shared/v2/agent';
import {validateAudio,transcriptToMessage,audioRejectionMessage,estimateTranscriptionCostUSD,MAX_AUDIO_SECONDS,MAX_AUDIO_BYTES} from '../shared/v2/audio';
import {OpenAITranscriptionProvider} from '../server/v2/transcription';
/*
 * Áudio do WhatsApp: limites, limpeza da transcrição, custo, e a regra de segurança
 * (lançamento vindo de áudio SEMPRE pede confirmação). Nenhum teste chama a rede.
 */
const today='2026-10-20';
let n=0;const tc=(name:string,args:unknown)=>({id:`call_${++n}`,name,arguments:args});
const model=(...turns:ModelResult[]):Provider=>({mode:'real',next:vi.fn().mockImplementation(async()=>turns.shift()||{content:''})});
const bytes=(size:number)=>new Uint8Array(size).fill(1);
const expense=(amount:number,description:string,evidencia:string)=>({type:'despesa',amount,description,date:today,evidencia,natureza:'fato_ocorrido'});

describe('validateAudio',()=>{
 const ok={bytes:bytes(20000),mimeType:'audio/ogg; codecs=opus',durationSeconds:15};
 it('aceita mensagem de voz do WhatsApp',()=>{expect(validateAudio(ok)).toEqual({ok:true});});
 it('recusa vazio, tipo estranho, grande e longo',()=>{
  expect(validateAudio({...ok,bytes:bytes(10)})).toEqual({ok:false,reason:'empty'});
  expect(validateAudio({...ok,mimeType:'video/mp4'})).toEqual({ok:false,reason:'unsupported'});
  expect(validateAudio({...ok,bytes:bytes(MAX_AUDIO_BYTES+1)})).toEqual({ok:false,reason:'too_large'});
  expect(validateAudio({...ok,durationSeconds:MAX_AUDIO_SECONDS+1})).toEqual({ok:false,reason:'too_long'});
 });
 it('toda recusa tem uma mensagem em português, sem jargão',()=>{
  for(const r of ['empty','too_large','too_long','unsupported','no_speech'] as const)expect(audioRejectionMessage(r)).toMatch(/áudio|ouvir/);
 });
});

describe('transcriptToMessage',()=>{
 it('limpa espaços e quebras',()=>{expect(transcriptToMessage('  gastei   50 \n no mercado ')).toBe('gastei 50 no mercado');});
 it('descarta silêncio e frases inventadas em áudio sem fala',()=>{
  expect(transcriptToMessage('')).toBeUndefined();
  expect(transcriptToMessage(' . ')).toBeUndefined();
  expect(transcriptToMessage('Obrigado por assistir!')).toBeUndefined();
 });
});

describe('custo',()=>{
 it('15 s no gpt-4o-mini-transcribe custa US$ 0,00075',()=>{expect(Math.round(estimateTranscriptionCostUSD(15,'gpt-4o-mini-transcribe')!*1e6)).toBe(750);});
 it('modelo desconhecido não inventa preço',()=>{expect(estimateTranscriptionCostUSD(15,'outro')).toBeUndefined();});
});

describe('regra de segurança: áudio sempre confirma',()=>{
 const message='gastei 50 no mercado';
 const call=()=>model({calls:[tc('registrar_transacao',expense(50,'mercado',message))]});
 it('o mesmo texto digitado registra direto',async()=>{
  const r=await runConversation(call(),createSession(),message,crypto.randomUUID(),today);
  expect(r.session.state.transactions).toHaveLength(1);
 });
 it('vindo de áudio, não grava: pede confirmação com o valor entendido',async()=>{
  const r=await runConversation(call(),createSession(),message,crypto.randomUUID(),today,{source:'audio'});
  expect(r.session.state.transactions).toHaveLength(0);
  expect(r.trace.confirmation).toBe('pending');
  expect(r.trace.message).toContain('Entendi pelo áudio');
  expect(r.trace.message).toContain('50,00');
 });
 it('e grava só depois do "sim"',async()=>{
  const first=await runConversation(call(),createSession(),message,crypto.randomUUID(),today,{source:'audio'});
  const done=await runConversation(model(),first.session,'sim',crypto.randomUUID(),today);
  expect(done.session.state.transactions).toHaveLength(1);
  expect(done.session.state.transactions[0]).toMatchObject({amount:50,description:'mercado'});
 });
});

describe('OpenAITranscriptionProvider (sem rede)',()=>{
 it('envia modelo, idioma pt e vocabulário; devolve o texto',async()=>{
  let seen:{url:string;init:RequestInit}|undefined;
  const fake=vi.fn().mockImplementation(async(url:string,init:RequestInit)=>{seen={url,init};return new Response(JSON.stringify({text:'gastei cinquenta reais no mercado'}),{status:200});});
  const provider=new OpenAITranscriptionProvider('sk-teste','gpt-4o-mini-transcribe',fake as unknown as typeof fetch);
  const out=await provider.transcribe({bytes:bytes(5000),mimeType:'audio/ogg; codecs=opus',durationSeconds:7},{language:'pt'});
  expect(out).toEqual({text:'gastei cinquenta reais no mercado',model:'gpt-4o-mini-transcribe',durationSeconds:7});
  expect(seen!.url).toBe('https://api.openai.com/v1/audio/transcriptions');
  const form=seen!.init.body as FormData;
  expect(form.get('model')).toBe('gpt-4o-mini-transcribe');expect(form.get('language')).toBe('pt');
  expect(String(form.get('prompt'))).toContain('Pix');
  expect((seen!.init.headers as Record<string,string>).Authorization).toBe('Bearer sk-teste');
 });
 it('erro HTTP vira exceção sem vazar a chave',async()=>{
  const fake=vi.fn().mockResolvedValue(new Response('no',{status:429}));
  const provider=new OpenAITranscriptionProvider('sk-secreta','gpt-4o-mini-transcribe',fake as unknown as typeof fetch);
  await expect(provider.transcribe({bytes:bytes(5000),mimeType:'audio/ogg'},{language:'pt'})).rejects.toThrow('TRANSCRIPTION_HTTP_429');
 });
 it('sem chave não nasce',()=>{expect(()=>new OpenAITranscriptionProvider('')).toThrow();});
});
