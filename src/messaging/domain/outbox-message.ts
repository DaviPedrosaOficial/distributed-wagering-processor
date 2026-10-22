interface OutboxState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
}
export class OutboxMessage {
  private constructor(private readonly state: OutboxState) {}
  static rehydrate(state: OutboxState): OutboxMessage {
    return new OutboxMessage({
      ...state,
      payload: structuredClone(state.payload),
      occurredAt: new Date(state.occurredAt),
      nextAttemptAt: state.nextAttemptAt ? new Date(state.nextAttemptAt) : null,
      publishedAt: state.publishedAt ? new Date(state.publishedAt) : null,
    });
  }
  get attempts() {
    return this.state.attempts;
  }
  get nextAttemptAt() {
    return this.state.nextAttemptAt ? new Date(this.state.nextAttemptAt) : null;
  }
  get publishedAt() {
    return this.state.publishedAt ? new Date(this.state.publishedAt) : null;
  }
  isPending(): boolean {
    return this.state.publishedAt === null;
  }
  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (!this.state.nextAttemptAt || this.state.nextAttemptAt <= now)
    );
  }
  markPublished(at: Date): void {
    if (!this.isPending() || !Number.isFinite(at.getTime()))
      throw new Error("Publicação de outbox inválida.");
    this.state.publishedAt = new Date(at);
    this.state.nextAttemptAt = null;
  }
  scheduleRetry(at: Date): void {
    if (!this.isPending() || !Number.isFinite(at.getTime()))
      throw new Error("Retry de outbox inválido.");
    this.state.attempts++;
    this.state.nextAttemptAt = new Date(
      at.getTime() +
        Math.min(5000 * 2 ** Math.min(this.state.attempts - 1, 6), 300000),
    );
  }
}
