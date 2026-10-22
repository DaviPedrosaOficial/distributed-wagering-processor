import { Module } from "@nestjs/common";
import { ProcessTransactionService } from "./application/process-transaction.service.js";
import { WageringController } from "./http/wagering.controller.js";
@Module({
  controllers: [WageringController],
  providers: [ProcessTransactionService],
  exports: [ProcessTransactionService],
})
export class WageringModule {}
