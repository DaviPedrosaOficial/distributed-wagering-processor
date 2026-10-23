import { IntegrationEvent, type IntegrationEventProps, } from "../../shared/domain/integration-event.js";
import type { FailureCode } from "./wager-transaction.js";

export class WagerTransactionFailed extends IntegrationEvent<{
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  failureCode: FailureCode;
}> {
  readonly eventType = "WagerTransactionFailed";
  readonly version = 1;
  static create(
    props: IntegrationEventProps<{
      transactionId: string;
      walletId: string;
      providerId: string;
      externalTransactionId: string;
      failureCode: FailureCode;
    }>,
  ): WagerTransactionFailed {
    return new WagerTransactionFailed(props);
  }
}
