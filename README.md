# Distributed Wagering Processor

Serviço financeiro desenvolvido para o desafio técnico de **Backend Developer da
Jungle Gaming**. O objetivo é processar apostas com precisão monetária, impedir
movimentações duplicadas e manter saldo, histórico e eventos consistentes.
O projeto também consolida meu aprendizado de domínio, concorrência e recuperação
de falhas, com decisões justificadas em [ARCHITECTURE.md](ARCHITECTURE.md).
O [Mapa do Sistema](MAPA-DO-SISTEMA.md) liga cada decisão aos arquivos que a
implementam e resume a comunicação entre as partes.

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
- Registro de FAILED e evento de falha ao esgotar retries, quando o banco responde.
- Suíte de concorrência, reinício e interrupções com processos independentes.

A API não autentica clientes neste desafio. ProviderAuthGuard é um ponto de
extensão explícito e atualmente permite as chamadas; não oferece proteção.
O desenho com Identity Provider externo e as limitações estão no ARCHITECTURE.
A entrega de eventos pode se repetir; consumidores devem deduplicar pelo eventId.

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
e `wager-events.fifo` (eventos). O script de setup configura FIFO e redrive em cinco
recebimentos. As credenciais padrão são exclusivas do ambiente local.

| Método | Rota | Finalidade |
| --- | --- | --- |
| POST | /wallets | Abrir carteira |
| GET | /wallets/:walletId | Consultar carteira |
| POST | /wagering/transactions | Processar operações |
| GET | /wallets/:walletId/ledger | Ledger com limit e cursor |
| GET | /wagering/transactions/:transactionId | Consultar transação |
| GET | /providers/:providerId/wagering/transactions/:externalTransactionId | Consultar pelo ID externo |
| POST | /wallets/:walletId/reconciliation | Comparar saldo e ledger, sem reparar |
| GET | /health/live | Verificar processo |
| GET | /health/ready | Verificar PostgreSQL e as três filas |
| GET | /metrics | Métricas em formato Prometheus |

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
por referência 202. Falha transitória reconhecida retorna 503. Replay de uma
operação terminal FAILED retorna 500 com status e failureCode persistidos;
esse estado a mesma operação não será reaplicada.

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
bun run test:recovery
```

**Use banco exclusivo terminado em `_test`: a suíte HTTP/SQL reverte migrations
e remove os dados desse banco. Rode as suítes em sequência.** A suíte SQS utiliza
filas próprias e as remove no encerramento. Não execute workers externos nesse banco.

A suíte de recuperação inicia suas próprias instâncias Bun em portas livres.
Ela verifica três APIs concorrentes, 50 repetições, disputa de saldo, carteiras
distintas, reinício, referências fora de ordem, kill após commit/antes de ack e
kill após envio/antes de marcar outbox. Dois publishers independentes retomam o
trabalho. As pausas de falha existem somente nas fixtures de teste. O caso de ack
aguarda a visibilidade real de 30 segundos; não encerre a suíte durante essa espera.

Resultados registrados em **23/10/2026**:

| Suíte | Aprovados | Ambiente da validação |
| --- | ---: | --- |
| Unitários | 117 | Bun 1.4.3, validação local de desenvolvimento |
| HTTP/SQL | 66 | PostgreSQL 17 em Docker, transporte controlado para falhas |
| Mensageria | 7 | PostgreSQL e LocalStack em Docker |
| Recuperação | 4 | Processos Bun independentes com PostgreSQL e LocalStack em Docker |

Todas essas execuções terminaram sem falhas. Build e lint também passaram na
validação de desenvolvimento. As três suítes de integração acima foram confirmadas
no Windows do autor. Os testes de recuperação verificaram encerramento após
commit/antes de ack e após envio/antes de marcar publicação, além de retomada e
reconciliação. Não foi realizado teste de carga.

## Contrato de mensagens e limites

A fila de entrada recebe JSON com messageId, type="WagerTransactionRequested",
occurredAt em ISO e data. Em data, use os campos da operação HTTP (providerId,
externalTransactionId, playerId, walletId, roundId, gameId, kind e money), mais
idempotencyKey e referenceExternalTransactionId quando aplicável. OPENING é interno.
Valores de money usam {"amount":"25.00","currency":"BRL"}.

No quinto recebimento sem resultado confirmado, o consumidor tenta persistir
FAILED, inbox e WagerTransactionFailed juntos, sem alterar saldo ou ledger.
Se a tentativa anterior já confirmou a operação, recupera seu resultado.
Se o banco não permite nem essa gravação, preserva o pedido na DLQ e registra a
indisponibilidade da auditoria; não existe reconciliação automática da DLQ para SQL.
Mensagens inválidas também ficam na DLQ, sem fabricar uma transação financeira.

A outbox mantém eventos até publicar, com backoff. FIFO reduz repetições, mas sua
janela não substitui deduplicação persistente no destino. A suíte demonstra um
consumidor de eventos com recibo e efeito atômicos em tabelas exclusivas de teste;
não há consumidor de negócio da fila de eventos na aplicação.

## Documentação

- [ARCHITECTURE.md](ARCHITECTURE.md): decisões adotadas, justificativas, trade-offs e limitações.
- [MAPA-DO-SISTEMA.md](MAPA-DO-SISTEMA.md): responsabilidades dos arquivos e ligação entre arquitetura, implementação e testes.

Desafio: [Jungle Gaming — Backend Challenge](https://github.com/junglegaming/backend-challenge).
