# Pulse — interpretação semântica (fix/pulse-semantic-interpretation)

Base: `feat/pulse-conversation-manus` (`33d8ed1`). Sem merge na `main`, sem produção, sem Supabase, sem WhatsApp.

**Princípio aplicado:** o modelo interpreta e propõe; o código valida, autoriza e executa.

## 1. Diagnóstico da causa-raiz

Reproduzido no código da base, com o mesmo modelo roteirizado nas duas versões (seção 6).

| Problema | Causa no código anterior |
| --- | --- |
| A — regex como autoridade | `policy.ts` exigia que os argumentos do modelo fossem **idênticos** ao que `explicitTransaction` extraía por regex (`transactionAuthorizationFailure`). Qualquer frase fora do padrão era recusada: "com cartão", "não", "ou", dois valores, verbo que não abre a frase. Além disso, quando o modelo não chamava ferramenta, o próprio regex registrava (`deterministic_fallback`). |
| B — conversa classificada como consulta | `classifyIntent` (lista de palavras) decidia o fluxo antes do modelo e ia para o prompt ("Intenção classificada…"). "conta" casava "te **conta**r". |
| C — respostas descartadas | `renderAnswer` apagava **a resposta inteira** se houvesse qualquer dígito, "R$", "saldo"… e devolvia "Preciso de mais contexto…". |
| D — "Não." vira cancelamento | `isCancellation` era avaliado antes de tudo, **mesmo sem operação pendente**. Resposta a "Você está em segurança agora?" → "Operação cancelada". |
| Memória falsa | `topicOf` usava palavras soltas: "Vou almoçar com meu **chefe**" → "Planeja deixar o emprego". |

## 2. Arquitetura anterior e nova

**Antes:** mensagem → regex de memória → `classifyIntent` (regex) → atalhos por regex (preferências, simulação, edição, "sim/não") → modelo → argumentos comparados com regex → resposta do modelo descartada se tivesse número.

**Agora:**

1. **Pendência real primeiro.** Só se existir operação pendente válida (não expirada) "sim/pode/claro" confirmam e "não/cancela" cancelam. Sem pendência, ou com sinal de risco emocional, a mensagem segue para o modelo como conversa.
2. **Interpretação pelo modelo.** O modelo recebe ferramentas com contrato estrito (`toolSchemas` em `shared/v2/contracts.ts`). Escritas trazem a leitura do modelo (`natureza`: fato_ocorrido / hipótese / plano / desejo / dúvida) e `evidencia` (trecho literal da mensagem atual).
3. **Política determinística** (`shared/v2/policy.ts`) decide cada proposta: **executar**, **pedir confirmação** ou **recusar**.
4. **Execução** pelo core do laboratório (inalterado na essência; ganhou a aplicação atômica de `create`).
5. **Resposta**: números e recibos continuam escritos pelo código; o texto do modelo passa por grounding frase a frase (`shared/v2/grounding.ts`).

Não há chamada extra ao modelo: a interpretação é a própria escolha de ferramentas e argumentos.

## 3. Política de escrita

| Decisão | Quando |
| --- | --- |
| **Recusa** | `natureza` ≠ fato_ocorrido · valor que não aparece na mensagem atual (inclui "3 mil", "2k") · evidência que não está na mensagem · data futura ou com mais de um ano · turno com sinal de risco emocional · schema inválido ou ferramenta desconhecida |
| **Confirmação** | vários lançamentos (`registrar_varios`, ou várias chamadas de registro na mesma resposta, que são unidas) · mais de um valor na mensagem · linguagem hipotética, negação ou contradição ("se eu", "amanhã", "não gastei", "não registra", "brincadeira", "?") · valor acima de R$ 5.000 · data que não é hoje/ontem nem está escrita · tipo receita/despesa contrário aos verbos · descrição sem nenhuma palavra da mensagem · mensagem repetida · segunda escrita no turno · toda edição, exclusão e troca de meta |
| **Execução direta** | registro novo, fato, valor e evidência na mensagem, sem nenhum motivo de confirmação |

