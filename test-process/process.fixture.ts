// Executado apenas pela suíte test:recovery. Os pontos de pausa não existem na API.
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { MikroORM } from "@mikro-orm/postgresql";
import { WalletsModule } from "../src/wallets/wallets.module.js";
import { WageringModule } from "../src/wagering/wagering.module.js";
import { integrationConfig } from "../test/integration-config.js";
import { ReferenceRetryWorker } from "../src/wagering/application/reference-retry.worker.js";
import { ProcessTransactionService } from "../src/wagering/application/process-transaction.service.js";
import { WagerConsumerWorker } from "../src/messaging/application/wager-consumer.worker.js";
import { OutboxPublisherWorker } from "../src/messaging/application/outbox-publisher.worker.js";
import { SqsTransport } from "../src/messaging/infrastructure/sqs.transport.js";
import { queueNames } from "../src/messaging/application/queue.port.js";

process.env.MESSAGING_ENABLED = "false";
process.env.REFERENCE_WORKER_ENABLED = "false";
const mode = process.argv[2];
const report = (data: object) =>
  process.stdout.write(`RECOVERY:${JSON.stringify(data)}\n`);
class CheckpointTransport extends SqsTransport {
  override async acknowledge(queue: string, receipt: string): Promise<void> {
    if (mode === "consumer-crash") {
      report({ checkpoint: "after-commit-before-ack", pid: process.pid });
      await new Promise<void>(() => {});
    }
    await super.acknowledge(queue, receipt);
  }
  override async publish(
    queue: string,
    body: string,
    group: string,
    dedup: string,
    attributes?: Record<string, string>,
  ): Promise<void> {
    await super.publish(queue, body, group, dedup, attributes);
    if (mode === "publisher-crash") {
      report({
        checkpoint: "after-send-before-mark",
        eventId: dedup,
        pid: process.pid,
      });
      await new Promise<void>(() => {});
    }
  }
}
const module = await Test.createTestingModule({
  imports: [
    MikroOrmModule.forRoot(integrationConfig()),
    WalletsModule,
    WageringModule,
  ],
}).compile();
const app = module.createNestApplication();
app.useLogger(["error"]);
await app.init();
const transport = new CheckpointTransport();
const orm = app.get<MikroORM>(MikroORM);
const service = app.get(ProcessTransactionService);
if (mode === "api") {
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as { port: number };
  report({ ready: true, port: address.port, pid: process.pid });
} else if (mode === "consumer" || mode === "consumer-crash") {
  report({ ready: true, pid: process.pid });
  const consumer = new WagerConsumerWorker(transport, service);
  for (;;) {
    const deliveries = await transport.receive(queueNames().requests, 1);
    for (const delivery of deliveries) {
      await consumer.handle(delivery);
      report({ handled: true, pid: process.pid });
    }
  }
} else if (mode === "references") {
  report({ ready: true, pid: process.pid });
  const worker = new ReferenceRetryWorker(orm, service);
  for (;;) {
    await worker.runDue();
    await Bun.sleep(250);
  }
} else if (mode === "publisher" || mode === "publisher-crash") {
  report({ ready: true, pid: process.pid });
  if (mode === "publisher")
    await new Promise<void>((resolve) =>
      process.stdin.once("data", () => resolve()),
    );
  const publisher = new OutboxPublisherWorker(orm, transport);
  await publisher.runBatch();
  report({ finished: true, pid: process.pid });
  transport.close();
  await app.close();
} else throw new Error("Modo de fixture inválido");
