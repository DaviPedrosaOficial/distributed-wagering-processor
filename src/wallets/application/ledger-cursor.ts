import { BadRequestException } from "@nestjs/common";
import { isUUID } from "class-validator";

export const encodeLedgerCursor = (walletId: string, id: string) =>
  Buffer.from(JSON.stringify({ v: 1, walletId, id })).toString("base64url");

export function decodeLedgerCursor(token: string, walletId: string): string {
  try {
    if (token.length > 512 || !/^[A-Za-z0-9_-]+$/.test(token))
      throw new Error();
    const bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token) throw new Error();
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    const data = value as Record<string, unknown>;
    if (
      Object.keys(data).length !== 3 ||
      data.v !== 1 ||
      data.walletId !== walletId.toLowerCase() ||
      typeof data.id !== "string" ||
      !isUUID(data.id)
    )
      throw new Error();
    return data.id;
  } catch {
    throw new BadRequestException({ code: "INVALID_LEDGER_CURSOR" });
  }
}
