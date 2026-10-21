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
