# Primeiro bloco de processamento externo

Este guia explica a base de BET, WIN e LOSS por HTTP. O incremento de referências, REFUND, ROLLBACK e worker agendado está em [GUIA-REFERENCIAS.md](GUIA-REFERENCIAS.md). Não há worker SQS, inbox ou publicador da outbox.

## Como aplicar e validar

Copie as pastas src/ e test/ deste pacote para a raiz do projeto, preservando os demais arquivos. O pacote é incremental: não remova as pastas existentes. GUIA-TRANSACOES.md é apenas material de estudo. Não contém .env nem depende de mudanças em package.json, bun.lock ou migrations.

Execute no PowerShell:

```powershell
bun run build
bun run lint
bun run test:unit
bun run db:test:prepare
bun run test:e2e
```

POSTGRES_TEST_DB precisa continuar configurado com um banco separado, terminado em _test. A suíte existente reverte e reaplica migrations nesse banco; nunca aponte para dados que deseja preservar. Não é necessário criar uma migration para este bloco.

No primeiro bloco foram validados 103 testes unitários e 31 testes de integração/HTTP. O incremento de referências amplia essa suíte. A verificação local do assistente usa PGlite; os cenários concorrentes precisam ser executados também contra seu PostgreSQL 17 no Docker. Esta suíte ainda não comprova os requisitos de três processos independentes, SQS ou recuperação após matar um worker.

## O caminho de uma aposta

1. WageringController recebe POST /wagering/transactions. O DTO valida os campos e exclui OPENING da entrada externa; os tipos de reversão foram acrescentados no incremento de referências. O header Idempotency-Key é obrigatório. O controlador recebe ou gera X-Correlation-Id.
2. ProcessTransactionService valida o valor com Money e calcula o hash do conteúdo de negócio. Uma movimentação BET ou WIN deve ser maior que zero. LOSS pode ter valor zero e nunca gera movimentação.
3. O serviço abre uma transação SQL usando um EntityManager independente. Busca a carteira com LockMode.PESSIMISTIC_WRITE, equivalente ao bloqueio de linha FOR UPDATE do PostgreSQL.
4. Depois de obter o bloqueio, procura uma operação com a mesma chave de idempotência ou a mesma identidade externa (providerId, externalTransactionId). Se já existe, compara chave e hash e devolve seu resultado persistido. Não executa wallet.debit() novamente.
5. Para uma operação nova, reconstrói Wallet a partir do registro e cria WagerTransaction. O domínio continua responsável pela aritmética e pelas transições. O serviço coordena a persistência.
6. BET chama wallet.debit(); WIN chama wallet.credit(); LOSS apenas marca a transação como processada. Saldo insuficiente e divergência de moeda produzem REJECTED com failureCode, sem ledger nem alteração da carteira.
7. Para uma operação processada, markProcessed recebe o saldo observado naquele processamento. Esse saldo vai para result_balance e será utilizado em futuros replays.
8. O primeiro flush grava a transação já PROCESSED ou REJECTED. Isso permite que o trigger do ledger encontre a operação processada quando validar seu lançamento. Ainda não ocorreu commit.
9. O serviço prepara a atualização da carteira, o ledger e os eventos na outbox. O segundo flush envia essas gravações para a mesma transação SQL.
10. O retorno de transactional confirma o commit. Somente depois disso a resposta HTTP é enviada. Uma falha em qualquer gravação reverte inclusive o primeiro flush.

## Por que o bloqueio importa

Com saldo de R$ 100 e duas apostas de R$ 80, a primeira execução bloqueia a linha da carteira. A segunda espera. Se a primeira confirma o débito, a segunda lê o saldo atualizado de R$ 20 e registra uma rejeição por saldo insuficiente.

O bloqueio é do banco, não uma variável em memória. Ele funciona entre processos que utilizem o mesmo protocolo. Não existe um bloqueio global: cada carteira tem sua própria linha. O teste com requisições simultâneas ajuda a verificar o fluxo; a prova exigida de múltiplos processos continua pendente.

A versão permanece um contador de alterações do saldo. Este bloco usa bloqueio pessimista, não usa a versão como optimistic lock. LOSS, rejeição e replay não incrementam a versão.

## Por que ainda precisamos das restrições únicas

