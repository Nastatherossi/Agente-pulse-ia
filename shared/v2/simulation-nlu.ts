import {transaction,goal,normalize,defaultPreferences,storedTransaction,type Session,type Period,type PendingOperation} from './contracts.js';
import {describeOperation} from './personality.js';
import {dateOffset,monthPeriod,knownCategory} from './policy.js';
/**
 * Pattern-based language understanding used ONLY by the deterministic SimulationProviderV2
 * (the offline stand-in for the model). Nothing here authorizes a write: the simulated model
 * proposes tool calls exactly like the real model and goes through the same policy in policy.ts.
 */
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
export function explicitTransaction(message:string,today:string,_session:Session){
 const text=normalize(message.trim());
 // Current user message is authority. Past history and model text are never authority.
 if(!/^(?:eu\s+)?(?:gastei|paguei|comprei|recebi|ganhei|registra|registre|registrar)\b/.test(text)||/[?]/.test(text)||/\b(se|talvez|nao|gastaria|compraria|quero comprar|pretendo|vou|amanha|credito|cartao|parcelado|transferencia|estorno|ou)\b/.test(text))return undefined;
 const income=/\b(recebi|ganhei|receita)\b/.test(text);
 if(income&&/\b(gastei|paguei|comprei|despesa)\b/.test(text))return undefined;
 const dates=message.match(/\d{4}-\d{2}-\d{2}/g)||[];
 const stripped=text.replace(/\d{4}-\d{2}-\d{2}/g,'');if(/-\s*\d/.test(stripped))return undefined;
 const amounts=stripped.match(/\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/g)||[];if(amounts.length!==1||dates.length>1)return undefined;
 const raw=amounts[0],amount=Number(raw.includes(',')?raw.replace(/\./g,'').replace(',','.'): /^\d{1,3}(?:\.\d{3})+$/.test(raw)?raw.replace(/\./g,''):raw);
 const date=dates[0]||(/\bontem\b/.test(text)?dateOffset(today,-1):today);
 const description=message.replace(/\d{4}-\d{2}-\d{2}/g,'').replace(raw,'').replace(/R\$/gi,'').replace(/\b(eu|gastei|paguei|comprei|recebi|ganhei|registra|registre|registrar|despesa|receita|hoje|ontem|de|em|com|no|na|num|numa|por|reais)\b/gi,' ').replace(/[.!]+$/,'').replace(/\s+/g,' ').trim().replace(/^(?:um|uma|o|a)\s+/i,'');
 const parsed=transaction.safeParse({type:income?'receita':'despesa',amount,description,date,category:knownCategory(description)});
 return parsed.success?parsed.data:undefined;
}
export function requestedPreferences(message:string,current:Session['state']['preferences']){
 const text=normalize(message);
 if(/(redefin|restaur|reset).*(preferenc|comunicac)/.test(text))return defaultPreferences();
 const next={...current};let found=false;
 if(!/(prefir|fala comigo|falar comigo|pode ser|pode explicar|respostas|seja|mais direto|mais descontraido|estilo|modo|proativ|dicas|so responda|explicac|exemplos|emojis)/.test(text))return undefined;
 if(/neutro/.test(text)){next.style='neutro';found=true;}
 if(/diret/.test(text)){next.style='direto';found=true;}if(/descontraid/.test(text)){next.style='descontraido';found=true;}if(/formal/.test(text)){next.style='formal';found=true;}
 if(/curt|breve/.test(text)){next.detail='curto';found=true;}if(/explicar melhor|detalhad/.test(text)){next.detail='detalhado';found=true;}
 if(/equilibrad/.test(text)){next.proactivity='equilibrado';found=true;}else if(/proativ/.test(text)){next.proactivity='proativo';found=true;}
 if(/discret|nao precisa.*dicas|so responda|sem dicas/.test(text)){next.proactivity='discreto';found=true;}
 if(/(menos|sem|pouca|minima).*explicac/.test(text)){next.explanation='minima';found=true;}else if(/(mais|completa).*explicac|explicac.*completa/.test(text)){next.explanation='completa';found=true;}
 if(/exemplos/.test(text)){next.examples=!/(sem|nao).*exemplos/.test(text);found=true;}
 if(/emojis/.test(text)){next.emojis=!/(sem|nao).*emojis/.test(text);found=true;}
 return found?next:undefined;
}
export function requestedGoal(message:string){
 const text=normalize(message.trim());if(!/^(crie (uma )?meta|registre (uma )?meta|defina|minha meta|meu objetivo)/.test(text))return undefined;
 const dates=message.match(/\d{4}-\d{2}-\d{2}/g)||[];
 const stripped=message.replace(/\d{4}-\d{2}-\d{2}/g,'');if(/-\s*\d/.test(stripped))return undefined;const numbers=stripped.match(/\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/g)||[];
 if(numbers.length!==1||dates.length>1)return undefined;const raw=numbers[0],amount=Number(raw.includes(',')?raw.replace(/\./g,'').replace(',','.'): /^\d{1,3}(?:\.\d{3})+$/.test(raw)?raw.replace(/\./g,''):raw);
 const description=stripped.replace(raw,'').replace(/R\$/gi,'').replace(/^(crie (uma )?meta|registre (uma )?meta|defina|minha meta|meu objetivo)/i,'').replace(/\b(reais|para|ate|de|e)\b/gi,' ').replace(/[.!]+$/,'').replace(/\s+/g,' ').trim()||'objetivo financeiro';
 const parsed=goal.safeParse({description,amount,targetDate:dates[0]});return parsed.success?parsed.data:undefined;
}
const number=(s:string)=>Number(s.includes(',')?s.replace(/\./g,'').replace(',','.'): /^\d{1,3}(?:\.\d{3})+$/.test(s)?s.replace(/\./g,''):s);
export function purchaseImpact(message:string){
 const t=normalize(message);if(!/compr|celular/.test(t)||!/[?]|hipot|se eu/.test(t))return undefined;
 const nums=[...message.matchAll(/R\$\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/g)].map(m=>number(m[1]));
 if(nums.length===2&&/tenho/.test(t))return {available:nums[0],amount:nums[1]};
 if(nums.length===1)return {amount:nums[0]};return undefined;
}
export function prepareOperation(message:string,session:Session,now=Date.now()):{operation?:PendingOperation;message:string}{
 const text=normalize(message),base={id:crypto.randomUUID(),createdAt:now,expiresAt:now+5*60000};
 if(/meta|objetivo/.test(text)){
  if(!session.state.goal)return {message:'Não há uma meta existente para alterar.'};
  const requested=requestedGoal(message)||requestedGoal(message.replace(/^(altere|altera|corrige|mude|mudar)\s+(a\s+)?(meta|objetivo)\s*(para)?/i,'minha meta'));
  if(!requested)return {message:'Informe a descrição, o valor e, se desejar, a data da meta que quer alterar.'};
  const operation:PendingOperation={...base,kind:'goal',before:session.state.goal,after:requested};return {operation,message:describeOperation(operation)};
 }
 const amounts=[...message.replace(/\d{4}-\d{2}-\d{2}/g,'').matchAll(/\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/g)].map(m=>number(m[0]));
 const deleting=/exclu|apag|remov/.test(text);
 if(/-\s*\d/.test(message.replace(/\d{4}-\d{2}-\d{2}/g,'')))return {message:'O valor deve ser positivo. Nenhuma alteração foi preparada.'};
 const terms=text.replace(/r\$/g,'').replace(/\d{4}-\d{2}-\d{2}|\d[\d.,]*/g,'').split(/[^a-z]+/).filter(w=>w.length>2&&!['corrige','corrigir','corrija','correcao','altera','alterar','altere','exclui','excluir','exclua','apaga','apagar','apague','remove','remover','remova','aquele','aquela','lancamento','registro','transacao','para','era','eram','foi','nao','pera','valor','descricao','categoria','data','hoje','ontem','com','por','uma','deixa','mude','mudar','troque','troca'].includes(w));
 // Description/category changes identify the old record before the explicit field marker.
 const reference=text.split(/(?:descricao|categoria|data)\s+(?:para|por)/)[0];
 let candidates=session.state.transactions.filter(t=>terms.some(w=>reference.includes(w)&&(normalize(t.description).includes(w)||normalize(t.category||'').includes(w))));
 if(!candidates.length&&!terms.length)candidates=/pera|eram?/.test(text)?session.state.transactions.slice(-1):session.state.transactions;
 const fromTo=/\bde\s+r?\$?\s*\d.*\bpara\s+r?\$?\s*\d/.test(text);
 if(deleting&&amounts.length===1)candidates=candidates.filter(t=>t.amount===amounts[0]);
 if(amounts.length>1)candidates=candidates.filter(t=>t.amount===(fromTo?amounts[0]:amounts.at(-1)));
 const dates=message.match(/\d{4}-\d{2}-\d{2}/g)||[];
 if(dates.length===1&&!/data/.test(text))candidates=candidates.filter(t=>t.date===dates[0]);
 if(candidates.length!==1)return {message:candidates.length?'Há mais de um lançamento possível. Informe a descrição e a data ou o valor original para identificar um único registro.':'Qual lançamento você quer alterar? Informe a descrição e a data ou o valor original.'};
 const before=candidates[0];let after={...before};
 if(!deleting){
  const field=message.match(/(?:descri[cç][aã]o|categoria)\s+(?:para|por)\s+["“]?(.+?)["”]?[.!]?$/i);
  if(field){const value=field[1].replace(/["”]+$/,'').trim();if(/categoria/i.test(field[0]))after.category=value;else after.description=value;}
  else if(/data/.test(text)&&dates.length===1)after.date=dates[0];
  else if(amounts.length)after.amount=fromTo?amounts.at(-1)!:amounts[0];
  else return {message:'Qual valor, descrição, categoria ou data deve substituir o dado atual?'};
  const parsed=storedTransaction.safeParse(after); // UUID target is retained, never supplied by the model.
  if(!parsed.success)return {message:'O novo dado é inválido. Informe um valor positivo com até duas casas decimais ou uma data ISO válida.'};
  after=parsed.data;
 }
 const operation:PendingOperation={...base,kind:deleting?'delete':'edit',targetId:before.id,before,after:deleting?undefined:after};
 return {operation,message:describeOperation(operation)};
}
