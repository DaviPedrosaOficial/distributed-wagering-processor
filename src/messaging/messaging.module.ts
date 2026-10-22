import { Module } from "@nestjs/common";
import { WageringModule } from "../wagering/wagering.module.js";
import { QueuePort } from "./application/queue.port.js";
import { WagerConsumerWorker } from "./application/wager-consumer.worker.js";
import { OutboxPublisherWorker } from "./application/outbox-publisher.worker.js";
import { SqsTransport } from "./infrastructure/sqs.transport.js";
@Module({
  imports: [WageringModule],
  providers: [
    { provide: QueuePort, useClass: SqsTransport },
    WagerConsumerWorker,
    OutboxPublisherWorker,
  ],
  exports: [QueuePort],
})
export class MessagingModule {}