O bloqueio da carteira organiza operações sobre a mesma carteira. Porém, duas carteiras diferentes podem receber simultaneamente a mesma chave de idempotência. As restrições únicas já existentes no banco resolvem essa disputa.

A transação perdedora recebe uma violação de unicidade e sofre rollback. O serviço então usa outro EntityManager para consultar a operação vencedora. Se a chave ou o hash divergem, responde 409. Nunca continua usando a transação SQL abortada.

Uma identidade externa já registrada com outra chave também responde conflito. A chave não é inferida nem substituída silenciosamente pelo servidor.

## Como funciona o hash

transaction-payload.ts monta explicitamente os campos de negócio: providerId, externalTransactionId, walletId, playerId, roundId, gameId, kind, money e referência quando fornecida. Ordena as chaves do objeto principal; money é construído com amount e currency nessa ordem. Como o contrato possui somente esse objeto aninhado, ambos os níveis ficam em ordem alfabética.

O resultado de JSON.stringify é convertido para SHA-256 hexadecimal em UTF-8. Idempotency-Key, correlationId, IDs de mensagem e outros campos de transporte não participam. A ordem das propriedades recebidas não altera o hash. Strings são consideradas exatamente como recebidas; não há normalização de Unicode nem remoção de espaços de identificadores. O DTO exige dinheiro no formato decimal com duas casas; representações textuais diferentes também geram hashes diferentes.

## Histórico, ledger e outbox

Considere uma carteira com saldo inicial de R$ 100. Uma aposta de R$ 25 reduz o saldo para R$ 75; depois, um prêmio de R$ 40 aumenta o saldo para R$ 115. Se o provedor reenviar o mesmo pedido da aposta já processada, o sistema não fará outro débito: devolverá o resultado original daquela operação, com saldo histórico de R$ 75, o mesmo transactionId e idempotentReplay: true. O saldo atual da carteira continuará sendo R$ 115. Esse resultado é recuperado da transação persistida, sem consultar o saldo atual para reconstruí-lo.

BET e WIN geram WagerTransactionProcessed e WalletBalanceChanged. LOSS gera apenas WagerTransactionProcessed. Uma rejeição gera WagerTransactionRejected. Esses objetos são persistidos na outbox e permanecem aguardando publicação; este código não envia mensagens a um broker.

Uma operação rejeitada também é idempotente: se foi recusada por saldo insuficiente, um depósito posterior não transforma seu replay em uma aposta aprovada. Para outra tentativa de negócio, o provedor precisa enviar outra operação com identidade própria.

## Arquivos

| Arquivo | Responsabilidade |
| --- | --- |
| src/wagering/http/submit-transaction.dto.ts | Validação do contrato HTTP deste bloco. |
| src/wagering/http/wagering.controller.ts | Recebe HTTP, encaminha ao serviço e escolhe 200 ou 422. |
| src/wagering/application/transaction-payload.ts | Contrato de negócio e cálculo determinístico do hash. |
| src/wagering/application/process-transaction.service.ts | Coordena bloqueio, idempotência, domínio e gravação atômica. |
| src/wagering/domain/wager-transaction-rejected.event.ts | Evento tipado de rejeição com versão e failureCode. |
| src/wagering/wagering.module.ts | Registra o serviço e o controlador no Nest. |
| src/app.module.ts | Importa WageringModule para ativar a rota na aplicação. |
| src/wagering/application/transaction-payload.spec.ts | Verifica ordem das chaves, campos de negócio e exclusão de transporte. |
| test/wallets.integration.spec.ts | Amplia a suíte existente com operações, replay, disputas e rollback. |

## Respostas deste bloco

| HTTP | Situação |
| --- | --- |
| 200 | Operação processada ou replay de operação processada. |
| 400 | Contrato inválido, chave ausente, valor inválido ou recurso ainda não suportado. |
| 404 | Carteira inexistente. |
| 409 | Conflito de chave/conteúdo ou identidade externa. |
| 422 | Rejeição financeira persistida, com failureCode. |
| 503 | Falha transitória reconhecida de conexão, serialização, deadlock ou indisponibilidade do PostgreSQL. |
| 500 | Falha inesperada; a transação financeira é revertida. |

O mapeamento de infraestrutura ainda não é global para todos os endpoints. Referências e reprocessamento agora estão descritos em GUIA-REFERENCIAS.md. Mensageria, consultas de transações, reconciliação e validação com múltiplos processos permanecem pendentes.
