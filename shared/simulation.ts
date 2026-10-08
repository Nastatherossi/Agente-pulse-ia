import { decisionSchema, type Decision, type ModelProvider } from './contracts';
export class SimulationProvider implements ModelProvider {
 readonly mode='simulation' as const;
 async interpret(message:string,today:string):Promise<Decision> {
  const original=message.trim(),text=original.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const clarify=(s:string):Decision=>({intent:'Esclarecimento necessário',clarification:s});
  if(!text||text.length>2000) return clarify('Envie uma mensagem de 1 a 2.000 caracteres.');
  if(/saldo/.test(text)&&!/(gastei|recebi|registr|paguei)/.test(text)) return {intent:'Consultar saldo consolidado',call:{name:'consultar_saldo',arguments:{}}};
  if(/(listar|mostrar|ver|quais|ultimas|extrato)/.test(text)&&/(transac|despesas|receitas|extrato|gastos)/.test(text)) return {intent:'Consultar transações',call:{name:'listar_transacoes',arguments:{limit:20,type:/despesas|gastos/.test(text)?'despesa':/receitas/.test(text)?'receita':undefined}}};
  const expense=/(gastei|paguei|despesa|gasto)/.test(text),income=/(recebi|receita|ganhei)/.test(text);
  if(/-\s*\d/.test(text.replace(/\d{4}-\d{2}-\d{2}/g,''))) return clarify('O valor deve ser positivo.');
  if(expense&&income) return clarify('Há receita e despesa na mesma mensagem. Registre uma transação por vez.');
  if(!expense&&!income) return clarify('Na simulação, experimente “qual meu saldo?”, “gastei 50 em mercado hoje” ou “listar transações”.');
  if(/(credito|cartao|parcel|amanha|ontem|estorn|transfer|nao |talvez|se |ou )/.test(text)) return clarify('A simulação aceita receitas e despesas simples. Informe um lançamento definitivo, o valor, a descrição e a data em AAAA-MM-DD ou “hoje”.');
  const withoutDate=text.replace(/\d{4}-\d{2}-\d{2}/g,'');
  const amounts=withoutDate.match(/(?:\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?)/g)||[];
  if(amounts.length!==1) return clarify('Informe um único valor para esta transação.');
  const raw=amounts[0],amount=Number(raw.includes(',')?raw.replace(/\./g,'').replace(',','.'):raw);
  const date=text.match(/\d{4}-\d{2}-\d{2}/)?.[0]||(/\bhoje\b/.test(text)?today:undefined);
  if(!date) return clarify('Qual a data? Reenvie o comando com “hoje” ou uma data em AAAA-MM-DD.');
  let description=original.replace(/\d{4}-\d{2}-\d{2}/g,'').replace(raw,'').replace(/R\$/gi,'').replace(/\b(gastei|paguei|recebi|ganhei|registrar|registre|despesa|receita|hoje|de|em|com|no|na|por|reais)\b/gi,' ').replace(/\s+/g,' ').trim();
  if(!description) return clarify('Informe a descrição, por exemplo “gastei 50 em mercado hoje”.');
  const parsed=decisionSchema.safeParse({intent:expense?'Registrar despesa':'Registrar receita',call:{name:'registrar_transacao',arguments:{type:expense?'despesa':'receita',amount,description,date}}});
  return parsed.success?parsed.data:clarify('Valor ou data inválidos. Use valor positivo, até duas casas decimais e uma data válida.');
 }
}
