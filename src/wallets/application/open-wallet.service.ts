import { Injectable } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { UniqueConstraintViolationException } from "@mikro-orm/core";
import { randomUUID } from "node:crypto";
import { Money, type MoneyProps } from "../../shared/domain/money.js";
import { OutboxRecord } from "../../database/entities/outbox.record.js";
import { WalletRecord } from "../../database/entities/wallet.record.js";
import { ledgerToRecord, transactionToRecord, walletFromRecord, walletToRecord, } from "../../database/mappers/financial-records.mapper.js";
import { WagerTransactionProcessed } from "../../wagering/domain/wager-transaction-processed.event.js";
import { WalletBalanceChanged } from "../domain/wallet-balance-changed.event.js";
import { PrepareWalletOpening } from "./prepare-wallet-opening.js";

export class WalletAlreadyExistsError extends Error {
  constructor() {
    super("Já existe uma carteira deste jogador para esta moeda.");
    this.name = "WalletAlreadyExistsError";
  }
}

export class WalletNotFoundError extends Error {
  constructor() {
    super("Carteira não encontrada.");
    this.name = "WalletNotFoundError";
  }
}

@Injectable()
export class OpenWalletService {
  constructor(private readonly orm: MikroORM) {}

  async execute(
    input: { playerId: string; initialBalance: MoneyProps },
    correlationId: string,
  ) {
    const plan = new PrepareWalletOpening().execute({
      walletId: randomUUID(),
      playerId: input.playerId,
      initialBalance: Money.from(input.initialBalance),
      transactionId: randomUUID(),
      ledgerEntryId: randomUUID(),
    });

    try {
      // Um fork por execução impede compartilhar estado entre requisições.
      await this.orm.em.fork().transactional(async (em) => {
        em.persist(walletToRecord(plan.wallet));

        if (plan.opening !== undefined) {
          const { transaction, entry } = plan.opening;
          em.persist(transactionToRecord(transaction));
          em.persist(ledgerToRecord(entry));

          const context = {
            aggregateId: plan.wallet.id,
            correlationId,
            causationId: transaction.id,
            occurredAt: transaction.createdAt,
          };
          const events = [
            WagerTransactionProcessed.create({
              ...context,
              eventId: randomUUID(),
              data: {
                transactionId: transaction.id,
                walletId: plan.wallet.id,
                providerId: transaction.providerId,
                externalTransactionId: transaction.externalTransactionId,
                kind: transaction.kind,
                money: transaction.money.toJSON(),
                balance: plan.wallet.balance.toJSON(),
              },
            }).toJSON(),
            WalletBalanceChanged.create({
              ...context,
              eventId: randomUUID(),
              data: {
                walletId: plan.wallet.id,
                transactionId: transaction.id,
                direction: entry.direction,
                money: entry.money.toJSON(),
                balanceBefore: entry.balanceBefore.toJSON(),
                balanceAfter: entry.balanceAfter.toJSON(),
                walletVersion: plan.wallet.version,
              },
            }).toJSON(),
          ];
          for (const event of events) {
            em.persist(
              Object.assign(new OutboxRecord(), {
                id: event.eventId,
                aggregateId: event.aggregateId,
                eventType: event.eventType,
                payload: event,
                occurredAt: transaction.createdAt,
                attempts: 0,
                nextAttemptAt: null,
                publishedAt: null,
              }),
            );
          }
        }

        await em.flush();
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        const existing = await this.orm.em.fork().findOne(WalletRecord, {
          playerId: plan.wallet.playerId,
          currency: plan.wallet.currency,
        });
        if (existing !== null) throw new WalletAlreadyExistsError();
      }
      throw error;
    }

    return this.response(plan.wallet);
  }

  async findById(id: string) {
    const record = await this.orm.em.fork().findOne(WalletRecord, { id });
    if (record === null) throw new WalletNotFoundError();
    return this.response(walletFromRecord(record));
  }

  private response(wallet: ReturnType<typeof walletFromRecord>) {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
