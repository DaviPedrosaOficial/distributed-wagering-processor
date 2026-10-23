import { CallHandler, ExecutionContext, HttpException, Injectable, type NestInterceptor, } from "@nestjs/common";
import { DriverException, ConnectionException } from "@mikro-orm/core";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { tap } from "rxjs";
import { operationalLog, telemetry } from "../telemetry.js";

@Injectable()
export class HttpObservabilityInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const supplied = request.headers["x-correlation-id"];
    
    const correlationId =
      typeof supplied === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(supplied)
        ? supplied
        : randomUUID();
    
    request.headers["x-correlation-id"] = correlationId;
    response.setHeader("X-Correlation-Id", correlationId);
    
    const start = performance.now();
    const ids: Record<string, unknown> = {};
    
    if (request.body && typeof request.body === "object")
      for (const name of ["walletId", "providerId"]) {
        const value = (request.body as Record<string, unknown>)[name];
        if (typeof value === "string" && value.length <= 255) ids[name] = value;
      }
    if (typeof request.params.walletId === "string")
      ids.walletId = request.params.walletId;
    return next.handle().pipe(
      tap({
        next: (value: unknown) => {
          if (
            value &&
            typeof value === "object" &&
            "transactionId" in value &&
            typeof value.transactionId === "string"
          )
            ids.transactionId = value.transactionId;
          telemetry.inc("wager_http_requests_total", {
            status: String(response.statusCode),
          });
          operationalLog("http_completed", {
            correlationId,
            ...ids,
            method: request.method,
            path: request.path,
            status: response.statusCode,
            durationMs: performance.now() - start,
          });
        },
        error: (error: unknown) => {
          const status =
            error instanceof HttpException
              ? error.getStatus()
              : error instanceof ConnectionException ||
                  (error instanceof DriverException &&
                    [
                      "40001",
                      "40P01",
                      "55P03",
                      "57014",
                      "57P01",
                      "57P02",
                      "57P03",
                    ].includes(error.code ?? ""))
                ? 503
                : 500;
          telemetry.inc("wager_http_requests_total", {
            status: String(status),
          });
          operationalLog("http_failed", {
            correlationId,
            ...ids,
            method: request.method,
            path: request.path,
            status,
            durationMs: performance.now() - start,
          });
        },
      }),
    );
  }
}
