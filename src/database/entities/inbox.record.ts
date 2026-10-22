import { EntitySchema } from "@mikro-orm/core";
import type { TransactionResponse } from "../../wagering/application/process-transaction.service.js";

export class InboxRecord {
  messageId!: string;
  consumerName!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
  result!: TransactionResponse | null;
}

export const InboxRecordSchema = new EntitySchema<InboxRecord>({
  class: InboxRecord,
  tableName: "inbox_messages",
  properties: {
    messageId: { type: "string", length: 128, primary: true },
    consumerName: { type: "string", length: 128, primary: true },
    payloadHash: { type: "string", length: 64 },
    receivedAt: { type: Date, columnType: "timestamptz" },
    processedAt: { type: Date, columnType: "timestamptz", nullable: true },
    result: { type: "json", nullable: true },
  },
  checks: [
    {
      name: "inbox_messages_processed_result",
      expression: "processed_at IS NULL OR result IS NOT NULL",
    },
  ],
});
