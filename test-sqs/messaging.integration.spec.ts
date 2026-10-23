import "reflect-metadata";
import request from "supertest";
import { OperationsModule } from "../src/operations/operations.module.js";
import { LedgerDirection } from "../src/wallets/domain/wallet-ledger-entry.js";
import { FailureCode } from "../src/wagering/domain/wager-transaction.js";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { MikroORM } from "@mikro-orm/postgresql";
import { randomUUID } from "node:crypto";
import { DeleteQueueCommand } from "@aws-sdk/client-sqs";
import { integrationConfig } from "../test/integration-config.js";
import { WalletsModule } from "../src/wallets/wallets.module.js";
import { WageringModule } from "../src/wagering/wagering.module.js";
import { OpenWalletService } from "../src/wallets/application/open-wallet.service.js";
import { ProcessTransactionService } from "../src/wagering/application/process-transaction.service.js";
import { WagerConsumerWorker, WAGER_CONSUMER_NAME, } from "../src/messaging/application/wager-consumer.worker.js";
import { OutboxPublisherWorker } from "../src/messaging/application/outbox-publisher.worker.js";
import { SqsTransport } from "../src/messaging/infrastructure/sqs.transport.js";
import { queueNames, type QueueDelivery, } from "../src/messaging/application/queue.port.js";
import { parseWagerMessage } from "../src/messaging/application/parse-wager-message.js";
import { InboxRecord } from "../src/database/entities/inbox.record.js";
import { OutboxRecord } from "../src/database/entities/outbox.record.js";
import { WalletLedgerRecord } from "../src/database/entities/wallet-ledger.record.js";
import { WalletRecord } from "../src/database/entities/wallet.record.js";

process.env.REFERENCE_WORKER_ENABLED = "false";
process.env.MESSAGING_ENABLED = "false";
const prefix = `wager-test-${Date.now()}`;
process.env.SQS_REQUEST_QUEUE = `${prefix}.fifo`;
process.env.SQS_DLQ = `${prefix}-dlq.fifo`;
process.env.SQS_EVENT_QUEUE = `${prefix}-events.fifo`;

