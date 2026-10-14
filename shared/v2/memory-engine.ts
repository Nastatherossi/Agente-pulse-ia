import {normalize,type Session} from './contracts.js';
import {memoryActionSchema,memoryTopics,MEMORY_LIMITS,type MemoryAction,type MemoryRecord} from './memory-contracts.js';
import {clearContext} from './personality.js';
/** Closed, minimized topics: no raw message is automatically persisted. */
const sensitive=/(cpf|rg\b|senha|password|token|api.?key|diagnostic|depress|suicid|me matar|abuso|sexual|religia|politic|namoro|terminei|trauma|doenca|medicamento)|@|\b\d{8,}\b/i;
const unsafe=(message:string)=>sensitive.test(normalize(message))||/ignore.*instruc|system prompt|execute.*sql|workspace.?id/.test(normalize(message));
const labels:Record<MemoryRecord['topic'],string>={career:'deixar o emprego',popcorn:'vender pipoca',business:'abrir um negócio',housing:'morar sozinho',marriage:'casamento',programming:'estudar programação',city:'mudar de cidade'};
export function topicOf(message:string):MemoryRecord['topic']|undefined {
 const t=normalize(message);
 if(/pipoca/.test(t))return 'popcorn';
 if(/emprego|demissao|pedir conta|chefe/.test(t))return 'career';
 if(/morar sozinho/.test(t))return 'housing';
 if(/casar|casamento/.test(t))return 'marriage';
 if(/abrir.*(negocio|empresa)|plano de negocios/.test(t))return 'business';
 if(/estud.*programac|aprend.*programac/.test(t))return 'programming';
 if(/mudar de cidade/.test(t))return 'city';return undefined;
}
const canonical=(topic:MemoryRecord['topic'],status:MemoryRecord['status'])=>`${status==='abandoned'?'Abandonou a ideia de':status==='declared_decision'?'Declarou decisão de':status==='planned'?'Planeja':status==='outdated'?'Informação desatualizada sobre':'Está explorando a ideia de'} ${labels[topic]}.`;
export function candidateMemory(message:string,session:Session):Omit<MemoryRecord,'id'|'ownerId'|'createdAt'|'updatedAt'>|undefined {
 const t=normalize(message);if(unsafe(message)||/[?]/.test(t)||/^(lembra|o que|esque|pode esquecer)/.test(t)||/^(gastei|paguei|comprei|recebi|registre|registra)\b/.test(t))return undefined;
 let topic=topicOf(message);
 if(!topic&&/^(decidi que vou sair|desisti de sair)/.test(t)&&session.narrative.records.some(r=>r.topic==='career'))topic='career';
 if(!topic)return undefined;
 const abandoned=/desisti|nao (quero|vou|pretendo) mais|abandonei/.test(t);
 if(!abandoned&&!/^(eu )?(estou pensando|to pensando|quero|vou|pretendo|planejo|decidi|estou estudando|estou aprendendo|lembre)/.test(t))return undefined;
 if(abandoned&&!session.narrative.records.some(r=>r.topic===topic))return undefined;
 const status=abandoned?'abandoned':/decidi/.test(t)?'declared_decision':/^(eu )?(vou|planejo|pretendo)/.test(t)?'planned':'exploring';
 return {topic,type:['housing','marriage','city'].includes(topic)?'life_goal':topic==='programming'?'project':'intention',content:canonical(topic,status),status,source:abandoned||session.narrative.records.some(r=>r.topic===topic&&r.status!==status)?'user_correction':'explicit_user_statement',confidence:'high'};
}
export function pruneMemories(session:Session,now=Date.now()){
 session.narrative.records=session.narrative.records.filter(r=>r.ownerId===session.id&&now-Date.parse(r.updatedAt)<MEMORY_LIMITS.retentionMs);
}
export function observeMemory(session:Session,message:string,now=Date.now()){
 pruneMemories(session,now);
 const candidate=candidateMemory(message,session);
 if((!session.narrative.enabled||!session.narrative.noticeAccepted)&&candidate?.source!=='user_correction')return;
 if(!candidate||session.narrative.tombstones.includes(candidate.topic))return;
 const existing=session.narrative.records.find(r=>r.topic===candidate.topic),timestamp=new Date(now).toISOString();
 if(existing){if(existing.content===candidate.content&&existing.status===candidate.status)return;Object.assign(existing,candidate,{updatedAt:timestamp});}
 else if(session.narrative.records.length<MEMORY_LIMITS.records)session.narrative.records.push({...candidate,id:crypto.randomUUID(),ownerId:session.id,createdAt:timestamp,updatedAt:timestamp});
}
export function conversationTone(session:Session,message:string){
 const t=normalize(message);
 if(/seri[oa]|seriamente|terminei|\bto\b.*\bmal\b|triste|nao aguento|insuportavel/.test(t))return 'serious';
 if(session.narrative.style.explicitStyle||session.state.preferences.style!=='neutro')return session.state.preferences.style;
 if(/mano|\bpo\b|kkk|putz/.test(t))return 'casual_current';
 const signals=session.narrative.style.signals;
 return signals.length>=4&&signals.filter(v=>v==='informal').length/signals.length>=0.75?'casual_provisional':'neutral';
}
export function observeStyle(session:Session,message:string){
 if(!session.narrative.enabled||unsafe(message))return;
 const t=normalize(message);if(/seri[oa]|terminei|triste|nao aguento/.test(t))return;
 const signal:'informal'|'neutral'=/mano|\bpo\b|kkk|putz/.test(t)?'informal':'neutral';session.narrative.style.signals=[...session.narrative.style.signals,signal].slice(-6);
}
export function retrieveMemories(session:Session,message:string,intent:string){
 pruneMemories(session);
 if(['execucao','alteracao','confirmacao','preferencias'].includes(intent))return [];
 const topic=topicOf(message),opinion=/acha|opiniao|vale a pena/.test(normalize(message));
 const eligible=session.narrative.records.filter(r=>r.ownerId===session.id&&!['abandoned','outdated'].includes(r.status)&&!session.narrative.tombstones.includes(r.topic));
 const ranked=eligible.filter(r=>r.topic===topic||opinion&&r.type==='life_goal').sort((a,b)=>(b.topic===topic?10:0)-(a.topic===topic?10:0)||(b.confidence==='high'?1:0)-(a.confidence==='high'?1:0)||Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
 const selected:MemoryRecord[]=[];let size=0;
 for(const record of ranked){const length=JSON.stringify({id:record.id,topic:record.topic,content:record.content,status:record.status,confidence:record.confidence}).length;if(selected.length>=MEMORY_LIMITS.retrieved||size+length+selected.length+2>MEMORY_LIMITS.contextCharacters)break;selected.push(structuredClone(record));size+=length;}
 return selected;
}
export const memoryContext=(records:MemoryRecord[])=>records.map(({id,topic,content,status,confidence})=>({id,topic,content,status,confidence}));
const statusLabel:Record<MemoryRecord['status'],string>={exploring:'em exploração',planned:'plano',declared_decision:'decisão declarada',abandoned:'abandonado',outdated:'desatualizado'};
export function applyMemoryAction(session:Session,raw:MemoryAction){
 const action=memoryActionSchema.parse(raw);pruneMemories(session);
 if(action.kind==='enable'){session.narrative.enabled=action.enabled;session.narrative.noticeAccepted=true;return action.enabled?'Memória automática habilitada para objetivos e intenções dos temas suportados, sem salvar detalhes íntimos. Ela vale só nesta sessão do laboratório; no modo real, o token expira em até seis horas. Você pode consultar e excluir memórias; cópias antigas de tokens não são revogadas.':'Memória automática desativada. As memórias existentes continuam disponíveis; você pode excluí-las.';}
 if(action.kind==='list')return session.narrative.records.length?'Memórias armazenadas:\n'+session.narrative.records.map(r=>`${r.content} (${statusLabel[r.status]}).`).join('\n'):'Não há memórias narrativas armazenadas.';
 if(action.kind==='clear'){session.narrative.records=[];session.narrative.tombstones=[...memoryTopics];session.narrative.style.signals=[];clearContext(session);return 'Memórias narrativas apagadas. Preferências e dados financeiros preservados.';}
 const record=session.narrative.records.find(r=>r.id===action.id&&r.ownerId===session.id);if(!record)throw new Error('MEMORY_NOT_FOUND');
 if(action.kind==='delete'){session.narrative.records=session.narrative.records.filter(r=>r.id!==record.id);session.narrative.tombstones=[...new Set([...session.narrative.tombstones,record.topic])];clearContext(session);return 'Memória excluída da sessão atual.';}
 if(unsafe(action.content))throw new Error('MEMORY_CONTENT_NOT_ALLOWED');
 record.content=action.content;record.status=action.status;record.source='user_correction';record.confidence='high';record.updatedAt=new Date().toISOString();clearContext(session);return 'Memória corrigida e contexto anterior invalidado.';
}
export function memoryCommand(session:Session,message:string):string|undefined {
 const t=normalize(message);
 if(/nao quero.*(guarde|salve)|desativ.*memoria automatica/.test(t))return applyMemoryAction(session,{kind:'enable',enabled:false,noticeAccepted:true});
 if(/^(habilit|ativ).*memoria automatica/.test(t))return applyMemoryAction(session,{kind:'enable',enabled:true,noticeAccepted:true});
 if(/o que.*lembra.*mim|consultar.*memorias/.test(t))return applyMemoryAction(session,{kind:'list'});
 if(/^(limp|apag).*memorias/.test(t))return applyMemoryAction(session,{kind:'clear'});
 const topic=topicOf(message);
 if(/lembra|retomar/.test(t)&&topic&&!/^lembre/.test(t)){const record=session.narrative.records.find(r=>r.topic===topic&&r.ownerId===session.id&&!session.narrative.tombstones.includes(topic));return record?`${record.content} ${record.status==='abandoned'?'Esse assunto está marcado como abandonado.':record.status==='outdated'?'Essa informação está desatualizada.':'Podemos retomar a partir daí.'}`:'Não há memória armazenada sobre esse assunto.';}
 if(/esquece|esqueca|pode esquecer/.test(t)&&topic){const records=session.narrative.records.filter(r=>r.topic===topic&&r.ownerId===session.id);if(records.length!==1)return 'Não encontrei uma memória única sobre esse assunto.';return applyMemoryAction(session,{kind:'delete',id:records[0].id});}
 if(/^lembre (disso|que|da)/.test(t)&&topic&&!unsafe(message)){
  session.narrative.tombstones=session.narrative.tombstones.filter(v=>v!==topic);const enabled=session.narrative.enabled,accepted=session.narrative.noticeAccepted;session.narrative.enabled=true;session.narrative.noticeAccepted=true;observeMemory(session,message);session.narrative.enabled=enabled;session.narrative.noticeAccepted=accepted;
  return session.narrative.records.some(r=>r.topic===topic)?'Informação registrada como memória narrativa, sem criar uma operação financeira.':'Não consegui identificar uma informação adequada para lembrar.';
 }
 return undefined;
}
