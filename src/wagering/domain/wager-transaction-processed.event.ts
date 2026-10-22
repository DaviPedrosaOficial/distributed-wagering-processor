import { IntegrationEvent,  type IntegrationEventProps, } from "../../shared/domain/integration-event.js";
import type { MoneyProps } from "../../shared/domain/money.js";
import type { WagerTransactionKind } from "./wager-transaction.js";

export interface WagerTransactionProcessedData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  balance: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static create(
    props: IntegrationEventProps<WagerTransactionProcessedData>,
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed(props);
  }
}
