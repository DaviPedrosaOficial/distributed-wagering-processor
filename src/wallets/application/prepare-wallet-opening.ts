import { createHash } from "node:crypto";
import { Money } from "../../shared/domain/money.js";
import { WagerTransaction, WagerTransactionKind, } from "../../wagering/domain/wager-transaction.js";
import { Wallet } from "../domain/wallet.js";
import { LedgerDirection, WalletLedgerEntry, } from "../domain/wallet-ledger-entry.js";

export interface PrepareWalletOpeningProps {
  walletId: string;
  playerId: string;
  initialBalance: Money;
  transactionId: string;
  ledgerEntryId: string;
}

// Prepara objetos em memória; quem chama é responsável pela transação SQL.
export class PrepareWalletOpening {
  execute(props: PrepareWalletOpeningProps) {
    const wallet = Wallet.open({
      id: props.walletId,
      playerId: props.playerId,
      initialBalance: props.initialBalance,
    });

    if (wallet.balance.isZero()) {
      return { wallet, opening: undefined };
    }

    const identity = `opening:${wallet.id}`;
    
    // OPENING é interno. Os campos e sua ordem são fixos para este hash.
    const payloadHash = createHash("sha256")
      .update(
        JSON.stringify({
          amount: wallet.balance.toJSON().amount,
          currency: wallet.currency,
          kind: WagerTransactionKind.Opening,
          playerId: wallet.playerId,
          walletId: wallet.id,
        }),
      )
      .digest("hex");

    const transaction = WagerTransaction.create({
      id: props.transactionId,
      providerId: "__internal__",
      externalTransactionId: identity,
      idempotencyKey: `__internal__:${identity}`,
      payloadHash,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: identity,
      gameId: "__wallet_opening__",
      kind: WagerTransactionKind.Opening,
      money: wallet.balance,
      createdAt: wallet.createdAt,
    });

    const entry = WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: wallet.id,
      transactionId: transaction.id,
      direction: LedgerDirection.Credit,
      money: wallet.balance,
      balanceBefore: Money.zero(wallet.currency),
      balanceAfter: wallet.balance,
      createdAt: wallet.createdAt,
    });

    transaction.markProcessed(undefined, wallet.createdAt, wallet.balance);
    return { wallet, opening: { transaction, entry } };
  }
}
