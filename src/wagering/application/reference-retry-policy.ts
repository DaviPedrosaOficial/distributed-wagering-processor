// TTL curto e explícito para o desafio; relógio é recebido para testes determinísticos.
export const REFERENCE_TTL_MS = 15 * 60 * 1000;
export function nextReferenceAttempt(at: Date, attempts: number): Date {
  const delayMs = Math.min(
    5 * 1000 * 2 ** Math.min(attempts, 6),
    5 * 60 * 1000,
  );
  return new Date(at.getTime() + delayMs);
}
