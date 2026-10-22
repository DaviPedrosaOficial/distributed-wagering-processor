interface InboxState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}
export class InboxMessage {
  private constructor(private readonly state: InboxState) {}
  static receive(state: Omit<InboxState, "processedAt">): InboxMessage {
    if (
      ![state.messageId, state.consumerName].every(
        (v) => typeof v === "string" && v.trim() && v.length <= 128,
      ) ||
      !/^[a-f0-9]{64}$/.test(state.payloadHash) ||
      !Number.isFinite(state.receivedAt.getTime())
    )
      throw new Error("Mensagem de inbox inválida.");
    return InboxMessage.rehydrate(state);
  }
  static rehydrate(state: InboxState): InboxMessage {
    return new InboxMessage({
      ...state,
      receivedAt: new Date(state.receivedAt),
      processedAt:
        state.processedAt === undefined
          ? undefined
          : new Date(state.processedAt),
    });
  }
  get messageId() {
    return this.state.messageId;
  }
  get consumerName() {
    return this.state.consumerName;
  }
  get payloadHash() {
    return this.state.payloadHash;
  }
  get receivedAt() {
    return new Date(this.state.receivedAt);
  }
  get processedAt() {
    return this.state.processedAt === undefined
      ? undefined
      : new Date(this.state.processedAt);
  }
  isProcessed(): boolean {
    return this.state.processedAt !== undefined;
  }
  markProcessed(at: Date): void {
    if (
      this.isProcessed() ||
      !Number.isFinite(at.getTime()) ||
      at < this.state.receivedAt
    )
      throw new Error("Transição de inbox inválida.");
    this.state.processedAt = new Date(at);
  }
}
