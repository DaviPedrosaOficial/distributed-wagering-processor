import "dotenv/config";
import { SqsTransport } from "../src/messaging/infrastructure/sqs.transport.js";
import { queueNames } from "../src/messaging/application/queue.port.js";
const transport = new SqsTransport();
try {
  await transport.setup();
  console.log("Filas disponíveis:", queueNames());
} finally {
  transport.close();
}
