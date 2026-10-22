import "reflect-metadata";
import { expect, test } from "bun:test";
import { parseWagerMessage } from "./parse-wager-message.js";
import { retryDelaySeconds } from "./wager-consumer.worker.js";

const envelope = () => ({
  messageId: "message-1",
  type: "WagerTransactionRequested",
  occurredAt: "2026-10-22T00:00:00Z",
  data: {
    providerId: "provider-a",
    externalTransactionId: "t1",
    idempotencyKey: "p:t1",
    playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
    roundId: "r",
    gameId: "g",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
  },
});
test("mensagem SQS utiliza validação do contrato HTTP e mantém a chave fornecida", () => {
  const result = parseWagerMessage(JSON.stringify(envelope()));
  expect(result.idempotencyKey).toBe("p:t1");
  expect(result.input.money.amount).toBe("25.00");
});
test("mensagem inválida, OPENING e campos extras são permanentes", () => {
  expect(() => parseWagerMessage("{")).toThrow();
  for (const kind of ["OPENING", "OTHER"]) {
    const input = envelope();
    input.data.kind = kind;
    expect(() => parseWagerMessage(JSON.stringify(input))).toThrow();
  }
  const input = envelope();
  Object.assign(input.data, { extra: "invalid" });
  expect(() => parseWagerMessage(JSON.stringify(input))).toThrow();
});
test("retry de consumidor tem início de cinco segundos e teto de cinco minutos", () => {
  expect([1, 2, 3, 10].map(retryDelaySeconds)).toEqual([5, 10, 20, 300]);
});
