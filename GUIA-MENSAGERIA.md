# SQS, inbox e publicador da outbox

Este incremento conecta o processamento financeiro a SQS via LocalStack e
acrescenta inbox persistente, consumidor, retry/DLQ e publicação da outbox.
O módulo de mensageria usa o mesmo ProcessTransactionService da API HTTP.

## Instalação e testes no Windows

O ZIP é incremental e contém os arquivos diretamente na raiz. Na pasta que contém
package.json, execute:

```powershell
Expand-Archive -LiteralPath .\bloco-mensageria.zip -DestinationPath . -Force
bun install --frozen-lockfile
docker compose up -d --wait
bun run build
bun run lint
bun run db:migration:up
bun run queues:setup
bun run test:unit
bun run db:test:prepare
bun run test:e2e
bun run test:messaging
```

Agora há uma dependência nova, @aws-sdk/client-sqs, e uma quarta migration.
Não gere outra migration para aplicar este pacote. .env.example é atualizado,
mas o pacote não contém nem substitui seu .env. SQS usa por padrão o endpoint
http://127.0.0.1:4566, região us-east-1 e credenciais locais test/test.

Os testes precisam do banco exclusivo POSTGRES_TEST_DB terminado em _test.
A suíte HTTP/SQL reverte e reaplica migrations, removendo os dados desse banco.
A suíte SQS usa filas próprias com nomes únicos e as remove no encerramento.
Ela não deve ser executada simultaneamente com a suíte que reverte migrations
no mesmo banco. Não execute as suítes com workers da aplicação usando o banco de testes.

Para executar a aplicação com consumidor e publicador habilitados:

```powershell
$env:MESSAGING_ENABLED = "true"
bun run start
```

Essa variável vale para o terminal atual. Também pode ser definida no .env para
persistir a configuração. Sem o valor true, a API funciona e a outbox acumula
pendências, mas consumidor e publicador não iniciam. O worker de referências
continua controlado separadamente por REFERENCE_WORKER_ENABLED.

## Filas e configuração local

| Fila | Papel |
| --- | --- |
| wager-transactions.fifo | Entrada das operações solicitadas. |
| wager-transactions-dlq.fifo | Mensagens inválidas ou que esgotaram tentativas. |
| wager-events.fifo | Saída dos eventos persistidos na outbox. |

LocalStack está no Compose, com a porta 4566 limitada ao host local. O script
queues:setup cria as filas FIFO e configura redrive da entrada para a DLQ após
cinco recebimentos. Não expomos um endpoint HTTP administrativo para esse setup.

O container local não é uma garantia de retenção de filas após sua remoção ou
recriação. Os cenários de recuperação deste incremento tratam reinício de
consumidores/publicadores, mantendo PostgreSQL e broker disponíveis.

## Como uma mensagem vira uma operação

A entrada segue o envelope do desafio:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-22T18:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Os UUIDs acima são ilustrativos: a carteira precisa existir para processar o pedido.
O parser verifica envelope, data e chave e reutiliza o DTO HTTP para validar os
campos de negócio. OPENING e campos extras no payload são recusados. O serviço
continua validando Money, referências e saldo. A identidade do provedor na fila
continua sujeita a essas validações; não foi adicionada autenticação neste bloco.

O consumidor busca uma mensagem por vez em cada instância, com long polling de
até 10 segundos e visibilidade inicial de 30 segundos. Enquanto processa, tenta
renovar a visibilidade a cada 10 segundos. Instâncias diferentes podem trabalhar
em paralelo; o bloqueio por carteira no PostgreSQL continua sendo a garantia do
saldo. Produtores devem usar walletId como MessageGroupId para aproveitar a
ordenação FIFO, sem depender dela como proteção financeira.

## O que a inbox protege

SQS tem seu MessageId e ReceiptHandle. O envelope possui outro messageId, fornecido
pela integração. A inbox utiliza o messageId do envelope junto de um consumerName
fixo, wager-transactions-v1. O ReceiptHandle atual é utilizado exclusivamente
para confirmar ou alterar a visibilidade daquela entrega ao SQS.

InboxMessage possui factory, reidratação, datas defensivas e transição explícita
para processado. InboxRecord persiste identidade, hash, datas e resultado em JSONB.
A chave primária composta impede duplicação; um trigger impede alterar ou excluir
uma confirmação existente.

O hash da inbox é SHA-256 do JSON [payloadHash, idempotencyKey]. Inclui a chave
porque mudar apenas esse campo também muda a identidade pretendida da operação.
Metadados como horário do envelope e correlação não participam. Reutilizar o mesmo
messageId com conteúdo diferente gera conflito permanente.

ProcessTransactionService recebe contexto opcional de inbox. Ele registra a
confirmação na mesma transação SQL das finanças e da outbox, antes do commit final.
Se a confirmação da inbox falhar depois de flushes anteriores, tudo é revertido.
Um replay de operação criada via HTTP também pode confirmar uma nova inbox, sem
repetir sua movimentação.

Somente depois que execute() resolve, o consumidor chama DeleteMessage (ack).
Se o processo perder o ack após o commit, outra entrega encontra a inbox e não
movimenta novamente. A inbox é uma proteção adicional à idempotência financeira:
mensagens com IDs diferentes ainda passam pela chave e identidade externa da operação.
Para PENDING_REFERENCE, o aceite e o agendamento são confirmados antes do ack;
a retomada da referência passa a ser responsabilidade do worker persistido.

## Retry, rejeições e DLQ

Rejeição financeira como saldo insuficiente é um resultado terminal persistido:
o consumidor confirma a mensagem. Não a coloca em retry nem na DLQ.

