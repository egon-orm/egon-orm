/**
 * `@egon-orm/sqlite`: the SQLite adapter of Egon ORM, over `better-sqlite3`.
 *
 * @module
 */
import type { DatabaseAdapter } from "egon-orm";
import { createAdapter } from "egon-orm";
import { quoteIdentifier, SQLITE_CAPABILITIES } from "./dialect.js";
import { SqliteDriver } from "./driver.js";
import { normalizeSqliteError } from "./errors.js";
import { resolveOptions, type SqliteOptions } from "./options.js";
import { own } from "./own.js";
import { SQLITE_DRIVER_CODECS } from "./values.js";

export type { PragmaValue, SqliteOptions } from "./options.js";

/**
 * The version of the `@egon-orm/sqlite` package.
 *
 * @example
 * ```ts
 * import { VERSION } from "@egon-orm/sqlite";
 *
 * console.log(VERSION); // "0.0.0"
 * ```
 */
export const VERSION: string = "0.0.0";

/**
 * Creates a SQLite adapter over `better-sqlite3`: one database handle, used by one
 * statement at a time, with transactions and savepoints, streaming, error normalisation and
 * telemetry. Hand it to `createRepo`.
 *
 * The file is opened when the adapter is first used, with foreign keys on (unless
 * `pragmas` sets `foreign_keys`) and then the given pragmas, in order. `close()` waits for
 * running statements and a transaction in progress, then closes the file.
 *
 * `better-sqlite3` runs each statement synchronously: a statement cannot be cancelled once
 * it has started, so `timeoutMs` and `signal` bound only the wait for the handle (and the
 * time between the batches of a stream). Row locks are accepted and ignored.
 *
 * @example
 * ```ts
 * import { sqlite } from "@egon-orm/sqlite";
 *
 * const adapter = sqlite({ filename: "app.db", pragmas: { journal_mode: "WAL" } });
 * const { rows } = await adapter.execute("select 1 as one", []);
 * await adapter.close();
 * ```
 *
 * @throws TypeError when an option is unknown or has the wrong type, or a pragma is not a
 * plain name with a plain value.
 */
export function sqlite(options: SqliteOptions): DatabaseAdapter {
  const settings = resolveOptions(options);
  const planCacheSize = own(options, "planCacheSize");
  return createAdapter({
    dialect: "sqlite",
    capabilities: SQLITE_CAPABILITIES,
    quoteIdentifier,
    driver: (hooks) => new SqliteDriver(settings, hooks),
    driverCodecs: SQLITE_DRIVER_CODECS,
    normalizeError: normalizeSqliteError,
    ...(planCacheSize === undefined ? {} : { planCacheSize }),
  });
}
