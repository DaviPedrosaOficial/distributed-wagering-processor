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

## 3. Abertura financeira e unidade transacional

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

Essa estratégia foi validada para a abertura. Não há ainda estratégia implementada
de bloqueio ou retry para movimentações concorrentes de uma carteira existente.
A versão, sozinha, não constitui optimistic locking.

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
carteira de texto para UUID e criar as demais tabelas. Ambas possuem up() e down().
A aplicação não sincroniza automaticamente o schema na inicialização.

## 5. Estados, referências e códigos de falha

WagerTransaction nasce em PENDING. Os métodos públicos controlam as transições:

| Origem | Destinos permitidos |
| --- | --- |
| PENDING | PENDING_REFERENCE, PROCESSED, REJECTED, FAILED |
| PENDING_REFERENCE | PROCESSED, REJECTED, FAILED |
| PROCESSED, REJECTED, FAILED | Nenhum |

REFUND e ROLLBACK exigem referência externa. Somente esses tipos podem entrar em
PENDING_REFERENCE. Repetir a marcação mantém o estado de espera. Tentativas de
mudar um estado terminal lançam InvalidTransactionStateError, inclusive após a
reidratação.

Separei referenceExternalTransactionId, recebido do provedor, de
referenceTransactionId, o identificador interno informado após a resolução.
O modelo não consulta o banco nem comprova sozinho a validade da referência.

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
categoria. A classificação integrada, a resolução de referências e a política de
espera/reprocessamento não estão implementadas. O código REFERENCE_NOT_FOUND não
significa que já exista um worker ou um limite de tentativas definido.

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

As unicidades do banco e o resultado histórico preparam a integração com
idempotência, mas não implementam replay completo. A canonicalização de payloads
externos, sua comparação e a devolução de respostas repetidas ainda não existem.

## 7. Eventos e outbox da abertura

Decidi persistir WagerTransactionProcessed e WalletBalanceChanged junto da abertura
positiva. Cada um possui uma classe concreta com eventType e versão `1`, baseada
em IntegrationEvent. O envelope contém eventId, aggregateId, correlationId,
causationId, occurredAt e data.

A serialização usa datas ISO e MoneyProps, sem instâncias de Money. Cópias dos
dados isolam o envelope dos objetos externos. A versão do evento identifica seu
contrato; é independente da versão financeira da carteira.

OutboxRecord guarda o envelope em JSONB, com tentativas em zero e publishedAt nulo.
A decisão preserva a intenção de publicação no mesmo commit dos dados financeiros.
Em contrapartida, a comunicação com outros serviços não ocorre imediatamente.

Ainda não existe publisher SQS, coordenação entre publishers ou recuperação de
publicações. Persistir eventos pendentes não comprova entrega distribuída.

## 8. Contrato HTTP da carteira

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
O tratamento HTTP dos demais fluxos ainda não está definido.

## 9. Validação e limites conhecidos

Build e lint passaram. Foram aprovados 100 testes unitários e 20 testes HTTP/SQL
no ambiente local com PostgreSQL 17 em Docker.

A suíte integrada verifica up/down das migrations, abertura positiva e zero,
versão inicial, duplicidade, precisão monetária, consulta, resultado histórico,
restrições SQL e rollback quando a outbox falha. O banco indicado por
POSTGRES_TEST_DB é separado e deve terminar em _test, pois a suíte reverte e
reaplica migrations nele.

Essa validação cobre a abertura financeira. Processamento externo de apostas,
replay completo, concorrência entre múltiplas instâncias, referências fora de
ordem, inbox, publicação/consumo SQS, reconciliação e observabilidade operacional
ainda não foram concluídos. Não há alegação de atendimento integral do desafio.
