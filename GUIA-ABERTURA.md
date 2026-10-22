# Aplicar e entender o bloco de abertura financeira

## O que foi entregue

POST /wallets e GET /wallets/:walletId estão conectados ao PostgreSQL pelo MikroORM.
Uma abertura positiva confirma carteira, OPENING, ledger e dois eventos na outbox
na mesma transação. A carteira permanece na versão 1. Saldo zero cria apenas a
carteira. A consulta reconstrói a carteira a partir do registro do banco.

A outbox contém eventos pendentes; não existe publicação SQS neste bloco.
A persistência do saldo histórico está implementada. A deduplicação e o replay de
operações externas continuam no próximo bloco.

## 1. Aplicar no projeto do Windows

O ZIP tem os arquivos diretamente na raiz e inclui os fontes anteriores. Ele não
contém .env real, .git, node_modules, dist ou ferramentas usadas na validação.

Com o repositório no checkpoint já commitado, coloque projeto-revisao.zip na raiz
do projeto e execute no PowerShell:

```powershell
Expand-Archive -LiteralPath .\projeto-revisao.zip -DestinationPath . -Force
bun install --frozen-lockfile
```

Preserve o .env atual. Acrescente nele somente esta variável, se ainda não existir:

```dotenv
POSTGRES_TEST_DB=wagering_test
```

O banco de testes é separado do wagering_db. A suíte de integração reverte e
reaplica migrations em wagering_test e remove os dados desse banco de testes.

## 2. Validar no PostgreSQL 17 do Docker

```powershell
docker compose up -d
bun run db:debug
bun run db:migration:up
bun run db:migration:list
bun run build
bun run lint
bun run test:unit
bun run db:test:prepare
bun run test:e2e
```

Resultado esperado:

- As duas migrations aparecem aplicadas.
- Build e lint concluem sem erros.
- 100 testes unitários aprovados.
- 20 testes HTTP/SQL aprovados (18 financeiros e 2 testes básicos anteriores).

Para executar apenas os 18 testes financeiros:

```powershell
bun run test:integration
```

Nesta revisão, os testes de banco passaram em PostgreSQL embarcado via PGlite,
sem adicionar essa ferramenta às dependências do projeto. É necessário confirmar
os resultados no PostgreSQL 17 do seu Docker. Nenhum teste deste bloco demonstra
concorrência entre três instâncias ou recuperação SQS.

## 3. Ler o fluxo na ordem em que ele acontece

| Arquivo | Responsabilidade |
| --- | --- |
| src/wallets/http/create-wallet.dto.ts | Valida o corpo HTTP, sem converter dinheiro em number. |
| src/wallets/http/wallets.controller.ts | Recebe a requisição e chama o serviço. |
| src/wallets/application/prepare-wallet-opening.ts | Prepara a carteira com versão 1, OPENING e ledger em memória. |
| src/wallets/application/open-wallet.service.ts | Abre a transação SQL e persiste o conjunto completo. |
| src/database/mappers/financial-records.mapper.ts | Converte objetos do domínio em registros e reconstrói objetos com rehydrate(). |
| src/database/entities/ | Declara os campos, relações, índices e checks do ORM. |
| src/database/migrations/Migration20261022142442.ts | Converte o ID da carteira para UUID, cria as tabelas e aplica triggers de integridade. |
| test/wallets.integration.spec.ts | Comprova o fluxo HTTP, SQL, constraints e rollback. |

O serviço usa um EntityManager independente por execução. A resposta de sucesso
só é devolvida depois da confirmação da transação. Se a gravação de um evento
falhar, as demais gravações da abertura são desfeitas.

Na abertura, não utilizamos wallet.credit(): Wallet.open() já recebe o saldo
inicial. O ledger registra de onde esse saldo veio, sem incrementar a versão.

A primeira migration foi preservada. A segunda adiciona as mudanças sobre ela;
não recria a tabela wallets e não exige apagar o volume do Docker.

## 4. Experimentar a API

```powershell
bun run start:prod
```

Em outro terminal, use o exemplo PowerShell do README ou envie pelo Insomnia:

```http
POST http://localhost:3000/wallets
Content-Type: application/json
```

```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "100.00", "currency": "BRL" }
}
```

A resposta deve ter status 201, balance.amount igual a "100.00" e version igual a 1.
Use o ID retornado em GET /wallets/:walletId. Repetir a criação para o mesmo jogador
e moeda retorna 409. Essa resposta é conflito de carteira, não replay financeiro.

## 5. Commit após confirmar a validação local

```powershell
git status
git add src test scripts package.json .env.example README.md ARCHITECTURE.md GUIA-ABERTURA.md
git diff --cached --stat
git commit -m "feat: persiste abertura de carteira com ledger e outbox atomicos"
git push
```

Não adicione o ZIP baixado nem o .env real ao commit. O bun.lock foi preservado,
pois não foi adicionada dependência ao projeto.
