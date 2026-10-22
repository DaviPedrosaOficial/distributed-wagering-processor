# Decisões de arquitetura

Este documento registra as decisões já adotadas no Distributed Wagering Processor,
suas justificativas, trade-offs e limitações. A referência é o
[enunciado do desafio](https://github.com/junglegaming/backend-challenge).
Os comandos de preparação e execução estão no [README.md](README.md).

## 1. ORM e separação do domínio

Escolhi MikroORM com PostgreSQL por oferecer EntityManager e Unit of Work e por
ser a opção preferida no desafio. TypeORM também seria uma alternativa aceita.

As regras financeiras ficam em classes de domínio, com construtores privados e
factories. Os registros do ORM são definidos separadamente por classes Record e
EntitySchema. Os mappers convertem as representações e utilizam rehydrate() para
reconstruir objetos persistidos sem repetir operações de negócio.

Essa separação permite testar as regras sem infraestrutura. O custo é manter os
mapeamentos e as conversões. Neste estágio, o serviço de aplicação usa MikroORM
diretamente; ainda não há interfaces de repositório separando essa dependência.

Um fork do EntityManager por execução isola os objetos acompanhados pela Unit of
Work. Ele não substitui transações SQL nem resolve a disputa pelo saldo entre
requisições concorrentes.

## 2. Money e precisão monetária

Adotei strings decimais com exatamente duas casas na entrada e na saída e
`decimal.js` nos cálculos. Dinheiro não é convertido para `number`.

O contrato é estrito: `"25.00"` é aceito; `"25"`, `"25.0"`, valores com mais de duas
casas, notação científica, valores não finitos e entradas negativas são rejeitados.
A aplicação não arredonda entradas fora da escala. Isso exige que o cliente envie
o formato correto, mas evita alterar silenciosamente o valor solicitado.

Money é imutável: soma, subtração e inversão de sinal retornam novas instâncias.
Cálculos internos podem produzir valores negativos; os contratos de entrada e o
saldo da carteira não os aceitam. As moedas suportadas são BRL e USD, sem conversão
cambial. Operações e comparações entre moedas diferentes lançam erro de domínio.

Defini o limite de magnitude `999999999999999999.99`, compatível com
`NUMERIC(20, 2)`. O construtor independente de decimal.js usa 40 dígitos
significativos, suficientes para somar ou subtrair dois operandos desse intervalo.
Resultados fora do limite são rejeitados.

Na persistência, valor e moeda ocupam colunas separadas. `DecimalType('string')`
preserva a representação textual ao atravessar o ORM. O mapper reconstrói Money
antes de entregar valores ao domínio.

## 3. Abertura, processamento e unidade transacional

Wallet concentra as regras de saldo. Créditos e débitos exigem valor positivo e
moeda compatível; débitos sem saldo são rejeitados. Cada movimentação valida seu
lançamento antes de alterar saldo, versão e data em memória.

Para a abertura, PrepareWalletOpening constrói a carteira diretamente com o saldo
inicial e versão `1`. Quando o saldo é positivo, prepara uma operação interna
OPENING e um lançamento CREDIT, de zero até o saldo inicial. Não utiliza credit(),
que incrementaria a versão. Com saldo zero, cria somente a carteira.

Os identificadores `__internal__` e `__wallet_opening__` são convenções reservadas
à abertura. A entrada POST /wallets não permite ao cliente escolher um tipo de
transação.

OpenWalletService executa a persistência com `EntityManager.transactional()`.
Carteira, operação OPENING, ledger e eventos da outbox participam da mesma
transação SQL. O flush envia as gravações dentro dessa transação; a resposta de
sucesso é devolvida após o commit. Uma falha desfaz o conjunto por rollback.

O trade-off é que a abertura depende de todas essas gravações, inclusive da
outbox. Aceitei esse custo para não confirmar dados financeiros sem registrar
os eventos correspondentes. Nenhuma chamada a serviço externo ocorre nesse fluxo.

ProcessTransactionService aplica BET, WIN, LOSS, REFUND e ROLLBACK. BET debita,
WIN credita e LOSS registra o resultado sem alterar saldo ou gerar ledger.
BET, WIN e reversões exigem valor positivo. LOSS aceita zero ou valor positivo, mas
nunca movimenta esse valor.
Jogador e carteira precisam corresponder; moeda incompatível e saldo insuficiente
produzem rejeições persistidas, sem movimentação.

Para carteiras existentes, adotei `LockMode.PESSIMISTIC_WRITE` dentro da transação
SQL, antes da leitura utilizada no cálculo. O PostgreSQL bloqueia a linha da
carteira até commit ou rollback. Uma segunda execução sobre a mesma carteira
aguarda e utiliza o saldo confirmado pela anterior. Carteiras distintas não
compartilham esse bloqueio de linha; não há mutex global em memória.

Escolhi o bloqueio pessimista pela simplicidade de serializar a disputa pelo
saldo no banco. O custo é a espera e o uso de conexões durante a contenção; por
isso não faço chamadas externas dentro da transação. A versão é um contador de
mudanças de saldo, não um mecanismo de optimistic locking. LOSS, rejeição e replay
não a incrementam. Não há retry automático implementado para falhas de bloqueio.

Transação externa, atualização da carteira, ledger e outbox também são atômicos.
O primeiro flush grava o estado da transação, permitindo que o
trigger do ledger encontre seu estado. O segundo envia as demais gravações.
Ambos ocorrem antes do commit: uma falha posterior reverte inclusive o primeiro
flush. A resposta só sai após a conclusão de transactional().

A entrada HTTP usa execute(); o worker retoma operações por retryPending(). Ambos
utilizam o método privado apply(), evitando duplicar regras financeiras. Uma
retomada reidrata a operação existente e mantém seu transactionId. Agendamento,
transição de estado e eventos também participam da mesma transação SQL.

## 4. Garantias no PostgreSQL e imutabilidade do ledger

Defini unicidade por jogador e moeda para carteiras, por chave de idempotência e
por provedor e ID externo para transações, e por transação e carteira no ledger.
As chaves estrangeiras preservam os vínculos entre registros. Os índices compostos
por carteira, data e ID dão suporte à consulta ordenada de transações e lançamentos.

Os checks restringem moedas, intervalos monetários, versão positiva e a equação
do lançamento. Uma transação PROCESSED exige data de processamento e saldo
resultante; estados REJECTED e FAILED exigem código de falha.

No domínio, WalletLedgerEntry não oferece métodos de alteração, utiliza atributos
readonly e congela a instância. As datas são protegidas por cópias defensivas.
No banco, triggers rejeitam UPDATE, DELETE e TRUNCATE do ledger. Um trigger de
inserção verifica a correspondência com a transação processada, incluindo valor,
moeda, carteira, jogador e saldo resultante. Outro impede alterar ou excluir
transações em estados terminais.

Essas proteções são aplicadas também ao SQL executado fora do ORM. O custo é
manter SQL customizado nas migrations e revisar as alterações geradas. Elas não
substituem as regras completas de processamento de apostas e reversões.

Preservei a primeira migration e acrescentei uma segunda para converter o ID da
carteira de texto para UUID e criar as demais tabelas. Uma terceira migration cria
reference_schedules, o índice único parcial de
reversões e a validação SQL da referência processada. As três possuem up() e down().
A aplicação não sincroniza automaticamente o schema na inicialização.

O índice único (reference_transaction_id, kind), limitado a REFUND e ROLLBACK
PROCESSED, impede duas reversões processadas do mesmo tipo sobre a mesma
referência. O check exige referência interna para reversões processadas. Um
trigger valida o vínculo de uma referência processada com a identidade externa,
contexto, tipo permitido e valor integral quando aplicável.

## 5. Estados, referências e códigos de falha

WagerTransaction nasce em PENDING. Os métodos públicos controlam as transições:

| Origem | Destinos permitidos |
| --- | --- |
| PENDING | PENDING_REFERENCE, PROCESSED, REJECTED, FAILED |
| PENDING_REFERENCE | PROCESSED, REJECTED, FAILED |
| PROCESSED, REJECTED, FAILED | Nenhum |

REFUND e ROLLBACK exigem referência externa. WIN pode omiti-la; quando informada,
também pode aguardar em PENDING_REFERENCE. Repetir a marcação mantém o estado de espera.
Tentativas de
mudar um estado terminal lançam InvalidTransactionStateError, inclusive após a
reidratação.

Separei referenceExternalTransactionId, recebido do provedor, de
referenceTransactionId, o identificador interno informado após a resolução.
O modelo não consulta o banco. O serviço busca a referência por (providerId,
referenceExternalTransactionId), e referenceIsCompatible() valida mesmo provedor,
jogador, carteira, moeda e rodada. Não acrescentei igualdade de gameId, pois ela
não é exigida pelo enunciado. Referência à própria operação é inválida.

REFUND só reembolsa BET processada, com valor integral. ROLLBACK aceita BET, WIN
ou REFUND processado, também com valor integral, e aplica uma nova movimentação
inversa; não altera o ledger original. WIN referenciado exige BET processada,
mas seu valor pode ser diferente. BET e LOSS não aceitam referências.

Referências incompatíveis, rejeitadas, falhas ou já revertidas pelo mesmo tipo
geram INVALID_REFERENCE. A restrição é por tipo: uma BET pode ter um REFUND e um
ROLLBACK processados; dois REFUND ou dois ROLLBACK sobre ela são impedidos.
Uma rejeição não reserva a referência. ROLLBACK que debitaria além do saldo gera
REVERSAL_INSUFFICIENT_BALANCE, distinto da insuficiência de uma aposta.

Os códigos declarados em FailureCode são:

| Código | Significado definido |
| --- | --- |
| INSUFFICIENT_BALANCE | Saldo insuficiente para uma aposta |
| CURRENCY_MISMATCH | Moeda incompatível |
| REFERENCE_NOT_FOUND | Referência não encontrada após esgotar a espera |
| INVALID_REFERENCE | Referência incompatível com a operação |
| REVERSAL_INSUFFICIENT_BALANCE | Reversão que produziria saldo negativo |
| PERMANENT_INFRASTRUCTURE_FAILURE | Falha permanente de infraestrutura |

reject() registra rejeição de negócio; fail() registra falha permanente. Ambos
validam a existência do código no enum, mas ainda não restringem seus membros por
categoria. O fluxo integrado utiliza os códigos de negócio acima.
PERMANENT_INFRASTRUCTURE_FAILURE permanece declarado no domínio; ainda não há
classificação operacional integrada que finalize transações com esse código.

### Espera persistida e política de reprocessamento

Uma referência ausente, ou ainda não terminal e compatível, mantém a operação em
PENDING_REFERENCE. Saldo, versão e ledger não mudam. Na mesma transação SQL,
reference_schedules armazena transactionId, attempts, nextAttemptAt, expiresAt e
correlationId; a outbox recebe WagerTransactionPendingReference.

Adotei TTL de 15 minutos desde a criação, sem limite adicional por quantidade
de tentativas. O primeiro intervalo é 5 segundos; os seguintes são 10, 20, 40,
80, 160 e 300 segundos, com teto de 300. O próximo horário não ultrapassa o
vencimento. A escolha limita a espera e reduz consultas repetidas, mas é uma
política do desafio, não um SLA derivado de um provedor real.

O prazo é verificado antes da resolução na retomada: vencido o TTL, a operação
é rejeitada com REFERENCE_NOT_FOUND, mesmo que a referência tenha se tornado
disponível enquanto aguardava a próxima execução. A rejeição, seu evento e a
remoção do agendamento são atômicos. Uma referência tardia não reabre o estado
terminal. Cada sondagem sem resolução incrementa attempts e atualiza a próxima
tentativa, sem emitir outro evento de entrada em espera.

ReferenceRetryWorker consulta até 50 itens devidos por varredura, a cada segundo.
A seleção só encontra candidatos; retryPending() bloqueia carteira e agendamento,
nessa ordem, e revalida horário e estado dentro da transação. Assim, outra
execução não repete uma movimentação já confirmada nem antecipa um reagendamento.
O agendamento sobrevive ao reinício porque fica no PostgreSQL. O custo é fazer
consultas periódicas, e sob carga o processamento pode ocorrer após o horário
previsto. Falhas de infraestrutura não confirmam a tentativa; o item permanece
para nova varredura, sem uma política separada de backoff para essas falhas.

O worker roda dentro da aplicação Nest. REFERENCE_WORKER_ENABLED=false o desativa;
por padrão está habilitado. Um controle local evita sobrepor suas próprias
varreduras, enquanto os locks SQL protegem execuções de instâncias distintas.
Os hooks de desligamento interrompem novas varreduras e aguardam a ativa.
Isso ainda não implementa encerramento ou devolução de visibilidade de mensagens SQS.

## 6. Resultado histórico e identidade da operação

markProcessed() recebe o saldo observado no processamento, verifica sua moeda e
não-negatividade e o preserva como Money imutável. O valor é persistido em
result_balance e restaurado pela reidratação.

getProcessedResult() utiliza esse saldo, sem consultar a carteira atual. Assim,
uma movimentação posterior não altera o resultado original da transação.
A persistência exige esse dado nas operações processadas.

Para OPENING, defini a identidade `opening:<walletId>` e a chave
`__internal__:opening:<walletId>`. Seu payloadHash é SHA-256 sobre o JSON construído
na ordem fixa amount, currency, kind, playerId e walletId, com valores monetários
serializados como strings. Essa convenção é específica da operação interna.

Para operações externas, Idempotency-Key é obrigatório, não vazio e limitado a
255 caracteres. O serviço procura pela chave ou por (providerId,
externalTransactionId). O replay exige um único registro, a mesma chave e o mesmo
payloadHash; conteúdo diferente ou identidade externa reutilizada com outra chave
produzem conflito. Não utilizo cache em memória como garantia.

O hash externo é SHA-256 hexadecimal sobre o JSON em UTF-8 de campos explícitos:
externalTransactionId, gameId, kind, money, playerId, providerId, referência externa
quando presente, roundId e walletId. As chaves do objeto principal são ordenadas;
money é construído na ordem amount, currency. Isso ordena ambos os níveis do
contrato atual. Idempotency-Key e metadados de transporte ficam fora. As strings
são comparadas conforme recebidas, sem normalização Unicode ou remoção de espaços.
Essa canonicalização é específica deste contrato, não um algoritmo JSON genérico.

O serviço devolve result_balance da operação processada, sem consultar o saldo
atual. Considere saldo inicial de 100.00: uma aposta de 25.00 deixa 75.00, e um
prêmio posterior de 40.00 leva a carteira a 115.00. Se o provedor reenviar o mesmo
pedido daquela aposta, devolvemos seu saldo histórico de 75.00 e o mesmo
transactionId, com idempotentReplay=true. Não há outro débito: o saldo atual
continua em 115.00. Rejeições também são
repetidas com o resultado registrado; saldo posterior não as transforma em sucesso.
Enquanto aguarda referência, o replay devolve PENDING_REFERENCE e HTTP 202, sem
novo agendamento ou evento. Após a retomada, devolve o resultado terminal da mesma
transação. Portanto, uma resposta pendente pode evoluir; resultados terminais
permanecem históricos.

O bloqueio por carteira serializa as repetições sobre a mesma carteira. Para
colisões de chave entre carteiras distintas, as restrições UNIQUE decidem a
vencedora. A execução perdedora sofre rollback e consulta o registro confirmado
com outro EntityManager, pois a transação abortada não pode ser reutilizada.

## 7. Eventos e outbox

Decidi persistir WagerTransactionProcessed e WalletBalanceChanged junto da abertura
positiva. Cada um possui uma classe concreta com eventType e versão `1`, baseada
em IntegrationEvent. O envelope contém eventId, aggregateId, correlationId,
causationId, occurredAt e data.

No processamento externo, BET, WIN e reversões processadas geram
WagerTransactionProcessed e
WalletBalanceChanged; LOSS gera somente WagerTransactionProcessed. Rejeições
geram WagerTransactionRejected, incluindo um failureCode estável. Replay não cria
novos eventos nem lançamentos. A entrada em espera gera
WagerTransactionPendingReference; sua expiração gera WagerTransactionRejected.
Os eventos de espera e conclusão compartilham a correlação preservada no
agendamento, com IDs próprios e causationId da transação.

A serialização usa datas ISO e MoneyProps, sem instâncias de Money. Cópias dos
dados isolam o envelope dos objetos externos. A versão do evento identifica seu
contrato; é independente da versão financeira da carteira.

OutboxRecord guarda o envelope em JSONB, com tentativas em zero e publishedAt nulo.
A decisão preserva a intenção de publicação no mesmo commit dos dados financeiros.
Em contrapartida, a comunicação com outros serviços não ocorre imediatamente.

Ainda não existe publisher SQS, coordenação entre publishers ou recuperação de
publicações. Persistir eventos pendentes não comprova entrega distribuída.

## 8. Contratos HTTP e classificação dos resultados

DTOs validam UUID, formato monetário e campos permitidos. A validação de entrada
complementa as regras de Money; não as substitui. O filtro traduz os erros
conhecidos de criação e consulta:

| Situação | HTTP |
| --- | --- |
| Carteira criada | 201 |
| Entrada inválida | 400 |
| Carteira ausente na consulta | 404 |
| Jogador e moeda já cadastrados | 409 |
| Carteira encontrada | 200 |

A restrição UNIQUE decide a duplicidade no banco. Após sua violação, o serviço
consulta se já existe a carteira e devolve o conflito correspondente. Uma consulta
prévia, isoladamente, não impediria duas inserções concorrentes.

O X-Correlation-Id é aceito dentro do formato limitado do controller ou substituído
por um UUID gerado. Esse identificador correlaciona os eventos; não é chave de
idempotência nem autorização. Os endpoints atuais não possuem autenticação.
POST /wagering/transactions aceita BET, WIN, LOSS, REFUND e ROLLBACK.
OPENING é exclusivamente interno e o identificador de provedor `__internal__` é
reservado. Os DTOs validam referências opcionais quando presentes, rejeitando
null; o serviço exige referência para as reversões.

| Situação no processamento externo | HTTP |
| --- | --- |
| Operação processada ou replay processado | 200 |
| Operação aguardando referência ou seu replay pendente | 202 |
| Payload, valor ou chave inválidos; recurso não suportado | 400 |
| Carteira inexistente | 404 |
| Conflito de idempotência ou identidade externa | 409 |
| Rejeição financeira persistida ou seu replay | 422 |
| Falha transitória de banco reconhecida | 503 |
| Falha inesperada | 500 |

O serviço traduz exceções de conexão e os SQLSTATE 40001, 40P01, 55P03, 57014,
57P01, 57P02 e 57P03 em TRANSIENT_DATABASE_FAILURE. Erros inesperados são
propagados e provocam rollback. Esse tratamento ainda é local ao processamento,
não uma política global aplicada a todos os endpoints. Autenticação e seu ponto de
extensão continuam
pendentes; verificar o playerId não comprova a identidade de quem chama a API.

## 9. Validação e limites conhecidos

Build e lint passaram sem avisos. Foram aprovados 108 testes unitários e 44
testes HTTP/SQL no ambiente local com PostgreSQL 17 em Docker.

A suíte integrada verifica up/down das migrations, abertura positiva e zero,
versão inicial, duplicidade, precisão monetária, consulta e restrições SQL.
No processamento, cobre BET, WIN, LOSS, replay histórico, conflitos e rejeições,
além de rollback quando a outbox falha após o primeiro flush. A ampliação cobre
reversões, referências incompatíveis, WIN referenciado, chegada fora de ordem,
backoff e expiração. Também verifica chamadas concorrentes de reprocessamento,
restrição SQL de reversões, retomada por outro objeto de worker e rollback da
expiração se a outbox falhar. Os testes usam horários explícitos e desativam o
timer automático para não depender de sleeps ou esperar 15 minutos.

Os cenários concorrentes executados incluem duas apostas de 80.00 disputando
100.00, cinquenta pedidos simultâneos da mesma operação e uma chave disputada
entre carteiras. Confirmam um único débito quando aplicável. São requisições
concorrentes à mesma aplicação de teste; ainda não comprovam o cenário exigido
com três ou mais processos independentes.

O banco indicado por POSTGRES_TEST_DB é separado e deve terminar em _test,
pois a suíte reverte e reaplica migrations nele. Não há sincronização automática
do schema na inicialização.

Inbox, publicação/consumo SQS, coordenação entre publishers, recuperação após
interrupção real de processos, consultas de ledger/transações, reconciliação,
health checks e observabilidade operacional completa ainda estão pendentes.
Recriar um objeto de worker não comprova recuperação após matar um processo. Não há
alegação de atendimento integral do desafio.
