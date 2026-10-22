import { EntitySchema } from "@mikro-orm/core";

// O evento é confirmado com os registros financeiros; não há publicação aqui.
export class OutboxRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date | null;
  publishedAt!: Date | null;
}

export const OutboxRecordSchema = new EntitySchema<OutboxRecord>({
  class: OutboxRecord,
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "uuid" },
    eventType: { type: "string" },
    payload: { type: "json" },
    occurredAt: { type: Date, columnType: "timestamptz" },
    attempts: { type: "integer", default: 0 },
    nextAttemptAt: { type: Date, columnType: "timestamptz", nullable: true },
    publishedAt: { type: Date, columnType: "timestamptz", nullable: true },
  },
  indexes: [
    {
      name: "outbox_pending_index",
      properties: ["publishedAt", "nextAttemptAt", "occurredAt", "id"],
    },
  ],
  checks: [
    { name: "outbox_attempts_nonnegative", expression: "attempts >= 0" },
  ],
});
