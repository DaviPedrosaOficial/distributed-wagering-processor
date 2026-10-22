import { createHash } from "node:crypto";
import type { MoneyProps } from "../../shared/domain/money.js";
import type { WagerTransactionKind } from "../domain/wager-transaction.js";

export interface TransactionPayload {
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

// Lista explícita de campos de negócio; transporte e Idempotency-Key ficam fora.
export function payloadHash(input: TransactionPayload): string {
  const fields = {
    externalTransactionId: input.externalTransactionId,
    gameId: input.gameId,
    kind: input.kind,
    money: { amount: input.money.amount, currency: input.money.currency },
    playerId: input.playerId,
    providerId: input.providerId,
    ...(input.referenceExternalTransactionId === undefined
      ? {}
      : {
          referenceExternalTransactionId: input.referenceExternalTransactionId,
        }),
    roundId: input.roundId,
    walletId: input.walletId,
  };
  const sorted = Object.fromEntries(
    Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}
