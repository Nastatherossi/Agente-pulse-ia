# Contrato Cloudflare Workers — v1

Arquitetura definitiva: usuário → Pulse AI (interpretação server-side) → Cloudflare Worker (autorização e validação) → Financial Core (regras) → Supabase (persistência).

No laboratório, `ModelProvider` e `ToolAdapter` são interfaces independentes. O `SimulationProvider` interpreta comandos determinísticos; `SimulatedCloudflareAdapter` valida e chama `FinancialCore`. Não existe chamada de rede ou Worker real nesta etapa. O core e o executor rodam no browser exclusivamente com dados fictícios.

## Requisição

Futuro `POST /v1/tools/execute` via HTTPS, `Content-Type: application/json`:

```json
{
  "version": "1",
  "requestId": "e68c2da2-d01f-4a12-a7fb-599e97ceea90",
  "call": {
    "name": "registrar_transacao",
    "arguments": {
      "type": "despesa",
      "amount": 50,
      "description": "mercado",
      "date": "2026-10-08"
    }
  }
}
```

Ferramentas permitidas:

| Nome | Argumentos |
|---|---|
| `consultar_saldo` | Objeto vazio estrito |
| `registrar_transacao` | `type`: receita/despesa; `amount`: número positivo até 1 milhão, máximo 2 casas; `description`: 1–120 caracteres; `date`: data ISO válida |
| `listar_transacoes` | `limit`: inteiro 1–100 (padrão 20); `type`: receita/despesa opcional |

## Resposta

```json
{"requestId":"e68c2da2-d01f-4a12-a7fb-599e97ceea90","ok":true,"result":{"transaction":{"id":"9c3738f6-89b6-48a3-936f-88cf05936523","type":"despesa","amount":50,"description":"mercado","date":"2026-10-08"},"balance":2450}}
```

```json
{"requestId":"e68c2da2-d01f-4a12-a7fb-599e97ceea90","ok":false,"error":{"code":"EXECUTION_FAILED","message":"Não foi possível executar a ferramenta.","retryable":true}}
```

Erros simulados: `INVALID_REQUEST`, `VALIDATION_FAILED`, `EXECUTION_FAILED`, `IDEMPOTENCY_CONFLICT`. Futuramente: `UNAUTHENTICATED`, `FORBIDDEN`, `RATE_LIMITED`, `CORE_UNAVAILABLE`. Não retornar stack traces, segredos ou dados de terceiros.

## Autenticação e autorização futuras

- O frontend envia somente mensagens ao backend autenticado. Não recebe credenciais do Worker.
- Backend → Worker com token de curta duração/assinatura verificada, audience específica e proteção contra replay. Segredos em variáveis de servidor e bindings do Worker.
- Worker resolve identidade e workspace em contexto confiável, fora de `call.arguments`. IDs que vierem do modelo são rejeitados.
- Allowlist de ferramentas por usuário, schema estrito, limites de payload, rate limiting e tempo limite.
- Financial Core recebe contexto verificado e implementa regras, transações atômicas e acesso Supabase com isolamento apropriado.
- Persistir idempotência por identidade + `requestId` em armazenamento durável; mesma chave com payload diferente gera conflito. O mapa do laboratório é apenas em memória e dura até reiniciar/recarregar.
- Logs padrão limitados a requestId, ferramenta, status e duração. Não registrar mensagens, argumentos ou valores financeiros por padrão.
- Em timeout após escrita, consultar o resultado pela chave de idempotência antes de repetir ou confirmar.

Não implementar autorização real no browser, confiar em headers controlados pelo cliente ou usar esta simulação como serviço financeiro de produção.
