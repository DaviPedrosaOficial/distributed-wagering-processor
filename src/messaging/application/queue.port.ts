export interface QueueDelivery {
  body: string;
  receiptHandle: string;
  brokerMessageId: string;
  receiveCount: number;
}
export abstract class QueuePort {
  abstract receive(
    queue: string,
    waitSeconds: number,
    signal?: AbortSignal,
  ): Promise<QueueDelivery[]>;
  abstract publish(
    queue: string,
    body: string,
    groupId: string,
    deduplicationId: string,
    attributes?: Record<string, string>,
  ): Promise<void>;
  abstract acknowledge(queue: string, receiptHandle: string): Promise<void>;
  abstract visibility(
    queue: string,
    receiptHandle: string,
    seconds: number,
  ): Promise<void>;
}
export const queueNames = () => ({
  requests: process.env.SQS_REQUEST_QUEUE ?? "wager-transactions.fifo",
  deadLetters: process.env.SQS_DLQ ?? "wager-transactions-dlq.fifo",
  events: process.env.SQS_EVENT_QUEUE ?? "wager-events.fifo",
});
export function messagingLog(
  event: string,
  fields: Record<string, unknown> = {},
): void {
  process.stdout.write(
    JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }) +
      "\n",
  );
}
