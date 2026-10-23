import { Body, Controller, Headers, Post, Res, Get, Param, ParseUUIDPipe, } from "@nestjs/common";
import type { Response } from "express";
import { TransactionQueriesService } from "../application/transaction-queries.service.js";
import { randomUUID } from "node:crypto";
import { ProcessTransactionService } from "../application/process-transaction.service.js";
import { WagerTransactionStatus } from "../domain/wager-transaction.js";
import { SubmitTransactionDto } from "./submit-transaction.dto.js";

@Controller("wagering/transactions")
export class WageringController {
  constructor(
    private readonly service: ProcessTransactionService,
    private readonly queries: TransactionQueriesService,
  ) {}
  @Post()
  async submit(
    @Body() body: SubmitTransactionDto,
    @Headers("idempotency-key") key: string,
    @Headers("x-correlation-id") correlation: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const correlationId =
      correlation && /^[A-Za-z0-9:_-]{1,128}$/.test(correlation)
        ? correlation
        : randomUUID();
    const result = await this.service.execute(body, key, correlationId);
    response.status(
      result.status === WagerTransactionStatus.PendingReference
        ? 202
        : result.status === WagerTransactionStatus.Rejected
          ? 422
          : 200,
    );
    response.setHeader("X-Correlation-Id", correlationId);
    return result;
  }
  @Get(":transactionId")
  find(@Param("transactionId", new ParseUUIDPipe()) id: string) {
    return this.queries.byId(id);
  }
}
