# Distributed Wagering Processor

Serviço financeiro para processamento de operações de apostas, desenvolvido como
parte do desafio técnico de **Backend Developer da Jungle Gaming**.

O objetivo é construir uma solução que preserve a precisão dos valores e a
consistência entre saldo, transações e histórico financeiro. O projeto também
serve como experiência prática de modelagem de domínio, persistência e tratamento
de falhas, com decisões justificadas ao longo do desenvolvimento.

## Tecnologias

TypeScript em modo estrito, NestJS, Bun, MikroORM, PostgreSQL 17, decimal.js e
Docker Compose.

## Funcionalidades implementadas

- Valores monetários imutáveis, com precisão decimal e validação de moeda.
- Regras de carteira, lançamentos financeiros e estados das transações.
- Abertura e consulta de carteiras pela API HTTP.
- Abertura positiva com OPENING, ledger e eventos da outbox no mesmo commit,
  preservando a versão inicial `1`.
- Resultado histórico persistido e restrições de integridade no PostgreSQL.

O projeto está em desenvolvimento. Processamento de apostas externas, replay
completo, concorrência das movimentações, integração SQS e reconciliação ainda
não estão concluídos. Os eventos da outbox são armazenados, mas ainda não publicados.
A API atual não possui autenticação.

## Executar localmente

Requisitos: **Bun 1.x** e **Docker com Compose**. Na raiz do projeto, no PowerShell:

```powershell
bun install --frozen-lockfile
if (!(Test-Path .env)) { Copy-Item .env.example .env }
docker compose up -d
bun run db:migration:up
bun run start
```

Confira as variáveis do `.env` antes da execução. Por padrão, a API atende em
`http://localhost:3000`.

| Método | Rota | Finalidade |
| --- | --- | --- |
| POST | /wallets | Abrir carteira |
| GET | /wallets/:walletId | Consultar carteira |

Exemplo de corpo para criação:

```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "100.00", "currency": "BRL" }
}
```

## Validar

```powershell
bun run build
bun run lint
bun run test:unit
```

Para os testes HTTP e de integração, defina `POSTGRES_TEST_DB=wagering_test` no
`.env`, mantenha o PostgreSQL em execução e rode:

```powershell
bun run db:test:prepare
bun run test:e2e
```

**Use um banco separado terminado em `_test`: a suíte reverte e reaplica as
migrations, removendo os dados desse banco de testes.**

Validação realizada: **100 testes unitários e 20 testes HTTP/SQL aprovados**, com
PostgreSQL 17 em Docker, além de build e lint sem erros.

As decisões, justificativas e limitações estão em
[ARCHITECTURE.md](ARCHITECTURE.md). O passo a passo da abertura e dos comandos
está em [GUIA-ABERTURA.md](GUIA-ABERTURA.md).

Desafio de referência: [Jungle Gaming — Backend Challenge](https://github.com/junglegaming/backend-challenge).
