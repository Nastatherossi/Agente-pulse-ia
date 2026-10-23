import {normalize} from './contracts.js';
/** Cartão como o agente o enxerga: só o que importa para encaixar compras na fatura. */
export type Card={name:string;closingDay:number;dueDay:number};
/** "cartão Nubank", "Nubank" e "nubank" são o mesmo cartão. */
export const cardKey=(name:string)=>normalize(name).replace(/\bcartao\b/g,' ').replace(/[^a-z0-9]+/g,' ').trim();
/** O cartão citado. Sem nome: o único cadastrado (ou nenhum, se houver mais de um ou nenhum). */
export function findCard<T extends {name:string}>(cards:readonly T[]|undefined,name?:string):T|undefined{
 const list=cards??[];
 if(!name||!cardKey(name))return list.length===1?list[0]:undefined;
 const key=cardKey(name);
 return list.find(c=>cardKey(c.name)===key);
}
const iso=(y:number,m:number,d:number)=>`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
const lastDay=(y:number,m:number)=>new Date(Date.UTC(y,m,0)).getUTCDate();
const addMonths=(y:number,m:number,n:number)=>{const t=y*12+(m-1)+n;return {y:Math.floor(t/12),m:t%12+1};};
/**
 * Fatura em que cai a parcela `index` (0 = primeira) de uma compra. Espelha finance_create_card_purchase (banco):
 * compra depois do dia de fechamento vai para a fatura do mês seguinte; o vencimento fica no mesmo mês do fechamento
 * quando o dia de vencimento é maior que o de fechamento, senão no mês seguinte.
 */
export function invoiceFor(card:Pick<Card,'closingDay'|'dueDay'>,purchaseDate:string,index=0){
 const y0=Number(purchaseDate.slice(0,4)),m0=Number(purchaseDate.slice(5,7)),day=Number(purchaseDate.slice(8,10));
 const base=addMonths(y0,m0,day>card.closingDay?1:0),c=addMonths(base.y,base.m,index);
 const closingDate=iso(c.y,c.m,Math.min(card.closingDay,lastDay(c.y,c.m)));
 const d=card.dueDay>card.closingDay?c:addMonths(c.y,c.m,1);
 const dueDate=iso(d.y,d.m,Math.min(card.dueDay,lastDay(d.y,d.m)));
 return {competence:iso(c.y,c.m,1),closingDate,dueDate};
}
/** "3x" / "3 vezes" / "em 3 parcelas" / "parcelei em 3". */
export function installmentsIn(text:string):number|undefined{
 const t=normalize(text);
 const m=t.match(/\b(\d{1,2})\s*(?:x|vezes)\b/)||t.match(/\b(?:em|de)\s+(\d{1,2})\s+(?:parcelas?|vezes|x)\b/)||t.match(/\b(\d{1,2})\s+parcelas?\b/)||t.match(/\bparcel\w*\s+(?:em\s+)?(\d{1,2})\b/);
 const n=m?Number(m[1]):undefined;
 return n&&n>=1&&n<=48?n:undefined;
}
export const dm=(d:string)=>`${d.slice(8,10)}/${d.slice(5,7)}`;
