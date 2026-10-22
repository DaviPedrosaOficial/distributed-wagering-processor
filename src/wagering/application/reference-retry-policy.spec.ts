import { expect, test } from "bun:test";
import { nextReferenceAttempt, REFERENCE_TTL_MS, } from "./reference-retry-policy.js";
test("espera exponencial de referências tem início, teto e TTL explícitos", () => {
  const at = new Date("2026-10-22T00:00:00Z");
  expect(
    [0, 1, 2, 6, 100].map(
      (n) => nextReferenceAttempt(at, n).getTime() - at.getTime(),
    ),
  ).toEqual([5000, 10000, 20000, 300000, 300000]);
  expect(REFERENCE_TTL_MS).toBe(900000);
  expect(at.toISOString()).toBe("2026-10-22T00:00:00.000Z");
});
