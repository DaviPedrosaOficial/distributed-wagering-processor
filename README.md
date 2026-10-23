# Distributed Wagering Processor

Serviço financeiro desenvolvido para o desafio técnico de **Backend Developer da
Jungle Gaming**. O objetivo é processar apostas com precisão monetária, impedir
movimentações duplicadas e manter saldo, histórico e eventos consistentes.
O projeto também consolida meu aprendizado de domínio, concorrência e recuperação
de falhas, com decisões justificadas em [ARCHITECTURE.md](ARCHITECTURE.md).

## Tecnologias e funcionalidades

TypeScript estrito, NestJS, Bun 1.x, MikroORM, PostgreSQL 17, decimal.js e SQS via
AWS SDK/LocalStack, com infraestrutura local em Docker Compose.

- Abertura de carteira com versão 1, ledger e operação interna OPENING.
- BET, WIN, LOSS, REFUND e ROLLBACK pela API e pelo mesmo processamento via SQS.
- Dinheiro em strings decimais, bloqueio por carteira e idempotência persistida.
- Replay histórico, referências validadas e espera com backoff e TTL de 15 minutos.
- Inbox, finanças e outbox atômicas; ack após commit, retry e DLQ.
- Publicador da outbox com seleção concorrente e eventos versionados.
- Ledger paginado, consulta de transações e reconciliação sem alteração de saldo.
- Liveness, readiness de PostgreSQL/SQS, métricas e logs com correlação.

Ainda faltam validações com processos independentes e interrupções reais, a
classificação operacional completa de falhas definitivas e o ponto de extensão de
autenticação. A API ainda não possui autenticação. A entrega de eventos pode se
repetir; consumidores devem deduplicar pelo eventId.

## Executar localmente

Requisitos: **Bun 1.x e Docker com Compose**. Na raiz, no PowerShell:

```powershell
bun install --frozen-lockfile
if (!(Test-Path .env)) { Copy-Item .env.example .env }
docker compose up -d --wait
bun run db:migration:up
bun run queues:setup
$env:MESSAGING_ENABLED = "true"
bun run start
```

Confira o `.env`. A API usa `http://localhost:3000`; SQS local usa
`http://127.0.0.1:4566`, região `us-east-1` e credenciais locais `test/test`.
O comando acima habilita consumidor e publicador nesse terminal. Sem
`MESSAGING_ENABLED=true`, a API funciona, mas a outbox acumula eventos sem publicar.
O worker de referências inicia por padrão; `REFERENCE_WORKER_ENABLED=false` o desativa.

Filas: `wager-transactions.fifo` (entrada), `wager-transactions-dlq.fifo` (falhas)
e `wager-events.fifo` (eventos). O guia explica configuração e envelopes.

| Método | Rota                                                                | Finalidade                           |
| ------ | ------------------------------------------------------------------- | ------------------------------------ |
| POST   | /wallets                                                            | Abrir carteira                       |
| GET    | /wallets/:walletId                                                  | Consultar carteira                   |
| POST   | /wagering/transactions                                              | Processar operações                  |
| GET    | /wallets/:walletId/ledger                                           | Ledger com limit e cursor            |
| GET    | /wagering/transactions/:transactionId                               | Consultar transação                  |
| GET    | /providers/:providerId/wagering/transactions/:externalTransactionId | Consultar pelo ID externo            |
| POST   | /wallets/:walletId/reconciliation                                   | Comparar saldo e ledger, sem reparar |
| GET    | /health/live                                                        | Verificar processo                   |
| GET    | /health/ready                                                       | Verificar PostgreSQL e as três filas |
| GET    | /metrics                                                            | Métricas em formato Prometheus       |

Exemplo de abertura:

```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "100.00", "currency": "BRL" }
}
```

Operações HTTP exigem `Idempotency-Key`. Reenviar uma operação finalizada sem
alterações recupera seu resultado histórico com `idempotentReplay: true`, sem
nova movimentação. Conflitos retornam 409, rejeições financeiras 422 e espera
por referência 202.

O ledger usa limite padrão 50, máximo 100, e devolve nextCursor para a próxima
página. Consultas de transações preservam o saldo histórico; a carteira mostra
o saldo atual. Readiness verifica SQS mesmo com os workers desativados.

## Validar

Defina `POSTGRES_TEST_DB=wagering_test` no `.env` e mantenha os containers ativos:

```powershell
bun run build
bun run lint
bun run test:unit
bun run db:test:prepare
bun run test:e2e
bun run test:messaging
```

**Use banco exclusivo terminado em `_test`: a suíte HTTP/SQL reverte migrations
e remove os dados desse banco. Rode as suítes em sequência.** A suíte SQS utiliza
filas próprias e as remove no encerramento. Não execute workers externos nesse banco.

Neste incremento, build e lint passaram; foram aprovados **117 testes unitários**
e **62 HTTP/SQL com PGlite e transporte controlado** no ambiente de desenvolvimento.
A suíte SQS tem sete cenários. A execução deste bloco com PostgreSQL 17 e LocalStack
no Docker do autor ainda precisa ser confirmada. O bloco anterior havia passado
55 testes HTTP/SQL e seis com PostgreSQL/LocalStack reais.
Os testes atuais ainda não comprovam três processos independentes ou kill real.

Desafio: [Jungle Gaming — Backend Challenge](https://github.com/junglegaming/backend-challenge).
