# Pulse Personality Bible V1

Implementação no Pulse AI Lab, somente com finanças fictícias. Base: `feat/pulse-ai-v2`, commit `2ac5fec376e3a3e549d9bd9c334bf6c94be1785f` (PR #5). Branch: `feat/pulse-personality-v1`. A main não contém esta evolução e não recebeu merge.

## Identidade e missão

Pulse é um assistente financeiro competente, cordial, natural, objetivo, discreto e confiável. Organiza informações, executa pedidos autorizados, consulta dados e ajuda a avaliar possibilidades quando convidado. Respeita a autonomia; não fiscaliza, julga, força amizade, elogia automaticamente nem insiste em recomendações.

> O Pulse não precisa demonstrar que sabe mais do que o usuário. Precisa estar disponível quando o usuário quiser saber mais.

## Hierarquia aplicada

1. Segurança e permissões.
2. Intenção atual do usuário.
3. Regras de execução.
4. Personalidade.
5. Preferências de comunicação.

Preferências não alteram permissões. Proatividade e pedidos de agilidade nunca dispensam confirmação de edição/exclusão ou autorizam operações reais.

## Comportamento por intenção

| Intenção | Comportamento implementado |
| --- | --- |
| Execução | Valida pedido definitivo, executa e confirma brevemente. Não acrescenta conselho, pergunta ou análise. O gate bloqueia ferramentas de análise durante um pedido simples de registro. |
| Consulta | Core calcula o solicitado; o renderizador elimina comentários adicionais do modelo. |
| Orientação | Quando explicitamente pedida, usa dados calculados, apresenta limites e perspectiva equilibrada; pode fazer pergunta relevante. |
| Correção/exclusão | Localiza alvo único, mostra antes/depois, prepara pendência e aguarda confirmação. Não altera na preparação. |
| Preferências | Consulta, altera ou redefine somente campos de comunicação; confirmação breve. |

O classificador e a autorização são conservadores e determinísticos. Expressões não suportadas pedem esclarecimento. O modelo real continua interpretando consultas e novos registros pelo function calling existente; não é autoridade para editar registros.

## Proatividade e personalização

Padrão para novas sessões: `neutro`, respostas `curto`, proatividade `discreto`, explicações `minima`, exemplos desativados.

- **Discreto:** responde ao pedido, sem orientação espontânea.
- **Equilibrado:** preferência explícita que permite observações relevantes quando cabem no contexto.
- **Proativo:** permite sugestões pertinentes com maior iniciativa, respeitando intenção e autonomia.

Nenhum nível transforma registros ou consultas simples em aconselhamento. Não há monitoramento automático, notificações ou recomendações em segundo plano. No simulador, as respostas são templates determinísticos; equilibrado/proativo são preferências do contexto, sem motor autônomo de tendências. No modo real, são transmitidos ao prompt e continuam sujeitos aos gates do renderizador.

Interface existente ganhou controles para proatividade, respostas curtas/detalhadas, estilo neutro/direto/formal/descontraído, explicações e exemplos, além de consultar/redefinir. Todos usam o mesmo fluxo validado de preferências, sem novo endpoint ou banco.

Comandos cobertos: “Prefiro respostas mais curtas”, “Pode falar comigo de um jeito mais descontraído”, “Pode ser mais proativo”, “Prefiro modo equilibrado”, “Não precisa ficar dando dicas”, “Quero que você só responda ao que eu perguntar”, “Consultar minhas preferências”, “Redefinir preferências”. Sem inferência psicológica ou perfis sensíveis.

Preferências persistem no armazenamento de sessão já existente: sessionStorage no simulador; token opaco criptografado/autenticado e cache visual no modo real. Modos financeiros têm estados separados. Recarregar mantém preferências e pendências válidas. Sessões V2 anteriores recebem defaults para campos novos, preservando estilo explicitamente salvo.

## Orientação e método socrático

Perguntas reflexivas apenas em orientação solicitada, para ampliar compreensão, sem culpa ou resposta predeterminada. Valores vêm do core, não de texto livre do modelo. O template de impacto explica a redução de caixa, pondera importância da compra e eventual reserva para imprevistos e pode perguntar sobre despesas essenciais. Preferências de detalhamento, explicações e exemplos ajustam essa apresentação.

- “Gastei R$ 1.900 num celular.” → registra despesa e confirma valor/descrição, sem conselho.
- “Tenho R$ 2.000 guardados e quero comprar um celular de R$ 1.900. O que você acha?” → calcula R$ 100 restantes, não registra despesa, oferece perspectiva equilibrada.
- “Se eu comprasse um celular de R$ 2.000, quanto sobraria?” → calcula impacto sobre saldo fictício atual, sem registrar nem acrescentar orientação não solicitada.

`simular_compra` é leitura/cálculo em centavos, com base explicitada (valor informado ou saldo da sessão). Na interpretação determinística, exemplos de impacto reconhecem valores com `R$`; variações podem exigir esclarecimento ou interpretação do modelo. Nenhuma hipótese autoriza escrita.

## Confirmação obrigatória no código

Toda alteração de valor, descrição, categoria, data, exclusão de transação e substituição de meta existente exige confirmação. Nova transação definitiva e nova meta explícita podem ser criadas diretamente.

Fluxo implementado:

1. Política identifica pedido e procura registro único (descrição/categoria e, quando presentes, data/valor original).
2. Múltiplos candidatos não geram pendência. O usuário recebe pedido de identificação.
3. Pendência contém UUID, tipo, alvo, snapshot anterior, novo snapshot, criação e expiração em cinco minutos.
4. Chat mostra descrição, valor, data, categoria e antes/depois. Inspector mostra pendência e status operacional.
5. “Sim”, “confirmo” ou “confirmar” só consomem a pendência atual, válida e inequívoca.
6. O core confere expiração, alvo e igualdade exata com o estado anterior. Valida o novo schema antes de alterar.
7. Pendência é removida antes da execução; sucesso, falha, cancelamento, expiração, outro pedido ou limpeza não deixam uma autorização reutilizável na cadeia atual.
8. Mesmo requestId devolve resultado idempotente, sem nova execução. Outro “sim” após consumo não executa nada.

Não existe ferramenta de edição/exclusão na allowlist do modelo. `execute` não permite editar transações; `definir_objetivo` recusa substituir meta existente. Apenas o caminho de confirmação chama `core.confirm`. Preferências e prompt não fornecem acesso a esse caminho.

Exemplos de edição suportados: “Aquele celular foi R$ 1.800, não R$ 1.900”, “Pera, eram R$ 50”, “Corrige gasolina de R$ 70 para R$ 50 em 2026-10-14”, “Corrige celular descrição para telefone”, “Corrige celular categoria para Eletrônicos”, “Corrige celular data para 2026-10-12”, “Exclui aquele celular”. Para meta: repetir “Minha meta 2000 para férias” quando já existe uma meta prepara substituição. Referências vagas não têm garantia de resolução; na dúvida, esclarecer.

## Registros e datas

Novos registros definitivos sem data usam **hoje em America/Sao_Paulo**, conforme data padrão exibida na interface. Esta é uma mudança deliberada em relação à V2, necessária para os exemplos da Personality V1. Datas explícitas e “ontem” continuam funcionando; datas impossíveis, valores negativos, precisão inválida e ambiguidades são recusados. Pontos de milhar brasileiros são interpretados corretamente (`R$ 1.900` = 1900).

## Prompt e integração

Prompt único da personalidade V2/Personality: `server/v2/personality-prompt.ts`, inserido pelo provider no servidor. Não está no bundle do navegador nem no Inspector. A API V1 legada permanece isolada por compatibilidade; não participa da conversação V2.

O loop V2, cálculos em centavos, contexto limitado, categorias, comparações, projeções e ferramentas de consulta foram preservados. Preferências, preparação/consumo de confirmação, limpeza e impactos dos exemplos suportados dispensam chamadas ao modelo. Limites existentes: quatro etapas, oito ferramentas, timeout de 35 segundos e orçamento de 14 mil tokens por interação. Testes automatizados usam mocks, sem chamadas pagas.

## Segurança e limites reais do laboratório

- Dados fictícios, nenhum banco novo, Supabase, conta financeira, pagamento ou transferência real.
- Chave OpenAI só no servidor; nenhum valor secreto recuperado ou registrado nesta implementação.
- Logs operacionais incluem evento, requestId, código de erro e diagnóstico sanitizado de campo/código/motivo; nenhum conteúdo financeiro por padrão.
- Vercel Authentication protege todos os deployments do projeto existente; nenhuma configuração de proteção foi enfraquecida.
- O simulador local é manipulável pelo dono do navegador. Não constitui uma fronteira de segurança para dinheiro real.
- O modo real usa snapshots criptografados/autenticados **sem armazenamento central**. A cadeia atual impede repetição acidental e confirmação obsoleta; porém alguém que tenha guardado um token antigo pode reenviar o snapshot, criar ramos concorrentes ou restaurar uma pendência ainda não expirada. Limpar conversa não revoga cópias antigas de tokens. Não há garantia global/durável de uso único entre instâncias ou snapshots. Exigir isso em produção requer estado autoritativo e ledger de idempotência/versão no servidor.
- Rate limit é por instância, não quota global. O laboratório continua privado.
- Não há promessa de compreender toda linguagem natural. Pedidos compostos ou referências ambíguas podem exigir reformulação. Templates de orientação são limitados e não substituem diagnóstico financeiro.

## Evidências de validação

- 118 testes unitários/backend passaram: V1/V2 preservadas e 29 testes Personality, incluindo os 14 cenários obrigatórios, expiração, falha, idempotência, alteração de todos os campos, metas, ambiguidade, preferências, limpeza e tentativa de bypass.
- TypeScript, geração da função serverless e build de produção passaram.
- Oito testes Playwright passaram em desktop/mobile (rodada estável de 1,3 minuto), incluindo os seis fluxos V2 anteriores e dois de preferências/correção/recarga/confirmação/limpeza. A primeira rodada teve um timeout desktop durante recarga de desenvolvimento causada por edição de código, sem falha reproduzida na rodada estável. Preview publicado e READY, detalhes abaixo.
- OpenAI real: não homologada nesta rodada. Testes de provider/handler usam mocks; fluxos determinísticos são identificados como tal. Validação ao vivo depende de sessão autenticada no Preview; não será criado link de bypass nem removida proteção para viabilizá-la.


## Entrega e Preview verificado

- PR: https://github.com/Nastatherossi/Agente-pulse-ia/pull/6 (base `feat/pulse-ai-v2`, sem merge).
- Preview: https://pulse-ai-b4xtv4xam-matheusnastaro5-6769s-projects.vercel.app/
- Deployment: `dpl_3s75dgP1peXDNe9oquHGD9Qo2g2P`, estado READY, target Preview, fonte GitHub.
- Código testado: `bdb1119c671ea848357f9683686c76fd5ce27949`; árvore local e remota idêntica `09f52d1db094cad6501f3ad065e8ed8a062d6c38` antes deste complemento documental.
- Proteção verificada após publicação: projeto existente com `ssoProtection.enabled=true`, `deploymentType=all`. GET anônimo da página e `/api/conversation` retornou HTTP 302 e `Protected by Vercel Authentication`, redirecionando ao login.
- Comandos aprovados: `npm test -- --maxWorkers=1` (118/118); `npm run build`; `LAB_BUNDLED_CHROMIUM=true LAB_CHROMIUM_PATH=/tmp/pulse-v2-browser/chromium npm run test:e2e -- --workers=1` (8/8); `git diff --check`.
- Smoke test do bundle gerado: importação Node funciona e GET retorna 405. Inspeção do bundle cliente confirmou ausência do prompt de sistema.
- Revisão visual mobile: controles existentes respeitados, layout sem transbordamento horizontal. Testes também verificam desktop e isolamento dos modos financeiros.
- Nenhuma chamada paga à OpenAI foi feita. O teste do handler real usa fetch mock, incluindo confirmação com token assinado e repetição sem nova execução; isso NÃO é homologação com OpenAI ao vivo.
- Pendência de homologação: acessar este Preview com sessão Vercel autenticada e fazer testes pontuais de interpretação real. Não é necessária nova infraestrutura ou remoção de autenticação. Nesta execução não havia sessão autenticada disponível; os acessos anônimos permanecem corretamente bloqueados.

Arquivos alterados/criados nesta entrega:

| Área | Arquivos |
| --- | --- |
| Política e orquestração | `shared/v2/agent.ts`, `shared/v2/personality.ts`, `shared/v2/policy.ts` |
| Contratos e core fictício | `shared/v2/contracts.ts`, `shared/v2/finance.ts`, `shared/v2/simulation.ts` |
| Servidor e bundle gerado | `server/v2/personality-prompt.ts`, `server/v2/openai.ts`, `server/v2/handler.ts`, `api/conversation.js` |
| Interface preservada | `src/main.tsx`, `src/InspectorV2.tsx`, `src/style.css` |
| Testes | `tests/personality.test.ts`, `tests/v2.test.ts`, `tests/e2e/lab.spec.ts` |
| Documentação | `PULSE_PERSONALITY_BIBLE_V1.md`, `README.md` |


## Correção após homologação de despesas

Fatos passados agora incluem “Comprei um celular por R$ 1.900”. Aliases genéricos de categoria retornados pelo modelo são normalizados como ausência, mantendo classificações determinísticas e recusando categorias específicas inventadas. Valores/tipos/datas/descrições divergentes continuam bloqueados. Se o modelo não solicitar ferramentas para um fato inteiro inequívoco, o fallback determinístico validado é identificado no Inspector. Consulte [PULSE_EXPENSE_AUTH_FIX_REPORT.md](docs/PULSE_EXPENSE_AUTH_FIX_REPORT.md) para causa reproduzida, diagnósticos, regressões, Preview e estado da homologação.
