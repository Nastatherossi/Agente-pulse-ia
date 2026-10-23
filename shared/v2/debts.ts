/** Financiamento / empréstimo: cálculo da parcela e das datas. Tudo em código, nunca no modelo. */
export type RatePeriod='annual'|'monthly';
/** Taxa efetiva mensal (fração). 5% a.a. => (1,05)^(1/12) - 1. */
export function monthlyRate(rate:number,period:RatePeriod):number{
 const r=rate/100;
 return period==='monthly'?r:Math.pow(1+r,1/12)-1;
}
/** Parcela fixa (tabela Price) com arredondamento em centavos. */
export function pmt(principal:number,rate:number,period:RatePeriod,months:number):number{
 const i=monthlyRate(rate,period);
 const v=i===0?principal/months:principal*i/(1-Math.pow(1+i,-months));
 return Math.round(v*100)/100;
}
const lastDay=(y:number,m:number)=>new Date(Date.UTC(y,m,0)).getUTCDate();
const iso=(y:number,m:number,d:number)=>`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
/** Mesma data N meses depois, respeitando o fim do mês (31/01 + 1 mês = 28/02). */
export function addMonths(date:string,n:number,keepDay?:number):string{
 const y=Number(date.slice(0,4)),m=Number(date.slice(5,7)),d=keepDay??Number(date.slice(8,10));
 const t=y*12+(m-1)+n,ny=Math.floor(t/12),nm=t%12+1;
 return iso(ny,nm,Math.min(d,lastDay(ny,nm)));
}
