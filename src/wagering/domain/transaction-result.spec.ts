import { describe, expect, test } from "bun:test";
import { Money } from "../../shared/domain/money.js";
import { transactionFromRecord, transactionToRecord, } from "../../database/mappers/financial-records.mapper.js";
import { InvalidWagerTransactionError, WagerTransaction, WagerTransactionKind, } from "./wager-transaction.js";

describe("Resultado histórico da transação", () => {
  const create = () =>
    WagerTransaction.create({
      id: "transaction-1",
      providerId: "provider-a",
      externalTransactionId: "external-1",
      idempotencyKey: "provider-a:external-1",
      payloadHash: "hash",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "game-1",
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: "25.00", currency: "BRL" }),
      createdAt: new Date(),
    });

  test("deve preservar o resultado após um cálculo posterior", () => {
    const transaction = create();
    const balance = Money.from({ amount: "75.00", currency: "BRL" });
    transaction.markProcessed(undefined, new Date(), balance);
    const current = balance.add(
      Money.from({ amount: "40.00", currency: "BRL" }),
    );
    expect(current.toJSON().amount).toBe("115.00");
    expect(transaction.getProcessedResult().balance.amount).toBe("75.00");
  });

  test("deve recuperar o resultado pelo mapper de persistência", () => {
    const original = create();
    original.markProcessed(
      undefined,
      new Date(),
      Money.from({ amount: "75.00", currency: "BRL" }),
    );
    const record = transactionToRecord(original);
    expect(record.resultBalance).toBe("75.00");
    const restored = transactionFromRecord(record);
    expect(restored.getProcessedResult()).toEqual(
      original.getProcessedResult(),
    );
  });

  test("deve impedir resultado para transação pendente", () => {
    expect(() => create().getProcessedResult()).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test("deve rejeitar saldo histórico negativo sem finalizar", () => {
    const transaction = create();
    expect(() =>
      transaction.markProcessed(
        undefined,
        new Date(),
        Money.from({ amount: "1.00", currency: "BRL" }).negate(),
      ),
    ).toThrow(InvalidWagerTransactionError);
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.resultBalance).toBeUndefined();
  });

  test("deve rejeitar saldo histórico em outra moeda sem finalizar", () => {
    const transaction = create();
    expect(() =>
      transaction.markProcessed(undefined, new Date(), Money.zero("USD")),
    ).toThrow(InvalidWagerTransactionError);
    expect(transaction.isTerminal()).toBe(false);
  });
});
