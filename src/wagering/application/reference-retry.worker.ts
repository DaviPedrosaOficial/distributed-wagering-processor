import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit, } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { ReferenceScheduleRecord } from "../../database/entities/reference-schedule.record.js";
import { ProcessTransactionService } from "./process-transaction.service.js";

@Injectable()
export class ReferenceRetryWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private readonly logger = new Logger(ReferenceRetryWorker.name);
  constructor(
    private readonly orm: MikroORM,
    private readonly service: ProcessTransactionService,
  ) {}
  onModuleInit(): void {
    if (process.env.REFERENCE_WORKER_ENABLED === "false") return;
    this.timer = setInterval(() => {
      if (this.active) return;
      this.active = this.runDue()
        .catch(() => {
          this.logger.error(JSON.stringify({ event: "reference_scan_failed" }));
        })
        .finally(() => {
          this.active = undefined;
        });
    }, 1000);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
  async runDue(at = new Date()): Promise<void> {
    const due = await this.orm.em
      .fork()
      .find(
        ReferenceScheduleRecord,
        { nextAttemptAt: { $lte: at } },
        { orderBy: { nextAttemptAt: "asc", transactionId: "asc" }, limit: 50 },
      );
    for (const item of due) {
      try {
        await this.service.retryPending(item.transactionId, at);
      } catch {
        this.logger.error(
          JSON.stringify({
            event: "reference_retry_failed",
            transactionId: item.transactionId,
            correlationId: item.correlationId,
          }),
        );
      }
    }
  }
}