Listas de palavras só **rebaixam** "executar" para "confirmar"; nunca autorizam uma escrita. Categoria: lista fechada (`CATEGORIES`); fora dela, ou se o usuário disser que não sabe, fica sem categoria.

## 4. Arquivos

| Arquivo | Mudança |
| --- | --- |
| `shared/v2/agent.ts` | Fluxo novo: pendência só quando existe; sem `classifyIntent`, sem atalhos por regex, sem fallback que gravava sozinho; propostas passam pela política; resposta com grounding; rótulo de intenção derivado do que aconteceu |
| `shared/v2/policy.ts` | Reescrito: `decideCreate`, `decidePreferences`, `decideGoal`, `prepareChange`, `amountsIn`, `riskSignal`, mensagens |
| `shared/v2/grounding.ts` | Novo: substitui o sanitizador por verificação frase a frase |
| `shared/v2/contracts.ts` | `toolSchemas` (contrato do modelo) separado de `schemas` (contrato do core); `registrar_varios`, `propor_edicao_transacao`, `propor_exclusao_transacao`; `CATEGORIES`; pendência `create` |
| `shared/v2/finance.ts` | `confirm` aplica `create` de forma atômica (valida tudo antes de gravar) |
| `shared/v2/personality.ts` | Remove `classifyIntent`; amplia sim/não (só usados com pendência); descreve pendência de criação |
| `shared/v2/simulation.ts`, `shared/v2/simulation-nlu.ts` | O provider de simulação passa a propor ferramentas como o modelo; o regex de linguagem ficou só nele |
| `shared/v2/memory-engine.ts`, `memory-contracts.ts` | Captura de memória exige verbo de intenção + tema na mesma oração; ironia não vira plano; default de narrativa clonado |
| `server/v2/personality-prompt.ts` | Prompt reescrito; parte fixa primeiro e contexto no fim (cache) |
| `server/v2/openai.ts` | Expõe o novo contrato de ferramentas |
| `api/conversation.js` | Bundle regenerado (esbuild 0.28.2, mesmas opções do script) |
| `tests/semantic-interpretation.test.ts` | 53 testes novos (casos obrigatórios + adversariais) |
| `tests/*.test.ts`, `tests/e2e/lab.spec.ts` | Ajustes onde o contrato mudou de propósito (abaixo) |

Testes existentes alterados de propósito: "sim" sem pendência agora chega ao modelo (antes era engolido); categoria fora da lista é descartada em vez de bloquear o registro; o fallback que gravava sem chamada do modelo foi removido; os testes do classificador foram trocados por testes de comportamento; o e2e de IA real passou a roteirizar as propostas do modelo (edição incluída).

## 5. Evidências de teste

**Ambiente desta entrega:** o registro npm estava inacessível no sandbox, então `npm ci` não rodou. Os testes foram executados com um harness local que empacota cada arquivo com esbuild e implementa a API do Vitest usada pelo repositório. Ele foi validado na base antes de qualquer mudança: 201 de 202 testes passaram, e a falha era um efeito da versão de zod disponível offline (default compartilhado entre sessões), que esta branch também corrige.

| Verificação | Resultado |
| --- | --- |
| Testes unitários/integração (7 arquivos) | **254 aprovados, 0 falhas** (201 existentes + 53 novos) |
| `tests/server.test.ts` | Não executado: depende de `express`, indisponível offline. Área não alterada |
| TypeScript (`shared/`, `server/v2`, testes) | Sem erros |
| TypeScript da UI (`src/`) | Não verificado com tipos reais do React (indisponíveis offline) |
| Bundle `api/conversation.js` | Regenerado e testado ponta a ponta (handler → OpenAI mockado → política → core → token) |
| Playwright | Não executado (Vite/Chromium indisponíveis). Os fluxos dos specs alterados foram reproduzidos pelo mesmo caminho de código e chegaram aos saldos esperados |
| `npm run build` / `vite build` | Não executado |
| OpenAI real | **Não executado.** Todos os testes usam modelo roteirizado ou mock. Nada aqui prova que o modelo real lê bem as mensagens; prova que o código age corretamente sobre as propostas |

Rodar antes do merge: `npm ci && npm test && npm run build && npm run test:e2e`, e uma bateria com OpenAI real no Preview protegido.

