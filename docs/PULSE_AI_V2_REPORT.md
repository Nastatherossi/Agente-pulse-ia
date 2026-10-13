# Pulse AI V2 — implementação e validação

Data: 13/10/2026. Branch: `feat/pulse-ai-v2`, criada da versão funcional `origin/feat/real-ai-private-lab` no commit `0e26a0fad4426310134715611467243e609f1f91`. A main foi inspecionada e não continha a correção mais recente. PRs existentes foram consultados; nenhum foi mesclado nesta missão.

## Arquitetura implementada — Modelo A

Simulação: chat → provider determinístico contextual → loop de ferramentas → política de escrita → FinancialCoreV2 local.

IA real: chat → POST /api/conversation (protegido pela Vercel) → sessão criptografada/autenticada → OpenAI function calling → schemas + política baseada no pedido atual → FinancialCoreV2 no servidor → tool result para OpenAI → resposta + Inspector + sessão atualizada assinada.

Preservada a interface React/Vite e o endpoint V1. Não foi instalado framework de agentes, alterado provedor para Gateway, criado banco, fila, serviço, Worker ou acesso Supabase. O cliente nunca fornece números como dados financeiros verificados pelo servidor.

## Entregue

- Contexto por sessão: assunto e dois períodos anteriores, data de registro explícita, histórico limitado.
- Conversa, registro/consulta, múltiplas consultas, análise, comparação, categorias e projeção.
- Nove ferramentas allowlisted, schemas estritos e cálculos em centavos.
- Preferências explícitas de estilo/detalhe e objetivo financeiro fictício. Sem inferência psicológica ou memória permanente.
- Escrita vinculada a valor, tipo, descrição e data da mensagem atual; hipótese não autoriza. Repetição acidental exige confirmação para um segundo registro.
- Dados sem categoria continuam sem categoria. Regras transparentes apenas para novas transações.
- Inspector com todas as ferramentas, ordem, argumentos validados, resultados, falhas, duração, resposta final e modelo/tokens disponíveis.
- Limpar conversa separadamente de reiniciar dados; sessões distintas entre modos.
- Backend autocontido gerado por esbuild para preservar correção ESM, sem carregar Vite em função serverless.

## Cálculos e fatos

Somatórios, classificação por regra, agrupamentos, percentuais, diferenças e projeções são calculados pelo core. Diferença de comparação = A − B; magnitude absoluta também retornada. Percentual = (A − B) / |B|; null se B = zero. Projeção = despesa registrada até asOf / dias corridos inclusivos × dias totais do período, arredondada a centavos; limitada a intervalos de até dez anos e marcada como estimativa. Dias sem registros entram na média. Poucos registros geram aviso.

Texto numérico do modelo não é copiado para a resposta financeira. O renderer constrói fatos a partir das ferramentas e gera recomendações básicas a partir do maior grupo calculado; sem afirmar que o usuário gasta demais ou inventar renda. Comentário qualitativo do modelo continua sujeito às limitações de um LLM.

## Testes e resultados reais

- `npm test`: **84 testes passaram**, incluindo os existentes e o novo arquivo V2.
- `npm run build`: **TypeScript e build Vite aprovados**, com geração do endpoint autocontido.
- Importação direta Node do bundle: handler carregou e GET retornou 405, sem erro de imports.
- Playwright: **6 testes passaram**, três histórias em desktop 1440×1000 e mobile 390×844.
- Cenas UI: cenário principal, contexto mensal, preferências, limpeza, persistência, falha, reinício e troca de modo com isolamento.
- Backend com OpenAI mock: function calls oficiais → execução no servidor → token assinado → retry sem novo consumo/escrita → consulta com contexto e contagem de tokens.
- Cobertos: receita/despesa/saldo, períodos, filtros, agrupamento, sem categoria retroativa, percentuais, projeção, ambiguidade, duplicação, confirmação, falhas, limites de etapas/ferramentas/tokens/tempo, ferramenta desconhecida, escrita hipotética, valores divergentes, token adulterado/expirado e rejeição de estado/histórico do cliente.
- Screenshots desktop/mobile foram inspecionados. Ajustada a altura do painel e a rolagem interna para manter chat e entrada utilizáveis em interações com várias ferramentas.
- `npm audit --omit=dev`: zero vulnerabilidades de produção reportadas.

O Chromium temporário da rodada anterior não existia nesta sessão. Foi extraído novamente do pacote instalado. A flag single-process do navegador empacotado causava falha ao criar contextos subsequentes; a configuração de testes removeu essa flag e duas flags que desativavam segurança. Depois disso, todos os seis testes passaram.

## OpenAI real versus mocks

**Nenhuma chamada V2 à OpenAI real foi realizada nesta rodada.** Todos os testes automatizados usam mocks ou provider de simulação, sem tokens pagos. O usuário informou funcionamento da integração anterior; isso não substitui homologação desta nova V2.

No turno anterior, o navegador dedicado não conseguiu autenticar no fluxo Google (502/Connection refused), e ações que poderiam gerar bypass foram rejeitadas. Essas ações não foram repetidas. A proteção existente não foi removida. A validação remota ao vivo deve ocorrer numa sessão Vercel autorizada; caso não esteja disponível, a entrega não declara a IA V2 real homologada.

## Limites de confiança

- Sessão real em token AES-GCM de seis horas, chave derivada no servidor com domínio próprio. Sem recuperação ou impressão da chave.
- Somente o token autenticado pode fornecer estado/histórico ao backend. Campo extra de estado/resultado/identidade é rejeitado.
- Histórico não autoriza escrita; current message + policy conferem os argumentos.
- Replay/idempotência limitados à cadeia de snapshots e aos últimos quatro pedidos. Snapshot antigo, cópia de token, chamadas concorrentes e rate limiting distribuído NÃO constituem garantias globais de produção.
- Dados fictícios por aba, até 300 transações; dez mensagens de contexto, contexto textual limitado, quatro etapas de modelo, oito ferramentas, 35s e 14 mil tokens medidos por interação. A contagem só está disponível após resposta do provedor; não é um teto de faturamento da conta OpenAI.
- Endpoint protegido pela autenticação de deployment; não é sistema multiusuário bancário. Não conectar operações reais ao simulador.
- Parser de autorização é conservador: linguagem fora dos padrões seguros exige esclarecer. Datas omitidas só herdam hoje de registro explícito anterior, exibindo a data na confirmação. Outras referências temporais não são assumidas.
- Preferências e objetivos são fictícios e por sessão. Projeção usa registros, não calendário de futuras contas/cartões.

## Arquivos principais

- `shared/v2/contracts.ts`, `finance.ts`, `policy.ts`, `agent.ts`, `simulation.ts`
- `server/v2/openai.ts`, `session.ts`, `handler.ts`
- `api/conversation.js` (gerado), `scripts/build-conversation.mjs`
- `src/main.tsx`, `src/InspectorV2.tsx`, `src/style.css`
- `server/app.ts`, `package.json`, `package-lock.json`, `vercel.json`
- `tests/v2.test.ts`, `tests/e2e/lab.spec.ts`, `playwright.config.ts`
- `README.md`, este relatório

## Publicação e próximos passos

Preview e PR serão preenchidos após build remoto. Não publicar em main automaticamente.

Próximo passo: validar na sessão autorizada o cenário principal, as referências mensais e projeção com o modelo configurado; medir custo/latência com poucos exemplos e ajustar limites se necessário. Depois, criar staging separado para adaptador Worker/Core com autorização e idempotência duráveis antes de considerar qualquer dado real.
