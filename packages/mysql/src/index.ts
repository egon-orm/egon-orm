/**
 * `@egon-orm/mysql`: the MySQL adapter of Egon ORM, over `mysql2`.
 *
 * @module
 */
import type { DatabaseAdapter } from "egon-orm";
import { createAdapter } from "egon-orm";
import { MYSQL_CAPABILITIES, quoteIdentifier } from "./dialect.js";
import { MysqlDriver } from "./driver.js";
import { normalizeMysqlError } from "./errors.js";
import { type MysqlOptions, resolveOptions } from "./options.js";
import { own } from "./own.js";
import { MYSQL_DRIVER_CODECS } from "./values.js";

export type { MysqlOptions, MysqlPoolOptions } from "./options.js";

/**
 * The version of the `@egon-orm/mysql` package.
 *
 * @example
 * ```ts
 * import { VERSION } from "@egon-orm/mysql";
 *
 * console.log(VERSION); // "0.0.0"
 * ```
 */
export const VERSION: string = "0.0.0";

/**
 * Creates a MySQL adapter over `mysql2`: a connection pool, statements with bound
 * parameters (prepared statements), streaming, transactions and savepoints, cancellation
 * with `KILL QUERY`, error normalisation and telemetry. Hand it to `createRepo`.
 *
 * Every session is UTC: timestamps mean the same instant whatever the server's or the
 * process's time zone. Nothing connects until the adapter is first used. `close()` waits
 * for checked-out connections, then ends the pool.
 *
 * @example
 * ```ts
 * import { mysql } from "@egon-orm/mysql";
 *
 * const adapter = mysql({ connectionString: process.env.DATABASE_URL, pool: { max: 10 } });
 * const { rows } = await adapter.execute("select 1 as one", []);
 * await adapter.close();
 * ```
 *
 * @throws TypeError when an option is unknown, has the wrong type or is out of range.
 */
export function mysql(options?: MysqlOptions): DatabaseAdapter {
  const settings = resolveOptions(options);
  const planCacheSize = own(options, "planCacheSize");
  return createAdapter({
    dialect: "mysql",
    capabilities: MYSQL_CAPABILITIES,
    quoteIdentifier,
    driver: (hooks) => new MysqlDriver(settings, hooks),
    driverCodecs: MYSQL_DRIVER_CODECS,
    normalizeError: normalizeMysqlError,
    ...(planCacheSize === undefined ? {} : { planCacheSize }),
  });
}
