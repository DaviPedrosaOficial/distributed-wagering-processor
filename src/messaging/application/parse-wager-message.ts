import { plainToInstance } from "class-transformer";
import { isISO8601, validateSync } from "class-validator";
import { createHash } from "node:crypto";
import { SubmitTransactionDto } from "../../wagering/http/submit-transaction.dto.js";

export class InvalidQueueMessageError extends Error {}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function parseWagerMessage(body: string) {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body);
  } catch {
    throw new InvalidQueueMessageError("INVALID_JSON");
  }
  if (
    !object(envelope) ||
    envelope.type !== "WagerTransactionRequested" ||
    typeof envelope.messageId !== "string" ||
    !envelope.messageId.trim() ||
    envelope.messageId.length > 128 ||
    typeof envelope.occurredAt !== "string" ||
    !isISO8601(envelope.occurredAt, { strict: true }) ||
    !object(envelope.data)
  )
    throw new InvalidQueueMessageError("INVALID_ENVELOPE");
  const { idempotencyKey, ...payload } = envelope.data;
  if (
    typeof idempotencyKey !== "string" ||
    !idempotencyKey.trim() ||
    idempotencyKey.length > 255
  )
    throw new InvalidQueueMessageError("INVALID_IDEMPOTENCY_KEY");
  const input = plainToInstance(SubmitTransactionDto, payload);
  if (
    validateSync(input, { whitelist: true, forbidNonWhitelisted: true }).length
  )
    throw new InvalidQueueMessageError("INVALID_PAYLOAD");
  const correlationId =
    typeof envelope.correlationId === "string" &&
    /^[A-Za-z0-9:_-]{1,128}$/.test(envelope.correlationId)
      ? envelope.correlationId
      : createHash("sha256").update(envelope.messageId).digest("hex");
  return {
    messageId: envelope.messageId,
    correlationId,
    input,
    idempotencyKey,
  };
}
