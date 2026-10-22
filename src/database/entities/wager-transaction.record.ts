import { DecimalType, EntitySchema, ReferenceKind } from "@mikro-orm/core";
import { FailureCode, WagerTransactionKind, WagerTransactionStatus, } from "../../wagering/domain/wager-transaction.js";

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: WagerTransactionKind;
  amount!: string;
  currency!: string;
  status!: WagerTransactionStatus;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  failureCode!: FailureCode | null;
  resultBalance!: string | null;
  createdAt!: Date;
  processedAt!: Date | null;
}

export const WagerTransactionRecordSchema =
  new EntitySchema<WagerTransactionRecord>({
    class: WagerTransactionRecord,
    tableName: "wager_transactions",
    properties: {
      id: { type: "uuid", primary: true },
      providerId: { type: "string" },
      externalTransactionId: { type: "string" },
      idempotencyKey: { type: "string" },
      payloadHash: { type: "string", length: 64 },
      walletId: {
        kind: ReferenceKind.MANY_TO_ONE,
        type: "WalletRecord",
        mapToPk: true,
        fieldName: "wallet_id",
        deleteRule: "restrict",
      },
      playerId: { type: "uuid" },
      roundId: { type: "string" },
      gameId: { type: "string" },
      kind: { enum: true, items: () => WagerTransactionKind },
      amount: { type: new DecimalType("string"), precision: 20, scale: 2 },
      currency: { type: "string", length: 3 },
      status: { enum: true, items: () => WagerTransactionStatus },
      referenceExternalTransactionId: { type: "string", nullable: true },
      referenceTransactionId: {
        kind: ReferenceKind.MANY_TO_ONE,
        type: "WagerTransactionRecord",
        mapToPk: true,
        nullable: true,
        fieldName: "reference_transaction_id",
        deleteRule: "restrict",
      },
      failureCode: { enum: true, items: () => FailureCode, nullable: true },
      resultBalance: {
        type: new DecimalType("string"),
        precision: 20,
        scale: 2,
        nullable: true,
      },
      createdAt: { type: Date, columnType: "timestamptz" },
      processedAt: { type: Date, columnType: "timestamptz", nullable: true },
    },
    uniques: [
      {
        name: "wager_transactions_reversal_unique",
        properties: ["referenceTransactionId", "kind"],
        where: "status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')",
      },
      {
        name: "wager_transactions_idempotency_unique",
        properties: ["idempotencyKey"],
      },
      {
        name: "wager_transactions_provider_external_unique",
        properties: ["providerId", "externalTransactionId"],
      },
    ],
    indexes: [
      {
        name: "wager_transactions_wallet_created_index",
        properties: ["walletId", "createdAt", "id"],
      },
    ],
    checks: [
      {
        name: "wager_transactions_resolved_reversal",
        expression:
          "status <> 'PROCESSED' or kind not in ('REFUND','ROLLBACK') or reference_transaction_id is not null",
      },
      {
        name: "wager_transactions_amount_range",
        expression: "amount >= 0 AND amount <= 999999999999999999.99",
      },
      {
        name: "wager_transactions_currency_supported",
        expression: "currency IN ('BRL', 'USD')",
      },
      {
        name: "wager_transactions_result_balance_range",
        expression:
          "result_balance IS NULL OR (result_balance >= 0 AND result_balance <= 999999999999999999.99)",
      },
      {
        name: "wager_transactions_processed_result",
        expression:
          "status <> 'PROCESSED' OR (processed_at IS NOT NULL AND result_balance IS NOT NULL)",
      },
      {
        name: "wager_transactions_failure_required",
        expression:
          "status NOT IN ('REJECTED', 'FAILED') OR failure_code IS NOT NULL",
      },
      {
        name: "wager_transactions_reference_required",
        expression:
          "kind NOT IN ('REFUND', 'ROLLBACK') OR (reference_external_transaction_id IS NOT NULL AND btrim(reference_external_transaction_id) <> '')",
      },
    ],
  });
