# Decisões de arquitetura

Este documento registra as decisões tomadas durante o desenvolvimento do
Distributed Wagering Processor, seus motivos e as limitações conhecidas.
As decisões são acrescentadas conforme os respectivos assuntos são trabalhados.

## 1. Escolha do ORM e separação do domínio

Escolhi MikroORM para integrar a aplicação ao PostgreSQL. Além de ser a opção
preferida no desafio, ele oferece EntityManager e Unit of Work para organizar
consultas e persistência.

As regras financeiras estão em classes de domínio, sem dependência do NestJS ou
dos tipos do ORM. Para a carteira, o mapeamento foi definido separadamente em
WalletRecord e EntitySchema.

Essa separação permite testar as regras sem conexão com o banco. Em contrapartida,
exige a conversão entre os registros de persistência e os objetos do domínio.

EntityManager e Unit of Work não garantem sozinhos a segurança das movimentações.
A conexão configurada não representa uma implementação de transações financeiras
ou controle de concorrência.

## 2. Representação monetária

Escolhi decimal.js para os cálculos de Money. Os valores entram e saem como strings,
sem conversão de dinheiro para number.

Adotei um formato estrito com exatamente duas casas decimais: `"25.00"` é aceito;
`"25"`, `"25.0"`, mais de duas casas, notação científica, valores não finitos e
entradas negativas são rejeitados. Isso evita arredondar silenciosamente uma
entrada fora do formato. O cliente precisa enviar o valor já formatado.

As moedas aceitas são BRL e USD. A validação verifica o formato e a presença no
conjunto de moedas suportadas. Operações e comparações entre moedas diferentes
lançam erro de domínio. Não há conversão cambial.

Money é imutável: soma, subtração e inversão de sinal retornam novas instâncias.
Valores negativos podem surgir em cálculos internos, mas não são aceitos como
entrada pública nem como saldo de uma carteira.

O limite de magnitude é `999999999999999999.99`. Configurei um construtor
independente de decimal.js com 40 dígitos significativos. Essa precisão comporta
as somas e subtrações de dois valores dentro do intervalo adotado. Resultados
fora do limite são rejeitados.

Para a persistência, defini `NUMERIC(20, 2)` para o valor e uma coluna separada
para a moeda. O mapeamento usa `DecimalType('string')`, preservando o valor como
string no JavaScript. Essa escolha mantém o limite do domínio compatível com o
armazenamento definido.

## 3. Regras da carteira

Wallet concentra as regras de saldo. A abertura recebe o saldo inicial e define
a versão como `1`. Saldo inicial negativo é rejeitado; zero é permitido. A moeda
da carteira é obtida do saldo inicial, evitando receber moedas conflitantes em
dois campos de criação.

Créditos e débitos exigem valores positivos e moeda compatível. Um débito maior
que o saldo disponível lança InsufficientBalanceError.

Antes de alterar a carteira, a movimentação calcula o novo saldo e constrói seu
lançamento no ledger. Somente depois dessas validações atualiza saldo, versão e
data. Se a construção do lançamento falhar, o estado permanece inalterado.

A versão aumenta em cada movimentação bem-sucedida. Como esses métodos rejeitam
valor zero, cada movimentação aceita corresponde a uma mudança de saldo.

Essa ordem protege o objeto em memória. Ainda não comprova a gravação atômica da
carteira e do lançamento no banco.

## 4. Lançamentos do ledger

WalletLedgerEntry registra o valor movimentado, a direção, a carteira, a transação
de origem, os saldos anterior e posterior e a data.

O valor do lançamento deve ser positivo; a direção determina se ele é somado ou
subtraído. A factory create() verifica a equação financeira e rejeita saldos
negativos. As operações de Money também verificam a compatibilidade das moedas.

O lançamento não oferece métodos de alteração. Seus atributos são readonly e a
instância é congelada com Object.freeze(). Money já é imutável, e a data recebe
cópias defensivas.

