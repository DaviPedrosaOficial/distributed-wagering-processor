import { ProviderAuthGuard } from "../shared/http/provider-auth.guard.js";
import { WalletQueriesService } from "./application/wallet-queries.service.js";
import { Module, ValidationPipe } from "@nestjs/common";
import { APP_PIPE } from "@nestjs/core";
import { OpenWalletService } from "./application/open-wallet.service.js";
import { WalletsController } from "./http/wallets.controller.js";

@Module({
  controllers: [WalletsController],
  providers: [
    ProviderAuthGuard,
    OpenWalletService,
    WalletQueriesService,
    {
      provide: APP_PIPE,
      useFactory: () =>
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
    },
  ],
  exports: [OpenWalletService],
})
export class WalletsModule {}
