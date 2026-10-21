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
