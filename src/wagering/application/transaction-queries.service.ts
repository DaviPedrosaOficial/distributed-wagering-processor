import { Injectable, NotFoundException } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { WagerTransactionRecord } from "../../database/entities/wager-transaction.record.js";

@Injectable()
export class TransactionQueriesService {
  constructor(private readonly orm: MikroORM) {}
  async byId(id: string) {
    return this.lookup({ id });
  }
  async byExternal(providerId: string, externalTransactionId: string) {
    return this.lookup({ providerId, externalTransactionId });
  }
  private async lookup(
    where:
      { id: string } | { providerId: string; externalTransactionId: string },
  ) {
    const record = await this.orm.em
      .fork()
      .findOne(WagerTransactionRecord, where);
    if (!record) throw new NotFoundException({ code: "TRANSACTION_NOT_FOUND" });
    return {
      transactionId: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind,
      money: { amount: record.amount, currency: record.currency },
      status: record.status,
      referenceExternalTransactionId: record.referenceExternalTransactionId,
      referenceTransactionId: record.referenceTransactionId,
      failureCode: record.failureCode,
      balance:
        record.resultBalance === null
          ? null
          : { amount: record.resultBalance, currency: record.currency },
      createdAt: record.createdAt.toISOString(),
      processedAt: record.processedAt?.toISOString() ?? null,
    };
  }
}
