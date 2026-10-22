import { DecimalType, EntitySchema, ReferenceKind } from "@mikro-orm/core";
import { LedgerDirection } from "../../wallets/domain/wallet-ledger-entry.js";

export class WalletLedgerRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: LedgerDirection;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const WalletLedgerRecordSchema = new EntitySchema<WalletLedgerRecord>({
  class: WalletLedgerRecord,
  tableName: "wallet_ledger",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: {
      kind: ReferenceKind.MANY_TO_ONE,
      type: "WalletRecord",
      mapToPk: true,
      fieldName: "wallet_id",
      deleteRule: "restrict",
    },
    transactionId: {
      kind: ReferenceKind.MANY_TO_ONE,
      type: "WagerTransactionRecord",
      mapToPk: true,
      fieldName: "transaction_id",
      deleteRule: "restrict",
    },
    direction: { enum: true, items: () => LedgerDirection },
    amount: { type: new DecimalType("string"), precision: 20, scale: 2 },
    currency: { type: "string", length: 3 },
    balanceBefore: { type: new DecimalType("string"), precision: 20, scale: 2 },
    balanceAfter: { type: new DecimalType("string"), precision: 20, scale: 2 },
    createdAt: { type: Date, columnType: "timestamptz" },
  },
  uniques: [
    {
      name: "wallet_ledger_transaction_wallet_unique",
      properties: ["transactionId", "walletId"],
    },
  ],
  indexes: [
    {
      name: "wallet_ledger_wallet_created_index",
      properties: ["walletId", "createdAt", "id"],
    },
  ],
  checks: [
    {
      name: "wallet_ledger_amount_positive",
      expression: "amount > 0 AND amount <= 999999999999999999.99",
    },
    {
      name: "wallet_ledger_currency_supported",
      expression: "currency IN ('BRL', 'USD')",
    },
    {
      name: "wallet_ledger_balances_range",
      expression:
        "balance_before >= 0 AND balance_before <= 999999999999999999.99 AND balance_after >= 0 AND balance_after <= 999999999999999999.99",
    },
    {
      name: "wallet_ledger_balanced",
      expression:
        "(direction = 'DEBIT' AND balance_after = balance_before - amount) OR (direction = 'CREDIT' AND balance_after = balance_before + amount)",
    },
  ],
});
