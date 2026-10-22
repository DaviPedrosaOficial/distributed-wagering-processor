import { MikroORM } from "@mikro-orm/postgresql";
import config from "../src/database/mikro-orm.config.js";

const name = process.env.POSTGRES_TEST_DB;
if (!name || !/^[a-z][a-z0-9_]*_test$/.test(name) || name === config.dbName) {
  throw new Error(
    "Defina POSTGRES_TEST_DB com um banco separado terminado em _test.",
  );
}

const orm = await MikroORM.init({ ...config, dbName: "postgres" });
try {
  const exists = await orm.em
    .getConnection()
    .execute("select 1 from pg_database where datname = ?", [name]);
  if (exists.length === 0) {
    // O identificador já foi restringido pela expressão regular acima.
    await orm.em.getConnection().execute(`create database "${name}"`);
  }
  console.log(`Banco de integração disponível: ${name}`);
} finally {
  await orm.close(true);
}
