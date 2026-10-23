import { Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { SQSClient, GetQueueUrlCommand, GetQueueAttributesCommand, CreateQueueCommand, SetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand, } from "@aws-sdk/client-sqs";
import { QueuePort, queueNames, type QueueDelivery, } from "../application/queue.port.js";

@Injectable()
export class SqsTransport extends QueuePort implements OnApplicationShutdown {
  readonly client = new SQSClient({
    endpoint: process.env.SQS_ENDPOINT ?? "http://127.0.0.1:4566",
    region: process.env.SQS_REGION ?? "us-east-1",
    credentials: {
      accessKeyId: process.env.SQS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.SQS_SECRET_ACCESS_KEY ?? "test",
    },
    useQueueUrlAsEndpoint: false,
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 2000, requestTimeout: 15000 },
  });
  private readonly urls = new Map<string, string>();
  async queueUrl(name: string, signal?: AbortSignal): Promise<string> {
    const cached = this.urls.get(name);
    if (cached) return cached;
    const result = await this.client.send(
      new GetQueueUrlCommand({ QueueName: name }),
      { abortSignal: signal },
    );
    if (!result.QueueUrl) throw new Error("SQS não retornou QueueUrl.");
    this.urls.set(name, result.QueueUrl);
    return result.QueueUrl;
  }
  async ready(): Promise<void> {
    const signal = AbortSignal.timeout(3000);
    await Promise.all(
      Object.values(queueNames()).map(async (name) => {
        await this.client.send(
          new GetQueueAttributesCommand({
            QueueUrl: await this.queueUrl(name, signal),
            AttributeNames: ["QueueArn"],
          }),
          { abortSignal: signal },
        );
      }),
    );
  }
  async setup(): Promise<void> {
    const names = queueNames();
    const dead = await this.client.send(
      new CreateQueueCommand({
        QueueName: names.deadLetters,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "false",
          MessageRetentionPeriod: "1209600",
        },
      }),
    );
    if (!dead.QueueUrl) throw new Error("DLQ não criada.");
    const attributes = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: dead.QueueUrl,
        AttributeNames: ["QueueArn"],
      }),
    );
    const arn = attributes.Attributes?.QueueArn;
    if (!arn) throw new Error("ARN da DLQ ausente.");
    const redrive = JSON.stringify({
      deadLetterTargetArn: arn,
      maxReceiveCount: "5",
    });
    const requests = await this.client.send(
      new CreateQueueCommand({
        QueueName: names.requests,
        Attributes: {
          FifoQueue: "true",
          ContentBasedDeduplication: "false",
          VisibilityTimeout: "30",
          ReceiveMessageWaitTimeSeconds: "10",
          RedrivePolicy: redrive,
        },
      }),
    );
    if (!requests.QueueUrl) throw new Error("Fila não criada.");
    await this.client.send(
      new SetQueueAttributesCommand({
        QueueUrl: requests.QueueUrl,
        Attributes: { RedrivePolicy: redrive },
      }),
    );
    await this.client.send(
      new CreateQueueCommand({
        QueueName: names.events,
        Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
      }),
    );
  }
  async receive(
    queue: string,
    waitSeconds: number,
    signal?: AbortSignal,
  ): Promise<QueueDelivery[]> {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.queueUrl(queue),
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: waitSeconds,
        VisibilityTimeout: 30,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
      { abortSignal: signal },
    );
    return (result.Messages ?? []).map((message) => {
      if (
        !message.ReceiptHandle ||
        !message.MessageId ||
        message.Body === undefined
      )
        throw new Error("Entrega SQS incompleta.");
      return {
        body: message.Body,
        receiptHandle: message.ReceiptHandle,
        brokerMessageId: message.MessageId,
        receiveCount: Number(
          message.Attributes?.ApproximateReceiveCount ?? "1",
        ),
      };
    });
  }
  async publish(
    queue: string,
    body: string,
    groupId: string,
    deduplicationId: string,
    attributes?: Record<string, string>,
  ): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl(queue),
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: deduplicationId,
        MessageAttributes: attributes
          ? Object.fromEntries(
              Object.entries(attributes).map(([name, StringValue]) => [
                name,
                { DataType: "String", StringValue },
              ]),
            )
          : undefined,
      }),
    );
  }
  async acknowledge(queue: string, receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: await this.queueUrl(queue),
        ReceiptHandle: receiptHandle,
      }),
    );
  }
  async visibility(
    queue: string,
    receiptHandle: string,
    seconds: number,
  ): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queueUrl(queue),
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }
  onApplicationShutdown(): void {
    this.close();
  }
  close(): void {
    this.client.destroy();
  }
}
