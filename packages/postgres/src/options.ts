/**
 * The options of `postgres(...)`, checked, and the `pg` pool configuration made from them.
 *
 * @module
 */
import type pg from "pg";
import { own } from "./own.js";

/**
 * Pool settings for the pool the adapter creates.
 *
 * @example
 * ```ts
 * const pool: PostgresPoolOptions = { max: 20, idleTimeoutMs: 30_000, connectionTimeoutMs: 5_000 };
 * ```
 */
export interface PostgresPoolOptions {
  /** The most connections the pool opens. Default 10. */
  readonly max?: number | undefined;
  /** How long an unused connection stays open, in milliseconds; `0` keeps it open. Default 10,000. */
  readonly idleTimeoutMs?: number | undefined;
  /**
   * How long to wait for a connection, in milliseconds, both to open a new one and for a
   * busy pool to free one; `0` waits forever. Default `0`.
   */
  readonly connectionTimeoutMs?: number | undefined;
}

/**
 * The options of {@link postgres}. Every option may also be given as `undefined`, which
 * is the same as leaving it out (`connectionString: process.env.DATABASE_URL`).
 *
 * Connect with `connectionString`, or with `host`, `port`, `user`, `password`, `database`
 * and `ssl`, or both (the separate settings win). With none of them, `pg` reads the usual
 * `PG*` environment variables.
 *
 * @example
 * ```ts
 * const options: PostgresOptions = {
 *   connectionString: process.env.DATABASE_URL,
 *   pool: { max: 10, idleTimeoutMs: 30_000, connectionTimeoutMs: 5_000 },
 *   applicationName: "my-app",
 * };
 * ```
 */
export interface PostgresOptions {
  /** A `postgres://` URL. */
  readonly connectionString?: string | undefined;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly user?: string | undefined;
  /** A password, or a function that returns one (for rotating credentials). */
  readonly password?: string | (() => string | Promise<string>) | undefined;
  readonly database?: string | undefined;
  /** `true`, or TLS options for `node:tls`. */
  readonly ssl?: pg.ConnectionConfig["ssl"] | undefined;
  /**
   * Settings for the pool the adapter creates, or an existing `pg.Pool` to use as it is.
   * A pool you pass in stays yours: the adapter does not change its settings and
   * `close()` does not end it.
   */
  readonly pool?: PostgresPoolOptions | pg.Pool | undefined;
  /** How many compiled query shapes the adapter keeps. Default 1,000. */
  readonly planCacheSize?: number | undefined;
  /** A server-side limit for every statement, in milliseconds (Postgres `statement_timeout`). */
  readonly statementTimeoutMs?: number | undefined;
  /** Shown in `pg_stat_activity` (Postgres `application_name`). */
  readonly applicationName?: string | undefined;
}

/** What the driver needs: a pool configuration, or the caller's pool. */
export type PoolSource =
  | { readonly owned: true; readonly config: pg.PoolConfig }
  | { readonly owned: false; readonly pool: pg.Pool };

const OPTION_KEYS: ReadonlySet<string> = /* @__PURE__ */ new Set([
  "connectionString",
  "host",
  "port",
  "user",
  "password",
  "database",
  "ssl",
  "pool",
  "planCacheSize",
  "statementTimeoutMs",
  "applicationName",
]);

const POOL_KEYS: ReadonlySet<string> = /* @__PURE__ */ new Set([
  "max",
  "idleTimeoutMs",
  "connectionTimeoutMs",
]);

/** Options that configure the connections the adapter opens, which a supplied pool has already settled. */
const CONNECTION_KEYS = [
  "connectionString",
  "host",
  "port",
  "user",
  "password",
  "database",
  "ssl",
  "statementTimeoutMs",
  "applicationName",
] as const;

