import { IntegrationEvent, type IntegrationEventProps, } from "../../shared/domain/integration-event.js";
interface PendingReferenceData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  referenceExternalTransactionId: string;
  expiresAt: string;
}
export class WagerTransactionPendingReference extends IntegrationEvent<PendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;
  static create(
    props: IntegrationEventProps<PendingReferenceData>,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(props);
  }
}
