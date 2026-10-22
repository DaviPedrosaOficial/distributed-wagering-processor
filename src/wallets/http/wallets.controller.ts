import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, UseFilters, } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { OpenWalletService } from "../application/open-wallet.service.js";
import { CreateWalletDto } from "./create-wallet.dto.js";
import { WalletErrorsFilter } from "./wallets-errors.filter.js";

@Controller("wallets")
@UseFilters(WalletErrorsFilter)
export class WalletsController {
  constructor(private readonly service: OpenWalletService) {}

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
}
