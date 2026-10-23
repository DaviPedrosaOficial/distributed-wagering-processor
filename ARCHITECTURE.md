# Decisões de arquitetura

Revisado em 23/10/2026, incluindo consultas, diagnóstico e fechamento de recuperação de falhas.

Este documento registra as decisões já adotadas no Distributed Wagering Processor,
suas justificativas, trade-offs e limitações. A referência é o
[enunciado do desafio](https://github.com/junglegaming/backend-challenge).
Os comandos de preparação e execução estão no [README.md](README.md).
O [Mapa do Sistema](MAPA-DO-SISTEMA.md) relaciona cada seção abaixo aos arquivos
responsáveis, com um resumo de sua implementação e das ligações entre componentes.

## 1. ORM e separação do domínio

Implementação: [arquivos e responsabilidades](MAPA-DO-SISTEMA.md#1-orm-e-separação-do-domínio).

Escolhi MikroORM com PostgreSQL por oferecer EntityManager e Unit of Work e por
ser a opção preferida no desafio. TypeORM também seria uma alternativa aceita.

As regras financeiras ficam em classes de domínio, com construtores privados e
factories. Os registros do ORM são definidos separadamente por classes Record e
EntitySchema. Os mappers convertem as representações e utilizam rehydrate() para
reconstruir objetos persistidos sem repetir operações de negócio.

Essa separação permite testar as regras sem infraestrutura. O custo é manter os
mapeamentos e as conversões. Neste estágio, o serviço de aplicação usa MikroORM
diretamente; ainda não há interfaces de repositório separando essa dependência.
Na mensageria, QueuePort separa as operações de fila do adaptador SqsTransport.
Essa porta já existe; não representa uma abstração dos repositórios financeiros.

Um fork do EntityManager por execução isola os objetos acompanhados pela Unit of
Work. Ele não substitui transações SQL nem resolve a disputa pelo saldo entre
requisições concorrentes.

## 2. Money e precisão monetária

Implementação: [arquivos e responsabilidades](MAPA-DO-SISTEMA.md#2-money-e-precisão-monetária).

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

Implementação: [arquivos e responsabilidades](MAPA-DO-SISTEMA.md#3-abertura-processamento-e-unidade-transacional).

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
Quando a entrada é SQS, a confirmação da inbox integra esse mesmo commit.
O primeiro flush grava o estado da transação, permitindo que o
trigger do ledger encontre seu estado. O segundo envia as demais gravações.
Ambos ocorrem antes do commit: uma falha posterior reverte inclusive o primeiro
flush. A resposta só sai após a conclusão de transactional().

A entrada HTTP usa execute(); o worker retoma operações por retryPending(). Ambos
utilizam o método privado apply(), evitando duplicar regras financeiras. Uma
retomada reidrata a operação existente e mantém seu transactionId. Agendamento,
transição de estado e eventos também participam da mesma transação SQL.

## 4. Garantias no PostgreSQL e imutabilidade do ledger

Implementação: [arquivos e responsabilidades](MAPA-DO-SISTEMA.md#4-garantias-no-postgresql-e-imutabilidade-do-ledger).

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
reversões e a validação SQL da referência processada. A quarta acrescenta a inbox,
sua chave composta e a imutabilidade das confirmações. Todas possuem up() e down().
A aplicação não sincroniza automaticamente o schema na inicialização.

O índice único (reference_transaction_id, kind), limitado a REFUND e ROLLBACK
PROCESSED, impede duas reversões processadas do mesmo tipo sobre a mesma
referência. O check exige referência interna para reversões processadas. Um
trigger valida o vínculo de uma referência processada com a identidade externa,
contexto, tipo permitido e valor integral quando aplicável.

## 5. Estados, referências e códigos de falha

Implementação: [arquivos e responsabilidades](MAPA-DO-SISTEMA.md#5-estados-referências-e-códigos-de-falha).

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
Ao esgotar as cinco tentativas na entrada SQS, a política operacional utiliza
PERMANENT_INFRASTRUCTURE_FAILURE, conforme a seção 10. Essa classificação por
esgotamento é uma decisão da aplicação, não prova de que a dependência jamais voltará.

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
Esse worker possui ciclo de vida separado dos workers SQS descritos na seção 7.

## 6. Resultado histórico e identidade da operação

Implementação: [arquivos e responsabilidades](MAPA-DO-SISTEMA.md#6-resultado-histórico-e-identidade-da-operação).

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

## 7. Mensageria, inbox e publicação da outbox

Implementação: [arquivos e responsabilidades](MAPA-DO-SISTEMA.md#7-mensageria-inbox-e-publicação-da-outbox).

### Transporte e filas

Adotei AWS SDK v3 para SQS via LocalStack no Docker Compose. QueuePort define as
operações utilizadas pelos workers; SqsTransport adapta o SDK. A separação permite
controlar falhas nos testes sem substituir a validação contra broker real.
LocalStack está fixado em 4.0.3; a porta 4566 fica limitada ao host local. Não há
garantia implementada de persistência das filas após recriar o container local.

O script queues:setup cria wager-transactions.fifo, wager-transactions-dlq.fifo e
wager-events.fifo. A terceira recebe os eventos publicados. Configurei redrive da
entrada para a DLQ após cinco recebimentos. FIFO ajuda na ordenação por carteira,
mas o banco continua responsável por idempotência e correção financeira.

Consumidor e publicador só iniciam com MESSAGING_ENABLED=true. Sem isso, a API pode
processar e acumular outbox. Separar essa configuração facilita testes e execução
local; readiness verifica separadamente o acesso ao PostgreSQL e às três filas,
mesmo com os workers desativados.

### Inbox e confirmação após o commit

A mensagem contém messageId, type, occurredAt e data, incluindo idempotencyKey.
O parser valida o envelope e reutiliza o DTO HTTP. O consumidor chama o mesmo
ProcessTransactionService, fornecendo contexto opcional de inbox. Não existe uma
segunda implementação das regras financeiras para SQS.

A chave da inbox é (consumerName, messageId do envelope). O consumidor atual se
chama wager-transactions-v1. O ID do broker é usado no diagnóstico e no envio à
DLQ; o ReceiptHandle da entrega atual é usado para ack e visibilidade.

InboxMessage encapsula recebimento e confirmação; InboxRecord persiste identidade,
datas, hash e resultado em JSONB. O hash é SHA-256 do JSON [payloadHash,
idempotencyKey], para detectar também mudança da chave no mesmo messageId.
Uma confirmação existente com conteúdo diferente gera conflito. A chave primária
composta e um trigger de imutabilidade reforçam a proteção no PostgreSQL.

A inbox é confirmada na mesma transação SQL de saldo, transação, ledger e outbox.
Até um replay de operação criada por HTTP pode confirmar uma nova inbox sem
repetir a movimentação. Falhar na inbox após flushes financeiros reverte tudo.
Somente após execute() concluir o commit o consumidor executa DeleteMessage.

Se ocorrer redelivery depois do commit e antes do ack, a inbox devolve o resultado
registrado sem outro efeito financeiro. IDs de mensagem diferentes continuam
sujeitos à idempotência da operação. Para PENDING_REFERENCE, o aceite e o
agendamento são persistidos antes do ack; o worker de referências assume a
continuidade. A inbox conserva o resultado de seu recebimento, não consulta o
saldo atual para reconstruí-lo.

### Visibilidade, retry e DLQ

Cada instância recebe uma mensagem por vez, com long polling de até 10 segundos.
A visibilidade começa em 30 segundos e é renovada a cada 10 enquanto processa.
Isso reduz redelivery durante operações lentas, mas não substitui locks e inbox.
O custo é limitar o paralelismo por instância; outras instâncias podem avançar
sobre carteiras distintas. Produtores devem usar walletId como MessageGroupId.

Rejeições financeiras recebem ack, pois já são resultados auditáveis no banco.
Mensagens inválidas, carteira inexistente e conflitos permanentes são enviados à
DLQ com corpo original e atributos de motivo/origem. A origem só é confirmada
após o envio. Não há atomicidade entre esse envio e a remoção: a DLQ também pode
receber repetições se houver falha nessa janela.

Outras falhas usam ChangeMessageVisibility com intervalos de 5, 10, 20 e 40
segundos. No quinto recebimento sem processamento confirmado, o consumidor envia
à DLQ. A contagem vem de ApproximateReceiveCount, não de memória da aplicação.
O cálculo limita intervalos a 300 segundos para contagens maiores, e o redrive
do broker oferece proteção quando a instância falha antes do encaminhamento.

Falha apenas no ack após commit mantém a inbox confirmada e permite redelivery
seguro; não transforma o resultado financeiro em uma nova falha. Mensagens na
DLQ são preservadas. O registro automático de FAILED quando o banco responde está
detalhado na seção 10; não há retomada administrativa automática da DLQ.

### Eventos e publicador concorrente

Os eventos concretos herdam IntegrationEvent, têm eventType e versão 1. O envelope
contém eventId, aggregateId, correlationId, causationId, occurredAt e data. Datas
são ISO e dinheiro usa MoneyProps, sem instâncias de Money. Cópias defensivas
isolam os dados. A versão do evento é independente da versão da carteira.

Abertura positiva, BET, WIN e reversões processadas geram WagerTransactionProcessed
e WalletBalanceChanged. LOSS gera somente WagerTransactionProcessed. Rejeições
geram WagerTransactionRejected. A entrada em espera gera
WagerTransactionPendingReference; sua expiração gera rejeição. Replay não cria
novos eventos nem lançamentos.

OutboxRecord persiste o envelope no commit financeiro. OutboxPublisherWorker lê
apenas eventos confirmados e devidos e bloqueia uma linha por transação com
FOR UPDATE SKIP LOCKED. Assim, outro publicador seleciona outro evento. A chamada
SQS ocorre nessa transação separada da outbox, sem lock financeiro da carteira.
Mantê-la durante o envio simplifica a posse do trabalho, ao custo de ocupar uma
conexão e um lock durante a rede; o cliente usa prazos de conexão/requisição.

Após o envio, marca publishedAt. Em falha, OutboxMessage incrementa attempts e
persiste nextAttemptAt com backoff de 5 segundos até 300. Não há descarte por
limite de tentativas: um evento financeiro confirmado permanece recuperável.
A varredura ocorre a cada segundo, com até dez itens por rodada.

Se o SQS aceitar e a marcação SQL falhar, pode haver outra publicação. O mesmo
eventId é usado como MessageDeduplicationId. A deduplicação FIFO possui janela
limitada; consumidores dos eventos precisam deduplicar persistentemente pelo
eventId. Ainda não existe consumidor de negócio da fila de eventos no projeto.
Publicadores concorrentes não garantem ordem global de publicação. A garantia
adotada é entrega com possíveis repetições, não exactly-once entre banco e broker.

### Encerramento e diagnóstico

Consumidor e publicador interrompem novas buscas e aguardam trabalho ativo antes
de fechar dependências. O long polling é cancelado; uma entrega recebida durante
a parada pode ter visibilidade devolvida, enquanto uma já em processamento pode
concluir commit e ack. Os hooks estão habilitados no Nest. Essa proteção não
impede interrupção forçada; nesse caso a recuperação depende de banco e broker.

Os logs dos workers são JSON com IDs disponíveis de correlação, mensagem,
transação, carteira e provedor, sem corpos financeiros completos. Quando não há
correlação válida no envelope, ela é derivada de forma estável do messageId.
O bloco de diagnóstico acrescenta logs HTTP, métricas e health checks, descritos
na seção 9. Os logs padrão de inicialização do Nest mantêm o formato do framework.

## 8. Contratos HTTP e classificação dos resultados

Implementação: [arquivos e responsabilidades](MAPA-DO-SISTEMA.md#8-contratos-http-e-classificação-dos-resultados).

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
idempotência nem autorização. Os endpoints financeiros utilizam ProviderAuthGuard no-op: o ponto de extensão
está explícito, mas ainda não autentica nem autoriza chamadas.
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
| Replay de FAILED terminal, com failureCode persistido | 500 |
| Falha inesperada | 500 |

O serviço traduz exceções de conexão e os SQLSTATE 40001, 40P01, 55P03, 57014,
57P01, 57P02 e 57P03 em TRANSIENT_DATABASE_FAILURE. Erros inesperados são
propagados e provocam rollback. O filtro global também traduz exceções do driver SQL em 503 quando transitórias
ou 500 nos demais casos, sem expor SQL. A decisão de não implementar autenticação e seu ponto de extensão estão na
seção 10; verificar playerId não comprova a identidade de quem chama a API.

## 9. Consultas, reconciliação e observabilidade — 23/10/2026

Implementação: [arquivos e responsabilidades](MAPA-DO-SISTEMA.md#9-consultas-reconciliação-e-observabilidade).

### Consultas e paginação do ledger

Separei as leituras em WalletQueriesService e TransactionQueriesService. Consultar
não executa novamente operações de domínio. A transação é localizada pelo UUID ou
por (providerId, externalTransactionId), utilizando a unicidade existente. A resposta
preserva result_balance e não expõe payloadHash nem chave de idempotência.

O ledger usa paginação por chave, com ordem crescente (created_at, id), limite
padrão 50 e máximo 100. O ID desempata datas iguais. Escolhi esse formato para
continuar a leitura sem percorrer um offset crescente. O cursor contém versão,
carteira e ID da última entrada em base64url; formato, carteira e existência do
registro são validados. Ele não é criptografado, assinado ou uma autorização.

O SQL recupera a data diretamente da entrada usada como âncora, preservando a
precisão do PostgreSQL em vez de reconstruí-la com Date. A imutabilidade do ledger
mantém essa âncora estável. O custo é uma consulta vinculada ao registro anterior.
Não há snapshot congelado entre páginas: inserções retroativas anteriores à âncora
não serão revisitadas, e novas entradas posteriores podem aparecer.

### Reconciliação sem reparo automático

Adotei uma única instrução SELECT para comparar o saldo materializado com a soma
dos créditos menos os débitos, incluindo o crédito de abertura. O snapshot da
instrução evita comparar metades de uma movimentação concorrente, cujas gravações
são atômicas. A soma ocorre em NUMERIC; decimal.js formata strings com duas casas,
sem converter dinheiro para number.

O resultado apresenta saldo armazenado, calculado, diferença, quantidade de
lançamentos e conflitos de moeda. consistent exige diferença zero e nenhum
conflito de moeda. Uma carteira aberta com zero e sem lançamentos reconcilia em zero.
Escolhi somente detectar: divergências geram resposta, log e métrica, sem corrigir
saldo ou modificar ledger. Uma correção automática exigiria uma decisão financeira
que este endpoint não possui autorização para tomar.

### Saúde, métricas e correlação

GET /health/live responde sem acessar dependências, distinguindo processo vivo de
infraestrutura disponível após a inicialização. GET /health/ready verifica SELECT 1
e acesso às três filas; retorna 503 se alguma verificação falhar. O adaptador SQS
limita sua verificação a três segundos e não consome mensagens. Mesmo com workers
desativados, readiness verifica o broker configurado.

GET /metrics expõe texto Prometheus. Contadores e histograma são locais ao processo
e reiniciam com ele: resultados, replays, retries por origem, DLQ, falhas de lock,
reconciliação, respostas HTTP e duração. São diagnóstico, nunca idempotência ou
auditoria durável. A contagem de conflitos inclui exceções reconhecidas de lock,
deadlock e serialização; não mede espera normal por lock.

Gauges consultam estados persistidos, quantidade de eventos pendentes e idade do
mais antigo. Como representam dados compartilhados, não devem ser somados
cegamente entre réplicas. /metrics depende do banco para obtê-los. Não acrescentei
dashboard ou OpenTelemetry; o formato permite coleta externa sem nova dependência.

Um interceptor global aceita ou gera X-Correlation-Id, devolve o header e registra
JSON com método, caminho, status, duração e IDs disponíveis. O serviço financeiro
registra seu resultado após o commit. Não registro corpo financeiro completo,
valores monetários nem headers de autenticação. Correlação é diagnóstico, não
identidade autenticada nem chave de idempotência.

Essas decisões não exigiram migration, alteração de schema ou dependência nova.

## 10. Autenticação e recuperação operacional — 23/10/2026

Implementação: [arquivos e responsabilidades](MAPA-DO-SISTEMA.md#10-autenticação-e-recuperação-operacional).

### Autenticação deixada como extensão explícita

Optei por não integrar um IdP no tempo do desafio, priorizando correção financeira,
concorrência e recuperação, conforme a opção aceita no enunciado. ProviderAuthGuard
está aplicado aos três controllers financeiros e registrado em seus módulos.
É deliberadamente no-op: permite chamadas e não valida identidade. Não criei
tabela de usuários, senha ou autenticação artesanal. Esse ponto não torna a API
segura para exposição pública.

O desenho adotado como extensão é um IdP externo OIDC, por exemplo Keycloak,
validando assinatura por JWKS, issuer, audience e expiração do token. Uma claim
confiável identificaria o provedor, que precisaria corresponder ao providerId do
pedido ou da rota. Consultas por carteira/ID interno também exigiriam autorização
sobre o recurso, não apenas token válido. Não implementei esse desenho: o guard
indica onde iniciar sua integração. Health permanece aberto e SQS é canal interno,
com os mesmos controles de contexto e regras de domínio.

### Esgotamento de retries, FAILED e DLQ

Adotei cinco recebimentos para encerrar retries da mensagem SQS. Após uma falha
operacional sem resultado devolvido, o quinto recebimento chama
recordPermanentFailure(). Ele reutiliza validações, identidade, hash, locks e
confirmação de inbox do processamento, mas não executa movimentações financeiras.

O serviço primeiro verifica inbox e transação existentes. Se uma tentativa confirmou
o commit e perdeu sua resposta, recupera esse resultado, sem mudar sucesso em falha.
Uma operação já em espera mantém seu agendamento independente. Apenas uma operação
nova e válida é criada e finalizada em FAILED com
PERMANENT_INFRASTRUCTURE_FAILURE. Transação, inbox e WagerTransactionFailed na
outbox são atômicos. Não há ledger nem incremento da versão. Resultado terminal
permanece imutável; replay HTTP retorna 500 com status FAILED e código persistido,
distinto de indisponibilidade transitória 503.

Após registrar FAILED, o consumidor publica o pedido original na DLQ e só então
remove a origem. Se esse envio falhar, a redelivery reconhece FAILED pela inbox,
repete o envio à DLQ com a mesma identidade de deduplicação e tenta o ack. Isso
evita perder a mensagem entre auditoria SQL e DLQ. Como banco e SQS não compartilham
transação, continuam possíveis repetições no transporte.

Se o banco estiver indisponível, ou impedir também a gravação da falha/outbox, não
há como prometer auditoria SQL. O consumidor preserva o pedido na DLQ e registra
sqs_failure_audit_unavailable, sem declarar um registro inexistente. Não há worker
que reconcilie automaticamente a DLQ para SQL; a investigação é manual. Mensagens
inválidas vão à DLQ sem inventar uma WagerTransaction válida. A outbox continua
retentando sem descarte, pois seus eventos financeiros já estão confirmados.

### Provas com processos separados

A suíte test:recovery inicia processos Bun independentes com o código compilado.
Três APIs utilizam portas livres e compartilham apenas PostgreSQL e broker.
São verificados disputa de saldo, 50 repetições, carteiras distintas e replay após
encerrar e recriar uma API, sempre confrontando saldo e ledger.

As fixtures usam o consumidor e o publicador reais com um adaptador SQS derivado
somente para pausar em fronteiras específicas. Na primeira, execute() já confirmou
a inbox e a execução para antes de DeleteMessage. Na segunda, SendMessage já foi
aceito e a transação de marcação da outbox permanece aberta. O processo é encerrado
à força; outra instância retoma o trabalho. Não há flags de falha na API de produção.
No teste de publishers, uma barreira de início mantém ambos vivos antes de liberar
seu trabalho. A referência fora de ordem é retomada por um worker independente
após a morte da API que recebeu a operação pendente.

O teste de publicação também força duas entregas do mesmo eventId com identidades
de transporte distintas, evitando depender da janela FIFO. Um consumidor
exclusivo da suíte insere recibo e aplica um efeito demonstrativo na mesma transação;
a unicidade durável do eventId permite apenas uma aplicação. São tabelas de teste,
não novas tabelas/migrations ou um consumidor de negócio da aplicação.

Esses testes requerem PostgreSQL e LocalStack reais. Compilar as fixtures ou
executá-las com PGlite só verifica funcionamento auxiliar, não comprova os locks
ou a recuperação distribuída exigidos no desafio.

## 11. Validação e limites conhecidos

Implementação: [arquivos e responsabilidades](MAPA-DO-SISTEMA.md#11-validação-e-limites-conhecidos).

Validação registrada em 23/10/2026:

| Suíte | Resultado | Ambiente |
| --- | --- | --- |
| Unitários | 117 aprovados, zero falhas | Bun 1.4.3, desenvolvimento local |
| HTTP/SQL | 66 aprovados, zero falhas | Windows, PostgreSQL 17 em Docker e transporte controlado |
| Mensageria | 7 aprovados, zero falhas | Windows, PostgreSQL e LocalStack em Docker |
| Processos e recuperação | 4 aprovados, zero falhas | Windows, processos Bun separados, PostgreSQL e LocalStack em Docker |

Build e lint passaram no ambiente de desenvolvimento. PGlite também foi utilizado
como apoio durante a implementação, mas não é apresentado como substituto das
execuções em PostgreSQL e SQS reais confirmadas acima.

Os testes unitários cobrem precisão monetária, regras e invariantes do domínio,
estados, identidade de payload e políticas de retry. A suíte HTTP/SQL verifica
migrations reversíveis, constraints, abertura com versão 1, operações, referências,
replay e rollback. Usa transporte controlado para provocar falhas em inbox, outbox,
ack e publicação, verificando atomicidade e recuperação. Também cobre paginação,
resultado histórico, reconciliação concorrente, correlação, métricas, readiness e
registro de FAILED sem movimento financeiro.

Os sete casos de mensageria exercitam filas reais: redelivery com o mesmo messageId,
retomada após commit sem ack, mensagem inválida em DLQ, ack de rejeição financeira,
retry até DLQ, publicadores concorrentes e readiness. A janela commit/ack nessa
suíte é simulada; a prova com encerramento de processo fica na suíte seguinte.

Os quatro cenários de processos e recuperação passaram em 23/10/2026:

1. Três APIs independentes disputaram saldo; 50 repetições produziram um débito,
   carteiras distintas avançaram e o replay funcionou após reiniciar uma API.
2. Um consumidor foi encerrado após commit e antes de ack. Outra instância recebeu
   a mensagem após a visibilidade de 30 segundos, sem novo débito ou incremento de versão.
3. Um publicador foi encerrado após envio ao SQS e antes de confirmar a marcação.
   Dois processos retomaram a outbox. Entregas repetidas do mesmo eventId produziram
   somente um efeito no consumidor demonstrativo com deduplicação persistida.
4. Uma operação aguardando referência sobreviveu à morte da API; outro processo
   resolveu a pendência e manteve o ID original e a consistência financeira.

A suíte de processos confronta os saldos com o ledger nos cenários exercitados.
Não trata recriar um objeto como reiniciar um processo. Os pontos de pausa são
exclusivos das fixtures; não há comandos de interrupção no código de produção.
A demonstração de deduplicação de eventos usa tabelas exclusivas de teste e não
representa um consumidor de negócio implementado na aplicação.

POSTGRES_TEST_DB deve apontar para banco exclusivo terminado em _test. A suíte
HTTP/SQL reverte e reaplica migrations nele. As suítes SQS e de recuperação criam
filas próprias e as removem ao finalizar. As suítes devem rodar em sequência, sem
workers externos usando o banco de testes.

Limitações assumidas: autenticação permanece desativada com extensão explícita;
não há recuperação automática da auditoria SQL a partir da DLQ nem consumidor de
negócio dos eventos. Métricas por processo reiniciam com a instância, não há garantia
de ordem global de publicação e a paginação não congela um snapshot entre páginas.
Não foram realizados teste de carga, dashboard ou integração OpenTelemetry.
Os resultados confirmam os cenários descritos; não são uma certificação de produção.
