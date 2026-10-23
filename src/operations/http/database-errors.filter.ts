import { ArgumentsHost, Catch, type ExceptionFilter } from "@nestjs/common";
import { DriverException, ConnectionException } from "@mikro-orm/core";
import type { Response } from "express";

@Catch(DriverException)
export class DatabaseErrorsFilter implements ExceptionFilter {
  catch(error: DriverException, host: ArgumentsHost): void {
    const transient =
      error instanceof ConnectionException ||
      ["40001", "40P01", "55P03", "57014", "57P01", "57P02", "57P03"].includes(
        error.code ?? "",
      );
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(transient ? 503 : 500)
      .json({
        code: transient ? "TRANSIENT_DATABASE_FAILURE" : "DATABASE_FAILURE",
      });
  }
}