A verificação aritmética confirma a consistência do próprio lançamento. Ela não
confirma que o saldo anterior corresponde ao banco nem impede, sozinha, um
lançamento duplicado. O congelamento do objeto também não protege registros SQL.

## 5. Criação, estados e reidratação

As classes de domínio usam construtores privados e factories para concentrar a
criação. Nos objetos com estado persistido, rehydrate() reconstrói esse estado
sem repetir ações de negócio ou regras de transição.

WagerTransaction nasce em PENDING. Adotei as seguintes transições:

| Origem                      | Destinos permitidos                            |
| --------------------------- | ---------------------------------------------- |
| PENDING                     | PENDING_REFERENCE, PROCESSED, REJECTED, FAILED |
| PENDING_REFERENCE           | PROCESSED, REJECTED, FAILED                    |
| PROCESSED, REJECTED, FAILED | Nenhum                                         |

REFUND e ROLLBACK exigem uma referência externa. Somente esses tipos podem ser
marcados como PENDING_REFERENCE. Repetir essa marcação mantém o estado de espera.

As mudanças passam por métodos explícitos. Transações finalizadas lançam
InvalidTransactionStateError quando recebem uma nova tentativa de transição.
Esse bloqueio também funciona após a reidratação.

Separei a referência recebida do provedor, referenceExternalTransactionId, da
referência interna, referenceTransactionId. A segunda é informada ao confirmar o
processamento de uma operação que exige referência. Esses métodos não consultam
o banco nem verificam sozinhos a existência e a validade da operação original.

Datas são copiadas na criação, na reidratação e nos getters. Isso impede que
alterações em um Date externo modifiquem o estado interno dos objetos.

## 6. Resultado histórico da transação

Uma transação processada guarda o saldo observado naquele processamento como um
Money imutável. markProcessed() exige esse saldo e verifica sua moeda e
não-negatividade antes de alterar o estado.

getProcessedResult() devolve o identificador da transação, o estado PROCESSED e o
saldo histórico. O método não consulta a carteira. Dessa forma, uma movimentação
posterior não muda o resultado que a transação representa.

A reidratação restaura esse saldo junto dos demais dados. Consultar o resultado
sem uma transação processada e um saldo registrado provoca erro de domínio.

A decisão prepara o resultado original para uso em replay. O armazenamento de
idempotencyKey, payloadHash e resultBalance no objeto ainda não implementa
persistência, detecção de duplicatas ou replay completo.

## 7. Códigos de falha

Defini códigos estáveis em FailureCode para identificar motivos de rejeição ou
falha, em vez de depender apenas de mensagens de texto.

| Código                           | Significado definido                            |
| -------------------------------- | ----------------------------------------------- |
| INSUFFICIENT_BALANCE             | Saldo insuficiente para uma aposta              |
| CURRENCY_MISMATCH                | Moeda incompatível                              |
| REFERENCE_NOT_FOUND              | Referência não encontrada após esgotar a espera |
| INVALID_REFERENCE                | Referência incompatível com a operação          |
| REVERSAL_INSUFFICIENT_BALANCE    | Reversão que produziria saldo negativo          |
| PERMANENT_INFRASTRUCTURE_FAILURE | Falha permanente de infraestrutura              |

reject() registra uma rejeição de negócio em REJECTED. fail() registra uma falha
permanente em FAILED. Ambos verificam se o código pertence ao enum e impedem
alterações em estados terminais.

Os códigos já estão declarados, mas a classificação completa dos erros pelo
processamento integrado ainda não existe. A classe também não restringe quais
membros do enum cada um desses dois métodos aceita.

## 8. Alcance da validação atual

As decisões de domínio foram verificadas com testes unitários. Eles cobrem
comportamentos em memória, incluindo preservação do estado em falhas, transições
e proteção das datas.

A conexão ao PostgreSQL foi verificada e a primeira migration foi gerada. Sua
aplicação não foi confirmada nesta etapa. Os testes atuais não demonstram ainda
atomicidade SQL, idempotência persistente nem segurança entre múltiplas instâncias.
