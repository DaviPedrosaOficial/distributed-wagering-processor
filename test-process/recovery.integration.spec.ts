import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { MikroORM } from "@mikro-orm/postgresql";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { DeleteQueueCommand } from "@aws-sdk/client-sqs";
import { integrationConfig } from "../test/integration-config.js";
import { WalletsModule } from "../src/wallets/wallets.module.js";
import { WageringModule } from "../src/wagering/wagering.module.js";
import { OpenWalletService } from "../src/wallets/application/open-wallet.service.js";
import { WalletQueriesService } from "../src/wallets/application/wallet-queries.service.js";
import { SqsTransport } from "../src/messaging/infrastructure/sqs.transport.js";
import { queueNames } from "../src/messaging/application/queue.port.js";
import { WagerTransactionKind as Kind } from "../src/wagering/domain/wager-transaction.js";

process.env.MESSAGING_ENABLED = "false";
process.env.REFERENCE_WORKER_ENABLED = "false";
const prefix = `recovery-${Date.now()}-${process.pid}`;
process.env.SQS_REQUEST_QUEUE = `${prefix}.fifo`;
process.env.SQS_DLQ = `${prefix}-dlq.fifo`;
process.env.SQS_EVENT_QUEUE = `${prefix}-events.fifo`;
const endpoint = new URL(process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4566");
if (
  ![
    "localhost",
    "127.0.0.1",
    "localstack",
    "localhost.localstack.cloud",
  ].includes(endpoint.hostname)
)
  throw new Error("Use LocalStack local, nunca AWS real, nesta suíte.");

type Signal = {
  ready?: boolean;
  port?: number;
  pid?: number;
  checkpoint?: string;
  eventId?: string;
  finished?: boolean;
  handled?: boolean;
};
const children = new Set<ChildProcess>();
function start(mode: string) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./process.fixture.js", import.meta.url)), mode],
    { env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] },
  );
  children.add(child);
  const messages: Signal[] = [];
  let buffered = "",
    diagnostics = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    const lines = buffered.split("\n");
    buffered = lines.pop()!;
    for (const line of lines) {
      if (line.startsWith("RECOVERY:"))
        messages.push(JSON.parse(line.slice(9)) as Signal);
      else diagnostics = (diagnostics + line + "\n").slice(-8000);
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-8000);
  });
  child.on("error", (error) => {
    diagnostics += error.message;
  });
  return {
    child,
    diagnostics: () => diagnostics,
    async wait(
      predicate: (signal: Signal) => boolean,
      timeout = 20000,
    ): Promise<Signal> {
      const end = Date.now() + timeout;
      for (;;) {
        const message = messages.find(predicate);
        if (message) return message;
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Processo ${mode} encerrou: ${diagnostics}`);
        if (Date.now() > end)
          throw new Error(`Timeout ${mode}: ${diagnostics}`);
        await Bun.sleep(30);
      }
    },
  };
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGKILL");
  await Promise.race([
    exited,
    Bun.sleep(5000).then(() => {
      throw new Error("Processo não encerrou");
    }),
  ]);
  children.delete(child);
}
async function eventually(check: () => Promise<boolean>, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end)
      throw new Error("Estado persistido não foi alcançado");
    await Bun.sleep(100);
  }
}

describe("Recuperação com processos independentes, PostgreSQL e SQS reais", () => {
  let app: INestApplication, orm: MikroORM, sqs: SqsTransport;
  let queuesCreated = false;
  async function setupQueues() {
    if (!queuesCreated) {
      await sqs.setup();
      queuesCreated = true;
    }
  }
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
    await orm.migrator.up();
    await app.init();
    sqs = new SqsTransport();
    // Apenas tabela de demonstração do consumidor de eventos, no banco de teste.
    await orm.em.getConnection()
      .execute(`create table if not exists recovery_event_receipts
      (event_id uuid primary key)`);
    await orm.em.getConnection()
      .execute(`create table if not exists recovery_event_effects
      (event_id uuid primary key, applications integer not null)`);
  }, 30000);
  afterAll(async () => {
    for (const child of children) await kill(child);
    if (sqs && queuesCreated) {
      for (const name of Object.values(queueNames()))
        await sqs.client.send(
          new DeleteQueueCommand({ QueueUrl: await sqs.queueUrl(name) }),
        );
      sqs.close();
    }
    sqs?.close();
    if (app) await app.close();
  }, 30000);
  const sql = <T extends object>(query: string, params: unknown[] = []) =>
    orm.em.fork().getConnection().execute<T[]>(query, params);
  const open = () =>
    app
      .get(OpenWalletService)
      .execute(
        {
          playerId: randomUUID(),
          initialBalance: { amount: "100.00", currency: "BRL" },
        },
        randomUUID(),
      );
  const input = (
    wallet: { id: string; playerId: string },
    amount = "25.00",
  ) => ({
    providerId: "recovery-provider",
    externalTransactionId: randomUUID(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: randomUUID(),
    gameId: "recovery-game",
    kind: Kind.Bet,
    money: { amount, currency: "BRL" },
  });
  async function submit(
    port: number,
    body: ReturnType<typeof input>,
    key = body.externalTransactionId,
  ) {
    const response = await fetch(
      `http://127.0.0.1:${port}/wagering/transactions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      },
    );
    return {
      code: response.status,
      body: (await response.json()) as {
        transactionId: string;
        status: string;
        idempotentReplay: boolean;
        balance?: { amount: string };
      },
    };
  }
  test("três APIs disputam saldo; 50 repetições debitam uma vez; carteiras distintas e reinício", async () => {
    const workers = [start("api"), start("api"), start("api")];
    try {
      const ready = await Promise.all(
        workers.map((worker) => worker.wait((message) => !!message.ready)),
      );
      expect(new Set(ready.map((item) => item.pid)).size).toBe(3);
      const ports = ready.map((item) => item.port!);
      const wallet = await open(),
        bet = input(wallet, "80.00"),
        other = input(wallet, "80.00");
      const race = await Promise.all([
        submit(ports[0]!, bet),
        submit(ports[1]!, other),
      ]);
      expect(race.map((item) => item.code).sort((a, b) => a - b)).toEqual([
        200, 422,
      ]);
      const disputed = await sql<{ balance: string }>(
        "select balance::text from wallets where id=?",
        [wallet.id],
      );
      expect(disputed[0]!.balance).toBe("20.00");
      const disputedDebits = await sql<{ count: string }>(
        "select count(*)::text as count from wallet_ledger where wallet_id=? and direction='DEBIT'",
        [wallet.id],
      );
      expect(disputedDebits[0]!.count).toBe("1");
      const replayWallet = await open(),
        repeated = input(replayWallet);
      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, n) => submit(ports[n % 3]!, repeated)),
      );
      if (responses.some((item) => item.code !== 200))
        throw new Error(
          `Respostas inesperadas: ${JSON.stringify(responses.filter((item) => item.code !== 200))}\n${workers.map((worker) => worker.diagnostics()).join("\n")}`,
        );
      expect(
        new Set(responses.map((item) => item.body.transactionId)).size,
      ).toBe(1);
      expect(
        responses.filter((item) => !item.body.idempotentReplay).length,
      ).toBe(1);
      const distinct = await Promise.all([open(), open(), open()]);
      const parallel = await Promise.all(
        distinct.map((item, n) => submit(ports[n]!, input(item))),
      );
      expect(parallel.every((item) => item.code === 200)).toBe(true);
      for (const item of [wallet, replayWallet, ...distinct])
        expect(
          (await app.get(WalletQueriesService).reconcile(item.id, randomUUID()))
            .consistent,
        ).toBe(true);
      const debits = await sql<{ count: string }>(
        "select count(*)::text as count from wallet_ledger where wallet_id=? and direction='DEBIT'",
        [replayWallet.id],
      );
      expect(debits[0]!.count).toBe("1");
      await Promise.all(workers.map((worker) => kill(worker.child)));
      const restarted = start("api");
      try {
        const info = await restarted.wait((message) => !!message.ready);
        const replay = await submit(info.port!, repeated);
        expect(replay.body.idempotentReplay).toBe(true);
        expect(replay.body.balance?.amount).toBe("75.00");
        expect(
          (
            await app
              .get(WalletQueriesService)
              .reconcile(replayWallet.id, randomUUID())
          ).consistent,
        ).toBe(true);
      } finally {
        await kill(restarted.child);
      }
    } finally {
      for (const worker of workers) await kill(worker.child);
    }
  }, 90000);

  test("kill após commit antes de ack; outra instância recebe e não debita novamente", async () => {
    await setupQueues();
    const wallet = await open(),
      body = input(wallet),
      messageId = randomUUID();
    await sqs.publish(
      queueNames().requests,
      JSON.stringify({
        messageId,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: { ...body, idempotencyKey: body.externalTransactionId },
      }),
      wallet.id,
      messageId,
    );
    const crashing = start("consumer-crash");
    try {
      await crashing.wait(
        (message) => message.checkpoint === "after-commit-before-ack",
      );
      const receipts = await sql<{ count: string }>(
        "select count(*)::text as count from inbox_messages where message_id=?",
        [messageId],
      );
      expect(receipts[0]!.count).toBe("1");
    } finally {
      await kill(crashing.child);
    }
    // Visibilidade configurada é 30s. Redelivery vem do broker, sem novo SendMessage.
    const recovery = start("consumer");
    try {
      await recovery.wait((message) => !!message.handled, 45000);
      const rows = await sql<{ balance: string; version: number }>(
        "select balance::text,version from wallets where id=?",
        [wallet.id],
      );
      expect(rows[0]!.balance).toBe("75.00");
      expect(rows[0]!.version).toBe(2);
      const entries = await sql<{ count: string }>(
        "select count(*)::text as count from wallet_ledger where wallet_id=? and direction='DEBIT'",
        [wallet.id],
      );
      expect(entries[0]!.count).toBe("1");
      expect(
        (await app.get(WalletQueriesService).reconcile(wallet.id, randomUUID()))
          .consistent,
      ).toBe(true);
    } finally {
      await kill(recovery.child);
    }
  }, 70000);

  test("kill do publisher após envio; dois processos recuperam outbox e consumidor deduplica persistentemente", async () => {
    await setupQueues();
    // Isola o cenário: itens anteriores já foram publicados ou não são seu objeto.
    await sql(
      "update outbox_messages set published_at=now() where published_at is null",
    );
    const wallet = await open();
    const crashing = start("publisher-crash");
    let eventId: string;
    try {
      const checkpoint = await crashing.wait(
        (message) => message.checkpoint === "after-send-before-mark",
      );
      eventId = checkpoint.eventId!;
    } finally {
      await kill(crashing.child);
    }
    await eventually(async () => {
      const rows = await sql<{ published_at: Date | null }>(
        "select published_at from outbox_messages where id=?",
        [eventId],
      );
      return rows.length === 1 && rows[0]!.published_at === null;
    });
    const publishers = [start("publisher"), start("publisher")];
    try {
      const ready = await Promise.all(
        publishers.map((worker) => worker.wait((message) => !!message.ready)),
      );
      expect(new Set(ready.map((message) => message.pid)).size).toBe(2);
      for (const worker of publishers) worker.child.stdin!.write("go\n");
      await Promise.all(
        publishers.map((worker) =>
          worker.wait((message) => !!message.finished),
        ),
      );
    } finally {
      for (const worker of publishers) await kill(worker.child);
    }
    const pending = await sql<{ count: string }>(
      "select count(*)::text as count from outbox_messages where aggregate_id=? and published_at is null",
      [wallet.id],
    );
    expect(pending[0]!.count).toBe("0");
    const rows = await sql<{ payload: object }>(
      "select payload from outbox_messages where id=?",
      [eventId],
    );
    // Força outra entrega lógica além da deduplicação FIFO: mesmo eventId,
    // outro ID de transporte. O consumidor demonstrativo decide pelo banco.
    await sqs.publish(
      queueNames().events,
      JSON.stringify(rows[0]!.payload),
      wallet.id,
      createHash("sha256").update(randomUUID()).digest("hex"),
    );
    let observed = 0;
    const deadline = Date.now() + 20000;
    while (observed < 2 && Date.now() < deadline) {
      for (const delivery of await sqs.receive(queueNames().events, 1)) {
        const event = JSON.parse(delivery.body) as { eventId: string };
        await orm.em.fork().transactional(async (em) => {
          const accepted = await em
            .getConnection()
            .execute<Array<{ event_id: string }>>(
              "insert into recovery_event_receipts(event_id) values (?) on conflict(event_id) do nothing returning event_id",
              [event.eventId],
            );
          if (accepted.length)
            await em.getConnection().execute(
              `insert into recovery_event_effects(event_id,applications) values (?,1)
             on conflict(event_id) do update set applications=recovery_event_effects.applications+1`,
              [event.eventId],
            );
        });
        if (event.eventId === eventId) observed++;
        await sqs.acknowledge(queueNames().events, delivery.receiptHandle);
      }
    }
    expect(observed).toBeGreaterThanOrEqual(2);
    const effects = await sql<{ applications: number }>(
      "select applications from recovery_event_effects where event_id=?",
      [eventId],
    );
    expect(effects[0]!.applications).toBe(1);
    expect(
      (await app.get(WalletQueriesService).reconcile(wallet.id, randomUUID()))
        .consistent,
    ).toBe(true);
  }, 60000);
  test("referência fora de ordem sobrevive à morte da API e é retomada por outro processo", async () => {
    const first = start("api"),
      second = start("api"),
      references = start("references");
    try {
      const [a, b] = await Promise.all([
        first.wait((message) => !!message.ready),
        second.wait((message) => !!message.ready),
        references.wait((message) => !!message.ready),
      ]);
      const wallet = await open(),
        bet = input(wallet);
      const refund = {
        ...bet,
        externalTransactionId: randomUUID(),
        kind: Kind.Refund,
        referenceExternalTransactionId: bet.externalTransactionId,
      };
      const pending = await submit(a!.port!, refund);
      expect(pending.code).toBe(202);
      await kill(first.child);
      expect((await submit(b!.port!, bet)).code).toBe(200);
      await eventually(async () => {
        const rows = await sql<{ status: string }>(
          "select status from wager_transactions where id=?",
          [pending.body.transactionId],
        );
        return rows[0]?.status === "PROCESSED";
      });
      const replay = await submit(b!.port!, refund);
      expect(replay.body.transactionId).toBe(pending.body.transactionId);
      expect(replay.body.balance?.amount).toBe("100.00");
      expect(replay.body.idempotentReplay).toBe(true);
      expect(
        (await app.get(WalletQueriesService).reconcile(wallet.id, randomUUID()))
          .consistent,
      ).toBe(true);
    } finally {
      await Promise.all([
        kill(first.child),
        kill(second.child),
        kill(references.child),
      ]);
    }
  }, 45000);
});
