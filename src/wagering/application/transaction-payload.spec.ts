import { describe, expect, test } from "bun:test";
import { payloadHash, type TransactionPayload } from "./transaction-payload.js";
import { WagerTransactionKind } from "../domain/wager-transaction.js";
const payload: TransactionPayload = {
  providerId: "provider-a",
  externalTransactionId: "tx-1",
  walletId: "wallet-1",
  playerId: "player-1",
  gameId: "game-1",
  roundId: "round-1",
  kind: WagerTransactionKind.Bet,
  money: { amount: "25.00", currency: "BRL" },
};
describe("Hash da operação externa", () => {
  test("independe da ordem das chaves inclusive em money", () => {
    const reordered = Object.fromEntries(
      Object.entries(payload).reverse(),
    ) as unknown as TransactionPayload;
    reordered.money = { currency: "BRL", amount: "25.00" };
    expect(payloadHash(reordered)).toBe(payloadHash(payload));
  });
  test("considera cada campo de negócio", () => {
    for (const key of [
      "providerId",
      "externalTransactionId",
      "walletId",
      "playerId",
      "gameId",
      "roundId",
    ] as const) {
      expect(payloadHash({ ...payload, [key]: "different" })).not.toBe(
        payloadHash(payload),
      );
    }
    expect(
      payloadHash({ ...payload, kind: WagerTransactionKind.Win }),
    ).not.toBe(payloadHash(payload));
    expect(
      payloadHash({ ...payload, money: { ...payload.money, amount: "26.00" } }),
    ).not.toBe(payloadHash(payload));
    expect(
      payloadHash({ ...payload, referenceExternalTransactionId: "ref" }),
    ).not.toBe(payloadHash(payload));
  });
  test("ignora metadados de transporte e campos fora do contrato", () => {
    const extra = {
      ...payload,
      correlationId: "corr",
      idempotencyKey: "other",
    };
    expect(payloadHash(extra)).toBe(payloadHash(payload));
  });
});
