# Referências, reversões e espera persistida

Este bloco amplia o serviço existente para REFUND, ROLLBACK e WIN com referência.
As operações continuam usando a mesma transação SQL, idempotência, bloqueio por
carteira, resultado histórico e outbox. Não acrescenta SQS nem publicador de eventos.

## Aplicação do pacote

O ZIP é incremental, com src/, test/, .env.example e os guias diretamente na raiz.
Coloque-o ao lado do package.json e execute no PowerShell:

```powershell
Expand-Archive -LiteralPath .\bloco-referencias.zip -DestinationPath . -Force
bun run build
bun run lint
bun run db:migration:up
bun run test:unit
bun run db:test:prepare
bun run test:e2e
```

Não é necessário instalar dependências nem substituir seu .env. O worker é
habilitado por padrão; REFERENCE_WORKER_ENABLED=false permite desativá-lo.
A suíte usa um banco separado terminado em _test e reverte/reaplica migrations
nele. Não configure o banco de testes com dados que deseja preservar.

O pacote acrescenta Migration20261022203000 e atualiza o snapshot do schema.
Não edite nem apague as migrations anteriores. A nova migration cria o agendamento,
o índice único das reversões e a validação SQL da referência processada. Seu down
remove apenas esses acréscimos.

## O que cada operação faz

| Operação | Referência aceita | Efeito |
| --- | --- | --- |
| WIN sem referência | Nenhuma | Credita seu próprio valor. |
| WIN com referência | BET processada | Credita seu próprio valor, que pode diferir da aposta. |
| REFUND | BET processada | Credita exatamente o valor da aposta. |
| ROLLBACK de BET | BET processada | Credita o valor, invertendo o débito. |
| ROLLBACK de WIN ou REFUND | WIN ou REFUND processado | Debita o valor, invertendo o crédito. |

REFUND e ROLLBACK exigem referenceExternalTransactionId e valor positivo.
BET e LOSS não aceitam referência. OPENING continua interno. Cada referência
precisa corresponder ao mesmo provedor, jogador, carteira, moeda e rodada.
O enunciado não exige igualdade de gameId nessa validação; não a acrescentamos.

Uma reversão parcial é rejeitada. Uma referência rejeitada ou falha, um tipo
incompatível, uma referência à própria operação e um contexto divergente geram
INVALID_REFERENCE. A referência é buscada pelo par (providerId, ID externo),
portanto um ID que só existe em outro provedor permanece ausente para essa busca.

Uma referência pode ter no máximo um REFUND processado e um ROLLBACK processado.
A proteção é por tipo, conforme o enunciado: não criamos uma proibição conjunta
entre REFUND e ROLLBACK da mesma BET. Essa interpretação está coberta pelos testes.
Uma rejeição anterior não reserva a referência para sempre.

## As duas referências na prática

Imagine uma BET recebida como externalTransactionId = aposta-123, à qual nosso
banco atribui id = UUID-A. Um REFUND envia referenceExternalTransactionId = aposta-123.
O serviço busca (providerId, aposta-123), valida a BET e grava UUID-A no campo
referenceTransactionId do REFUND processado.

O provedor conhece o identificador externo. A chave estrangeira e o índice único
utilizam o interno. O rehydrate reconstrói ambos a partir do registro persistido,
sem aplicar novamente o débito ou o crédito.

## Como a espera funciona

Se a referência ainda não existe, ou existe em estado não terminal compatível:

1. WagerTransaction passa a PENDING_REFERENCE. WIN com referência também pode
   entrar nesse estado; sua referência continua opcional no contrato geral.
2. reference_schedules recebe um registro com transactionId, attempts,
   nextAttemptAt, expiresAt e correlationId.
3. Um evento WagerTransactionPendingReference é persistido na mesma transação SQL.
4. A API retorna 202. Saldo, versão e ledger permanecem iguais.

Repetir o mesmo pedido enquanto aguarda retorna 202 com idempotentReplay=true,
sem outro agendamento ou evento de espera. Quando o worker concluir, o replay
retorna o resultado terminal da mesma transação, com o mesmo transactionId.

## Política escolhida

A primeira tentativa é agendada para cinco segundos depois. Se a referência
continua ausente, os intervalos seguintes são 10, 20, 40, 80, 160 e 300 segundos;
as tentativas seguintes ficam limitadas a 300 segundos entre si.

