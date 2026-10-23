import { telemetry, operationalLog } from "../../operations/telemetry.js";
import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException, } from "@nestjs/common";
import { ConnectionException, DriverException, LockMode, UniqueConstraintViolationException, } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { ReferenceScheduleRecord } from "../../database/entities/reference-schedule.record.js";
import { LedgerDirection } from "../../wallets/domain/wallet-ledger-entry.js";
import type { Wallet } from "../../wallets/domain/wallet.js";
import { referenceIsCompatible, movementDirection, } from "../domain/transaction-reference.js";
import { WagerTransactionPendingReference } from "../domain/wager-transaction-pending-reference.event.js";
import { REFERENCE_TTL_MS, nextReferenceAttempt, } from "./reference-retry-policy.js";
import { MikroORM } from "@mikro-orm/postgresql";
import { InboxRecord } from "../../database/entities/inbox.record.js";
import { InboxMessage } from "../../messaging/domain/inbox-message.js";
import { createHash, randomUUID } from "node:crypto";
import { WalletRecord } from "../../database/entities/wallet.record.js";
import { WagerTransactionRecord } from "../../database/entities/wager-transaction.record.js";
import { OutboxRecord } from "../../database/entities/outbox.record.js";
import { ledgerToRecord, transactionToRecord, transactionFromRecord, walletFromRecord, } from "../../database/mappers/financial-records.mapper.js";
import { InvalidMoneyError, Money } from "../../shared/domain/money.js";
import { InsufficientBalanceError } from "../../wallets/domain/wallet.js";
import type { WalletLedgerEntry } from "../../wallets/domain/wallet-ledger-entry.js";
import { WalletBalanceChanged } from "../../wallets/domain/wallet-balance-changed.event.js";
import { FailureCode, WagerTransaction, WagerTransactionKind as Kind, WagerTransactionStatus as Status, } from "../domain/wager-transaction.js";
import { WagerTransactionProcessed } from "../domain/wager-transaction-processed.event.js";
import { WagerTransactionRejected } from "../domain/wager-transaction-rejected.event.js";
import { payloadHash, type TransactionPayload } from "./transaction-payload.js";

export interface InboxContext {
  messageId: string;
  consumerName: string;
}
export interface TransactionResponse {
  transactionId: string;
  status: Status;
  balance?: { amount: string; currency: string };
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

@Injectable()
export class ProcessTransactionService {
  constructor(private readonly orm: MikroORM) {}

  async execute(
    input: TransactionPayload,
    key: string,
    correlationId: string,
    inbox?: InboxContext,
  ): Promise<TransactionResponse> {
    const started = performance.now();
    const channel = inbox ? "sqs" : "http";
    try {
      const result = await this.executeCore(input, key, correlationId, inbox);
      telemetry.inc("wager_transaction_results_total", {
        status: result.status,
        channel,
      });
      if (result.idempotentReplay)
        telemetry.inc("wager_duplicates_total", { channel });
      operationalLog("transaction_completed", {
        correlationId,
        messageId: inbox?.messageId,
        transactionId: result.transactionId,
        walletId: input.walletId,
        providerId: input.providerId,
        status: result.status,
        idempotentReplay: result.idempotentReplay,
      });
      return result;
    } finally {
      telemetry.observe((performance.now() - started) / 1000, channel);
    }
  }

