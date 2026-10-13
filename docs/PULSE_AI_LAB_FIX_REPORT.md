# Correção da interpretação — 13/10/2026

Branch: `feat/real-ai-private-lab`. PR: #2. Nenhuma alteração na main, frontend visual, Supabase, Workers ou ferramentas reais.

## Causa confirmada no código

O schema inline de `api/agent.ts` usava a regex literal `/^\\d{4}-\\d{2}-\\d{2}$/`. Em regex literal, `\\d` representa barra invertida seguida de `d`, e não dígito. Assim, qualquer `registrar_transacao` com data ISO válida era rejeitado pelo Zod. O catch genérico transformava isso em HTTP 502 `INTERPRETATION_FAILED`, sem logs.

A validação foi corrigida para `/^\d{4}-\d{2}-\d{2}$/`, mantendo o teste de validade real da data. Um teste de regressão valida paridade com o schema do cliente. O modelo configurado foi verificado como `gpt-4.1-mini`; `ENABLE_REAL_AI` foi verificado como ativo, e as três variáveis existem nos escopos Preview/Production. A chave não foi recuperada nem exposta.

Os logs Vercel consultados nos últimos 30 minutos mostraram o erro antigo `ERR_MODULE_NOT_FOUND` de um deployment anterior em main. O deployment atual da branch já era READY; seu catch não emitia a causa da interpretação. Portanto, o defeito de data é confirmado por inspeção e teste, mas não há prova de uma resposta OpenAI real naquela requisição histórica; outros bloqueios upstream só podem ser excluídos por teste autenticado.

## Correções

- Função serverless continua autocontida, sem imports locais que repetiriam o problema ESM.
- Tratamento específico de autenticação, quota/créditos, rate limiting, incompatibilidade de modelo/parâmetros, JSON inválido, schema inválido, truncamento, recusa, falha de rede e timeout, inclusive durante leitura do corpo.
- Respostas HTTP contêm somente código estável, requestId e retryable. Logs contêm apenas evento, requestId, código, status upstream e retryable. Nenhum erro bruto, corpo upstream, chave ou mensagem financeira é registrado.
- Sem retries automáticos ou chamadas pagas extras. Limite existente de 350 tokens de saída e timeout de 20s preservados.
- Prompt explicita moeda brasileira, data em America/Sao_Paulo e a omissão do campo não utilizado (sem null).
- Provider server-only reutiliza a mesma interpretação da API para evitar divergência de schema.

| Código | Ação mínima |
|---|---|
| OPENAI_AUTH_FAILED | Verificar a chave/permissões na configuração Vercel, sem colar em chat |
| OPENAI_QUOTA_EXCEEDED | Verificar créditos e limite do projeto OpenAI |
| OPENAI_RATE_LIMITED | Aguardar o limite de requisições |
| MODEL_INCOMPATIBLE | Selecionar modelo com acesso e suporte ao contrato JSON Chat Completions |
| INVALID_MODEL_JSON | Verificar formato da resposta; nenhum lançamento executado |
| SCHEMA_VALIDATION_FAILED | Verificar contrato; nenhum lançamento executado |
| OPENAI_TIMEOUT | Serviço não respondeu no prazo; nenhuma interpretação confirmada |

## Resultados reais dos testes

- `npm test`: **54 testes passaram** em 3 arquivos.
- `npm run build`: TypeScript e Vite passaram.
- Playwright: **4 testes passaram**, sendo simulador e caminho IA-real/API com mock, em desktop e mobile.
- Mensagem obrigatória `Gastei R$ 47,90 com gasolina hoje.`: teste com resposta OpenAI mock valida ferramenta `registrar_transacao`, tipo despesa, valor 47.9, descrição gasolina, data ISO, registro fictício e saldo R$ 2.452,10.
- Consulta de saldo e mensagem ambígua: validam consulta e esclarecimento sem escrita, incluindo Inspector na UI.
- Tests de erro upstream asseguram classificação e ausência de mensagens/chaves/corpos privados nos logs/respostas.

## Limite da confirmação com modelo real

Não houve chamada OpenAI real confirmada nesta execução. O navegador entrou no fluxo Vercel → GitHub → Google com o método escolhido pelo usuário, mas Google retornou `502 Bad Gateway / Connection refused`; a sessão não foi autenticada. A revisão automática rejeitou tanto a criação de link compartilhável como o fetch que pode gerar bypass, por contrariar a restrição de autenticação. Não houve tentativa de contornar as rejeições nem de extrair a chave.

O teste real deve ser concluído numa sessão Vercel autenticada com a mensagem obrigatória, consulta de saldo e mensagem ambígua. Não confundir os testes mock aprovados com homologação OpenAI ao vivo. Em caso de falha, o endpoint agora informa o código seguro e requestId; o log permite localizar a categoria sem registrar dados financeiros.

Preview testado no build remoto: https://pulse-ai-cszhc8915-matheusnastaro5-6769s-projects.vercel.app/

Commit de código: `d9e96d95d93799b85b480a013b1bd823aa279c09`. Deployment `dpl_7o6eRNvkATFRcSkxHeMSpTzizyxU`: READY, source git, ambiente Preview (target null), branch correta, build remoto concluído em aproximadamente 21 segundos. Projeto existente mantém `ssoProtection.enabled=true` e `deploymentType=all`. Acesso anônimo ao endpoint redireciona para autenticação; não foi removida ou flexibilizada a proteção. Nenhum deployment desta correção foi publicado em produção.

Estado final: correção e validação automatizada entregues; confirmação com modelo real ainda impedida pela autenticação do navegador. Ação mínima: acessar este Preview com conta Vercel autorizada e enviar os três casos descritos. Não fornecer a chave OpenAI no chat. Se houver novo erro, usar somente código e requestId para diagnóstico.
