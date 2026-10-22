import "reflect-metadata";
import { MessagingModule } from "../src/messaging/messaging.module.js";
import { InboxRecord } from "../src/database/entities/inbox.record.js";
import { QueuePort, type QueueDelivery, } from "../src/messaging/application/queue.port.js";
import { WagerConsumerWorker } from "../src/messaging/application/wager-consumer.worker.js";
import { OutboxPublisherWorker } from "../src/messaging/application/outbox-publisher.worker.js";

class RecordingQueue extends QueuePort {
  sent: Array<{ queue: string; body: string; deduplicationId: string }> = [];
  acknowledgements = 0;
  delays: number[] = [];
  failPublish = false;
  failAck = false;
  async receive(
    _queue?: string,
    _wait?: number,
    _signal?: AbortSignal,
  ): Promise<QueueDelivery[]> {
    return [];
  }
  async publish(
    queue: string,
    body: string,
    _group: string,
    deduplicationId: string,
  ): Promise<void> {
    if (this.failPublish) throw new Error("Broker indisponível");
    this.sent.push({ queue, body, deduplicationId });
  }
  async acknowledge(): Promise<void> {
    if (this.failAck) throw new Error("Ack falhou");
    this.acknowledgements++;
  }
  async visibility(
    _queue: string,
    _receipt: string,
    seconds: number,
  ): Promise<void> {
    this.delays.push(seconds);
  }
}

import { ProcessTransactionService } from "../src/wagering/application/process-transaction.service.js";
import { ReferenceRetryWorker } from "../src/wagering/application/reference-retry.worker.js";
import { ReferenceScheduleRecord } from "../src/database/entities/reference-schedule.record.js";
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

