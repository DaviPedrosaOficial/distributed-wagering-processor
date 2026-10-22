import { ReferenceRetryWorker } from "./application/reference-retry.worker.js";
import { Module } from "@nestjs/common";
import { ProcessTransactionService } from "./application/process-transaction.service.js";
import { WageringController } from "./http/wagering.controller.js";
@Module({
  controllers: [WageringController],
  providers: [ProcessTransactionService, ReferenceRetryWorker],
  exports: [ProcessTransactionService],
})
export class WageringModule {}