JSON/envelope inválido, payload inválido, carteira inexistente e conflito de
idempotência são tratados como falhas permanentes de mensagem. O consumidor
preserva o corpo original na DLQ, com atributos de motivo e ID da origem, e
somente depois confirma a mensagem original. Se enviar à DLQ ou confirmar a origem
falhar, a mensagem pode ser entregue novamente.

Outras falhas de processamento são tentadas novamente com intervalos de 5, 10,
20 e 40 segundos, usando ChangeMessageVisibility e a contagem ApproximateReceiveCount
do broker. No quinto recebimento sem sucesso, o consumidor envia à DLQ. A política
de redrive do broker oferece outra proteção caso a instância falhe antes disso.
O cálculo possui teto de 300 segundos para contagens maiores.

Falhas apenas no ack depois de um commit não são convertidas pelo consumidor em
uma nova falha financeira. A inbox continua confirmada e protege a próxima entrega.
O broker ainda pode encaminhar uma mensagem à DLQ se nunca conseguir concluí-la.
Não implementamos uma transação distribuída entre PostgreSQL e SQS: podem ocorrer
repetições, inclusive na janela entre envio à DLQ e remoção da origem.

Mensagens na DLQ permanecem auditáveis, mas este incremento não cria automaticamente
uma WagerTransaction FAILED para toda falha permanente de infraestrutura. Essa
classificação e eventual retomada operacional da DLQ continuam pendentes.

## Como publicamos a outbox

OutboxPublisherWorker consulta eventos confirmados e devidos. Abre uma transação
separada e bloqueia apenas uma linha da outbox com FOR UPDATE SKIP LOCKED.
Outro publicador pode selecionar outro evento, sem esperar por aquela linha.
Não lê eventos ainda não confirmados pela transação financeira.

O publicador envia o envelope ao SQS e marca publishedAt. Mantém o lock da outbox
durante a chamada de rede; isso simplifica a posse do trabalho, mas ocupa uma
conexão durante o envio. Os limites do cliente evitam chamadas sem prazo. Esse
lock não é o lock da carteira, e nenhuma publicação ocorre dentro da transação
financeira.

Em falha de envio, OutboxMessage incrementa tentativas e persiste nextAttemptAt,
com backoff a partir de 5 segundos e teto de 300. Não há expiração automática da
outbox: um evento confirmado não é descartado por esgotar tentativas. Cada varredura
processa até 10 itens, e há uma varredura por segundo.

Se o envio funcionar mas a marcação no banco falhar, o evento pode ser enviado
novamente. MessageDeduplicationId utiliza eventId; a deduplicação FIFO ajuda por
sua janela limitada, mas não garante unicidade indefinida. Consumidores dos eventos
precisam deduplicar persistentemente pelo eventId. Este projeto ainda não inclui
um consumidor de negócio da fila de eventos. Publicadores concorrentes também
não garantem uma ordem global de publicação dos eventos.

## Encerramento e logs

No desligamento, consumidor e publicador param de buscar novos trabalhos e
aguardam a execução ativa. O long polling é cancelado para não atrasar a parada.
Uma entrega recebida durante a parada é devolvida à visibilidade; o processamento
que já está ativo pode concluir seu commit e ack. PostgreSQL e cliente SQS são
fechados depois dessa etapa, usando os hooks do Nest.

Os logs novos são JSON, com IDs de mensagem, correlação, carteira, provedor e
transação quando disponíveis, sem registrar corpos financeiros completos. Quando
não há correlationId válido no envelope, ele é derivado de forma estável do
messageId. Logs globais da API, métricas completas e health checks permanecem
para outro incremento.

## Arquivos para estudar

| Arquivo | Responsabilidade |
| --- | --- |
| messaging.module.ts | Registra porta, transporte e workers. |
| queue.port.ts | Contrato de comunicação e nomes das filas. |
| sqs.transport.ts | Adapta AWS SDK a esse contrato. |
| parse-wager-message.ts | Valida envelope e payload recebido. |
| wager-consumer.worker.ts | Recebe, processa, confirma, reagenda ou envia à DLQ. |
| inbox-message.ts e inbox.record.ts | Estado de domínio e representação SQL da inbox. |
| outbox-message.ts | Transições de retry e publicação. |
| outbox-publisher.worker.ts | Seleção concorrente e publicação de eventos. |
| Migration20261022220000.ts | Inbox, integridade e imutabilidade das confirmações. |
| setup-queues.ts | Prepara as filas locais. |
| test-sqs/messaging.integration.spec.ts | Verificações contra PostgreSQL e LocalStack reais. |

## O que foi e o que falta validar

Os testes unitários cobrem inbox, retry/publicação e parser. A suíte HTTP/SQL
ampliada usa PostgreSQL/PGlite com transporte controlado para verificar redelivery,
atomicidade, falha após commit antes de ack, DLQ, publishers concorrentes e falha
na confirmação de publicação. Isso não substitui um broker real.

A suíte test:messaging exige PostgreSQL e LocalStack reais e possui seis cenários:
redelivery físico, janela commit/ack, mensagem inválida em DLQ, rejeição de negócio,
retry até DLQ e dois publishers enviando eventos. Os seis cenários foram aprovados em
22/10/2026 no ambiente local com PostgreSQL e LocalStack em Docker. No ambiente
do assistente, os testes SQL utilizaram PGlite e transporte controlado.

Ainda faltam os testes com três processos independentes, kill real após commit
antes de ack, interrupção de publicador e recuperação completa. As simulações
atuais não são apresentadas como prova desses cenários. README e ARCHITECTURE registram essas decisões e os limites da validação.
