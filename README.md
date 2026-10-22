# Pulse AI Lab V2

Laboratório privado de agente financeiro conversacional. **Tudo é fictício:** não acessa Supabase, contas bancárias ou o Pulse Finance de produção.

## Começar

Node.js 24, `npm ci`, depois `npm run dev`. Interface em http://127.0.0.1:5173; API local em http://127.0.0.1:3001. A simulação funciona imediatamente, sem chave e sem tokens.

Experimente, na mesma sessão:

1. `Gastei 120 reais no supermercado hoje.`
2. `Gastei 80 reais no restaurante.`
3. `Gastei 50 reais com transporte.`
4. `Cara, onde estou gastando mais dinheiro? E o que você acha que eu deveria fazer?`
5. `Quanto gastei este mês?` → `E no mês passado?` → `Qual foi a diferença?`
6. `Se continuar nesse ritmo, quanto gastarei até o fim do mês?`
7. `Prefiro respostas curtas e mais direto.`
8. `Defina 1000 para férias.`

“Limpar conversa” mantém os lançamentos; “Nova sessão” reinicia dados e contexto. Mensagens repetidas não duplicam automaticamente uma escrita: o Pulse pede confirmação para um segundo lançamento igual.

Na Personality V1, registros definitivos sem data usam **hoje em America/Sao_Paulo**, data padrão exibida na interface. Datas explícitas e “ontem” continuam suportados. Hipóteses nunca autorizam registros.

## Dois modos, duas sessões

- **Simulação:** provider determinístico, core local e sessionStorage por aba. Sem consumo. Linguagem fora dos padrões pode exigir esclarecimento.
- **IA real:** OpenAI com function/tool calling oficial; orquestração, validação e core no backend. Frontend envia apenas mensagem, requestId e token opaco. Variáveis `OPENAI_API_KEY`, `OPENAI_MODEL` e `ENABLE_REAL_AI=true` apenas no servidor.

As sessões dos modos são separadas para impedir que um saldo local alterado pelo navegador seja tratado como verificado pelo servidor. O modo real não importa automaticamente dados da simulação local. Não cole chaves no chat nem use variáveis `VITE_` para segredos.

## Ferramentas

| Ferramenta | Função |
|---|---|
| consultar_saldo | Saldo consolidado fictício |
| registrar_transacao | Proposta de UM lançamento ocorrido (com `natureza` e `evidencia`); a política decide executar, confirmar ou recusar |
| registrar_varios | Proposta de 2 a 5 lançamentos da mesma mensagem; sempre confirmados e aplicados juntos |
| propor_edicao_transacao / propor_exclusao_transacao | Proposta de correção/exclusão; nunca executa direto, gera confirmação com antes/depois |
| listar_transacoes | Lista com período e filtro opcional |
| resumir_financas | Receitas, despesas, resultado, categorias e percentuais |
| comparar_periodos | A, B, diferença e variação percentual (null se B é zero) |
| consultar_gastos_categoria | Total, quantidade e registros de uma categoria |
| projetar_despesas | Projeção determinística, com premissas e aviso de amostra |
| atualizar_preferencias | Estilo, extensão, proatividade, explicações e exemplos explícitos |
| definir_objetivo | Nova meta fictícia explícita; substituir existente exige confirmação |
| simular_compra | Impacto hipotético em centavos, sem registrar despesa |

Centavos inteiros nos cálculos; entradas em reais com até duas casas. O modelo escolhe a categoria numa lista fechada (`CATEGORIES` em `shared/v2/contracts.ts`); fora dela, ou quando o usuário diz que não sabe, o registro fica sem categoria. Se o modelo omitir, o código aplica o mapeamento fixo (mercado/restaurante → Alimentação, gasolina/uber → Transporte, bar/cinema → Lazer). Alterar categoria de registro existente exige confirmação, assim como valor, descrição, data, exclusão e substituição de meta.

O Inspector exibe chamadas em ordem, argumentos validados, resultados, duração, falhas, resposta final e tokens/modelo quando disponíveis. Não exibe credenciais, prompts privados ou raciocínio interno.

## Verificar

- `npm test`: V1, V2, autorização, contexto, cálculos, erros e backend com mocks OpenAI.
- `npm run build`: TypeScript, bundle autocontido da nova função Vercel e build Vite.
- `npx playwright install chromium` e `npm run test:e2e`: desktop/mobile.
- Em ambientes com Chromium empacotado: `LAB_BUNDLED_CHROMIUM=true LAB_CHROMIUM_PATH=/caminho/chromium npm run test:e2e`.
- `npm run preview`: frontend de produção local; para API, usar `npm run dev` ou Vercel.

