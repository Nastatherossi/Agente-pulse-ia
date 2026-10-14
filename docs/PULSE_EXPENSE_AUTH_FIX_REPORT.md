# Correção de interpretação e autorização de despesas

Branch `feat/pulse-personality-v1`, PR #6. Base inspecionada: `bc6509d74ff92e42b74a876acd2eca97eba4d593`. Sem reconstrução, merge na main ou acesso a produção.

## Causa e evidências

1. **Divergência de categoria reproduzida com os argumentos fornecidos pelo usuário.** O parser determinístico já extraía corretamente `1900`, `celular` e a data padrão. Porém `knownCategory('celular')` é undefined. O schema aceitava `category: 'outras'`, enquanto a política exigia categoria conhecida ou ausência: a chamada estruturalmente válida terminava em `WRITE_NOT_AUTHORIZED`. A resposta genérica dizia incorretamente que faltava uma instrução definitiva. O prompt “outras sem categoria” era ambíguo sobre como serializar ausência.
2. **Verbo ausente.** `comprei` não era reconhecido no classificador, extrator ou simulador. “Comprei um celular por R$ 1.900” não poderia passar pela autorização determinística anterior.
3. **Modelo sem chamada.** Quando o modelo devolvia apenas uma pergunta, mesmo com todos os campos na mensagem, não havia recuperação determinística para registrar o fato inequívoco. O renderizador retornava um pedido genérico de valor/descrição.
4. **Mensagem repetida.** O aviso de segundo lançamento igual era armazenado como draft e podia ser substituído pelo mesmo pedido genérico de campos. Corrigido para preservar a pergunta específica de confirmação.
5. **VALIDATION_FAILED histórico:** consulta dos runtime logs recentes da Vercel confirmou ocorrência de `VALIDATION_FAILED` e `WRITE_NOT_AUTHORIZED`. Os logs antigos guardavam somente requestId/código, sem campo rejeitado. Não é possível atribuir com certeza o primeiro erro histórico a um campo sem seu payload. Não se declara que foi ponto de milhar, data ou categoria null. Foram acrescentadas regressões e diagnósticos seguros para esses formatos, mantendo a validação estrita.

`1.900` já era interpretado como 1900 no código desta branch; não era a causa do bloqueio dos argumentos numéricos válidos relatados. Strings numéricas em tool calls continuam inválidas: o modelo deve enviar número JSON, conforme schema e prompt. Nenhum erro de autenticação, créditos ou modelo foi inferido dos erros de política/schema.

## Correção aplicada

- Reconhece fatos passados `gastei`, `paguei`, `comprei`; normaliza artigos iniciais da descrição (`um celular` → `celular`). Mantém rejeição de hipóteses, perguntas, futuro, valores negativos, ambiguidades, crédito e operações não suportadas.
- Normaliza **somente categoria neutra**, antes do schema: ausência, null, outras, outros e sem categoria não representam classificação. O código mantém a categoria conhecida pela regra ou omite category. Categoria específica inventada continua bloqueada. Nenhuma normalização altera valor, tipo, data ou descrição enviados pelo modelo.
- Autoriza pelo confronto da mensagem atual com argumentos validados. Erros recebem motivos distintos (`NO_DEFINITIVE_TRANSACTION`, `TYPE_MISMATCH`, `AMOUNT_MISMATCH`, `DATE_MISMATCH`, `DESCRIPTION_MISMATCH`, `CATEGORY_MISMATCH`), sem atribuir toda divergência à ausência de instrução.
- Zod continua exigindo valores numéricos positivos com até duas casas, datas ISO reais, descrição válida e ausência de campos extras. Não há coerção genérica de valores ou dates.
- Prompt de servidor explicita números JSON (`R$ 1.900` → `1900`, `R$ 1.900,50` → `1900.50`), data padrão de São Paulo e omissão de category para descrições não classificadas. Mantém discrição e a hierarquia Personality V1.
- Se o provider responde sem ferramentas, um fallback só pode ocorrer em intenção de execução, sem execução anterior nesta interação, e quando o extrator determinístico da mensagem atual encontra uma transação inteira válida. Usa o mesmo schema/gate/core/idempotência. Hipóteses e mensagens incompletas não recebem fallback de escrita; falhas de provider/schema/autorização não são ocultadas com esse fallback.
- Inspector identifica `deterministic_fallback`: não se afirma que a OpenAI interpretou algo quando o registro foi recuperado pela política.
- Logs de falha incluem somente requestId, códigos, motivos constantes e campo/código de Zod. Não incluem mensagem financeira, argumentos, valores, descrições, credenciais ou mensagens brutas de Zod. Campos fora do allowlist aparecem como `arguments`.

## Testes

A suíte nova `tests/expense-authorization.test.ts` cobre os quatro fatos realizados, os três exemplos de hipótese/intenção futura, pergunta, amanhã, milhares, centavos, data padrão, aliases neutros, categoria inventada, divergências de valor/tipo/data/descrição, tipos inválidos, valores negativos, datas impossíveis, campos extras, fallback transparente, falha de execução, mensagem repetida, criação/correção/confirmar/replay e edição direta bloqueada. Integração do handler usa OpenAI mock com os argumentos exatos informados, e verifica ausência de dados sensíveis nos logs.

O fluxo Playwright novo usa provider real mockado, category outras, core/sessão/Inspector, correção com confirmação, repetição, intenção futura sem escrita e fallback visível. Roda em desktop e mobile. Todos os fluxos anteriores V1/V2/Personality permanecem na suíte.

Resultado final: **155/155 testes unitários/backend e 10/10 testes Playwright desktop/mobile passaram**. TypeScript, build:api e build Vite passaram. `git diff --check` passou. A primeira execução E2E não iniciou Chromium porque o executável temporário de uma sessão anterior havia sido removido; o binário foi reextraído da dependência existente e a rodada completa passou. Preview é registrado após publicação. Testes automatizados usam mocks ou simulação; nenhuma chamada paga em massa ou chave real foi utilizada.

## Arquivos

- `shared/v2/policy.ts`: normalização e motivos da autorização.
- `shared/v2/personality.ts`, `shared/v2/simulation.ts`: verbo comprei e consistência do modo simulado.
- `shared/v2/agent.ts`: normalização antes de validar, diagnóstico seguro, fallback e aviso de duplicata.
- `shared/v2/contracts.ts`: metadados de diagnóstico/origem, sem afrouxar schemas financeiros.
- `server/v2/personality-prompt.ts`: contrato operacional explícito.
- `server/v2/handler.ts`: logs sanitizados de campo/código.
- `src/InspectorV2.tsx`: identificação do fallback.
- `api/conversation.js`: bundle regenerado.
- `tests/expense-authorization.test.ts`, `tests/e2e/lab.spec.ts`: regressões.
- `PULSE_PERSONALITY_BIBLE_V1.md`, este relatório: evidências e limites.

## Proteção e limites

Edição/exclusão e substituição de meta continuam passando exclusivamente pela pendência e confirmação existentes. O modelo não recebe ferramenta de edição. Proatividade não altera permissões. Limites de snapshots e idempotência global documentados na Bible continuam válidos: não há armazenamento central nem garantia contra restaurar tokens antigos. Nenhum Supabase, pulse-finance ou dado financeiro real foi acessado.

O projeto Vercel existente foi consultado e continua com Vercel Authentication para todos os deployments. A homologação com OpenAI ao vivo desta correção permanece pendente enquanto não houver sessão autenticada disponível no Preview. Os testes do provider real com fetch mock não equivalem a homologação paga ao vivo; não será removida proteção nem criado bypass para testar.
