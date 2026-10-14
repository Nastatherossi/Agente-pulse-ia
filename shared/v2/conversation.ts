import {normalize,type Session} from './contracts.js';
import {conversationTone,topicOf,retrieveMemories} from './memory-engine.js';
/** Simulation templates; real mode uses the server provider. No numbers or invented costs. */
export function conversationalReply(message:string,session:Session):string|undefined {
 const t=normalize(message),tone=conversationTone(session,message),formal=tone==='formal',serious=tone==='serious';
 if(/quero (me matar|morrer)|vou me matar|suicid|me machucar/.test(t))return 'Sinto muito que você esteja passando por isso. Se houver perigo imediato, procure atendimento de emergência local e alguém de confiança para ficar com você. Você está em segurança agora?';
 if(/nao quero (mais )?falar|deixa (isso|pra la)|por hoje (e|era) so|encerrar assunto/.test(t))return 'Tudo bem. Podemos deixar esse assunto aqui.';
 if(/^(oi|ola|bom dia|boa tarde|boa noite|e ai)[, !]*(pulse)?[.!]*$/.test(t))return formal?'Olá. Como posso ajudar hoje?':tone==='casual_provisional'?'E aí! Como estão as coisas por aí?':'Opa! Tudo certo? Como posso te ajudar hoje?';
 if(/preciso (falar|conversar).*(seri|coisa)|falar de uma coisa seria/.test(t))return 'Claro. Me conta o que está acontecendo.';
 if(/terminei.*namoro|\bto\b.*\bmal\b|estou.*triste/.test(t))return 'Parece estar sendo difícil. Se quiser, pode me contar o que aconteceu; podemos só conversar, sem procurar uma solução agora.';
 if(/chefe/.test(t))return formal?'Parece uma situação difícil no trabalho. O que aconteceu?':serious?'Parece que a situação no trabalho está complicada. O que aconteceu?':'Parece que aconteceu alguma coisa no trabalho. O que rolou?';
 const topic=topicOf(message),retrieved=retrieveMemories(session,message,'conversa');
 if(/lembra|retomar/.test(t)&&topic){const memory=session.narrative.records.find(r=>r.topic===topic&&r.ownerId===session.id&&!session.narrative.tombstones.includes(topic));return memory?`${memory.content} Isso é o que está registrado na memória narrativa, não um fato financeiro. ${memory.status==='abandoned'?'A ideia está marcada como abandonada.':'Podemos retomar a partir daí.'}`:'Não há uma memória armazenada sobre essa ideia. Se quiser, me conte novamente.';}
 if(/desisti|nao (quero|vou) mais/.test(t)&&topic)return 'Entendido. Essa intenção não será tratada como um plano ativo.';
 if(/plano de negocios|montar.*plano|vamos.*plano/.test(t))return 'Podemos montar um rascunho: defina o produto e o público, escolha onde testar a demanda, liste equipamentos e insumos e pesquise preços locais. Depois compare custo por venda, preço e margem. Qual desses pontos você já tem definido? Os custos serão hipóteses até você trazer cotações.';
 if(topic==='popcorn')return 'Podemos explorar a ideia de vender pipoca: local, público e estrutura para começar. Se quiser, montamos um plano inicial com custos a pesquisar, sem tratar estimativas como preços verificados.';
 if(topic==='business')return 'Podemos desenvolver essa ideia. Você já tem um produto ou público em mente?';
 if(topic==='career')return /decidi/.test(t)?'Entendi que você declarou uma decisão. Podemos organizar os próximos passos sem presumir que a saída já aconteceu.':'É uma mudança importante. O que está fazendo você considerar sair do emprego?';
 if(topic==='housing')return 'Podemos começar pelo tipo de moradia e região, depois listar aluguel, contas e custos da mudança para pesquisar. Você pensa em morar sozinho em breve ou está explorando a ideia?';
 if(topic==='marriage')return 'Podemos organizar essa intenção em etapas e pesquisar os custos que fazem sentido para você. Uma intenção lembrada não cria uma meta financeira; para isso, peça explicitamente para criar a meta.';
 if(topic==='programming')return 'Podemos escolher um projeto pequeno para praticar programação e dividir o aprendizado em passos. O que você gostaria de construir?';
 if(topic==='city')return 'Podemos comparar o que você procura na nova cidade, trabalho, moradia e rede de apoio. Qual é o principal motivo da mudança?';
 if(/acha.*(moto|comprar)|opiniao.*compr/.test(t))return (session.state.goal?`Há um objetivo financeiro fictício registrado: ${session.state.goal.description}. `:retrieved.length?`Você tem uma intenção lembrada: ${retrieved[0].content} `:'')+'Eu avaliaria a utilidade da compra e os compromissos que você quer preservar. Não tenho preços, renda ou custos de manutenção verificados para concluir se cabe no seu orçamento.';
 return undefined;
}
