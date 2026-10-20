import {normalize,type Step} from './contracts.js';
import {amountsIn} from './policy.js';
/*
 * ANSWER GROUNDING
 * ----------------
 * Replaces the old sanitizer that discarded the WHOLE model answer whenever it contained a digit,
 * "R$" or "saldo". Here each sentence is judged on its own:
 *   - a claim that something was registered/saved, with no successful write this turn → removed;
 *   - a claim that something was memorized, with no memory write → removed;
 *   - a statement about the user's own finances (balance, spending, income) with no data consulted → removed;
 *   - a money value that is neither in the user's words, nor in this turn's tool results, nor framed
 *     as an example/hypothesis → removed.
 * Everything else (opinions, general percentages, "três opções", numbers the user said) is kept.
 */
const WRITE_CLAIM=/\b(registrei|anotei|lancei|cadastrei|adicionei|salvei|ja registrad[oa]|registrad[oa] com sucesso|(despesa|receita|gasto|lancamento|transacao|pagamento) (foi )?(registrad[oa]|anotad[oa]|lancad[oa]|salv[oa]|efetuad[oa]|concluid[oa])|recorded|registered)\b/;
const MEMORY_CLAIM=/\b(memorizei|guardei (isso|essa|na memoria)|vou (me )?lembrar|lembrarei|salvei (isso |essa informacao )?na memoria|anotei na memoria|ficou guardad[oa])\b/;
// An assertion about the user's own money (subject + predicate), not a mere mention like "se você me disser sua renda".
const PERSONAL_FINANCE=/\b((seu saldo|sua renda|seu salario|suas economias|sua reserva) (e|esta|ficou|fica|vai|sera|caiu|subiu|aumentou|diminuiu|de)\b|voce (gastou|recebeu|ganhou|economizou|tem gastado|esta gastando|ganha|tem r)|seus gastos (aument|diminu|cresc|ca[ií]|subi|est|for)|suas despesas (aument|diminu|cresc|ca[ií]|subi|est))/;
const EXAMPLE_FRAME=/\b(por exemplo|exemplo|se voce|se a |se o |se for|supondo|suponha|imagine|digamos|hipotetic|simulac|caso voce|tipo assim)\b/;
const MONEY=/r\$\s*\d[\d.,]*(\s*mil)?|\d[\d.,]*\s*(mil\s*)?reais/g;
export type GroundingContext={message:string;history:string[];steps:Step[];wroteData:boolean;memoryWritten?:boolean};
const cents=(n:number)=>Math.round(n*100);
function resultNumbers(value:unknown,out:Set<number>,key=''){
 if(typeof value==='number'){if(/cents$/i.test(key))out.add(Math.round(value));else out.add(cents(value));return;}
 if(Array.isArray(value)){for(const v of value)resultNumbers(v,out,key);return;}
 if(value&&typeof value==='object')for(const [k,v] of Object.entries(value))resultNumbers(v,out,k);
}
export function groundedText(draft:string,ctx:GroundingContext):string{
 const text=draft.trim();if(!text)return '';
 const known=new Set<number>([...amountsIn(ctx.message),...ctx.history.flatMap(h=>amountsIn(h))].map(cents));
 const ok=ctx.steps.filter(s=>s.status==='success');
 for(const s of ok)resultNumbers(s.result,known);
 const consulted=ok.length>0;
 const sentences=text.split(/(?<=[.!?…])\s+|\n+/).filter(s=>s.trim());
 const kept=sentences.filter(sentence=>{
  const n=normalize(sentence);
  if(WRITE_CLAIM.test(n)&&!ctx.wroteData)return false;
  if(FAKE_CONFIRMATION.test(n))return false;
  if(MEMORY_CLAIM.test(n)&&!ctx.memoryWritten)return false;
  if(PERSONAL_FINANCE.test(n)&&!consulted)return false;
  const values=[...n.matchAll(MONEY)].flatMap(m=>amountsIn(m[0]));
  if(values.some(v=>!known.has(cents(v)))&&!EXAMPLE_FRAME.test(n))return false;
  return true;
 });
 return kept.join(' ').trim().slice(0,900);
}

/** Sentences that imitate the system's own confirmation prompt. Only code may ask "sim ou cancelar". */
const FAKE_CONFIRMATION=/responda .?sim.? ou .?cancelar|expira em 5 minutos/;
export const imitatesConfirmation=(text:string)=>FAKE_CONFIRMATION.test(normalize(text));
/** The model asks, in plain text, to confirm a write instead of proposing it through a tool. */
export const asksToConfirmInText=(text:string)=>{
 if(imitatesConfirmation(text))return true;
 // Only a question that offers to perform the write ("posso registrar…?", "quer que eu exclua…?"),
 // not one that rules it out ("posso conversar sem registrar").
 return normalize(text).split(/(?<=[.!?…])\s+|\n+/).some(q=>/\?/.test(q)&&!/\bsem (registr|anot|lanc)/.test(q)&&/\b(confirma|confirmar|posso|quer que eu|deseja que eu|devo)\s+(o |a |os |as |esse |essa |isso )?(exclu|apag|remov|alter|corrig|registr|lanc|anot)/.test(q));
};
/**
 * When the code already rendered the numbers (receipt, balance, summary, simulation), the model's comment
 * must be qualitative: any sentence with a number or a money word is dropped. A model paraphrasing a
 * computed value can get it wrong ("sobram uns 50 conto" for R$ 500) and the code-written line is already there.
 */
export function withoutNumbers(text:string):string{
 return text.split(/(?<=[.!?…])\s+|\n+/).filter(x=>x.trim()&&!/\d|\b(mil|conto|contos|pila|pilas|reais|real|centavos|por cento)\b/.test(normalize(x))&&!imitatesConfirmation(x)).join(' ').trim();
}
