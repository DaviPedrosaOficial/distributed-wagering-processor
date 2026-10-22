import "reflect-metadata";
import { WageringModule } from "../src/wagering/wagering.module.js";
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
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../src/wagering/domain/wager-transaction.js";
import { LedgerDirection } from "../src/wallets/domain/wallet-ledger-entry.js";
import { OpenWalletService } from "../src/wallets/application/open-wallet.service.js";

describe("Carteiras e operações (integração PostgreSQL)", () => {
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
      imports: [
        MikroOrmModule.forRoot(integrationConfig()),
        WalletsModule,
        WageringModule,
      ],
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
  const open = async () => {
    const playerId = randomUUID();
    const response = await api()
      .post("/wallets")
      .send(body(playerId))
      .expect(201);
    return { playerId, walletId: response.body.id as string };
  };
  const operation = (
    wallet: { playerId: string; walletId: string },
    kind = "BET",
    amount = "25.00",
  ) => ({
    ...wallet,
    providerId: "provider-a",
    externalTransactionId: randomUUID(),
    gameId: "game-1",
    roundId: "round-1",
    kind,
    money: { amount, currency: "BRL" },
  });
  const submit = (
    input: ReturnType<typeof operation>,
    key = `provider-a:${input.externalTransactionId}`,
  ) =>
    api()
      .post("/wagering/transactions")
      .set("Idempotency-Key", key)
      .send(input);

  test("BET debita, WIN credita e LOSS preserva saldo e versão", async () => {
    const wallet = await open();
    const bet = await submit(operation(wallet)).expect(200);
    expect(bet.body.balance.amount).toBe("75.00");
    const win = await submit(operation(wallet, "WIN", "40.00")).expect(200);
    expect(win.body.balance.amount).toBe("115.00");
    const loss = await submit(operation(wallet, "LOSS", "0.00")).expect(200);
    expect(loss.body.balance.amount).toBe("115.00");
    const saved = await orm.em
      .fork()
      .findOneOrFail(WalletRecord, { id: wallet.walletId });
    expect(saved.version).toBe(3);
    expect(
      await orm.em
        .fork()
        .count(WalletLedgerRecord, { walletId: wallet.walletId }),
    ).toBe(3);
    expect(
      await orm.em.fork().count(OutboxRecord, { aggregateId: wallet.walletId }),
    ).toBe(7);
  });

  test("replay devolve o saldo histórico depois de outra movimentação", async () => {
    const wallet = await open();
    const input = operation(wallet);
    const original = await submit(input).expect(200);
    await submit(operation(wallet, "WIN", "40.00")).expect(200);
    const replay = await submit(input).expect(200);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    expect(replay.body.balance.amount).toBe("75.00");
    expect(
      (await api().get(`/wallets/${wallet.walletId}`)).body.balance.amount,
    ).toBe("115.00");
  });

  test("chave repetida com conteúdo diferente e identidade externa com outra chave conflitam", async () => {
    const wallet = await open();
    const input = operation(wallet);
    await submit(input, "same-key").expect(200);
    await submit(
      { ...input, money: { amount: "30.00", currency: "BRL" } },
      "same-key",
    ).expect(409);
    await submit(input, "different-key").expect(409);
    expect(
      (await api().get(`/wallets/${wallet.walletId}`)).body.balance.amount,
    ).toBe("75.00");
  });

  test("rejeição por saldo insuficiente fica auditável e também é idempotente", async () => {
    const wallet = await open();
    const input = operation(wallet, "BET", "150.00");
    const original = await submit(input).expect(422);
    expect(original.body.failureCode).toBe("INSUFFICIENT_BALANCE");
    await submit(operation(wallet, "WIN", "100.00")).expect(200);
    const replay = await submit(input).expect(422);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    expect(
      await orm.em.fork().count(WalletLedgerRecord, {
        transactionId: original.body.transactionId,
      }),
    ).toBe(0);
  });

  test("rejeita moeda divergente sem tocar saldo ou ledger", async () => {
    const wallet = await open();
    const input = operation(wallet);
    input.money.currency = "USD";
    const result = await submit(input).expect(422);
    expect(result.body.failureCode).toBe("CURRENCY_MISMATCH");
    expect((await api().get(`/wallets/${wallet.walletId}`)).body.version).toBe(
      1,
    );
  });

  test("valida header, OPENING externo, valor zero, identidade e referência não implementada", async () => {
    const wallet = await open();
    const input = operation(wallet);
    await api().post("/wagering/transactions").send(input).expect(400);
    await submit({ ...input, kind: "OPENING" }).expect(400);
    await submit(operation(wallet, "BET", "0.00")).expect(400);
    await submit({ ...input, playerId: randomUUID() }).expect(400);
    await submit({
      ...input,
      referenceExternalTransactionId: "unknown",
    } as ReturnType<typeof operation>).expect(400);
  });

  test("duas apostas simultâneas de 80 disputam saldo de 100 sem lost update", async () => {
    const wallet = await open();
    const results = await Promise.all([
      submit(operation(wallet, "BET", "80.00")),
      submit(operation(wallet, "BET", "80.00")),
    ]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 422,
    ]);
    const saved = await orm.em
      .fork()
      .findOneOrFail(WalletRecord, { id: wallet.walletId });
    expect(saved.balance).toBe("20.00");
    expect(saved.version).toBe(2);
    expect(
      await orm.em.fork().count(WalletLedgerRecord, {
        walletId: wallet.walletId,
        direction: LedgerDirection.Debit,
      }),
    ).toBe(1);
  });

  test("50 envios simultâneos da mesma operação debitam somente uma vez", async () => {
    const wallet = await open();
    const input = operation(wallet);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => submit(input)),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(
      results.filter((r) => r.body.idempotentReplay === false),
    ).toHaveLength(1);
    expect(
      await orm.em.fork().count(WalletLedgerRecord, {
        walletId: wallet.walletId,
        direction: LedgerDirection.Debit,
      }),
    ).toBe(1);
    expect(
      (await api().get(`/wallets/${wallet.walletId}`)).body.balance.amount,
    ).toBe("75.00");
  }, 30000);

  test("mesma chave disputada entre carteiras reverte a operação perdedora", async () => {
    const wallets = await Promise.all([open(), open()]);
    const key = randomUUID();
    const results = await Promise.all(
      wallets.map((w) => submit(operation(w), key)),
    );
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    const balances = await Promise.all(
      wallets.map((w) => api().get(`/wallets/${w.walletId}`)),
    );
    expect(
      balances
        .map((r) => String(r.body.balance.amount))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ).toEqual(["100.00", "75.00"]);
  });
  test("falha na outbox desfaz débito, ledger e transação mesmo após o primeiro flush", async () => {
    const wallet = await open();
    const input = operation(wallet);
    const connection = orm.em.getConnection();
    await connection.execute(
      `create function fail_wager_outbox() returns trigger language plpgsql as $$ begin raise exception 'Falha simulada'; end; $$;`,
    );
    await connection.execute(
      `create trigger fail_wager_outbox before insert on outbox_messages for each row execute function fail_wager_outbox();`,
    );
    try {
      await submit(input).expect(500);
      const saved = await orm.em
        .fork()
        .findOneOrFail(WalletRecord, { id: wallet.walletId });
      expect(saved.balance).toBe("100.00");
      expect(saved.version).toBe(1);
      expect(
        await orm.em
          .fork()
          .count(WagerTransactionRecord, {
            externalTransactionId: input.externalTransactionId,
          }),
      ).toBe(0);
      expect(
        await orm.em
          .fork()
          .count(WalletLedgerRecord, { walletId: wallet.walletId }),
      ).toBe(1);
      expect(
        await orm.em
          .fork()
          .count(OutboxRecord, { aggregateId: wallet.walletId }),
      ).toBe(2);
    } finally {
      await connection.execute(
        `drop trigger fail_wager_outbox on outbox_messages;`,
      );
      await connection.execute(`drop function fail_wager_outbox();`);
    }
    await submit(input).expect(200);
    expect(
      (await api().get(`/wallets/${wallet.walletId}`)).body.balance.amount,
    ).toBe("75.00");
  });

  test("permite consumir todo saldo e rejeita carteira inexistente", async () => {
    const wallet = await open();
    const input = operation(wallet, "BET", "100.00");
    expect((await submit(input).expect(200)).body.balance.amount).toBe("0.00");
    await submit(operation({ ...wallet, walletId: randomUUID() })).expect(404);
  });
});
