import { EntitySchema, ReferenceKind } from "@mikro-orm/core";

// O agendamento é persistido junto de PENDING_REFERENCE e sobrevive a reinícios.
export class ReferenceScheduleRecord {
  transactionId!: string;
  attempts!: number;
  nextAttemptAt!: Date;
  expiresAt!: Date;
  correlationId!: string;
}
export const ReferenceScheduleRecordSchema =
  new EntitySchema<ReferenceScheduleRecord>({
    class: ReferenceScheduleRecord,
    tableName: "reference_schedules",
    properties: {
      transactionId: {
        kind: ReferenceKind.MANY_TO_ONE,
        type: "WagerTransactionRecord",
        mapToPk: true,
        primary: true,
        fieldName: "transaction_id",
        deleteRule: "restrict",
      },
      attempts: { type: "integer" },
      nextAttemptAt: { type: Date, columnType: "timestamptz" },
      expiresAt: { type: Date, columnType: "timestamptz" },
      correlationId: { type: "string", length: 128 },
    },
    indexes: [
      {
        name: "reference_schedules_due_index",
        properties: ["nextAttemptAt", "transactionId"],
      },
    ],
    checks: [
      {
        name: "reference_schedules_attempts_nonnegative",
        expression: "attempts >= 0",
      },
    ],
  });
