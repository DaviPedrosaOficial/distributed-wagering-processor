import { LedgerDirection } from "../../wallets/domain/wallet-ledger-entry.js";
import { WagerTransaction, WagerTransactionKind as Kind, WagerTransactionStatus as Status, } from "./wager-transaction.js";

// WIN com referência também aguarda sua BET; seu valor pode ser diferente.
export function referenceIsCompatible(transaction: WagerTransaction, reference: WagerTransaction,): boolean {
  const allowed =
    transaction.kind === Kind.Rollback
      ? [Kind.Bet, Kind.Win, Kind.Refund]
      : [Kind.Bet];

  return (
    transaction.id !== reference.id &&
    transaction.providerId === reference.providerId &&
    transaction.referenceExternalTransactionId ===
      reference.externalTransactionId &&
    transaction.walletId === reference.walletId &&
    transaction.playerId === reference.playerId &&
    transaction.money.currency === reference.money.currency &&
    transaction.roundId === reference.roundId &&
    allowed.includes(reference.kind) &&
    (transaction.kind === Kind.Win || transaction.money.equals(reference.money))
  );
}

export function movementDirection(transaction: WagerTransaction, reference?: WagerTransaction,): LedgerDirection | undefined {
  switch (transaction.kind) {
    case Kind.Loss:
      return undefined;
    case Kind.Bet:
      return LedgerDirection.Debit;
    case Kind.Opening:
    case Kind.Win:
    case Kind.Refund:
      return LedgerDirection.Credit;
    case Kind.Rollback:
      if (
        !reference ||
        reference.status !== Status.Processed ||
        !referenceIsCompatible(transaction, reference)
      )
        throw new Error("ROLLBACK exige referência processada compatível.");
      return reference.kind === Kind.Bet
        ? LedgerDirection.Credit
        : LedgerDirection.Debit;
  }
}