## 6. Antes e depois (mesmo modelo roteirizado nas duas versões)

| Mensagem | Antes | Depois |
| --- | --- | --- |
| Gastei 50 no mercado com cartão | "Os argumentos da ferramenta não correspondem…", nada registrado | Registrado R$ 50, Alimentação |
| Gastei 40 de Uber e 20 de café (+ "sim") | Recusado; depois "Não há operação pendente" | Confirmação única; após "sim", 40 + 20 gravados juntos |
| Almocei hoje, deu 35 | Recusado | Registrado R$ 35 |
| Comprei um celular por 1.900 | Registrado | Registrado (sem regressão) |
| Gastei 30 no iFood, não sei a categoria | Recusado | Registrado sem categoria |
| Se eu gastar 500 amanhã, quanto sobra? | Simulação | Simulação (sem regressão) |
| Tô pensando em sair do emprego | Conversa | Conversa (sem regressão) |
| Preciso te contar uma coisa | Texto do modelo, mas rotulado como consulta | Texto do modelo, rotulado como conversa |
| Tenho três ideias de negócio | Resposta apagada: "Preciso de mais contexto…" | Resposta do modelo mantida |
| Quanto devo guardar por mês? | Resposta apagada | "Referência comum de 10% a 20% da renda…" mantida |
| Quero abrir uma confeitaria | Conversa | Conversa (sem regressão) |
| "Não." após "Você está em segurança agora?" | **"Operação cancelada."** | Resposta de acolhimento do modelo |
| Memória: "Vou almoçar com meu chefe amanhã" | Grava "Planeja deixar o emprego" | Nada gravado |

## 7. Limitações que permanecem

- **Qualidade real do modelo não medida.** Falta uma bateria com OpenAI real (e, se for o caso, Gemini) sobre mensagens reais.
- Valores por extenso ("cinquenta reais") não têm número na mensagem e são recusados com pedido do valor.
- A política é conservadora: mensagens com dois números (por exemplo, "paguei 230 da luz do dia 15") pedem confirmação.
- O Memory Engine continua com 7 temas fixos e frases-modelo; a proteção nova evita falsos positivos, mas deixa passar intenções fora desses temas ("abrir uma confeitaria").
- Estado, idempotência e pendências continuam no token do cliente (laboratório); a chave do token ainda deriva da `OPENAI_API_KEY`. Ambos estão fora do escopo desta missão e seguem na auditoria.
- O status "esclarecimento" agora indica só bloqueio ou confirmação da política; uma pergunta do modelo ("qual o valor?") aparece como resposta comum.

## 8. Tokens e latência

Medido nos payloads gerados pelo código:

| Item por chamada ao modelo | Antes | Depois |
| --- | --- | --- |
| Prompt de sistema | 4.771 caracteres | 4.968 caracteres |
| Definições de ferramentas | 5.475 caracteres (10 ferramentas) | 9.101 caracteres (13 ferramentas) |
| Prefixo do prompt idêntico entre mensagens | 1.025 caracteres | 4.735 caracteres |

Cerca de 3.800 caracteres a mais por chamada (estimativa: ~1.100 tokens de entrada), mas o prefixo estável passou a incluir quase todo o prompt, o que permite cache de prompt do provedor. Número de chamadas ao modelo por mensagem: igual (registro continua com 2; bloqueio ou confirmação encerram em 1). Uma redução possível depois: pular a segunda chamada após registro, já que o recibo é do código.

## 9. Riscos de regressão

- Um modelo real que não preencha `evidencia`/`natureza` terá as escritas recusadas por schema. Mitigação: descrições das ferramentas e prompt; validar no Preview.
- Mais confirmações do que antes em mensagens com vários números; ajustar `HIGH_VALUE_REAIS` e regras após observar uso real.
- A UI de simulação passou a depender do provider de simulação para atalhos (preferências, simulação de compra), não mais do orquestrador.
- Sessões antigas com pendência no formato anterior continuam válidas (schema compatível).

## 10. Preview

Não publicado nesta entrega: a sessão não tinha permissão de push no GitHub. Publicar só como Preview protegido; não promover.
