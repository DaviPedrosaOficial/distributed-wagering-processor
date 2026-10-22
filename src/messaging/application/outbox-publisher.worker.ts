import { Injectable, type OnApplicationBootstrap, type BeforeApplicationShutdown, } from "@nestjs/common";
import { LockMode } from "@mikro-orm/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { OutboxRecord } from "../../database/entities/outbox.record.js";
import { OutboxMessage } from "../domain/outbox-message.js";
import { QueuePort, queueNames, messagingLog } from "./queue.port.js";

@Injectable()
export class OutboxPublisherWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopping = false;
  constructor(
    private readonly orm: MikroORM,
    private readonly broker: QueuePort,
  ) {}
  onApplicationBootstrap(): void {
    if (process.env.MESSAGING_ENABLED !== "true") return;
    this.timer = setInterval(() => {
      if (this.active || this.stopping) return;
      this.active = this.runBatch()
        .catch(() => messagingLog("outbox_scan_failed"))
        .finally(() => {
          this.active = undefined;
        });
    }, 1000);
    this.timer.unref();
  }
  async runBatch(at = new Date()): Promise<void> {
    for (let n = 0; n < 10 && !this.stopping; n++) {
      if (!(await this.publishOne(at))) break;
    }
  }
  async publishOne(at = new Date()): Promise<boolean> {
    return this.orm.em.fork().transactional(async (em) => {
      // Lock apenas da outbox; a transação financeira já foi confirmada.
      const record = await em.findOne(
        OutboxRecord,
        {
          publishedAt: null,
          $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: at } }],
        },
        {
          orderBy: { occurredAt: "asc", id: "asc" },
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        },
      );
      if (!record) return false;
      const message = OutboxMessage.rehydrate(record);
      try {
        await this.broker.publish(
          queueNames().events,
          JSON.stringify(record.payload),
          record.aggregateId,
          record.id,
        );
        message.markPublished(new Date());
      } catch {
        message.scheduleRetry(new Date());
        messagingLog("outbox_retry_scheduled", {
          eventId: record.id,
          walletId: record.aggregateId,
          attempt: message.attempts,
        });
      }
      record.publishedAt = message.publishedAt;
      record.nextAttemptAt = message.nextAttemptAt;
      record.attempts = message.attempts;
      await em.flush();
      return true;
    });
  }
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}
