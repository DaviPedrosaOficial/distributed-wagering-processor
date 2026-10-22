import { ArgumentsHost, Catch, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { InvalidMoneyError } from "../../shared/domain/money.js";
import { WalletAlreadyExistsError, WalletNotFoundError, } from "../application/open-wallet.service.js";

@Catch(InvalidMoneyError, WalletAlreadyExistsError, WalletNotFoundError)
export class WalletErrorsFilter implements ExceptionFilter {
  catch(
    error: InvalidMoneyError | WalletAlreadyExistsError | WalletNotFoundError,
    host: ArgumentsHost,
  ) {
    const status =
      error instanceof WalletAlreadyExistsError
        ? 409
        : error instanceof WalletNotFoundError
          ? 404
          : 400;
    const code =
      status === 409
        ? "WALLET_ALREADY_EXISTS"
        : status === 404
          ? "WALLET_NOT_FOUND"
          : "INVALID_MONEY";
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(status)
      .json({ statusCode: status, code, message: error.message });
  }
}
