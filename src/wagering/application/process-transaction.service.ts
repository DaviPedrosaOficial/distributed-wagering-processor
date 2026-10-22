import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException, } from "@nestjs/common";
import { ConnectionException, DriverException, LockMode, UniqueConstraintViolationException, } from "@mikro-orm/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { randomUUID } from "node:crypto";
import { WalletRecord } from "../../database/entities/wallet.record.js";
import { WagerTransactionRecord } from "../../database/entities/wager-transaction.record.js";
import { OutboxRecord } from "../../database/entities/outbox.record.js";
import { ledgerToRecord, transactionToRecord, walletFromRecord, } from "../../database/mappers/financial-records.mapper.js";
import { InvalidMoneyError, Money } from "../../shared/domain/money.js";
import { InsufficientBalanceError } from "../../wallets/domain/wallet.js";
import type { WalletLedgerEntry } from "../../wallets/domain/wallet-ledger-entry.js";
import { WalletBalanceChanged } from "../../wallets/domain/wallet-balance-changed.event.js";
import { FailureCode, WagerTransaction, WagerTransactionKind as Kind, WagerTransactionStatus as Status, } from "../domain/wager-transaction.js";
import { WagerTransactionProcessed } from "../domain/wager-transaction-processed.event.js";
import { WagerTransactionRejected } from "../domain/wager-transaction-rejected.event.js";
import { payloadHash, type TransactionPayload } from "./transaction-payload.js";

@Injectable()
export class ProcessTransactionService {
  constructor(private readonly orm: MikroORM) {}

