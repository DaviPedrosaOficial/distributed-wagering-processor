import { fileURLToPath } from "node:url";
import ormConfig from "../src/database/mikro-orm.config.js";

export function integrationConfig() {
  const dbName = process.env.POSTGRES_TEST_DB;
  // Os testes de migration podem remover tabelas. Nunca usar o banco da aplicação.
  if (
    !dbName ||
    !/^[a-z][a-z0-9_]*_test$/.test(dbName) ||
    dbName === ormConfig.dbName
  ) {
    throw new Error(
      "Defina POSTGRES_TEST_DB com um banco separado terminado em _test.",
    );
  }
  const migrationsPath = fileURLToPath(
    new URL("../src/database/migrations/", import.meta.url),
  );
  return {
    ...ormConfig,
    dbName,
    migrations: {
      ...ormConfig.migrations,
      path: migrationsPath,
      pathTs: migrationsPath,
    },
  };
}
