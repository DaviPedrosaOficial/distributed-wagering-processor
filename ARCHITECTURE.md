# Decisões de arquitetura

## Escolha do ORM

Escolhi MikroORM para integrar a aplicação ao PostgreSQL.
TypeORM também é aceito pelo desafio, mas segui com MikroORM
por ser a opção preferida do enunciado e oferecer recursos
para organizar a persistência, como EntityManager e Unit of Work.

O EntityManager é o objeto usado para consultar dados e coordenar
sua persistência. A Unit of Work acompanha os objetos carregados
e suas alterações, identificando o que precisa ser inserido,
atualizado ou removido ao sincronizar com o banco.

Esses recursos ajudam a organizar operações que envolvem vários
registros. Porém, não garantem sozinhos a segurança das movimentações:
ainda precisamos definir as transações SQL, as restrições do banco
e o controle de concorrência.

## Representação monetária

Money recebe valores como strings decimais não negativas,
com exatamente duas casas, e utiliza decimal.js internamente.

Nesta implementação, as moedas suportadas são BRL e USD.
A validação verifica tanto o formato do código quanto sua
presença no conjunto de moedas aceitas.

O modelo mantém a moeda em cada valor monetário para permitir
a identificação de conflitos entre moedas nas operações.

Os valores são limitados à magnitude máxima de
999999999999999999.99, compatível com a futura persistência
em NUMERIC(20, 2).

Os cálculos utilizam um construtor independente de decimal.js
com precisão de 40 dígitos significativos, suficiente para
somas e subtrações exatas dentro desse intervalo.
Resultados fora do limite são rejeitados.

Entradas negativas são proibidas, mas resultados internos podem
ser negativos. A proibição de saldo negativo pertence à Wallet.
Soma e subtração retornam novas instâncias e exigem moedas iguais.

## Carteira e ledger

Wallet concentra as regras de movimentação do saldo. Créditos e
débitos exigem valores positivos e moeda compatível com a carteira.
Débitos sem saldo suficiente são rejeitados.

Cada movimentação constrói e valida um WalletLedgerEntry antes
de alterar saldo, versão e data de atualização da carteira.
Se a validação falhar, o estado da carteira permanece inalterado.

Os lançamentos preservam valor, direção e saldos anterior e
posterior. Sua criação valida a equação financeira, e as datas
são protegidas por cópias defensivas.

A reidratação reconstrói objetos persistidos sem repetir as
regras de criação.

Na integração com PostgreSQL, carteira e lançamento deverão
ser persistidos na mesma transação SQL. Controle de concorrência,
unicidade e imutabilidade no banco ainda serão implementados.

## Ciclo de vida das transações

WagerTransaction nasce em PENDING e controla suas transições
por métodos explícitos.

REFUND e ROLLBACK exigem uma referência externa. Durante o
processamento, essa referência será resolvida pelo par
(providerId, referenceExternalTransactionId), obtendo o
identificador interno da operação original.

PENDING_REFERENCE representa a espera pela referência.
PROCESSED, REJECTED e FAILED são estados terminais e não
permitem novas transições.

Rejeições e falhas registram um código estável. A reidratação
preserva o estado persistido e protege as datas por cópias.

A resolução de referências, a idempotência persistente e a
integração com o banco ainda serão implementadas.