  async execute(input: TransactionPayload, key: string, correlationId: string) {
    if (typeof key !== "string" || !key.trim() || key.length > 255)
      throw new BadRequestException({ code: "INVALID_IDEMPOTENCY_KEY" });
    if (![Kind.Bet, Kind.Win, Kind.Loss].includes(input.kind))
      throw new BadRequestException({ code: "UNSUPPORTED_OPERATION" });
    if (input.providerId === "__internal__")
      throw new BadRequestException({ code: "RESERVED_PROVIDER" });
    // Referências serão integradas no próximo bloco; não as ignoramos silenciosamente.
    if (input.referenceExternalTransactionId !== undefined)
      throw new BadRequestException({ code: "REFERENCE_NOT_SUPPORTED_YET" });
    let money: Money;
    try {
      money = Money.from(input.money);
    } catch (error) {
      if (error instanceof InvalidMoneyError)
        throw new BadRequestException({ code: "INVALID_MONEY" });
      throw error;
    }
    if (input.kind !== Kind.Loss && money.isZero())
      throw new BadRequestException({ code: "ZERO_MOVEMENT" });
    const hash = payloadHash(input);
    const identity = {
      $or: [
        { idempotencyKey: key },
        {
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
        },
      ],
    };
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        // O bloqueio vive no PostgreSQL e termina somente no commit/rollback.
        const record = await em.findOne(
          WalletRecord,
          { id: input.walletId },
          // Bloqueio que nos permite travar a carteira de um usuário que já esteja sendo, forçando outras solicitações a aguardarem
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );

        if (!record) throw new NotFoundException({ code: "WALLET_NOT_FOUND" });
        
        const existing = await em.find(WagerTransactionRecord, identity);
        
        if (existing.length) return this.replay(existing, key, hash);
        
        if (record.playerId !== input.playerId) throw new BadRequestException({ code: "WALLET_PLAYER_MISMATCH" });
        
        const wallet = walletFromRecord(record);
        const at = new Date();
        const transaction = WagerTransaction.create({
          ...input,
          money,
          id: randomUUID(),
          idempotencyKey: key,
          payloadHash: hash,
          createdAt: at,
        });
        let entry: WalletLedgerEntry | undefined;
        if (wallet.currency !== money.currency) {
          transaction.reject(FailureCode.CurrencyMismatch);
        } else {
          try {
            const movement = {
              ledgerEntryId: randomUUID(),
              transactionId: transaction.id,
              money,
              at,
            };
            if (input.kind === Kind.Bet) entry = wallet.debit(movement);
            if (input.kind === Kind.Win) entry = wallet.credit(movement);
            transaction.markProcessed(undefined, at, wallet.balance);
          } catch (error) {
            if (!(error instanceof InsufficientBalanceError)) throw error;
            transaction.reject(FailureCode.InsufficientBalance);
          }
        }
        const transactionRecord = transactionToRecord(transaction);
        em.persist(transactionRecord);

        // Garante que o trigger do ledger encontre a transação PROCESSED.
        // Flush continua dentro da mesma transação SQL: ainda pode ser revertido.
        await em.flush();
        const context = {
          aggregateId: wallet.id,
          correlationId,
          causationId: transaction.id,
          occurredAt: at,
          eventId: randomUUID(),
        };
        const data = {
          transactionId: transaction.id,
          walletId: wallet.id,
          providerId: transaction.providerId,
          externalTransactionId: transaction.externalTransactionId,
        };
        const event =
          transaction.status === Status.Processed
            ? WagerTransactionProcessed.create({
                ...context,
                data: {
                  ...data,
                  kind: transaction.kind,
                  money: money.toJSON(),
                  balance: wallet.balance.toJSON(),
                },
              }).toJSON()
            : WagerTransactionRejected.create({
                ...context,
                data: { ...data, failureCode: transaction.failureCode! },
              }).toJSON();
        const events: Array<{
          eventId: string;
          eventType: string;
          data: object;
        }> = [event];
        if (entry) {
          record.balance = wallet.balance.toJSON().amount;
          record.version = wallet.version;
          record.updatedAt = wallet.updatedAt;
          em.persist(ledgerToRecord(entry));
          events.push(
            WalletBalanceChanged.create({
              ...context,
              eventId: randomUUID(),
              data: {
                walletId: wallet.id,
                transactionId: transaction.id,
                direction: entry.direction,
                money: entry.money.toJSON(),
                balanceBefore: entry.balanceBefore.toJSON(),
                balanceAfter: entry.balanceAfter.toJSON(),
                walletVersion: wallet.version,
              },
            }).toJSON(),
          );
        }
        for (const event of events) {
          em.persist(
            Object.assign(new OutboxRecord(), {
              id: event.eventId,
              aggregateId: wallet.id,
              eventType: event.eventType,
              payload: event,
              occurredAt: at,
              attempts: 0,
              nextAttemptAt: null,
              publishedAt: null,
            }),
          );
        }
        await em.flush();
        return this.response(transactionRecord, false);
      });
    } catch (error) {
      // Uma colisão entre carteiras diferentes aborta a transação perdedora.
      // Só consultamos a vencedora usando outro EntityManager após o rollback.
      if (error instanceof UniqueConstraintViolationException) {
        const existing = await this.orm.em.fork().find(WagerTransactionRecord, identity);
        if (existing.length) return this.replay(existing, key, hash);
      }
      if (
        error instanceof ConnectionException ||
        (error instanceof DriverException &&
          [
            "40001",
            "40P01",
            "55P03",
            "57014",
            "57P01",
            "57P02",
            "57P03",
          ].includes(error.code ?? ""))
      ) {
        throw new ServiceUnavailableException({
          code: "TRANSIENT_DATABASE_FAILURE",
        });
      }
      if (error instanceof InvalidMoneyError)
        throw new BadRequestException({ code: "MONETARY_LIMIT_EXCEEDED" });
      throw error;
    }
  }

  private replay(records: WagerTransactionRecord[], key: string, hash: string) {
    if (
      records.length !== 1 ||
      records[0]!.idempotencyKey !== key ||
      records[0]!.payloadHash !== hash
    )
      throw new ConflictException({ code: "IDEMPOTENCY_CONFLICT" });
    if (
      ![Status.Processed, Status.Rejected, Status.Failed].includes(
        records[0]!.status,
      )
    )
      throw new ServiceUnavailableException({
        code: "TRANSACTION_IN_PROGRESS",
      });
    return this.response(records[0]!, true);
  }

  private response(record: WagerTransactionRecord, replay: boolean) {
    return {
      transactionId: record.id,
      status: record.status,
      ...(record.resultBalance === null
        ? {}
        : {
            balance: {
              amount: record.resultBalance,
              currency: record.currency,
            },
          }),
      ...(record.failureCode === null
        ? {}
        : { failureCode: record.failureCode }),
      idempotentReplay: replay,
    };
  }
}
