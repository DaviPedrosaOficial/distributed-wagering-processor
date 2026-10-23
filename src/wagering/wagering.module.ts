import { ProviderAuthGuard } from "../shared/http/provider-auth.guard.js";
import { ReferenceRetryWorker } from "./application/reference-retry.worker.js";
import { TransactionQueriesService } from "./application/transaction-queries.service.js";
import { ProviderTransactionsController } from "./http/provider-transactions.controller.js";
import { Module } from "@nestjs/common";
import { ProcessTransactionService } from "./application/process-transaction.service.js";
import { WageringController } from "./http/wagering.controller.js";

@Module({
  controllers: [WageringController, ProviderTransactionsController],
  providers: [
    ProviderAuthGuard,
    ProcessTransactionService,
    ReferenceRetryWorker,
    TransactionQueriesService,
  ],
  exports: [ProcessTransactionService],
})
export class WageringModule {}
