# Pulse AI Lab — Relatório de entrega

Data: 08/10/2026. Repositório: https://github.com/Nastatherossi/Agente-pulse-ia — branch `feat/pulse-ai-lab`.

## Arquitetura

Definitiva: Usuário → Pulse AI → Cloudflare Workers → Financial Core → Supabase.

Entregue nesta versão: React/Vite → `SimulationProvider` → orquestrador → `SimulatedCloudflareAdapter` → `FinancialCore` em memória. O estado fictício é persistido em sessionStorage por aba; nenhum banco externo é acessado. Backend Express de desenvolvimento e endpoints serverless Vercel fornecem health check e bloqueiam o modo real. Provider OpenAI preparado exclusivamente no servidor, desacoplado por interface.

## Funcionalidades entregues

- Interface SaaS responsiva em português, chat à esquerda e Inspector à direita.
- Histórico da conversa em memória, exemplos clicáveis, loading, esclarecimentos, erros e revisão de chamadas anteriores.
- Saldo inicial de R$ 2.500 fictícios; receitas e despesas atualizam o saldo consolidado em centavos.
- `consultar_saldo`, `registrar_transacao` e `listar_transacoes` (com filtro de receita/despesa).
- Inspector: intenção, ferramenta, argumentos, resultado/erro estruturado, requestId, status e duração. Sem raciocínio privado.
- Schemas Zod estritos, validação de datas, valores positivos e casas decimais; rejeição de ferramentas desconhecidas e IDs extras.
- Idempotência em memória no adaptador; conflito de chave rejeitado.
- Falha simulada para demonstrar ausência de escrita e de confirmação indevida.
- Reinício de sessão confirmado pelo usuário; transações sobrevivem a reload na mesma aba.

## Testes realizados e resultados reais

| Verificação | Resultado |
|---|---|
| `npm test` | 29 testes passaram em 2 arquivos |
| Registro de receita/despesa, saldo e extrato | Passaram |
| Centavos, moeda brasileira, data ISO, isolamento e snapshot | Passaram |
| Valor inválido, negativo, zero, precisão excessiva e data inexistente | Passaram |
| Ambiguidade, ausência de data/descrição/valor, crédito e condicionais | Passaram |
| Ferramenta desconhecida, IDs extras, idempotência e conflito | Passaram |
| Falha de execução, retorno incorreto e confirmação somente após sucesso | Passaram |
| API real bloqueada e provider sem autorização | Passaram |
| Playwright desktop 1440×1000 e mobile 390×844 | 2 testes completos passaram; sem erro JavaScript nem overflow horizontal |
| Fluxo UI: registrar → saldo → extrato → reload → falha → esclarecer → reset | Passou nos dois tamanhos |
| `npm run build` | TypeScript e build Vite passaram |
| `npm audit --omit=dev` | Zero vulnerabilidades reportadas nas dependências de produção |
| Inspeção visual de screenshots desktop/mobile | Realizada, layout legível e sem cortes horizontais |

O download padrão do Chromium retornou um arquivo inválido neste ambiente. O teste foi efetivamente executado com Chromium empacotado de `@sparticuz/chromium`, extraído localmente e informado por `LAB_CHROMIUM_PATH` (não é um teste omitido). A API foi testada após aguardar o servidor iniciar.

## GitHub e publicação

O repositório estava completamente vazio. Para possibilitar uma branch isolada via conector GitHub, a `main` foi inicializada apenas com README; toda implementação está na `feat/pulse-ai-lab`. A tentativa de push pelo terminal não tinha credenciais, portanto a publicação de código foi realizada pelo conector GitHub autorizado.

Projeto Vercel: `pulse-ai-lab`, na equipe `matheusnastaro5-6769s-projects`. Proteção Vercel Authentication para **todos** os deployments foi configurada e confirmada antes do deploy. Nenhum plano pago foi contratado.

Laboratório: https://pulse-ai-lab.vercel.app/

Deployment `dpl_5f92ARntFuQLNEF2g1oFo1Cm1aLM`, commit `899edf5cddf5cbe7f1f13d1ded8f0327b7edf169`: build remoto `READY`, aliases atribuídos e sem erro. Requisições anônimas para `/` e `/api/health` retornaram 302 com corpo “Protected by Vercel Authentication”. Acesso autenticado pelo conector retornou HTTP 200 para a página HTML (com os assets do build local) e `/api/health` com `status:ok`, `mode:simulation`, `realAIEnabled:false`. Testes UI completos foram executados localmente; não houve sessão interativa de navegador remoto homologada. O acesso do usuário exige login em uma conta Vercel autorizada na equipe. A proteção permanece ativa para todos os deployments.

## Limitações da simulação

- Interpretação determinística: não é um LLM e não há consumo de tokens.
- Aceita uma transação simples por mensagem. Parcelas, crédito, estornos, transferências e linguagem fora dos padrões requerem esclarecimento.
- “Hoje” usa America/Sao_Paulo; outras datas devem ser explícitas em AAAA-MM-DD.
- Dados fictícios ficam na aba; histórico de chat não persiste ao recarregar. Não há sincronização multiusuário.
- Idempotência não persiste ao recarregar; para produção, usar registro durável por identidade.
- O core não representa todas as regras do Financial Core de produção. Saldo pode ficar negativo, como fluxo de caixa fictício.
- IA real está bloqueada. O provider preparado ainda não foi homologado com credenciais reais.

## Próximos passos — IA real

1. Obter autorização explícita para consumo e configurar chave somente no servidor.
2. Conectar autenticação verificada, autorização, limite de consumo e rate limiting ao backend.
3. Habilitar e testar `OpenAIProvider` com o mesmo orquestrador e ferramentas ainda simuladas.
4. Validar casos reais e mensagens ambíguas, com schemas estritos e confirmação somente após sucesso.

## Próximos passos — Cloudflare

1. Criar Worker de staging autorizado, seguindo `docs/CLOUDFLARE_CONTRACT.md`.
2. Implementar autenticação backend → Worker e resolução de identidade/workspace em contexto confiável.
3. Implementar adaptador HTTP, timeout, resposta correlacionada e idempotência durável.
4. Conectar Financial Core em staging e somente depois Supabase isolado, verificando isolamento antes de qualquer produção.

Nenhuma alteração foi feita em `pulse-finance` ou no Supabase. Nenhum Worker de produção ou ferramenta financeira real foi publicado.
