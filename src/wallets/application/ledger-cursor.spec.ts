import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { encodeLedgerCursor, decodeLedgerCursor } from "./ledger-cursor.js";

test("cursor está vinculado à carteira e rejeita formato inválido", () => {
  const wallet = randomUUID();
  const id = randomUUID();
  const cursor = encodeLedgerCursor(wallet, id);
  expect(decodeLedgerCursor(cursor, wallet)).toBe(id);
  expect(() => decodeLedgerCursor(cursor, randomUUID())).toThrow();
  for (const invalid of [
    "",
    "not-json",
    "!!!!",
    Buffer.from(JSON.stringify({ v: 2, walletId: wallet, id })).toString(
      "base64url",
    ),
  ])
    expect(() => decodeLedgerCursor(invalid, wallet)).toThrow();
});
