import { telemetry } from "../../operations/telemetry.js";
import { HttpException, Injectable, type OnApplicationBootstrap, type BeforeApplicationShutdown, } from "@nestjs/common";
import { createHash } from "node:crypto";
import { ProcessTransactionService } from "../../wagering/application/process-transaction.service.js";
import { QueuePort, queueNames, messagingLog, type QueueDelivery, } from "./queue.port.js";
import { InvalidQueueMessageError, parseWagerMessage, } from "./parse-wager-message.js";

export const WAGER_CONSUMER_NAME = "wager-transactions-v1";
export const retryDelaySeconds = (receiveCount: number) =>
  Math.min(5 * 2 ** Math.min(Math.max(receiveCount - 1, 0), 6), 300);

@Injectable()
export class WagerConsumerWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private stopping = false;
  private readonly abort = new AbortController();
  private loop?: Promise<void>;
  constructor(
    private readonly broker: QueuePort,
    private readonly service: ProcessTransactionService,
  ) {}
  onApplicationBootstrap(): void {
    if (process.env.MESSAGING_ENABLED === "true") this.loop = this.poll();
  }
  private async poll(): Promise<void> {
    while (!this.stopping) {
      try {
        const deliveries = await this.broker.receive(
          queueNames().requests,
          10,
          this.abort.signal,
        );
        for (const delivery of deliveries) {
          if (this.stopping) {
            await this.broker.visibility(
              queueNames().requests,
              delivery.receiptHandle,
              0,
            );
            continue;
          }
          await this.handle(delivery);
        }
      } catch {
        if (!this.stopping) {
          messagingLog("sqs_poll_failed");
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }
  }
  async handle(delivery: QueueDelivery): Promise<void> {
    const names = queueNames();
    let committed = false;
    let parsed: ReturnType<typeof parseWagerMessage> | undefined;
    const heartbeat = setInterval(() => {
      void this.broker
        .visibility(names.requests, delivery.receiptHandle, 30)
        .catch(() =>
          messagingLog("sqs_visibility_extension_failed", {
            brokerMessageId: delivery.brokerMessageId,
          }),
        );
    }, 10000);
    heartbeat.unref();
    try {
      parsed = parseWagerMessage(delivery.body);
      const result = await this.service.execute(
        parsed.input,
        parsed.idempotencyKey,
        parsed.correlationId,
        { messageId: parsed.messageId, consumerName: WAGER_CONSUMER_NAME },
      );
      committed = true;
      // FAILED pode ter sido auditado antes de uma falha no envio à DLQ.
      // Redelivery precisa concluir esse envio antes de remover a origem.
      if (result.status === "FAILED") {
        await this.broker.publish(
          names.deadLetters,
          delivery.body,
          parsed.input.walletId,
          createHash("sha256").update(delivery.brokerMessageId).digest("hex"),
          {
            failureCode: "RETRY_EXHAUSTED",
            sourceMessageId: delivery.brokerMessageId,
          },
        );
        telemetry.inc("wager_dlq_total");
      }
      // execute só resolve após o commit que inclui a inbox.
      await this.broker.acknowledge(names.requests, delivery.receiptHandle);
      messagingLog("sqs_processed", {
        messageId: parsed.messageId,
        correlationId: parsed.correlationId,
        transactionId: result.transactionId,
        walletId: parsed.input.walletId,
        providerId: parsed.input.providerId,
        status: result.status,
        idempotentReplay: result.idempotentReplay,
      });
    } catch (error) {
      const permanent =
        error instanceof InvalidQueueMessageError ||
        (error instanceof HttpException &&
          [400, 404, 409, 422].includes(error.getStatus()));
      const context = {
        messageId: parsed?.messageId ?? delivery.brokerMessageId,
        correlationId: parsed?.correlationId,
        walletId: parsed?.input.walletId,
        providerId: parsed?.input.providerId,
      };
      if (this.stopping) {
        await this.broker.visibility(names.requests, delivery.receiptHandle, 0);
        return;
      }
      if (permanent || (!committed && delivery.receiveCount >= 5)) {
        if (!permanent && !committed && parsed) {
          try {
            const audit = await this.service.recordPermanentFailure(
              parsed.input,
              parsed.idempotencyKey,
              parsed.correlationId,
              {
                messageId: parsed.messageId,
                consumerName: WAGER_CONSUMER_NAME,
              },
            );
            // Um commit cuja resposta se perdeu pode ser encontrado aqui.
            // Nesse caso recuperamos o resultado sem declarar uma falha falsa.
            if (audit.status !== "FAILED") {
              await this.broker.acknowledge(
                names.requests,
                delivery.receiptHandle,
              );
              messagingLog("sqs_recovered_result", {
                ...context,
                transactionId: audit.transactionId,
                status: audit.status,
              });
              return;
            }
            messagingLog("sqs_failure_audited", {
              ...context,
              transactionId: audit.transactionId,
            });
          } catch {
            // Banco indisponível não pode prometer auditoria SQL. A DLQ preserva
            // o pedido para investigação; não fabricamos um registro confirmado.
            messagingLog("sqs_failure_audit_unavailable", context);
          }
        }
        const dedup = createHash("sha256")
          .update(delivery.brokerMessageId)
          .digest("hex");
        // Se o envio ou o ack falhar, a origem continua recuperável por redelivery.
        await this.broker.publish(
          names.deadLetters,
          delivery.body,
          parsed?.input.walletId ?? "invalid",
          dedup,
          {
            failureCode: permanent
              ? "PERMANENT_MESSAGE_FAILURE"
              : "RETRY_EXHAUSTED",
            sourceMessageId: delivery.brokerMessageId,
          },
        );
        telemetry.inc("wager_dlq_total");
        await this.broker.acknowledge(names.requests, delivery.receiptHandle);
        messagingLog("sqs_dead_lettered", {
          ...context,
          reason: permanent ? "PERMANENT_MESSAGE_FAILURE" : "RETRY_EXHAUSTED",
        });
      } else {
        await this.broker.visibility(
          names.requests,
          delivery.receiptHandle,
          retryDelaySeconds(delivery.receiveCount),
        );
        telemetry.inc("wager_retries_total", { source: "sqs" });
        messagingLog("sqs_retry_scheduled", {
          ...context,
          attempt: delivery.receiveCount,
        });
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    await this.loop;
  }
}
