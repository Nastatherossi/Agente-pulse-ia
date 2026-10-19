# Pulse Personality V2.1 — auditoria e entrega

## Estado inicial e segurança

- Repositório: `Nastatherossi/Agente-pulse-ia`.
- Branch de trabalho: `feat/pulse-conversation-manus`.
- Branch de referência preservada: `feat/pulse-personality-v2`.
- SHA de origem: `7da4e0b01be6efd3160f38709780aed478e64a5a` (`Document verified protected Personality V2 Preview and memory guarantees`).
- O PR #7 (`feat/pulse-personality-v2` → `feat/pulse-personality-v1`) estava aberto. Seu head remoto era o SHA de origem acima, com os três commits da V2 (implementação, ajuste de linguagem da memória e documentação de Preview). Não havia commits posteriores nem alterações parciais da tentativa interrompida na branch de referência no momento da inspeção.
- `main`, V1, V2 e dados financeiros reais não foram alterados. As mudanças do laboratório permanecem isoladas; nenhuma integração com produção, Supabase ou WhatsApp foi adicionada.

## Auditoria e causa-raiz

O classificador em `shared/v2/personality.ts` já possuía a intenção `conversa`, mas classificava qualquer mensagem com `?` como `consulta` (`if(/[?]|saldo|.../)`). Portanto, “Tô pensando em sair do meu emprego?” era incorretamente promovida de conversa pessoal a consulta financeira.

Em seguida, `shared/v2/agent.ts` marcava qualquer resposta final contendo `?`, “preciso” ou “qual ” como `clarification`, sem verificar se faltava um campo financeiro obrigatório. Isso confundia uma pergunta de acompanhamento natural — por exemplo, “O que está fazendo você considerar sair do emprego?” — com esclarecimento operacional. O rótulo resultante no Inspector reforçava a impressão de erro, embora nenhuma ferramenta tivesse sido necessária.

A causa está demonstrada por esses dois condicionais no caminho `classifyIntent` → resposta sem chamadas → definição de status e intenção no trace. Não é necessário criar classificador adicional ou uma segunda chamada de modelo.

## Implementação

- `shared/v2/personality.ts`: pontuação interrogativa deixou de ser sinal suficiente de consulta; orientação e consulta dependem de contexto financeiro. A conversa pessoal permanece como intenção explícita `conversa`.
- `shared/v2/agent.ts`: perguntas de acompanhamento em conversas e orientações deixam de ser classificadas como esclarecimento. `clarification` continua disponível para mensagens de consulta que realmente pedem dados necessários e para execução financeira sem dados suficientes. Uma conversa sem ferramenta recebe a intenção legível `Conversa aberta` e status `success`.
- `server/v2/personality-prompt.ts`: o prompt transmite a intenção atual ao modelo e explicita que perguntas abertas de acompanhamento não são lacunas operacionais; nenhuma segurança financeira ou regra de autorização foi relaxada.
- `src/InspectorV2.tsx` e `src/main.tsx`: trace bem-sucedido sem ferramenta aparece como “Respondido” / “Conversa respondida”; operação financeira continua como “Executado”. O Inspector explica que não houve ferramenta porque nenhuma era necessária.
- `tests/v2.test.ts`, `tests/e2e/lab.spec.ts`: cobertura da intenção conversacional com “?”, pergunta de acompanhamento, esclarecimento de período financeiro, prompt, UI sem ferramentas e coexistência com registro objetivo.
- `public/manus-routes.json`: manifesta a rota `/` para validação local de Preview.
- O Memory Engine não exigiu mudança estrutural: segue subordinado à habilitação e às regras existentes; conversa não autoriza escrita financeira, e os registros/narrativas continuam isolados por sessão.

## Validação

- Backend, ferramentas, confirmação, isolamento e memória: **204 testes aprovados em 7 arquivos** (`npm test`).
- TypeScript, build da API e build frontend: **aprovados** (`npm run build`).
- Playwright desktop e mobile: **16 testes aprovados** (`LAB_BUNDLED_CHROMIUM=true npm run test:e2e`), incluindo conversa bem-sucedida sem ferramenta e, na mesma sessão, lançamento de R$ 80 no mercado com confirmação breve e saldo correto.
- A primeira tentativa de Playwright com browser default não encontrou o Chromium instalado; a execução final usou o Chromium bundled do projeto e passou. A instalação do pacote apresentou aviso de engine para `@sparticuz/chromium` (Node local 22.13.0, requisito declarado `^22.17.0 || >=24`); apesar do aviso, os testes Playwright executaram e passaram.
- Não houve chamada ao OpenAI real na homologação. A chave disponível no ambiente de sandbox pertence ao gateway de teste compatível com OpenAI e não foi tratada como credencial de produção da aplicação. Os testes de provider usam mocks; a qualidade do modelo real ainda precisa de validação autenticada no ambiente do Pulse.

## Publicação

- Branch / PR / Preview: atualização pendente de publicação; serão inseridos após a confirmação dos respectivos resultados.
- Não fazer merge. Nenhuma promoção para produção.
