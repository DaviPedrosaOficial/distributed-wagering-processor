import { UseGuards } from "@nestjs/common";
import { ProviderAuthGuard } from "../../shared/http/provider-auth.guard.js";
import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, UseFilters, Query, HttpCode, } from "@nestjs/common";
import { WalletQueriesService } from "../application/wallet-queries.service.js";
import { LedgerQueryDto } from "./ledger-query.dto.js";
import { randomUUID } from "node:crypto";
import { OpenWalletService } from "../application/open-wallet.service.js";
import { CreateWalletDto } from "./create-wallet.dto.js";
import { WalletErrorsFilter } from "./wallets-errors.filter.js";

@UseGuards(ProviderAuthGuard)
@Controller("wallets")
@UseFilters(WalletErrorsFilter)
export class WalletsController {
  constructor(
    private readonly service: OpenWalletService,
    private readonly queries: WalletQueriesService,
  ) {}

  @Post()
  create(
    @Body() body: CreateWalletDto,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    // Limita metadados recebidos sem registrar payload financeiro.
    const id =
      correlationId && /^[A-Za-z0-9:_-]{1,128}$/.test(correlationId)
        ? correlationId
        : randomUUID();
    return this.service.execute(body, id);
  }

  @Get(":walletId")
  findById(@Param("walletId", new ParseUUIDPipe()) walletId: string) {
    return this.service.findById(walletId);
  }
  @Get(":walletId/ledger")
  ledger(
    @Param("walletId", new ParseUUIDPipe()) walletId: string,
    @Query() query: LedgerQueryDto,
  ) {
    return this.queries.ledger(walletId, query);
  }
  @Post(":walletId/reconciliation")
  @HttpCode(200)
  reconcile(
    @Param("walletId", new ParseUUIDPipe()) walletId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    return this.queries.reconcile(walletId, correlationId ?? randomUUID());
  }
}
