import { IntegrationEvent, type IntegrationEventProps, } from "../../shared/domain/integration-event.js";
import type { FailureCode } from "./wager-transaction.js";
export class WagerTransactionRejected extends IntegrationEvent<{
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  failureCode: FailureCode;
}> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;
  static create(
    props: IntegrationEventProps<{
      transactionId: string;
      walletId: string;
      providerId: string;
      externalTransactionId: string;
      failureCode: FailureCode;
    }>,
  ): WagerTransactionRejected {
    return new WagerTransactionRejected(props);
  }
}
