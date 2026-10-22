import { expect, test } from "bun:test";
import { InboxMessage } from "./inbox-message.js";
test("inbox preserva datas e impede uma segunda confirmação", () => {
  const date = new Date();
  const message = InboxMessage.receive({
    messageId: "m1",
    consumerName: "c1",
    payloadHash: "a".repeat(64),
    receivedAt: date,
  });
  date.setTime(0);
  expect(message.receivedAt.getTime()).not.toBe(0);
  const at = new Date(message.receivedAt.getTime() + 1);
  message.markProcessed(at);
  at.setTime(0);
  expect(message.isProcessed()).toBe(true);
  expect(message.processedAt!.getTime()).not.toBe(0);
  expect(() => message.markProcessed(new Date())).toThrow();
});
test("inbox rejeita identidade vazia e reconstrói confirmação sem transição", () => {
  expect(() =>
    InboxMessage.receive({
      messageId: "",
      consumerName: "c",
      payloadHash: "a".repeat(64),
      receivedAt: new Date(),
    }),
  ).toThrow();
  const message = InboxMessage.rehydrate({
    messageId: "m",
    consumerName: "c",
    payloadHash: "hash",
    receivedAt: new Date(0),
    processedAt: new Date(1),
  });
  expect(message.isProcessed()).toBe(true);
});
