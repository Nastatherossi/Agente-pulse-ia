# Pulse AI Lab

Laboratório isolado do agente financeiro do Pulse. React + TypeScript + Vite, motor modular, adaptador Cloudflare simulado e Financial Core em memória. **Não acessa Supabase nem dados financeiros reais.**

## Executar

Node.js 22.12+ ou 24. `npm ci`, depois `npm run dev`.

- Interface: http://127.0.0.1:5173
- API de desenvolvimento: http://127.0.0.1:3001/api/health
- `npm test`: contratos, core, orquestrador e segurança da API.
- `npm run build`: TypeScript estrito e build de produção.
- `npx playwright install chromium` e `npm run test:e2e`: interface desktop/mobile.
- `npm run preview`: build estático local.

## Usar o laboratório

Saldo inicial fictício: R$ 2.500. Experimente:

- `Qual meu saldo?`
- `Gastei 50 em mercado hoje`
- `Recebi R$ 1.234,56 de salário 2026-10-08`
- `Listar transações` / `Listar despesas` / `Listar receitas`

Valores com vírgula e milhares no padrão brasileiro são aceitos. Informe `hoje` ou uma data ISO; datas ausentes pedem esclarecimento. Apenas uma operação por mensagem. Crédito, parcelas, transferências, estornos e comandos condicionais pedem esclarecimento.

Clique em uma execução do histórico para inspecioná-la. Ative a falha simulada para verificar que o saldo não muda e o agente não confirma sucesso. “Nova sessão” limpa tudo com confirmação.

As transações são salvas em `sessionStorage` por aba, com schema validado ao carregar; recarregar mantém os valores, mas o histórico do chat é apenas em memória. Não use dados reais. O armazenamento indisponível não impede o uso em memória. Sem dados compartilhados entre usuários no servidor.

## Estrutura

- `src/`: interface, estilos e estado da sessão fictícia.
- `shared/contracts.ts`: schemas Zod e contratos tipados.
- `shared/simulation.ts`: provider determinístico, identificado como simulação.
- `shared/orchestrator.ts`: interpretação → validação → execução → confirmação.
- `shared/core.ts`: regras financeiras em centavos e adaptador simulado com idempotência.
- `server/openai.ts`: provider real preparado, apenas servidor, validando a resposta do modelo.
- `server/`: Express local; `/api/agent` bloqueado por padrão.
- `api/`: endpoints serverless para Vercel, também com IA real bloqueada.
- `docs/CLOUDFLARE_CONTRACT.md`: contrato para integração futura.
- `PULSE_AI_LAB_REPORT.md`: resultados reais, deploy e limitações.

## IA real e segurança

**Modo real não está ativo e não consome tokens.** O menu de modo explica o bloqueio. A classe `OpenAIProvider` é um conector preparado, não uma integração homologada. Nenhuma chave foi configurada ou chamada de modelo realizada.

Antes de habilitar: autorização de consumo, credenciais exclusivamente server-side, autenticação de sessão verificada e autorização por usuário, rate limiting e quotas. Depois conectar o provider ao orquestrador no backend e testar com ferramentas ainda simuladas. A flag `ENABLE_REAL_AI` isolada não libera o endpoint: ele continua retornando 403.

IDs de identidade devem vir da sessão autenticada e nunca do modelo. Schemas estritos rejeitam campos extras e ferramentas desconhecidas. Não há SQL arbitrário, logs de mensagens ou analytics. Confirmações são produzidas somente depois do retorno bem-sucedido do executor. A simulação no browser não constitui barreira de segurança para finanças reais: ao integrar ferramentas reais, mover toda execução para servidor/Worker.

## Vercel

`vercel.json` configura o build, headers de segurança e funções em `api/`. Configure **Vercel Authentication para todos os deployments antes de publicar**. Não disponibilize um deployment sem proteção. Nenhum segredo deve usar prefixo `VITE_`.

Não foi alterado `pulse-finance`, criado Worker de produção, conectado Supabase ou contratado serviço pago.
