import { WageringModule } from "./wagering/wagering.module.js";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AppController } from "./app.controller.js";
import { AppService } from "./app.service.js";
import { DatabaseModule } from "./database/database.module.js";
import { WalletsModule } from "./wallets/wallets.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    DatabaseModule,
    WalletsModule,
    WageringModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