const endpoint = new URL(process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4566");
if (
  ![
    "127.0.0.1",
    "localhost",
    "localstack",
    "localhost.localstack.cloud",
  ].includes(endpoint.hostname)
)
  throw new Error("A suíte SQS requer LocalStack local; não utiliza AWS real.");

describe("PostgreSQL e LocalStack reais", () => {
  let app: INestApplication;
  let orm: MikroORM;
  let transport: SqsTransport;
  let service: ProcessTransactionService;
  let consumer: WagerConsumerWorker;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        MikroOrmModule.forRoot(integrationConfig()),
        WalletsModule,
        WageringModule,
        OperationsModule,
      ],
    }).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    orm = app.get(MikroORM);
    await orm.migrator.up();
    await app.init();
    service = app.get(ProcessTransactionService);
    transport = new SqsTransport();
    await transport.setup();
    consumer = new WagerConsumerWorker(transport, service);
  }, 30000);
  afterAll(async () => {
    if (transport) {
      for (const name of Object.values(queueNames())) {
        try {
          await transport.client.send(
            new DeleteQueueCommand({
              QueueUrl: await transport.queueUrl(name),
            }),
          );
        } catch {
          /* Limpeza de filas exclusivas da suíte. */
        }
      }
      transport.close();
    }
    if (app) await app.close();
  }, 30000);
  const open = () =>
    app.get(OpenWalletService).execute(
      {
        playerId: randomUUID(),
        initialBalance: { amount: "100.00", currency: "BRL" },
      },
      randomUUID(),
    );
  const body = (
    wallet: { id: string; playerId: string },
    amount = "25.00",
  ) => ({
    messageId: randomUUID(),
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-sqs",
      externalTransactionId: randomUUID(),
      idempotencyKey: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: "round-1",
      gameId: "game-1",
      kind: "BET",
      money: { amount, currency: "BRL" },
    },
  });
  const take = async (queue: string): Promise<QueueDelivery> => {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const messages = await transport.receive(queue, 1);
      if (messages[0]) return messages[0];
    }
    throw new Error(`Mensagem não recebida: ${queue}`);
  };
  test("recebe, confirma inbox e reconhece uma nova entrega física do mesmo messageId", async () => {
    const wallet = await open();
    const message = body(wallet);
    const text = JSON.stringify(message);
    await transport.publish(
      queueNames().requests,
      text,
      wallet.id,
      randomUUID(),
    );
    await consumer.handle(await take(queueNames().requests));
    await transport.publish(
      queueNames().requests,
      text,
      wallet.id,
      randomUUID(),
    );
    await consumer.handle(await take(queueNames().requests));
    expect(
      (await orm.em.fork().findOneOrFail(WalletRecord, { id: wallet.id }))
        .balance,
    ).toBe("75.00");
    expect(
      await orm.em.fork().count(InboxRecord, {
        messageId: message.messageId,
        consumerName: WAGER_CONSUMER_NAME,
      }),
    ).toBe(1);
    expect(
      await orm.em.fork().count(WalletLedgerRecord, {
        walletId: wallet.id,
        direction: LedgerDirection.Debit,
      }),
    ).toBe(1);
  }, 30000);
  test("commit sem ack é retomado por nova instância do consumidor", async () => {
    const wallet = await open();
    const message = body(wallet);
    await transport.publish(
      queueNames().requests,
      JSON.stringify(message),
      wallet.id,
      randomUUID(),
    );
    const first = await take(queueNames().requests);
    const parsed = parseWagerMessage(first.body);
    await service.execute(
      parsed.input,
      parsed.idempotencyKey,
      parsed.correlationId,
      { messageId: parsed.messageId, consumerName: WAGER_CONSUMER_NAME },
    );
    // Simula a janela entre commit e ack; o teste com kill real fica separado.
    await transport.visibility(queueNames().requests, first.receiptHandle, 0);
    await new WagerConsumerWorker(
      transport,
      new ProcessTransactionService(orm),
    ).handle(await take(queueNames().requests));
    expect(
      (await orm.em.fork().findOneOrFail(WalletRecord, { id: wallet.id }))
        .balance,
    ).toBe("75.00");
  }, 30000);
  test("mensagem inválida é preservada na DLQ e removida da origem", async () => {
    const invalid = "{invalid-json";
    await transport.publish(
      queueNames().requests,
      invalid,
      "invalid",
      randomUUID(),
    );
    await consumer.handle(await take(queueNames().requests));
    const dead = await take(queueNames().deadLetters);
    expect(dead.body).toBe(invalid);
    await transport.acknowledge(queueNames().deadLetters, dead.receiptHandle);
  }, 30000);
  test("rejeição de saldo recebe ack e não cria débito", async () => {
    const wallet = await open();
    const message = body(wallet, "500.00");
    await transport.publish(
      queueNames().requests,
      JSON.stringify(message),
      wallet.id,
      randomUUID(),
    );
    await consumer.handle(await take(queueNames().requests));
    const receipt = await orm.em.fork().findOneOrFail(InboxRecord, {
      messageId: message.messageId,
      consumerName: WAGER_CONSUMER_NAME,
    });
    expect(receipt.result?.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(
      (await orm.em.fork().findOneOrFail(WalletRecord, { id: wallet.id }))
        .balance,
    ).toBe("100.00");
  }, 30000);
  test("falha SQL permite retry e esgotamento envia a mensagem à DLQ", async () => {
    const wallet = await open();
    const message = body(wallet);
    await transport.publish(
      queueNames().requests,
      JSON.stringify(message),
      wallet.id,
      randomUUID(),
    );
    const connection = orm.em.getConnection();
    await connection.execute(
      `create function sqs_test_outbox_failure() returns trigger language plpgsql as $$ begin raise exception 'Falha simulada'; end; $$;`,
    );
    await connection.execute(
      `create trigger sqs_test_outbox_failure before insert on outbox_messages for each row execute function sqs_test_outbox_failure();`,
    );
    try {
      let item = await take(queueNames().requests);
      await consumer.handle(item);
      expect(
        await orm.em
          .fork()
          .count(InboxRecord, { messageId: message.messageId }),
      ).toBe(0);
      // Antecipa visibilidade para testar contagem real sem sleeps de backoff.
      for (let n = 0; n < 4; n++) {
        await transport.visibility(
          queueNames().requests,
          item.receiptHandle,
          0,
        );
        item = await take(queueNames().requests);
      }
      expect(item.receiveCount).toBe(5);
      await consumer.handle(item);
      const dead = await take(queueNames().deadLetters);
      expect(JSON.parse(dead.body).messageId).toBe(message.messageId);
      await transport.acknowledge(queueNames().deadLetters, dead.receiptHandle);
      expect(
        (await orm.em.fork().findOneOrFail(WalletRecord, { id: wallet.id }))
          .balance,
      ).toBe("100.00");
    } finally {
      await connection.execute(
        `drop trigger sqs_test_outbox_failure on outbox_messages;`,
      );
      await connection.execute(`drop function sqs_test_outbox_failure();`);
    }
  }, 30000);
  test("dois publishers enviam eventos confirmados para SQS", async () => {
    // Isola eventos deste cenário no banco exclusivo de testes.
    await orm.em
      .fork()
      .nativeUpdate(
        OutboxRecord,
        { publishedAt: null },
        { publishedAt: new Date() },
      );
    const wallet = await open();
    await Promise.all([
      new OutboxPublisherWorker(orm, transport).publishOne(),
      new OutboxPublisherWorker(orm, transport).publishOne(),
    ]);
    const ids = new Set<string>();
    for (let n = 0; n < 2; n++) {
      const item = await take(queueNames().events);
      const event = JSON.parse(item.body) as {
        eventId: string;
        aggregateId: string;
      };
      expect(event.aggregateId).toBe(wallet.id);
      ids.add(event.eventId);
      await transport.acknowledge(queueNames().events, item.receiptHandle);
    }
    expect(ids.size).toBe(2);
    expect(
      await orm.em
        .fork()
        .count(OutboxRecord, { aggregateId: wallet.id, publishedAt: null }),
    ).toBe(0);
  }, 30000);
  test("readiness verifica PostgreSQL e filas reais", async () => {
    const result = await request(app.getHttpServer())
      .get("/health/ready")
      .expect(200);
    expect(result.body.dependencies).toEqual({ postgres: true, sqs: true });
  });
});