function fail(message: string): never {
  throw new TypeError(`postgres(options): ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Whether `value` is a `pg.Pool` (from any copy of `pg`). */
function isPool(value: unknown): value is pg.Pool {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { connect?: unknown }).connect === "function" &&
    typeof (value as { end?: unknown }).end === "function" &&
    typeof (value as { totalCount?: unknown }).totalCount === "number"
  );
}

function checkUnknown(value: Record<string, unknown>, known: ReadonlySet<string>, where: string): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      fail(`unknown option ${JSON.stringify(key)}${where}. The options are: ${[...known].join(", ")}.`);
    }
  }
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || typeof value === "string") return value;
  return fail(`${name} must be a string.`);
}

function optionalCount(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    return fail(`${name} must be a whole number from ${min} to ${max}, but it is ${String(value)}.`);
  }
  return value;
}

const MAX_MS = 2_147_483_647;

/**
 * Checks the options and builds the pool configuration.
 *
 * @throws TypeError for an unknown option, a value of the wrong type or range, or
 * connection settings given together with an existing pool.
 */
export function resolveOptions(options: PostgresOptions | undefined): PoolSource {
  if (options === undefined) return { owned: true, config: { max: 10 } };
  if (!isPlainObject(options)) fail("options must be a plain object.");
  checkUnknown(options, OPTION_KEYS, "");

  const pool: unknown = own(options, "pool");
  if (isPool(pool)) {
    const given = CONNECTION_KEYS.filter((key) => own(options, key) !== undefined);
    if (given.length > 0) {
      fail(
        `${given.join(", ")} cannot be combined with an existing pool: they configure the connections the adapter opens, and a pool you pass in opens its own. Configure them on your pool instead.`,
      );
    }
    return { owned: false, pool };
  }

  const config: pg.PoolConfig = { max: 10 };
  const connectionString = optionalString(own(options, "connectionString"), "connectionString");
  if (connectionString !== undefined) config.connectionString = connectionString;
  const host = optionalString(own(options, "host"), "host");
  if (host !== undefined) config.host = host;
  const port = optionalCount(own(options, "port"), "port", 1, 65_535);
  if (port !== undefined) config.port = port;
  const user = optionalString(own(options, "user"), "user");
  if (user !== undefined) config.user = user;
  const password: unknown = own(options, "password");
  if (password !== undefined) {
    if (typeof password !== "string" && typeof password !== "function") {
      fail("password must be a string or a function that returns one.");
    }
    config.password = password as string | (() => string | Promise<string>);
  }
  const database = optionalString(own(options, "database"), "database");
  if (database !== undefined) config.database = database;
  const ssl: unknown = own(options, "ssl");
  if (ssl !== undefined) {
    if (typeof ssl !== "boolean" && (typeof ssl !== "object" || ssl === null)) {
      fail("ssl must be a boolean or an object of TLS options.");
    }
    config.ssl = ssl as pg.ConnectionConfig["ssl"] & object;
  }
  const statementTimeoutMs = optionalCount(
    own(options, "statementTimeoutMs"),
    "statementTimeoutMs",
    0,
    MAX_MS,
  );
  if (statementTimeoutMs !== undefined) config.statement_timeout = statementTimeoutMs;
  const applicationName = optionalString(own(options, "applicationName"), "applicationName");
  if (applicationName !== undefined) config.application_name = applicationName;

  if (pool !== undefined) {
    if (!isPlainObject(pool)) {
      fail("pool must be pool settings ({ max, idleTimeoutMs, connectionTimeoutMs }) or a pg.Pool.");
    }
    checkUnknown(pool, POOL_KEYS, " in pool");
    const max = optionalCount(own(pool, "max"), "pool.max", 1, 100_000);
    if (max !== undefined) config.max = max;
    const idle = optionalCount(own(pool, "idleTimeoutMs"), "pool.idleTimeoutMs", 0, MAX_MS);
    if (idle !== undefined) config.idleTimeoutMillis = idle;
    const connect = optionalCount(own(pool, "connectionTimeoutMs"), "pool.connectionTimeoutMs", 0, MAX_MS);
    if (connect !== undefined) config.connectionTimeoutMillis = connect;
  }
  return { owned: true, config };
}
