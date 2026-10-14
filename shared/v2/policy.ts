import {transaction,goal,normalize,defaultPreferences,type Session,type Period,type ValidCall} from './contracts.js';
export const dateOffset=(date:string,days:number)=>new Date(Date.parse(date+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
export const monthPeriod=(today:string,offset=0):Period=>{const d=new Date(today+'T12:00:00Z');const start=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+offset,1)),end=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+offset+1,0));return {start:start.toISOString().slice(0,10),end:end.toISOString().slice(0,10)};};
export function resolvePeriod(message:string,today:string,memory:Session['memory']):Period|undefined{
 const text=normalize(message);const dates=message.match(/\d{4}-\d{2}-\d{2}/g);
 if(dates?.length===2)return {start:dates[0],end:dates[1]};
 if(/mes passado|mes anterior/.test(text))return monthPeriod(today,-1);
 if(/mes|fim do mes/.test(text))return monthPeriod(today);
 if(/semana passada/.test(text)){const day=new Date(today+'T12:00:00Z').getUTCDay()||7,start=dateOffset(today,1-day-7);return {start,end:dateOffset(start,6)};}
 if(/ontem/.test(text)){const d=dateOffset(today,-1);return {start:d,end:d};}
 if(/hoje/.test(text))return {start:today,end:today};
 if(/nesse periodo|nessas despesas|isso|e quanto|e no|e na/.test(text)&&memory.periods.length)return memory.periods[0];
 return undefined;
}
export function knownCategory(description:string):string|undefined{
 const text=normalize(description);
 if(/\b(supermercado|mercado|restaurante|almoco|jantar)\b/.test(text))return 'Alimentação';
 if(/\b(transporte|gasolina|combustivel|uber|onibus)\b/.test(text))return 'Transporte';
 if(/\b(bar|cinema|lazer)\b/.test(text))return 'Lazer';
 return undefined;
}
export function explicitTransaction(message:string,today:string,_session:Session){
 const text=normalize(message.trim());
 // Current user message is authority. Past history and model text are never authority.
 if(!/^(?:eu\s+)?(?:gastei|paguei|recebi|ganhei|registra|registre|registrar)\b/.test(text)||/[?]/.test(text)||/\b(se|talvez|nao|gastaria|compraria|quero comprar|pretendo|credito|cartao|parcelado|transferencia|estorno|ou)\b/.test(text))return undefined;
 const income=/\b(recebi|ganhei|receita)\b/.test(text);
 if(income&&/\b(gastei|paguei|despesa)\b/.test(text))return undefined;
 const dates=message.match(/\d{4}-\d{2}-\d{2}/g)||[];
 const stripped=text.replace(/\d{4}-\d{2}-\d{2}/g,'');if(/-\s*\d/.test(stripped))return undefined;
 const amounts=stripped.match(/\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/g)||[];if(amounts.length!==1||dates.length>1)return undefined;
 const raw=amounts[0],amount=Number(raw.includes(',')?raw.replace(/\./g,'').replace(',','.'): /^\d{1,3}(?:\.\d{3})+$/.test(raw)?raw.replace(/\./g,''):raw);
 const date=dates[0]||(/\bontem\b/.test(text)?dateOffset(today,-1):today);
 const description=message.replace(/\d{4}-\d{2}-\d{2}/g,'').replace(raw,'').replace(/R\$/gi,'').replace(/\b(eu|gastei|paguei|recebi|ganhei|registra|registre|registrar|despesa|receita|hoje|ontem|de|em|com|no|na|num|numa|por|reais)\b/gi,' ').replace(/[.!]+$/,'').replace(/\s+/g,' ').trim();
 const parsed=transaction.safeParse({type:income?'receita':'despesa',amount,description,date,category:knownCategory(description)});
 return parsed.success?parsed.data:undefined;
}
export function requestedPreferences(message:string,current:Session['state']['preferences']){
 const text=normalize(message);
 if(/(redefin|restaur|reset).*(preferenc|comunicac)/.test(text))return defaultPreferences();
 const next={...current};let found=false;
 if(!/(prefir|fala comigo|falar comigo|pode ser|pode explicar|respostas|seja|mais direto|mais descontraido|estilo|modo|proativ|dicas|so responda|explicac|exemplos)/.test(text))return undefined;
 if(/neutro/.test(text)){next.style='neutro';found=true;}
 if(/diret/.test(text)){next.style='direto';found=true;}if(/descontraid/.test(text)){next.style='descontraido';found=true;}if(/formal/.test(text)){next.style='formal';found=true;}
 if(/curt|breve/.test(text)){next.detail='curto';found=true;}if(/explicar melhor|detalhad/.test(text)){next.detail='detalhado';found=true;}
 if(/equilibrad/.test(text)){next.proactivity='equilibrado';found=true;}else if(/proativ/.test(text)){next.proactivity='proativo';found=true;}
 if(/discret|nao precisa.*dicas|so responda|sem dicas/.test(text)){next.proactivity='discreto';found=true;}
 if(/(menos|sem|pouca|minima).*explicac/.test(text)){next.explanation='minima';found=true;}else if(/(mais|completa).*explicac|explicac.*completa/.test(text)){next.explanation='completa';found=true;}
 if(/exemplos/.test(text)){next.examples=!/(sem|nao).*exemplos/.test(text);found=true;}
 return found?next:undefined;
}
export function requestedGoal(message:string){
 const text=normalize(message.trim());if(!/^(quero (juntar|economizar|guardar)|defina|minha meta|meu objetivo)/.test(text))return undefined;
 const dates=message.match(/\d{4}-\d{2}-\d{2}/g)||[];
 const stripped=message.replace(/\d{4}-\d{2}-\d{2}/g,'');if(/-\s*\d/.test(stripped))return undefined;const numbers=stripped.match(/\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/g)||[];
 if(numbers.length!==1||dates.length>1)return undefined;const raw=numbers[0],amount=Number(raw.includes(',')?raw.replace(/\./g,'').replace(',','.'): /^\d{1,3}(?:\.\d{3})+$/.test(raw)?raw.replace(/\./g,''):raw);
 const description=stripped.replace(raw,'').replace(/R\$/gi,'').replace(/^(quero (juntar|economizar|guardar)|defina|minha meta|meu objetivo)/i,'').replace(/\b(reais|para|ate|de|e)\b/gi,' ').replace(/[.!]+$/,'').replace(/\s+/g,' ').trim()||'objetivo financeiro';
 const parsed=goal.safeParse({description,amount,targetDate:dates[0]});return parsed.success?parsed.data:undefined;
}
export function authorizeWrite(call:ValidCall,message:string,today:string,session:Session):boolean{
 if(call.name==='registrar_transacao'){
  const expected=explicitTransaction(message,today,session);if(!expected)return false;
  const a=call.arguments;return a.type===expected.type&&a.amount===expected.amount&&a.date===expected.date&&normalize(a.description as string)===normalize(expected.description)&&(!a.category||a.category===expected.category);
 }
 if(call.name==='atualizar_preferencias')return JSON.stringify(call.arguments)===JSON.stringify(requestedPreferences(message,session.state.preferences));
 if(call.name==='definir_objetivo')return !session.state.goal&& JSON.stringify(call.arguments)===JSON.stringify(requestedGoal(message));
 return true;
}
