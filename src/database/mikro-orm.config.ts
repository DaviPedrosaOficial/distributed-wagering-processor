import "dotenv/config";
import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
import { WalletRecordSchema } from "./entities/wallet.record.js";
import { WagerTransactionRecordSchema } from "./entities/wager-transaction.record.js";
import { WalletLedgerRecordSchema } from "./entities/wallet-ledger.record.js";
import { OutboxRecordSchema } from "./entities/outbox.record.js";

// CONFIGURAÇÃO OBRIGATÓRIA:
// Interrompe a inicialização se uma variável estiver ausente ou vazia.
function requiredEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.trim() === "") {
    throw new Error(`Variável de ambiente obrigatória: ${name}.`);
  }

  return value;
}

const port = Number(requiredEnv("POSTGRES_PORT"));

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("POSTGRES_PORT deve ser uma porta válida.");
}

// CONFIGURAÇÃO COMPARTILHADA:
// Usada pela aplicação e pela ferramenta de migrations.
export default defineConfig({
  host: requiredEnv("POSTGRES_HOST"),
  port,
  dbName: requiredEnv("POSTGRES_DB"),
  user: requiredEnv("POSTGRES_USER"),
  password: requiredEnv("POSTGRES_PASSWORD"),

  entities: [
    WalletRecordSchema,
    WagerTransactionRecordSchema,
    WalletLedgerRecordSchema,
    OutboxRecordSchema,
  ],

  extensions: [Migrator],

  migrations: {
    // Caminho das migrations compiladas.
    path: "./dist/database/migrations",

    // Caminho das migrations em TypeScript.
    pathTs: "./src/database/migrations",

    glob: "!(*.d).{js,ts}",

    transactional: true,
    allOrNothing: true,
  },
});