  private async executeCore(
    input: TransactionPayload,
    key: string,
    correlationId: string,
    inbox?: InboxContext,
  ): Promise<TransactionResponse> {
    if (typeof key !== "string" || !key.trim() || key.length > 255)
      throw new BadRequestException({ code: "INVALID_IDEMPOTENCY_KEY" });
    if (
      ![Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback].includes(
        input.kind,
      )
    )
      throw new BadRequestException({ code: "UNSUPPORTED_OPERATION" });
    if (input.providerId === "__internal__")
      throw new BadRequestException({ code: "RESERVED_PROVIDER" });
    const reversal = input.kind === Kind.Refund || input.kind === Kind.Rollback;
    if (reversal && !input.referenceExternalTransactionId?.trim())
      throw new BadRequestException({ code: "REFERENCE_REQUIRED" });
    if (
      input.referenceExternalTransactionId !== undefined &&
      ![Kind.Win, Kind.Refund, Kind.Rollback].includes(input.kind)
    )
      throw new BadRequestException({ code: "REFERENCE_NOT_ALLOWED" });
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
    const inboxHash = createHash("sha256")
      .update(JSON.stringify([hash, key]))
      .digest("hex");
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
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        if (!record) throw new NotFoundException({ code: "WALLET_NOT_FOUND" });
        if (inbox) {
          const receipt = await em.findOne(InboxRecord, {
            messageId: inbox.messageId,
            consumerName: inbox.consumerName,
          });
          if (receipt) return this.inboxReplay(receipt, inboxHash);
        }
        const existing = await em.find(WagerTransactionRecord, identity);
        if (existing.length)
          return this.completeInbox(
            em,
            inbox,
            inboxHash,
            this.replay(existing, key, hash),
          );
        if (record.playerId !== input.playerId)
          throw new BadRequestException({ code: "WALLET_PLAYER_MISMATCH" });
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
        const result = await this.apply(
          em,
          record,
          wallet,
          transaction,
          correlationId,
          at,
        );
        return this.completeInbox(em, inbox, inboxHash, result);
      });
    } catch (error) {
      // Uma colisão entre carteiras diferentes aborta a transação perdedora.
      // Só consultamos a vencedora usando outro EntityManager após o rollback.
      if (error instanceof UniqueConstraintViolationException) {
        if (inbox) {
          const receipt = await this.orm.em.fork().findOne(InboxRecord, {
            messageId: inbox.messageId,
            consumerName: inbox.consumerName,
          });
          if (receipt) return this.inboxReplay(receipt, inboxHash);
        }
        const existing = await this.orm.em
          .fork()
          .find(WagerTransactionRecord, identity);
        if (existing.length) {
          const result = this.replay(existing, key, hash);
          // Reentra após o rollback para confirmar inbox e replay juntos.
          return inbox
            ? this.executeCore(input, key, correlationId, inbox)
            : result;
        }
      }
      if (
        error instanceof DriverException &&
        ["40001", "40P01", "55P03"].includes(error.code ?? "")
      )
        telemetry.inc("wager_lock_conflicts_total");
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

  private async completeInbox(
    em: EntityManager,
    inbox: InboxContext | undefined,
    hash: string,
    result: TransactionResponse,
  ): Promise<TransactionResponse> {
    if (!inbox) return result;
    const message = InboxMessage.receive({
      ...inbox,
      payloadHash: hash,
      receivedAt: new Date(),
    });
    message.markProcessed(new Date());
    em.persist(
      Object.assign(new InboxRecord(), {
        messageId: message.messageId,
        consumerName: message.consumerName,
        payloadHash: message.payloadHash,
        receivedAt: message.receivedAt,
        processedAt: message.processedAt,
        result,
      }),
    );
    await em.flush();
    return result;
  }

  private inboxReplay(receipt: InboxRecord, hash: string): TransactionResponse {
    if (receipt.payloadHash !== hash)
      throw new ConflictException({ code: "INBOX_PAYLOAD_CONFLICT" });
    if (!receipt.processedAt || !receipt.result)
      throw new ServiceUnavailableException({ code: "INBOX_IN_PROGRESS" });
    return { ...receipt.result, idempotentReplay: true };
  }

  // Utilizado pelo worker; a ordem dos locks continua carteira -> agendamento.
  async retryPending(id: string, at = new Date()): Promise<boolean> {
    const location = await this.orm.em
      .fork()
      .findOne(WagerTransactionRecord, { id });
    if (!location) return false;
    return this.orm.em.fork().transactional(async (em) => {
      const record = await em.findOneOrFail(
        WalletRecord,
        { id: location.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      const schedule = await em.findOne(
        ReferenceScheduleRecord,
        { transactionId: id },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!schedule || schedule.nextAttemptAt.getTime() > at.getTime())
        return false;
      const transactionRecord = await em.findOneOrFail(WagerTransactionRecord, {
        id,
      });
      if (transactionRecord.status !== Status.PendingReference) return false;
      await this.apply(
        em,
        record,
        walletFromRecord(record),
        transactionFromRecord(transactionRecord),
        schedule.correlationId,
        at,
        transactionRecord,
        schedule,
      );
      return true;
    });
  }

  private async apply(
    em: EntityManager,
    record: WalletRecord,
    wallet: Wallet,
    transaction: WagerTransaction,
    correlationId: string,
    at: Date,
    existing?: WagerTransactionRecord,
    schedule?: ReferenceScheduleRecord,
  ) {
    const wasPending = transaction.status === Status.PendingReference;
    let reference: WagerTransaction | undefined;
    let waiting = false;
    let entry: WalletLedgerEntry | undefined;
    if (schedule && at.getTime() >= schedule.expiresAt.getTime()) {
      transaction.reject(FailureCode.ReferenceNotFound);
    } else if (wallet.currency !== transaction.money.currency) {
      transaction.reject(FailureCode.CurrencyMismatch);
    } else if (transaction.referenceExternalTransactionId !== undefined) {
      const referenceRecord = await em.findOne(WagerTransactionRecord, {
        providerId: transaction.providerId,
        externalTransactionId: transaction.referenceExternalTransactionId,
      });
      if (
        transaction.externalTransactionId ===
        transaction.referenceExternalTransactionId
      ) {
        transaction.reject(FailureCode.InvalidReference);
      } else if (!referenceRecord) {
        waiting = true;
      } else {
        reference = transactionFromRecord(referenceRecord);
        if (
          !referenceIsCompatible(transaction, reference) ||
          [Status.Rejected, Status.Failed].includes(reference.status)
        ) {
          transaction.reject(FailureCode.InvalidReference);
        } else if (reference.status !== Status.Processed) {
          waiting = true;
        } else if (
          transaction.requiresReference() &&
          (await em.findOne(WagerTransactionRecord, {
            referenceTransactionId: reference.id,
            kind: transaction.kind,
            status: Status.Processed,
          }))
        ) {
          transaction.reject(FailureCode.InvalidReference);
        }
      }
    }
    if (!transaction.isTerminal()) {
      if (waiting) {
        transaction.markPendingReference();
      } else {
        try {
          const direction = movementDirection(transaction, reference);
          const movement = {
            ledgerEntryId: randomUUID(),
            transactionId: transaction.id,
            money: transaction.money,
            at,
          };
          if (direction === LedgerDirection.Debit)
            entry = wallet.debit(movement);
          if (direction === LedgerDirection.Credit)
            entry = wallet.credit(movement);
          transaction.markProcessed(reference?.id, at, wallet.balance);
        } catch (error) {
          if (!(error instanceof InsufficientBalanceError)) throw error;
          transaction.reject(
            transaction.kind === Kind.Rollback
              ? FailureCode.ReversalInsufficientBalance
              : FailureCode.InsufficientBalance,
          );
        }
      }
    }
    const transactionRecord = existing
      ? Object.assign(existing, transactionToRecord(transaction))
      : transactionToRecord(transaction);
    em.persist(transactionRecord);
    // O trigger do ledger precisa encontrar a transação processada. Ainda não é commit.
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
    const events: Array<{ eventId: string; eventType: string; data: object }> =
      [];
    if (transaction.status === Status.PendingReference) {
      const expiresAt =
        schedule?.expiresAt ??
        new Date(transaction.createdAt.getTime() + REFERENCE_TTL_MS);
      const attempts = schedule ? schedule.attempts + 1 : 0;
      const nextAttemptAt = new Date(
        Math.min(
          nextReferenceAttempt(at, attempts).getTime(),
          expiresAt.getTime(),
        ),
      );
      em.persist(
        Object.assign(schedule ?? new ReferenceScheduleRecord(), {
          transactionId: transaction.id,
          attempts,
          nextAttemptAt,
          expiresAt,
          correlationId,
        }),
      );
      // Uma transição de espera gera um evento; cada sondagem não gera outro.
      if (!wasPending)
        events.push(
          WagerTransactionPendingReference.create({
            ...context,
            data: {
              ...data,
              referenceExternalTransactionId:
                transaction.referenceExternalTransactionId!,
              expiresAt: expiresAt.toISOString(),
            },
          }).toJSON(),
        );
    } else {
      if (schedule) em.remove(schedule);
      if (transaction.status === Status.Processed) {
        events.push(
          WagerTransactionProcessed.create({
            ...context,
            data: {
              ...data,
              kind: transaction.kind,
              money: transaction.money.toJSON(),
              balance: wallet.balance.toJSON(),
            },
          }).toJSON(),
        );
      } else {
        events.push(
          WagerTransactionRejected.create({
            ...context,
            data: { ...data, failureCode: transaction.failureCode! },
          }).toJSON(),
        );
      }
    }
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
    for (const event of events)
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
    await em.flush();
    return this.response(transactionRecord, false);
  }

  private replay(records: WagerTransactionRecord[], key: string, hash: string) {
    if (
      records.length !== 1 ||
      records[0]!.idempotencyKey !== key ||
      records[0]!.payloadHash !== hash
    )
      throw new ConflictException({ code: "IDEMPOTENCY_CONFLICT" });
    if (
      ![
        Status.Processed,
        Status.Rejected,
        Status.Failed,
        Status.PendingReference,
      ].includes(records[0]!.status)
    )
      throw new ServiceUnavailableException({
        code: "TRANSACTION_IN_PROGRESS",
      });
    return this.response(records[0]!, true);
  }

  private response(
    record: WagerTransactionRecord,
    replay: boolean,
  ): TransactionResponse {
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
