/**
 * Creating and dropping a whole database: development conveniences for the CLI's
 * `egon db create | drop | reset`.
 *
 * @module
 */
import { sqlDialectOf } from "../adapter/compiler.js";
import { quoteIdentifier } from "../compiler/dialect.js";
import type { Adapter } from "../contracts/adapter.js";
import { MigrationError } from "../errors.js";
import { own } from "../internal/own.js";

function quotedDatabase(where: string, adapter: Adapter, name: unknown): string {
  if (typeof name !== "string" || name.length === 0 || name.includes("\u0000")) {
    throw new TypeError(`${where}: the database name must be a non-empty string without NUL characters.`);
  }
  const syntax = sqlDialectOf(adapter.dialect);
  if (syntax === undefined) {
    throw new MigrationError(
      "migration.featureUnsupported",
      `${where} is not supported on ${String(adapter.dialect)} by this build of egon-orm.`,
    );
  }
  return quoteIdentifier(syntax, name);
}

/**
 * Runs `CREATE DATABASE name` through `adapter`, which must be connected to another
 * database of the same server (on Postgres, usually `postgres`).
 *
 * @example
 * ```ts
 * import { createDatabase } from "egon-orm/migration";
 * import { postgres } from "@egon-orm/postgres";
 *
 * const admin = postgres({ connectionString: "postgres://localhost/postgres" });
 * await createDatabase(admin, "blog_dev");
 * await admin.close();
 * ```
 *
 * @throws TypeError when the name is not a non-empty string.
 * @throws DatabaseError when the server refuses (the database exists, no permission).
 */
export async function createDatabase(adapter: Adapter, name: string): Promise<void> {
  await adapter.execute(`create database ${quotedDatabase("createDatabase()", adapter, name)}`, []);
}

/**
 * Runs `DROP DATABASE [IF EXISTS] name` through `adapter`, which must be connected to
 * another database of the same server. Everything in the database is lost.
 *
 * @example
 * ```ts
 * import { dropDatabase } from "egon-orm/migration";
 *
 * await dropDatabase(admin, "blog_dev", { ifExists: true });
 * ```
 *
 * @throws TypeError when the name is not a non-empty string.
 * @throws DatabaseError when the server refuses (the database is in use, no permission).
 */
export async function dropDatabase(
  adapter: Adapter,
  name: string,
  options?: { readonly ifExists?: boolean },
): Promise<void> {
  const ifExists = own(options, "ifExists");
  if (ifExists !== undefined && typeof ifExists !== "boolean") {
    throw new TypeError("dropDatabase(): ifExists must be a boolean.");
  }
  await adapter.execute(
    `drop database ${ifExists === true ? "if exists " : ""}${quotedDatabase("dropDatabase()", adapter, name)}`,
    [],
  );
}
