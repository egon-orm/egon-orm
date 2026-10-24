/**
 * `@egon-orm/postgres`: the Postgres adapter of Egon ORM, over `pg`.
 *
 * @module
 */
import type { DatabaseAdapter } from "egon-orm";
import { createAdapter } from "egon-orm";
import { POSTGRES_CAPABILITIES, quoteIdentifier } from "./dialect.js";
import { PgDriver } from "./driver.js";
import { normalizePgError } from "./errors.js";
import { type PostgresOptions, resolveOptions } from "./options.js";
import { own } from "./own.js";
import { PG_DRIVER_CODECS } from "./values.js";

export type { PostgresOptions, PostgresPoolOptions } from "./options.js";

/**
 * The version of the `@egon-orm/postgres` package.
 *
 * @example
 * ```ts
 * import { VERSION } from "@egon-orm/postgres";
 *
 * console.log(VERSION); // "0.0.0"
 * ```
 */
export const VERSION: string = "0.0.0";

/**
 * Creates a Postgres adapter: a connection pool, statement execution, streaming,
 * transactions and savepoints, cancellation, error normalisation and telemetry. Hand it
 * to `createRepo`.
 *
 * Nothing connects until the adapter is first used. `close()` waits for checked-out
 * connections, then ends the pool (a pool passed in as `pool` is left open).
 *
 * @example
 * ```ts
 * import { postgres } from "@egon-orm/postgres";
 *
 * const adapter = postgres({
 *   connectionString: process.env.DATABASE_URL,
 *   pool: { max: 10, idleTimeoutMs: 30_000, connectionTimeoutMs: 5_000 },
 *   applicationName: "my-app",
 * });
 * const { rows } = await adapter.execute("select now() as now", []);
 * await adapter.close();
 * ```
 *
 * @throws TypeError when an option is unknown, has the wrong type or is out of range, or
 * when connection settings are given together with an existing pool.
 */
export function postgres(options?: PostgresOptions): DatabaseAdapter {
  const source = resolveOptions(options);
  const planCacheSize = own(options, "planCacheSize");
  return createAdapter({
    dialect: "postgres",
    capabilities: POSTGRES_CAPABILITIES,
    quoteIdentifier,
    driver: (hooks) => new PgDriver(source, hooks),
    driverCodecs: PG_DRIVER_CODECS,
    normalizeError: normalizePgError,
    ...(planCacheSize === undefined ? {} : { planCacheSize }),
  });
}