`api/conversation.js` é **gerado** de `server/v2/handler.ts` por `npm run build:api` e versionado para garantir descoberta da rota e evitar a regressão de imports ESM na Vercel. Edite os módulos fonte, regenere e versione o bundle. A função não depende de Vite no runtime.

## Limites e confiança

No modo real, contexto e estado fictício são criptografados/autenticados com AES-GCM em token de sessão com validade de seis horas, usando chave derivada no servidor com separação de domínio. O segredo do provedor não sai do servidor. Alterar a chave invalida sessões anteriores. Identidade de sessão é gerada pelo servidor, não pelo modelo.

O servidor não aceita histórico, estado, resultados de ferramentas ou IDs de usuário/workspace enviados sem assinatura. O histórico assinado fornece referências; **somente a mensagem atual** pode respaldar uma escrita. O modelo interpreta e propõe; a política em `shared/v2/policy.ts` decide se a proposta é executada, vira pedido de confirmação ou é recusada (valor que não está na mensagem, data futura, hipótese). Veja `docs/PULSE_SEMANTIC_INTERPRETATION_REPORT.md`.

Limites por interação: quatro chamadas de modelo, oito ferramentas, 35 segundos, contexto textual de até 42 mil caracteres e limite de consumo medido de 14 mil tokens. Saída limitada a 700 tokens por chamada. Sem retries automáticos. Guarda de seis requisições/minuto por instância, que não é uma quota global.

Máximo de 300 transações fictícias; dez mensagens de contexto; quatro requestIds recentes para replay. Não é uma infraestrutura de produção: tokens podem ser copiados/retrocedidos pelo proprietário; chamadas paralelas e snapshots antigos não têm coordenação global. Nenhum dado real ou efeito financeiro externo deve ser conectado a esse mecanismo. Não há memória permanente, bancos novos ou filas.

Os números e a confirmação financeira são renderizados a partir de resultados determinísticos. O texto do modelo é verificado frase a frase (`shared/v2/grounding.ts`): afirmações de registro sem escrita, fatos financeiros pessoais sem consulta e valores em reais sem fonte são removidos; percentuais gerais, exemplos e números ditos pelo usuário são mantidos. Registros e consultas simples não recebem conselhos. Opiniões qualitativas não são consultoria financeira nem um diagnóstico psicológico.

## Publicação

Manter Vercel Authentication ativa para **todos** os deployments. Projeto existente `pulse-ai-lab`; publicar apenas Preview para esta missão. Não fazer merge automático na main. Em desenvolvimento, Express só escuta 127.0.0.1; não exponha o servidor local publicamente.

Confira `docs/PULSE_AI_V2_REPORT.md` para arquitetura, testes e limitações da homologação com modelo real. A API V1 `/api/agent` foi preservada por compatibilidade; a interface V2 usa `/api/conversation`.

## Pulse Personality V1

A evolução na branch `feat/pulse-personality-v1` aplica discrição por padrão, preferências explícitas e confirmação em código antes de editar/excluir transações ou substituir metas. Novos registros sem data usam a data de hoje (São Paulo), exibida na interface. Consulte [PULSE_PERSONALITY_BIBLE_V1.md](./PULSE_PERSONALITY_BIBLE_V1.md) para regras, exemplos, testes e limites de replay dos snapshots.


## Personality V2 + Memory Engine

Na branch `feat/pulse-personality-v2`, o Pulse conversa sobre trabalho, ideias e mudanças de vida sem exigir histórico financeiro. Memória automática fica desativada até habilitar no Memory Inspector; objetivos/intencões dos temas suportados podem ser guardados sem chamadas extras de modelo. Recarregar e limpar conversa preservam memórias na sessão; corrigir/excluir/limpar memórias também limpa contexto anterior e invalida pendências, mantendo transações.

Experimente: habilitar memória → “Estou pensando em largar meu emprego” → “Vou vender pipoca” → limpar conversa → “Lembra daquela ideia de vender pipoca?” → “Desisti de vender pipoca” → “Esquece aquela ideia de vender pipoca”.

Desejo de poupar é narrativa; para criar meta estruturada, use “Crie uma meta de 2000 para casamento” ou “Defina 1000 para férias”. Regras de registro/correção/confirmar e proatividade financeira discreta foram preservadas. Nenhuma integração WhatsApp ou produção foi conectada.

Consulte [Personality Bible V2](./PULSE_PERSONALITY_BIBLE_V2.md) e [Memory Engine V1](./PULSE_MEMORY_ENGINE_V1.md) para arquitetura, extração seletiva, controles, persistência e limitações. No modo real, a memória existe no token de sessão de até seis horas, sem armazenamento central; excluir não revoga cópias antigas. Isso é memória de demonstração por sessão, não memória permanente por usuário em produção.
