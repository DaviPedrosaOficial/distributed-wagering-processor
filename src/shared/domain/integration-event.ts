export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

// O payload guardado na outbox é um JSON independente dos objetos do domínio.
export abstract class IntegrationEvent<T extends object> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  private readonly props: IntegrationEventProps<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.props = {
      ...props,
      occurredAt: new Date(props.occurredAt.getTime()),
      data: structuredClone(props.data),
    };
  }

  toJSON() {
    return {
      eventId: this.props.eventId,
      eventType: this.eventType,
      aggregateId: this.props.aggregateId,
      correlationId: this.props.correlationId,
      ...(this.props.causationId === undefined
        ? {}
        : { causationId: this.props.causationId }),
      occurredAt: this.props.occurredAt.toISOString(),
      version: this.version,
      data: structuredClone(this.props.data),
    };
  }
}
