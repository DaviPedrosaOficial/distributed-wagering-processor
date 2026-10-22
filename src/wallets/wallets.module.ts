import { Module, ValidationPipe } from "@nestjs/common";
import { APP_PIPE } from "@nestjs/core";
import { OpenWalletService } from "./application/open-wallet.service.js";
import { WalletsController } from "./http/wallets.controller.js";

@Module({
  controllers: [WalletsController],
  providers: [
    OpenWalletService,
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
