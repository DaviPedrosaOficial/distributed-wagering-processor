import { Module } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { MessagingModule } from "../messaging/messaging.module.js";
import { OperationsController } from "./http/operations.controller.js";
import { HttpObservabilityInterceptor } from "./http/http-observability.interceptor.js";
import { DatabaseErrorsFilter } from "./http/database-errors.filter.js";

@Module({
  imports: [MessagingModule],
  controllers: [OperationsController],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: HttpObservabilityInterceptor },
    { provide: APP_FILTER, useClass: DatabaseErrorsFilter },
  ],
})
export class OperationsModule {}
