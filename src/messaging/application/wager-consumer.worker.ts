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
