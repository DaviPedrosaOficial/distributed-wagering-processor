import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { MikroORM } from "@mikro-orm/postgresql";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { integrationConfig } from "./integration-config.js";
import { WalletsModule } from "../src/wallets/wallets.module.js";
import { WalletRecord } from "../src/database/entities/wallet.record.js";
import { WalletLedgerRecord } from "../src/database/entities/wallet-ledger.record.js";
import { WagerTransactionRecord } from "../src/database/entities/wager-transaction.record.js";
import { OutboxRecord } from "../src/database/entities/outbox.record.js";
import { transactionFromRecord } from "../src/database/mappers/financial-records.mapper.js";
import { WagerTransactionKind, WagerTransactionStatus, } from "../src/wagering/domain/wager-transaction.js";
import { LedgerDirection } from "../src/wallets/domain/wallet-ledger-entry.js";
import { OpenWalletService } from "../src/wallets/application/open-wallet.service.js";

describe("Abertura de carteira (integração PostgreSQL)", () => {
  let app: INestApplication;
  let orm: MikroORM;
  const body = (
    playerId: string = randomUUID(),
    amount = "100.00",
    currency = "BRL",
  ) => ({ playerId, initialBalance: { amount, currency } });
  const api = () => request(app.getHttpServer());
  const expectRejection = async (operation: Promise<unknown>) => {
    let rejected = false;
    try {
      await operation;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [MikroOrmModule.forRoot(integrationConfig()), WalletsModule],
    }).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    orm = app.get(MikroORM);
    // Somente no banco dedicado *_test: comprova down/up das duas migrations.
    await orm.migrator.up();
    await orm.migrator.down({ to: 0 });
    await orm.migrator.up();
    await app.init();
  }, 30000);

  afterAll(async () => {
    if (app) await app.close();
  });

  test("deve aplicar e reverter migrations sem pendências", async () => {
    expect(await orm.migrator.getPending()).toHaveLength(0);
    expect(await orm.migrator.getExecuted()).toHaveLength(2);
  });

  test("deve salvar carteira, OPENING, ledger e dois eventos com versão 1", async () => {
    const input = body();
    const response = await api()
      .post("/wallets")
      .set("x-correlation-id", "opening-integration")
      .send(input)
      .expect(201);
    expect(response.body).toMatchObject({
      playerId: input.playerId,
      balance: input.initialBalance,
      version: 1,
    });
    const id = response.body.id as string;
    const em = orm.em.fork();
    const wallet = await em.findOneOrFail(WalletRecord, { id });
    const transaction = await em.findOneOrFail(WagerTransactionRecord, {
      walletId: id,
    });
    const entry = await em.findOneOrFail(WalletLedgerRecord, { walletId: id });
    const events = await em.find(OutboxRecord, { aggregateId: id });
    expect(wallet.balance).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(transaction.kind).toBe(WagerTransactionKind.Opening);
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.resultBalance).toBe("100.00");
    expect(entry.transactionId).toBe(transaction.id);
    expect(entry.balanceBefore).toBe("0.00");
    expect(entry.balanceAfter).toBe(wallet.balance);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(events.map((event) => event.eventType).sort()).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    for (const event of events) {
      expect(event.payload.correlationId).toBe("opening-integration");
      expect(event.publishedAt).toBeNull();
    }
    // Novo EM e consulta SQL: o resultado não depende da instância original.
    const restoredRecord = await orm.em
      .fork()
      .findOneOrFail(WagerTransactionRecord, { id: transaction.id });
    expect(
      transactionFromRecord(restoredRecord).getProcessedResult().balance.amount,
    ).toBe("100.00");
    await api().get(`/wallets/${id}`).expect(200).expect(response.body);
  });

  test("deve abrir com zero sem registros financeiros ou eventos", async () => {
    const response = await api()
      .post("/wallets")
      .send(body(randomUUID(), "0.00"))
      .expect(201);
    const id = response.body.id as string;
    const em = orm.em.fork();
    expect(response.body.version).toBe(1);
    expect(await em.count(WagerTransactionRecord, { walletId: id })).toBe(0);
    expect(await em.count(WalletLedgerRecord, { walletId: id })).toBe(0);
    expect(await em.count(OutboxRecord, { aggregateId: id })).toBe(0);
  });

  test("deve rejeitar jogador e moeda duplicados sem novos registros", async () => {
    const input = body();
    const response = await api().post("/wallets").send(input).expect(201);
    const conflict = await api().post("/wallets").send(input).expect(409);
    expect(conflict.body.code).toBe("WALLET_ALREADY_EXISTS");
    const em = orm.em.fork();
    expect(await em.count(WalletRecord, { playerId: input.playerId })).toBe(1);
    expect(
      await em.count(WagerTransactionRecord, { walletId: response.body.id }),
    ).toBe(1);
  });

  test("deve aceitar outra moeda para o mesmo jogador", async () => {
    const playerId = randomUUID();
    await api().post("/wallets").send(body(playerId)).expect(201);
    await api()
      .post("/wallets")
      .send(body(playerId, "10.00", "USD"))
      .expect(201);
    expect(await orm.em.fork().count(WalletRecord, { playerId })).toBe(2);
  });

  test.each(["25", "25.001", "-1.00", "1e2", "1000000000000000000.00"])(
    "deve rejeitar o valor HTTP %s",
    async (amount) => {
      const input = body(randomUUID(), amount);
      await api().post("/wallets").send(input).expect(400);
      expect(
        await orm.em.fork().count(WalletRecord, { playerId: input.playerId }),
      ).toBe(0);
    },
  );

  test("deve rejeitar corpo incompleto, UUID inválido e campos extras", async () => {
    await api().post("/wallets").send({ playerId: randomUUID() }).expect(400);
    await api().post("/wallets").send(body("invalid")).expect(400);
    await api()
      .post("/wallets")
      .send({ ...body(), kind: "OPENING" })
      .expect(400);
  });

  test("deve distinguir carteira ausente de identificador inválido", async () => {
    await api().get(`/wallets/${randomUUID()}`).expect(404);
    await api().get("/wallets/not-a-uuid").expect(400);
  });

  test("deve preservar centavos perto do limite do NUMERIC", async () => {
    const amount = "999999999999999999.99";
    const response = await api()
      .post("/wallets")
      .send(body(randomUUID(), amount))
      .expect(201);
    expect(response.body.balance.amount).toBe(amount);
    const wallet = await orm.em
      .fork()
      .findOneOrFail(WalletRecord, { id: response.body.id });
    expect(wallet.balance).toBe(amount);
  });

  test("deve desfazer todas as gravações se a outbox falhar", async () => {
    const input = body();
    const em = orm.em.fork();
    const before = await em.count(OutboxRecord, {});
    const connection = em.getConnection();
    await connection.execute(
      `create function test_fail_outbox() returns trigger language plpgsql as $$ begin raise exception 'Falha simulada da outbox'; end; $$;`,
    );
    await connection.execute(
      `create trigger test_fail_outbox before insert on outbox_messages for each row execute function test_fail_outbox();`,
    );
    try {
      const service = app.get(OpenWalletService);
      await expectRejection(service.execute(input, "rollback-test"));
      const fresh = orm.em.fork();
      expect(
        await fresh.count(WalletRecord, { playerId: input.playerId }),
      ).toBe(0);
      expect(
        await fresh.count(WagerTransactionRecord, { playerId: input.playerId }),
      ).toBe(0);
      expect(await fresh.count(OutboxRecord, {})).toBe(before);
      const orphan = await connection.execute(
        `select count(*)::int as total from wallet_ledger l left join wallets w on w.id = l.wallet_id where w.id is null`,
      );
      expect(orphan[0].total).toBe(0);
    } finally {
      await connection.execute(
        "drop trigger test_fail_outbox on outbox_messages",
      );
      await connection.execute("drop function test_fail_outbox()");
    }
  });

  test("deve bloquear UPDATE, DELETE e TRUNCATE do ledger no banco", async () => {
    const response = await api().post("/wallets").send(body()).expect(201);
    const connection = orm.em.getConnection();
    const id = response.body.id;
    await expectRejection(
      connection.execute(
        "update wallet_ledger set amount = amount where wallet_id = ?",
        [id],
      ),
    );
    await expectRejection(
      connection.execute("delete from wallet_ledger where wallet_id = ?", [id]),
    );
    await expectRejection(connection.execute("truncate wallet_ledger"));
    expect(
      await orm.em.fork().count(WalletLedgerRecord, { walletId: id }),
    ).toBe(1);
  });

  test("deve bloquear saldo negativo mesmo por SQL direto", async () => {
    const response = await api().post("/wallets").send(body()).expect(201);
    await expectRejection(
      orm.em
        .getConnection()
        .execute("update wallets set balance = -1 where id = ?", [
          response.body.id,
        ]),
    );
    const wallet = await orm.em
      .fork()
      .findOneOrFail(WalletRecord, { id: response.body.id });
    expect(wallet.balance).toBe("100.00");
  });

  test("deve impedir lançamento duplicado para a mesma transação e carteira", async () => {
    const response = await api().post("/wallets").send(body()).expect(201);
    await expectRejection(
      orm.em.getConnection().execute(
        `
      insert into wallet_ledger (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
      select ?::uuid, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at
      from wallet_ledger where wallet_id = ?::uuid`,
        [randomUUID(), response.body.id],
      ),
    );
    expect(
      await orm.em
        .fork()
        .count(WalletLedgerRecord, { walletId: response.body.id }),
    ).toBe(1);
  });

  test("deve impedir alterar o saldo histórico de uma transação finalizada", async () => {
    const response = await api().post("/wallets").send(body()).expect(201);
    await expectRejection(
      orm.em
        .getConnection()
        .execute(
          "update wager_transactions set result_balance = 0 where wallet_id = ?",
          [response.body.id],
        ),
    );
    const record = await orm.em
      .fork()
      .findOneOrFail(WagerTransactionRecord, { walletId: response.body.id });
    expect(record.resultBalance).toBe("100.00");
  });
});
