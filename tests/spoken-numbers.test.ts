import {describe,it,expect} from 'vitest';
import {spokenNumbersToDigits as f,transcriptToMessage} from '../shared/v2/audio';
import {amountsIn} from '../shared/v2/policy';
/* Valores falados viram dígitos para a política conseguir conferir o valor do áudio. */
describe('valores falados',()=>{
 it('reais e centavos sem a palavra reais',()=>{
  expect(f('gastei três e cinquenta no débito.')).toBe('gastei R$ 3,50 no débito.');
  expect(f('paguei dez e noventa')).toBe('paguei R$ 10,90');
 });
 it('reais com centavos por extenso',()=>{
  expect(f('foram doze reais e cinquenta centavos')).toBe('foram R$ 12,50');
  expect(f('foram quatro reais e cinco')).toBe('foram R$ 4,05');
 });
 it('inteiros compostos',()=>{
  expect(f('gastei trinta e dois reais')).toBe('gastei R$ 32');
  expect(f('gastei trinta e dois no almoço')).toBe('gastei 32 no almoço');
  expect(f('paguei cento e vinte e cinco')).toBe('paguei 125');
  expect(f('paguei duzentos e cinquenta reais')).toBe('paguei R$ 250');
 });
 it('milhares',()=>{
  expect(f('o aluguel foi mil e duzentos')).toBe('o aluguel foi 1200');
  expect(f('recebi dois mil e quinhentos reais')).toBe('recebi R$ 2500');
  expect(f('recebi mil reais')).toBe('recebi R$ 1000');
 });
 it('gíria de dinheiro',()=>{expect(f('dei vinte contos')).toBe('dei R$ 20');});
 it('não mexe no que não é valor',()=>{
  expect(f('comprei uma água aqui no posto')).toBe('comprei uma água aqui no posto');
  expect(f('foram duas vezes')).toBe('foram duas vezes');
  expect(f('gastei 50 no mercado')).toBe('gastei 50 no mercado');
 });
 it('o valor falado passa a ser visto pela política',()=>{
  expect(amountsIn(f('gastei três e cinquenta no débito'))).toEqual([3.5]);
  expect(amountsIn(f('foram doze reais e cinquenta centavos'))).toEqual([12.5]);
 });
 it('o áudio do teste real vira texto com o valor em número',()=>{
  expect(transcriptToMessage('Pô, se lança pra mim. Eu acabei de comprar uma água aqui no posto, gastei três e cinquenta no débito.')).toContain('R$ 3,50');
 });
});
