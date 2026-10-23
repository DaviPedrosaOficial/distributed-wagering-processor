import { UseGuards } from "@nestjs/common";
import { ProviderAuthGuard } from "../../shared/http/provider-auth.guard.js";
import { Controller, Get, Param } from "@nestjs/common";
import { IsString, Matches, MaxLength } from "class-validator";
import { TransactionQueriesService } from "../application/transaction-queries.service.js";

class ProviderTransactionParams {
  @IsString() @Matches(/\S/) @MaxLength(255) providerId!: string;
  @IsString() @Matches(/\S/) @MaxLength(255) externalTransactionId!: string;
}
@UseGuards(ProviderAuthGuard)
@Controller("providers/:providerId/wagering/transactions")
export class ProviderTransactionsController {
  constructor(private readonly queries: TransactionQueriesService) {}
  @Get(":externalTransactionId")
  find(@Param() params: ProviderTransactionParams) {
    return this.queries.byExternal(
      params.providerId,
      params.externalTransactionId,
    );
  }
}
