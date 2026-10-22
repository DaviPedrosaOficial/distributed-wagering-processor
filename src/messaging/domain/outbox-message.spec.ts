import { expect, test } from "bun:test";
import { OutboxMessage } from "./outbox-message.js";
const create = () =>
  OutboxMessage.rehydrate({
    id: "e",
    aggregateId: "w",
    eventType: "Event",
    payload: {},
    occurredAt: new Date(0),
    attempts: 0,
    nextAttemptAt: null,
    publishedAt: null,
  });
test("outbox calcula retry exponencial e respeita horário", () => {
  const message = create();
  message.scheduleRetry(new Date(0));
  expect(message.attempts).toBe(1);
  expect(message.nextAttemptAt!.getTime()).toBe(5000);
  expect(message.isDue(new Date(4999))).toBe(false);
  expect(message.isDue(new Date(5000))).toBe(true);
  for (let i = 0; i < 10; i++) message.scheduleRetry(new Date(0));
  expect(message.nextAttemptAt!.getTime()).toBe(300000);
});
test("outbox protege data publicada e bloqueia novas transições", () => {
  const message = create();
  const at = new Date(100);
  message.markPublished(at);
  at.setTime(0);
  expect(message.publishedAt!.getTime()).toBe(100);
  expect(message.isDue(new Date(200))).toBe(false);
  expect(() => message.scheduleRetry(new Date())).toThrow();
});