O TTL é de 15 minutos a partir da criação da operação. Não existe um limite
adicional por quantidade de tentativas: o prazo limita a espera. O próximo horário
é limitado pelo vencimento, para permitir a rejeição na primeira varredura após
o prazo, sem mais cinco minutos de atraso. Há uma varredura por segundo, em lotes
de até 50 itens. Sob carga, uma execução pode ocorrer depois do horário agendado.

Esse prazo dá espaço a entregas fora de ordem sem manter operações pendentes
indefinidamente no contexto do teste. Não foi derivado de um SLA real do provedor.
Mudá-lo exige rever os requisitos operacionais e os testes.

Ao vencer, a operação passa a REJECTED com REFERENCE_NOT_FOUND, gera o evento de
rejeição e remove o agendamento no mesmo commit. Se a referência só chegar depois,
a rejeição não é reaberta. Uma falha SQL ou da outbox reverte essa finalização e
preserva o agendamento para outra tentativa após a recuperação.

Os eventos continuam na outbox: gerar o evento não significa publicá-lo em SQS.

## Concorrência do worker

ReferenceRetryWorker consulta itens vencidos e chama retryPending() do serviço.
A seleção inicial apenas encontra candidatos. Dentro da transação, retryPending
bloqueia primeiro a carteira e depois o agendamento. Em seguida, confere novamente
se o item existe, está vencido e a transação continua pendente.

Assim, dois workers podem selecionar o mesmo candidato, mas o segundo reavalia o
estado após obter o bloqueio. Se o primeiro já confirmou a movimentação ou
reagendou a tentativa, o segundo não a repete. O índice único sobre
(reference_transaction_id, kind), limitado a reversões PROCESSED, também impede
reversões duplicadas por SQL direto.

O agendamento não depende de um Map ou de um timer por transação em memória.
Uma nova instância consegue ler os itens persistidos. O timer de varredura local
só evita sobrepor duas varreduras da própria instância. Ao encerrar, o worker
interrompe novas varreduras e aguarda a execução ativa; main.ts habilita os hooks
de desligamento do Nest. Isso ainda não implementa desligamento de consumidor SQS.

## Organização do código

| Arquivo | Responsabilidade |
| --- | --- |
| transaction-reference.ts | Funções de domínio: compatibilidade da referência e direção da movimentação. |
| process-transaction.service.ts | Busca referência, coordena regras, bloqueios e persistência; execute recebe pedidos e retryPending retoma agendamentos. |
| reference-retry-policy.ts | Define TTL e cálculo dos intervalos. |
| reference-retry.worker.ts | Varredura periódica e retomada de itens persistidos. |
| reference-schedule.record.ts | Mapeia os dados do agendamento no PostgreSQL. |
| wager-transaction-pending-reference.event.ts | Evento tipado da entrada em espera. |
| Migration20261022203000.ts | Tabela, índice único parcial e trigger de validação da referência. |
| DTO e controller | Aceitam as novas operações e devolvem 202 para espera. |

O método privado apply() reúne a lógica usada pela entrada HTTP e pelo worker.
No reprocessamento, ele atualiza o registro pendente existente; não cria uma nova
transação. Continua gravando o estado processado antes do ledger, com dois flushes
dentro da mesma transação SQL.

Reversão que debitaria mais que o saldo disponível gera
REVERSAL_INSUFFICIENT_BALANCE. Isso distingue a falha de uma aposta sem saldo.
Em ambos os casos há rejeição auditável, sem ledger nem mudança de saldo.

## Testes e limites

A suíte adiciona cobertura de direções, valores integrais, WIN com valor próprio,
referências incompatíveis, concorrência entre reembolsos e workers, backoff,
expiração, unicidade SQL e rollback se o evento de expiração falhar.
Os testes do worker usam um horário explícito e desativam a varredura automática,
para não depender de esperar quinze minutos ou de sleeps.

A validação local do assistente utiliza PGlite. Execute os comandos no PostgreSQL
17 do Docker para confirmar também seu ambiente. A retomada por outro objeto de
worker e as chamadas simultâneas não substituem os testes ainda pendentes com
processos independentes e interrupção real de processos.

SQS, inbox, publicador da outbox, consultas adicionais, reconciliação e
observabilidade completa permanecem para os próximos blocos. README e
ARCHITECTURE serão atualizados após a revisão e validação deste incremento.
