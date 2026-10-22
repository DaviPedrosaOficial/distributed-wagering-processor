import { describe, expect, test } from "bun:test";
import { Money } from "../../shared/domain/money.js";
import { WagerTransactionKind, WagerTransactionStatus, } from "../../wagering/domain/wager-transaction.js";
import { LedgerDirection } from "../domain/wallet-ledger-entry.js";
import { PrepareWalletOpening } from "./prepare-wallet-opening.js";

describe("PrepareWalletOpening", () => {
  const input = () => ({
    walletId: "wallet-1",
    playerId: "player-1",
    initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    transactionId: "transaction-1",
    ledgerEntryId: "entry-1",
  });

  test("deve preparar OPENING e ledger preservando a versão 1", () => {
    const { wallet, opening } = new PrepareWalletOpening().execute(input());
    if (opening === undefined) throw new Error("Abertura financeira ausente.");
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(opening.transaction.kind).toBe(WagerTransactionKind.Opening);
    expect(opening.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(opening.transaction.getProcessedResult().balance.amount).toBe(
      "100.00",
    );
    expect(opening.transaction.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(opening.entry.transactionId).toBe(opening.transaction.id);
    expect(opening.entry.direction).toBe(LedgerDirection.Credit);
    expect(opening.entry.balanceBefore.isZero()).toBe(true);
    expect(opening.entry.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(opening.entry.isBalanced()).toBe(true);
    expect(opening.entry.createdAt.getTime()).toBe(wallet.createdAt.getTime());
  });

  test("deve abrir com zero sem transação nem ledger", () => {
    const result = new PrepareWalletOpening().execute({
      ...input(),
      initialBalance: Money.zero("BRL"),
    });
    expect(result.wallet.version).toBe(1);
    expect(result.wallet.balance.isZero()).toBe(true);
    expect(result.opening).toBeUndefined();
  });

  test("deve suportar USD mantendo as moedas consistentes", () => {
    const { wallet, opening } = new PrepareWalletOpening().execute({
      ...input(),
      initialBalance: Money.from({ amount: "0.01", currency: "USD" }),
    });
    expect(wallet.currency).toBe("USD");
    expect(opening?.entry.money.currency).toBe("USD");
    expect(opening?.transaction.resultBalance?.currency).toBe("USD");
  });
});