process.env.REFERENCE_WORKER_ENABLED = "false";
process.env.MESSAGING_ENABLED = "false";

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
        MessagingModule,
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
    expect(await orm.migrator.getExecuted()).toHaveLength(4);
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
    referenceExternalTransactionId: undefined as string | undefined,
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

  test("valida header, OPENING externo, valor zero, identidade e referência indevida", async () => {
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
        await orm.em.fork().count(WagerTransactionRecord, {
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
  test("REFUND devolve integralmente a BET e sua referência interna fica persistida", async () => {
    const wallet = await open();
    const bet = operation(wallet);
    const original = await submit(bet).expect(200);
    const refund = {
      ...operation(wallet, "REFUND"),
      referenceExternalTransactionId: bet.externalTransactionId,
    };
    const result = await submit(refund).expect(200);
    expect(result.body.balance.amount).toBe("100.00");
    const record = await orm.em
      .fork()
      .findOneOrFail(WagerTransactionRecord, { id: result.body.transactionId });
    expect(record.referenceTransactionId).toBe(original.body.transactionId);
    expect((await submit(refund).expect(200)).body.idempotentReplay).toBe(true);
    expect(
      (
        await submit({ ...refund, externalTransactionId: randomUUID() }).expect(
          422,
        )
      ).body.failureCode,
    ).toBe("INVALID_REFERENCE");
  });

  test("dois REFUND simultâneos com identidades distintas creditam apenas uma vez", async () => {
    const wallet = await open();
    const bet = operation(wallet);
    await submit(bet).expect(200);
    const results = await Promise.all(
      [1, 2].map(() =>
        submit({
          ...operation(wallet, "REFUND"),
          referenceExternalTransactionId: bet.externalTransactionId,
        }),
      ),
    );
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      200, 422,
    ]);
    expect(
      (await api().get(`/wallets/${wallet.walletId}`)).body.balance.amount,
    ).toBe("100.00");
  });

  test("ROLLBACK inverte BET e também o crédito de REFUND", async () => {
    const wallet = await open();
    const bet = operation(wallet);
    await submit(bet).expect(200);
    const refund = {
      ...operation(wallet, "REFUND"),
      referenceExternalTransactionId: bet.externalTransactionId,
    };
    await submit(refund).expect(200);
    const undoRefund = await submit({
      ...operation(wallet, "ROLLBACK"),
      referenceExternalTransactionId: refund.externalTransactionId,
    }).expect(200);
    expect(undoRefund.body.balance.amount).toBe("75.00");
    const undoBet = await submit({
      ...operation(wallet, "ROLLBACK"),
      referenceExternalTransactionId: bet.externalTransactionId,
    }).expect(200);
    expect(undoBet.body.balance.amount).toBe("100.00");
  });

  test("ROLLBACK de WIN sem saldo usa código distinto e não gera ledger", async () => {
    const wallet = await open();
    const win = operation(wallet, "WIN", "40.00");
    await submit(win).expect(200);
    await submit(operation(wallet, "BET", "140.00")).expect(200);
    const result = await submit({
      ...operation(wallet, "ROLLBACK", "40.00"),
      referenceExternalTransactionId: win.externalTransactionId,
    }).expect(422);
    expect(result.body.failureCode).toBe("REVERSAL_INSUFFICIENT_BALANCE");
    expect(
      await orm.em.fork().count(WalletLedgerRecord, {
        transactionId: result.body.transactionId,
      }),
    ).toBe(0);
  });

  test("reversão parcial, rodada divergente, tipo e referência rejeitada são inválidos", async () => {
    const wallet = await open();
    const bet = operation(wallet);
    await submit(bet).expect(200);
    const refund = {
      ...operation(wallet, "REFUND"),
      referenceExternalTransactionId: bet.externalTransactionId,
    };
    await submit({
      ...refund,
      money: { amount: "20.00", currency: "BRL" },
    }).expect(422);
    await submit({
      ...refund,
      externalTransactionId: randomUUID(),
      roundId: "other",
    }).expect(422);
    const loss = operation(wallet, "LOSS", "0.00");
    await submit(loss).expect(200);
    await submit({
      ...operation(wallet, "ROLLBACK", "25.00"),
      referenceExternalTransactionId: loss.externalTransactionId,
    }).expect(422);
    const rejected = operation(wallet, "BET", "999.00");
    await submit(rejected).expect(422);
    await submit({
      ...operation(wallet, "REFUND", "999.00"),
      referenceExternalTransactionId: rejected.externalTransactionId,
    }).expect(422);
    const other = await open();
    await submit({
      ...operation(other, "REFUND"),
      referenceExternalTransactionId: bet.externalTransactionId,
    }).expect(422);
  });

  test("WIN referenciado aguarda BET e usa crédito próprio depois", async () => {
    const wallet = await open();
    const bet = operation(wallet);
    const win = {
      ...operation(wallet, "WIN", "40.00"),
      referenceExternalTransactionId: bet.externalTransactionId,
    };
    const pending = await submit(win).expect(202);
    const schedule = await orm.em
      .fork()
      .findOneOrFail(ReferenceScheduleRecord, {
        transactionId: pending.body.transactionId,
      });
    await submit(bet).expect(200);
    await app
      .get(ProcessTransactionService)
      .retryPending(pending.body.transactionId, schedule.nextAttemptAt);
    const result = await submit(win).expect(200);
    expect(result.body.balance.amount).toBe("115.00");
    expect(result.body.idempotentReplay).toBe(true);
  });

  test("REFUND antes de BET persiste espera, replay pendente e worker processa uma única vez", async () => {
    const wallet = await open();
    const bet = operation(wallet);
    const refund = {
      ...operation(wallet, "REFUND"),
      referenceExternalTransactionId: bet.externalTransactionId,
    };
    const pending = await submit(refund).expect(202);
    expect(pending.body.status).toBe("PENDING_REFERENCE");
    expect((await submit(refund).expect(202)).body.idempotentReplay).toBe(true);
    expect((await api().get(`/wallets/${wallet.walletId}`)).body.version).toBe(
      1,
    );
    const schedule = await orm.em
      .fork()
      .findOneOrFail(ReferenceScheduleRecord, {
        transactionId: pending.body.transactionId,
      });
    await submit(bet).expect(200);
    await app.get(ReferenceRetryWorker).runDue(schedule.nextAttemptAt);
    const result = await submit(refund).expect(200);
    expect(result.body.transactionId).toBe(pending.body.transactionId);
    expect(result.body.balance.amount).toBe("100.00");
    expect(
      await orm.em.fork().count(ReferenceScheduleRecord, {
        transactionId: pending.body.transactionId,
      }),
    ).toBe(0);
    expect(
      await orm.em.fork().count(WalletLedgerRecord, {
        transactionId: pending.body.transactionId,
      }),
    ).toBe(1);
    expect(
      await app
        .get(ProcessTransactionService)
        .retryPending(pending.body.transactionId, schedule.nextAttemptAt),
    ).toBe(false);
  });

  test("sondagem respeita vencimento, aplica backoff e expira a referência sem novo saldo", async () => {
    const wallet = await open();
    const refund = {
      ...operation(wallet, "REFUND"),
      referenceExternalTransactionId: randomUUID(),
    };
    const pending = await submit(refund).expect(202);
    let schedule = await orm.em.fork().findOneOrFail(ReferenceScheduleRecord, {
      transactionId: pending.body.transactionId,
    });
    const service = app.get(ProcessTransactionService);
    expect(
      await service.retryPending(
        pending.body.transactionId,
        new Date(schedule.nextAttemptAt.getTime() - 1),
      ),
    ).toBe(false);
    await service.retryPending(
      pending.body.transactionId,
      schedule.nextAttemptAt,
    );
    schedule = await orm.em.fork().findOneOrFail(ReferenceScheduleRecord, {
      transactionId: pending.body.transactionId,
    });
    expect(schedule.attempts).toBe(1);
    expect(
      await orm.em.fork().count(OutboxRecord, {
        aggregateId: wallet.walletId,
        eventType: "WagerTransactionPendingReference",
      }),
    ).toBe(1);
    await service.retryPending(pending.body.transactionId, schedule.expiresAt);
    const expired = await submit(refund).expect(422);
    expect(expired.body.failureCode).toBe("REFERENCE_NOT_FOUND");
    expect(
      await orm.em.fork().count(OutboxRecord, {
        aggregateId: wallet.walletId,
        eventType: "WagerTransactionRejected",
      }),
    ).toBe(1);
    expect(
      await orm.em.fork().count(WalletLedgerRecord, {
        transactionId: pending.body.transactionId,
      }),
    ).toBe(0);
    expect(
      (await api().get(`/wallets/${wallet.walletId}`)).body.balance.amount,
    ).toBe("100.00");
  });

  test("workers concorrentes reavaliam o agendamento depois do lock da carteira", async () => {
    const wallet = await open();
    const bet = operation(wallet);
    const refund = {
      ...operation(wallet, "REFUND"),
      referenceExternalTransactionId: bet.externalTransactionId,
    };
    const pending = await submit(refund).expect(202);
    const schedule = await orm.em
      .fork()
      .findOneOrFail(ReferenceScheduleRecord, {
        transactionId: pending.body.transactionId,
      });
    await submit(bet).expect(200);
    const service = app.get(ProcessTransactionService);
    const results = await Promise.all([
      service.retryPending(pending.body.transactionId, schedule.nextAttemptAt),
      service.retryPending(pending.body.transactionId, schedule.nextAttemptAt),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      await orm.em.fork().count(WalletLedgerRecord, {
        transactionId: pending.body.transactionId,
      }),
    ).toBe(1);
  });

  test("contrato exige referência de reversões e rejeita referência nula ou autorreferência", async () => {
    const wallet = await open();
    await submit(operation(wallet, "REFUND")).expect(400);
    await submit(operation(wallet, "ROLLBACK")).expect(400);
    await submit({
      ...operation(wallet, "WIN"),
      referenceExternalTransactionId: null,
    } as unknown as ReturnType<typeof operation>).expect(400);
    const self = operation(wallet, "REFUND");
    await submit({
      ...self,
      referenceExternalTransactionId: self.externalTransactionId,
    }).expect(422);
  });
  test("restrição SQL impede outra reversão processada da mesma referência e tipo", async () => {
    const wallet = await open();
    const bet = operation(wallet);
    await submit(bet).expect(200);
    const refund = await submit({
      ...operation(wallet, "REFUND"),
      referenceExternalTransactionId: bet.externalTransactionId,
    }).expect(200);
    let failure: unknown;
    try {
      await orm.em
        .getConnection()
        .execute(
          `insert into wager_transactions select (jsonb_populate_record(null::wager_transactions, to_jsonb(t) || jsonb_build_object('id', ?::text, 'external_transaction_id', ?::text, 'idempotency_key', ?::text))).* from wager_transactions t where t.id = ?::uuid`,
          [randomUUID(), randomUUID(), randomUUID(), refund.body.transactionId],
        );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(String(failure)).toContain("wager_transactions_reversal_unique");
  });

  test("outro worker reconstrói pendências do banco sem estado em memória", async () => {
    const wallet = await open();
    const bet = operation(wallet);
    const refund = {
      ...operation(wallet, "REFUND"),
      referenceExternalTransactionId: bet.externalTransactionId,
    };
    const pending = await submit(refund).expect(202);
    const schedule = await orm.em
      .fork()
      .findOneOrFail(ReferenceScheduleRecord, {
        transactionId: pending.body.transactionId,
      });
    await submit(bet).expect(200);
    const restartedWorker = new ReferenceRetryWorker(
      orm,
      new ProcessTransactionService(orm),
    );
    await restartedWorker.runDue(schedule.nextAttemptAt);
    expect((await submit(refund).expect(200)).body.balance.amount).toBe(
      "100.00",
    );
  });
  test("expiração e remoção do agendamento são revertidas se o evento de rejeição falhar", async () => {
    const wallet = await open();
    const input = {
      ...operation(wallet, "REFUND"),
      referenceExternalTransactionId: randomUUID(),
    };
    const pending = await submit(input).expect(202);
    const schedule = await orm.em
      .fork()
      .findOneOrFail(ReferenceScheduleRecord, {
        transactionId: pending.body.transactionId,
      });
    const connection = orm.em.getConnection();
    await connection.execute(
      `create function fail_reference_outbox() returns trigger language plpgsql as $$ begin raise exception 'Falha simulada'; end; $$;`,
    );
    await connection.execute(
      `create trigger fail_reference_outbox before insert on outbox_messages for each row execute function fail_reference_outbox();`,
    );
    try {
      await expectRejection(
        app
          .get(ProcessTransactionService)
          .retryPending(pending.body.transactionId, schedule.expiresAt),
      );
      expect((await submit(input).expect(202)).body.status).toBe(
        "PENDING_REFERENCE",
      );
      expect(
        await orm.em.fork().count(ReferenceScheduleRecord, {
          transactionId: pending.body.transactionId,
        }),
      ).toBe(1);
      expect(
        await orm.em.fork().count(WalletLedgerRecord, {
          transactionId: pending.body.transactionId,
        }),
      ).toBe(0);
    } finally {
      await connection.execute(
        `drop trigger fail_reference_outbox on outbox_messages;`,
      );
      await connection.execute(`drop function fail_reference_outbox();`);
    }
    await app
      .get(ProcessTransactionService)
      .retryPending(pending.body.transactionId, schedule.expiresAt);
    await submit(input).expect(422);
  });
  const delivery = (
    input: ReturnType<typeof operation>,
    messageId = randomUUID(),
  ): QueueDelivery => ({
    brokerMessageId: randomUUID(),
    receiptHandle: randomUUID(),
    receiveCount: 1,
    body: JSON.stringify({
      messageId,
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: {
        ...input,
        idempotencyKey: `provider-a:${input.externalTransactionId}`,
      },
    }),
  });
  test("inbox e efeito financeiro são confirmados juntos; redelivery não repete débito", async () => {
    const wallet = await open();
    const item = delivery(operation(wallet));
    const broker = new RecordingQueue();
    const consumer = new WagerConsumerWorker(
      broker,
      app.get(ProcessTransactionService),
    );
    await consumer.handle(item);
    await consumer.handle({
      ...item,
      receiptHandle: randomUUID(),
      receiveCount: 2,
    });
    expect(broker.acknowledgements).toBe(2);
    expect(await orm.em.fork().count(InboxRecord, {})).toBe(1);
    expect(
      (await api().get(`/wallets/${wallet.walletId}`)).body.balance.amount,
    ).toBe("75.00");
    expect(
      await orm.em.fork().count(WalletLedgerRecord, {
        walletId: wallet.walletId,
        direction: LedgerDirection.Debit,
      }),
    ).toBe(1);
  });
  test("mesmo messageId com outro conteúdo vai para DLQ sem movimentação adicional", async () => {
    const wallet = await open();
    const input = operation(wallet);
    const id = randomUUID();
    const broker = new RecordingQueue();
    const consumer = new WagerConsumerWorker(
      broker,
      app.get(ProcessTransactionService),
    );
    await consumer.handle(delivery(input, id));
    await consumer.handle(
      delivery({ ...input, money: { amount: "30.00", currency: "BRL" } }, id),
    );
    expect(
      broker.sent.filter((s) => s.queue.endsWith("dlq.fifo")),
    ).toHaveLength(1);
    expect(
      (await api().get(`/wallets/${wallet.walletId}`)).body.balance.amount,
    ).toBe("75.00");
  });
  test("falha após commit antes do ack é recuperada por inbox sem outro débito", async () => {
    const wallet = await open();
    const item = delivery(operation(wallet));
    const broker = new RecordingQueue();
    broker.failAck = true;
    const consumer = new WagerConsumerWorker(
      broker,
      app.get(ProcessTransactionService),
    );
    await consumer.handle(item);
    expect(broker.delays).toEqual([5]);
    broker.failAck = false;
    await consumer.handle({ ...item, receiveCount: 2 });
    expect(broker.acknowledgements).toBe(1);
    expect(
      (await api().get(`/wallets/${wallet.walletId}`)).body.balance.amount,
    ).toBe("75.00");
  });
  test("rejeição financeira recebe ack e registra inbox; JSON inválido recebe DLQ", async () => {
    const wallet = await open();
    const broker = new RecordingQueue();
    const consumer = new WagerConsumerWorker(
      broker,
      app.get(ProcessTransactionService),
    );
    await consumer.handle(delivery(operation(wallet, "BET", "500.00")));
    expect(broker.acknowledgements).toBe(1);
    expect(broker.sent).toHaveLength(0);
    await consumer.handle({ ...delivery(operation(wallet)), body: "invalid" });
    expect(broker.sent).toHaveLength(1);
    expect(broker.acknowledgements).toBe(2);
  });
  test("falha na outbox reverte inbox e finanças; consumidor agenda retry e limita tentativas", async () => {
    const wallet = await open();
    const input = operation(wallet);
    const item = delivery(input);
    const broker = new RecordingQueue();
    const consumer = new WagerConsumerWorker(
      broker,
      app.get(ProcessTransactionService),
    );
    const connection = orm.em.getConnection();
    await connection.execute(
      `create function fail_inbox_outbox() returns trigger language plpgsql as $$ begin raise exception 'Falha simulada'; end; $$;`,
    );
    await connection.execute(
      `create trigger fail_inbox_outbox before insert on outbox_messages for each row execute function fail_inbox_outbox();`,
    );
    try {
      await consumer.handle(item);
      expect(broker.delays).toEqual([5]);
      expect(broker.acknowledgements).toBe(0);
      const envelope = JSON.parse(item.body) as { messageId: string };
      expect(
        await orm.em
          .fork()
          .count(InboxRecord, { messageId: envelope.messageId }),
      ).toBe(0);
      expect(
        await orm.em.fork().count(WagerTransactionRecord, {
          externalTransactionId: input.externalTransactionId,
        }),
      ).toBe(0);
      await consumer.handle({ ...item, receiveCount: 5 });
      expect(broker.sent).toHaveLength(1);
      expect(broker.acknowledgements).toBe(1);
    } finally {
      await connection.execute(
        `drop trigger fail_inbox_outbox on outbox_messages;`,
      );
      await connection.execute(`drop function fail_inbox_outbox();`);
    }
    expect(
      (await api().get(`/wallets/${wallet.walletId}`)).body.balance.amount,
    ).toBe("100.00");
  });
  const isolateOutbox = async () => {
    await orm.em
      .fork()
      .nativeUpdate(
        OutboxRecord,
        { publishedAt: null },
        { publishedAt: new Date() },
      );
  };
  test("dois publishers dividem eventos com SKIP LOCKED e confirmam publicação", async () => {
    await isolateOutbox();
    const wallet = await open();
    const broker = new RecordingQueue();
    await Promise.all([
      new OutboxPublisherWorker(orm, broker).publishOne(),
      new OutboxPublisherWorker(orm, broker).publishOne(),
    ]);
    expect(broker.sent).toHaveLength(2);
    expect(new Set(broker.sent.map((x) => x.deduplicationId)).size).toBe(2);
    expect(
      await orm.em.fork().count(OutboxRecord, {
        aggregateId: wallet.walletId,
        publishedAt: null,
      }),
    ).toBe(0);
  });
  test("outbox guarda retry e outra instância publica depois da recuperação", async () => {
    await isolateOutbox();
    const wallet = await open();
    const broker = new RecordingQueue();
    broker.failPublish = true;
    await new OutboxPublisherWorker(orm, broker).runBatch();
    const rows = await orm.em
      .fork()
      .find(OutboxRecord, { aggregateId: wallet.walletId });
    expect(
      rows.every(
        (r) =>
          r.attempts === 1 &&
          r.nextAttemptAt !== null &&
          r.publishedAt === null,
      ),
    ).toBe(true);
    broker.failPublish = false;
    await new OutboxPublisherWorker(orm, broker).runBatch(
      new Date(Date.now() + 10000),
    );
    expect(broker.sent).toHaveLength(2);
    expect(
      await orm.em.fork().count(OutboxRecord, {
        aggregateId: wallet.walletId,
        publishedAt: null,
      }),
    ).toBe(0);
  });
  test("envio confirmado com falha no registro de publicação repete o mesmo eventId", async () => {
    await isolateOutbox();
    await open();
    const broker = new RecordingQueue();
    const publisher = new OutboxPublisherWorker(orm, broker);
    const connection = orm.em.getConnection();
    await connection.execute(
      `create function fail_publish_mark() returns trigger language plpgsql as $$ begin if new.published_at is not null then raise exception 'Falha simulada'; end if; return new; end; $$;`,
    );
    await connection.execute(
      `create trigger fail_publish_mark before update on outbox_messages for each row execute function fail_publish_mark();`,
    );
    try {
      await expectRejection(publisher.publishOne());
      expect(broker.sent).toHaveLength(1);
    } finally {
      await connection.execute(
        `drop trigger fail_publish_mark on outbox_messages;`,
      );
      await connection.execute(`drop function fail_publish_mark();`);
    }
    await publisher.publishOne();
    expect(broker.sent).toHaveLength(2);
    expect(broker.sent[0]!.deduplicationId).toBe(
      broker.sent[1]!.deduplicationId,
    );
  });
  test("inbox serializa entregas concorrentes e também confirma replay de operação HTTP", async () => {
    const wallet = await open();
    const input = operation(wallet);
    const parsed = JSON.parse(delivery(input).body) as { messageId: string };
    const context = {
      messageId: parsed.messageId,
      consumerName: "parallel-consumer",
    };
    const service = app.get(ProcessTransactionService);
    await Promise.all(
      Array.from({ length: 10 }, () =>
        service.execute(
          { ...input, kind: WagerTransactionKind.Bet },
          `provider-a:${input.externalTransactionId}`,
          "correlation",
          context,
        ),
      ),
    );
    expect(await orm.em.fork().count(InboxRecord, context)).toBe(1);
    expect(
      (await api().get(`/wallets/${wallet.walletId}`)).body.balance.amount,
    ).toBe("75.00");
    const other = operation(wallet);
    await submit(other).expect(200);
    const result = await service.execute(
      { ...other, kind: WagerTransactionKind.Bet },
      `provider-a:${other.externalTransactionId}`,
      "correlation",
      { messageId: randomUUID(), consumerName: "http-replay" },
    );
    expect(result.idempotentReplay).toBe(true);
    expect(
      await orm.em.fork().count(InboxRecord, { consumerName: "http-replay" }),
    ).toBe(1);
  });
  test("falha na confirmação da inbox reverte saldo, ledger, transação e eventos já enviados ao SQL", async () => {
    const wallet = await open();
    const input = operation(wallet);
    const broker = new RecordingQueue();
    const item = delivery(input);
    const connection = orm.em.getConnection();
    await connection.execute(
      `create function fail_inbox_confirmation() returns trigger language plpgsql as $$ begin raise exception 'Falha simulada'; end; $$;`,
    );
    await connection.execute(
      `create trigger fail_inbox_confirmation before insert on inbox_messages for each row execute function fail_inbox_confirmation();`,
    );
    try {
      await new WagerConsumerWorker(
        broker,
        app.get(ProcessTransactionService),
      ).handle(item);
      expect(broker.acknowledgements).toBe(0);
      expect(broker.delays).toEqual([5]);
      expect(
        (await api().get(`/wallets/${wallet.walletId}`)).body.balance.amount,
      ).toBe("100.00");
      expect(
        await orm.em.fork().count(WagerTransactionRecord, {
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
        `drop trigger fail_inbox_confirmation on inbox_messages;`,
      );
      await connection.execute(`drop function fail_inbox_confirmation();`);
    }
  });
  test("desligamento aguarda a confirmação em andamento antes de concluir", async () => {
    const wallet = await open();
    const item = delivery(operation(wallet));
    let started!: () => void;
    let release!: () => void;
    const ackStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    class SlowAckQueue extends RecordingQueue {
      private delivered = false;
      override async receive(): Promise<QueueDelivery[]> {
        if (this.delivered) return [];
        this.delivered = true;
        return [item];
      }
      override async acknowledge(): Promise<void> {
        started();
        await gate;
        await super.acknowledge();
      }
    }
    const broker = new SlowAckQueue();
    const worker = new WagerConsumerWorker(
      broker,
      app.get(ProcessTransactionService),
    );
    process.env.MESSAGING_ENABLED = "true";
    try {
      worker.onApplicationBootstrap();
      await ackStarted;
      let closed = false;
      const stop = worker.beforeApplicationShutdown().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      release();
      await stop;
      expect(broker.acknowledgements).toBe(1);
      expect(
        (await api().get(`/wallets/${wallet.walletId}`)).body.balance.amount,
      ).toBe("75.00");
    } finally {
      release();
      process.env.MESSAGING_ENABLED = "false";
    }
  });
});
