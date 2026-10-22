import { Money } from "../../shared/domain/money.js";
import { Wallet } from "../../wallets/domain/wallet.js";
import { WalletLedgerEntry } from "../../wallets/domain/wallet-ledger-entry.js";
import { WagerTransaction } from "../../wagering/domain/wager-transaction.js";
import { WalletRecord } from "../entities/wallet.record.js";
import { WalletLedgerRecord } from "../entities/wallet-ledger.record.js";
import { WagerTransactionRecord } from "../entities/wager-transaction.record.js";

export function walletToRecord(wallet: Wallet): WalletRecord {
  return Object.assign(new WalletRecord(), {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON().amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  });
}

export function walletFromRecord(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    balance: Money.from({ amount: record.balance, currency: record.currency }),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function transactionToRecord(transaction: WagerTransaction,): WagerTransactionRecord {
  return Object.assign(new WagerTransactionRecord(), {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount: transaction.money.toJSON().amount,
    currency: transaction.money.currency,
    status: transaction.status,
    referenceExternalTransactionId:
      transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    resultBalance: transaction.resultBalance?.toJSON().amount ?? null,
    createdAt: transaction.createdAt,
    processedAt: transaction.processedAt ?? null,
  });
}

export function transactionFromRecord(record: WagerTransactionRecord,): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind,
    money: Money.from({ amount: record.amount, currency: record.currency }),
    status: record.status,
    referenceExternalTransactionId:
      record.referenceExternalTransactionId ?? undefined,
    referenceTransactionId: record.referenceTransactionId ?? undefined,
    failureCode: record.failureCode ?? undefined,
    resultBalance:
      record.resultBalance === null
        ? undefined
        : Money.from({
            amount: record.resultBalance,
            currency: record.currency,
          }),
    createdAt: record.createdAt,
    processedAt: record.processedAt ?? undefined,
  });
}

export function ledgerToRecord(entry: WalletLedgerEntry): WalletLedgerRecord {
  return Object.assign(new WalletLedgerRecord(), {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toJSON().amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toJSON().amount,
    balanceAfter: entry.balanceAfter.toJSON().amount,
    createdAt: entry.createdAt,
  });
}
