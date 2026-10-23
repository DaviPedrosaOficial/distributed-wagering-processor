import { Controller, Get, Header, ServiceUnavailableException, } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { QueuePort } from "../../messaging/application/queue.port.js";
import { telemetry } from "../telemetry.js";

@Controller()
export class OperationsController {
  constructor(
    private readonly orm: MikroORM,
    private readonly broker: QueuePort,
  ) {}
  @Get("health/live") live() {
    return { status: "ok" };
  }
  @Get("health/ready") async ready() {
    const checks = await Promise.allSettled([
      this.orm.em.fork().getConnection().execute("select 1"),
      this.broker.ready(),
    ]);
    const dependencies = {
      postgres: checks[0]!.status === "fulfilled",
      sqs: checks[1]!.status === "fulfilled",
    };
    if (!dependencies.postgres || !dependencies.sqs)
      throw new ServiceUnavailableException({
        status: "not_ready",
        dependencies,
      });
    return { status: "ok", dependencies };
  }
  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  async metrics() {
    const em = this.orm.em.fork();
    const states = await em
      .getConnection()
      .execute<Array<{ status: string; count: string }>>(
        "select status,count(*)::text as count from wager_transactions group by status",
      );
    const pending = await em
      .getConnection()
      .execute<Array<{ count: string; oldest: Date | null }>>(
        "select count(*)::text as count,min(occurred_at) as oldest from outbox_messages where published_at is null",
      );
    let text = telemetry.render() + "# TYPE wager_transactions_current gauge\n";
    for (const status of [
      "PENDING",
      "PENDING_REFERENCE",
      "PROCESSED",
      "REJECTED",
      "FAILED",
    ])
      text += `wager_transactions_current{status="${status}"} ${states.find((row) => row.status === status)?.count ?? "0"}\n`;
    const row = pending[0]!;
    const lag =
      row.oldest === null
        ? 0
        : Math.max(0, (Date.now() - new Date(row.oldest).getTime()) / 1000);
    return (
      text +
      `# TYPE wager_outbox_pending gauge\nwager_outbox_pending ${row.count}\n# TYPE wager_outbox_lag_seconds gauge\nwager_outbox_lag_seconds ${lag}\n`
    );
  }
}
