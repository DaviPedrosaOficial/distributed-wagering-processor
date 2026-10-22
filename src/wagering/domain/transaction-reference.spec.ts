import { describe, expect, test } from "bun:test";
import { Money } from "../../shared/domain/money.js";
import { LedgerDirection } from "../../wallets/domain/wallet-ledger-entry.js";
import { WagerTransaction, WagerTransactionKind as Kind, WagerTransactionStatus as Status, } from "./wager-transaction.js";
import { movementDirection, referenceIsCompatible, } from "./transaction-reference.js";

const create = (
  kind: Kind,
  externalTransactionId: string,
  amount = "25.00",
  referenceExternalTransactionId?: string,
) =>
  WagerTransaction.create({
    id: externalTransactionId,
    externalTransactionId,
    providerId: "p",
    walletId: "w",
    playerId: "u",
    gameId: "g",
    roundId: "r",
    kind,
    money: Money.from({ amount, currency: "BRL" }),
    idempotencyKey: externalTransactionId,
    payloadHash: "hash",
    createdAt: new Date(),
    referenceExternalTransactionId,
  });
describe("Referências e direção das reversões", () => {
  test("REFUND exige valor integral e contexto compatível", () => {
    const bet = create(Kind.Bet, "bet");
    expect(
      referenceIsCompatible(create(Kind.Refund, "refund", "25.00", "bet"), bet),
    ).toBe(true);
    expect(
      referenceIsCompatible(
        create(Kind.Refund, "partial", "20.00", "bet"),
        bet,
      ),
    ).toBe(false);
    expect(
      referenceIsCompatible(
        create(Kind.Refund, "wrong", "25.00", "other"),
        bet,
      ),
    ).toBe(false);
  });
  test("WIN pode possuir valor diferente de sua BET", () => {
    expect(
      referenceIsCompatible(
        create(Kind.Win, "win", "80.00", "bet"),
        create(Kind.Bet, "bet"),
      ),
    ).toBe(true);
  });
  test("ROLLBACK inverte BET, WIN e REFUND", () => {
    for (const kind of [Kind.Bet, Kind.Win, Kind.Refund]) {
      const reference = create(
        kind,
        "ref",
        "25.00",
        kind === Kind.Refund ? "original" : undefined,
      );
      reference.markProcessed(
        kind === Kind.Refund ? "original-internal" : undefined,
        new Date(),
        Money.zero("BRL"),
      );
      const rollback = create(Kind.Rollback, "rollback", "25.00", "ref");
      expect(movementDirection(rollback, reference)).toBe(
        kind === Kind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit,
      );
    }
  });
  test("WIN referenciado pode aguardar a referência sem mudar requiresReference", () => {
    const win = create(Kind.Win, "win", "40.00", "bet");
    win.markPendingReference();
    expect(win.requiresReference()).toBe(false);
    expect(win.status).toBe(Status.PendingReference);
  });
});
