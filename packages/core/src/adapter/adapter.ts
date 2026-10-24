/**
 * The shared implementation of the `Adapter` contract. A dialect package supplies a
 * driver wrapper (`driver.ts`), its capabilities, its identifier quoting, its driver
 * fixes for column kinds (`codecs.ts`) and its error normaliser; everything else is here:
 * lazy start, pooled and dedicated execution, streaming, transactions and savepoints as
 * statements, cancellation and timeouts, telemetry, and closing.
 *
 * @module
 */

import type { PlanCacheStats } from "../compiler/index.js";
import type {
  Adapter,
  AdapterEvents,
  BeginOptions,
  Capabilities,
  CompiledQuery,
  Connection,
  Dialect,
  ExecuteOptions,
  ExplainOptions,
  FragmentNode,
  InsertPlanOptions,
  IsolationLevel,
  PoolEvent,
  RawResult,
  StreamOptions,
} from "../contracts/index.js";
import type { QueryAst, QueryOperation } from "../contracts/query.js";
import type { FieldMeta, SchemaMeta } from "../contracts/schema.js";
import type { AnyFieldType, Codec } from "../contracts/type.js";
import { DatabaseError, isEgonError, QueryError } from "../errors.js";
import { own } from "../internal/own.js";
import { isPlainObject } from "../internal/plain-object.js";
import type { DriverCodecs } from "./codecs.js";
import { type StatementCompiler, sharedStatementCompiler } from "./compiler.js";
import type { DriverConnection, DriverHooks, DriverWrapper } from "./driver.js";
import { type QueryListenerOptions, Telemetry } from "./telemetry.js";

/** The default size of the plan cache. */
export const DEFAULT_PLAN_CACHE_SIZE = 1000;

/** How many rows a stream fetches at a time when `batchSize` is not given. */
export const DEFAULT_BATCH_SIZE = 100;

/**
 * The state of an adapter's connection pool.
 *
 * @example
 * ```ts
 * declare const adapter: DatabaseAdapter;
 * const { size, idle, waiting } = adapter.poolStats();
 * const busy = size - idle;
 * ```
 */
export type PoolStats = PoolEvent;

/**
 * An adapter as the dialect packages create it: the `Adapter` contract plus a health
 * check, pool statistics, and parameter values on demand in `query` events.
 *
 * @example
 * ```ts
 * import { postgres } from "@egon-orm/postgres";
 *
 * const adapter: DatabaseAdapter = postgres({ connectionString: process.env.DATABASE_URL });
 * await adapter.ping();
 * adapter.on("query", (event) => process.stdout.write(`${event.sql} (${event.durationMs} ms)\n`));
 * ```
 */
export interface DatabaseAdapter extends Adapter {
  /**
   * Runs a trivial statement on a pooled connection; resolves when the database answered.
   *
   * @throws DatabaseError with the code `"connection"` when the database cannot be reached.
   */
  ping(): Promise<void>;
  /** How many connections are open, idle, and how many callers wait for one. */
  poolStats(): PoolStats;
  /**
   * The counters of this adapter's plan cache: lookups answered from it (`hits`), plans
   * compiled (`misses`), lookups whose key matched another shape (`collisions`, also
   * misses; it should stay 0) and plans held (`size`). The cache is shared by every
   * adapter created with the same dialect, capabilities, driver codecs and
   * `planCacheSize`, so the counters include their lookups too.
   */
  planCacheStats(): PlanCacheStats;
  /**
   * Subscribes to an event; returns the function that unsubscribes. A `query` listener
   * receives parameter values only when it asks for them with `{ params: true }`.
   *
   * @throws TypeError when the event is unknown or the listener is not a function.
   */
  on<E extends keyof AdapterEvents>(
    event: E,
    listener: (payload: AdapterEvents[E]) => void,
    options?: E extends "query" ? QueryListenerOptions : never,
  ): () => void;
}

/**
 * What a dialect package gives {@link createAdapter}, internal to the Egon packages like
 * `createAdapter`, and not a supported extension point. It holds everything that differs
 * between databases. Applications do not write one; they call `postgres(...)` and the like.
 *
 * @example
 * ```ts
 * declare const definition: AdapterDefinition;
 * const adapter = createAdapter({ ...definition, planCacheSize: 500 });
 * ```
 */
export interface AdapterDefinition {
  readonly dialect: Dialect;
  readonly capabilities: Capabilities;
  /** Quotes an identifier (a savepoint name, for the adapter), doubling the quote character. */
  readonly quoteIdentifier: (name: string) => string;
  /** Creates the driver wrapper. Called once, on the adapter's first use. */
  readonly driver: (hooks: DriverHooks) => DriverWrapper;
  /** Where the driver's values differ from the canonical driver values of the types, by column kind. */
  readonly driverCodecs: DriverCodecs;
  /**
   * Maps a driver error to an Egon error (`ConstraintError`, `DatabaseError`, ...) that
   * keeps it as `cause` and carries `sql` when it is known. Returns anything it does not
   * recognise unchanged.
   */
  readonly normalizeError: (error: unknown, sql: string | undefined) => unknown;
  /**
   * The size of the plan cache: how many query shapes it keeps. Default 1000. Adapters
   * created with the same dialect, capabilities, driver codecs and size share one cache.
   */
  readonly planCacheSize?: number;
}

/** Postgres-style transaction modes, by option. The dialect's `capabilities.isolationLevels` says which levels exist. */
const ISOLATION_SQL: ReadonlyMap<IsolationLevel, string> = /* @__PURE__ */ new Map<IsolationLevel, string>([
  ["read committed", "isolation level read committed"],
  ["repeatable read", "isolation level repeatable read"],
  ["serializable", "isolation level serializable"],
]);

/** The options of a `begin`, checked. */
interface CheckedBegin {
  readonly isolation: IsolationLevel | undefined;
  readonly readOnly: boolean | undefined;
  readonly deferrable: boolean | undefined;
}

const NO_BEGIN_OPTIONS: CheckedBegin = /* @__PURE__ */ Object.freeze({
  isolation: undefined,
  readOnly: undefined,
  deferrable: undefined,
});

/**
 * Checks the options of a `begin` against the database's capabilities. A mode the
 * database lacks is refused when it asks for something (`readOnly: true`,
 * `deferrable: true`); asking for the default (`false`) is accepted everywhere.
 */
function checkBegin(
  options: BeginOptions | undefined,
  capabilities: Capabilities,
  dialect: Dialect,
): CheckedBegin {
  if (options === undefined) return NO_BEGIN_OPTIONS;
  if (!isPlainObject(options)) {
    throw new TypeError("connection.begin(options): options must be a plain object or undefined.");
  }
  const isolation = own(options, "isolation");
  const readOnly = own(options, "readOnly");
  const deferrable = own(options, "deferrable");
  if (isolation !== undefined) {
    if (!ISOLATION_SQL.has(isolation)) {
      throw new TypeError(
        `connection.begin({ isolation }): unknown isolation level ${JSON.stringify(isolation)}. Use "read committed", "repeatable read" or "serializable".`,
      );
    }
    if (!capabilities.isolationLevels.includes(isolation)) {
      throw new QueryError(
        "query.isolationUnsupported",
        `The isolation level "${isolation}" is not supported by ${dialect}.`,
        { params: { dialect } },
      );
    }
  }
  if (readOnly !== undefined) {
    if (typeof readOnly !== "boolean")
      throw new TypeError("connection.begin({ readOnly }): readOnly must be a boolean.");
    if (readOnly && !capabilities.readOnlyTransactions) {
      throw new QueryError(
        "query.readOnlyUnsupported",
        `A read-only transaction (readOnly: true) is not supported by ${dialect}.`,
        { params: { dialect } },
      );
    }
  }
  if (deferrable !== undefined) {
    if (typeof deferrable !== "boolean") {
      throw new TypeError("connection.begin({ deferrable }): deferrable must be a boolean.");
    }
    if (deferrable && !capabilities.deferrableTransactions) {
      throw new QueryError(
        "query.deferrableUnsupported",
        `A deferrable transaction (deferrable: true) is not supported by ${dialect}.`,
        { params: { dialect } },
      );
    }
  }
  return { isolation, readOnly, deferrable };
}

/** The statement that starts a transaction with `options`, as Postgres writes it. */
export function beginSql(
  options: BeginOptions | undefined,
  capabilities: Capabilities,
  dialect: Dialect = "postgres",
): string {
  const { isolation, readOnly, deferrable } = checkBegin(options, capabilities, dialect);
  const modes: string[] = [];
  if (isolation !== undefined) modes.push(ISOLATION_SQL.get(isolation) as string);
  if (readOnly !== undefined) modes.push(readOnly ? "read only" : "read write");
  if (deferrable !== undefined) modes.push(deferrable ? "deferrable" : "not deferrable");
  return modes.length === 0 ? "begin" : `begin ${modes.join(", ")}`;
}

/**
 * The statements that start a transaction with `options` on `dialect`, in order:
 *
 * - Postgres: `begin [isolation level …, read only, deferrable]`;
 * - MySQL: `set transaction isolation level …` (for the next transaction only), then
 *   `start transaction [read only | read write]`;
 * - SQLite: `begin` (one writer at a time: there is nothing to choose).
 *
 * @example
 * ```ts
 * beginStatements("mysql", { isolation: "serializable", readOnly: true }, MYSQL_CAPABILITIES);
 * // ["set transaction isolation level serializable", "start transaction read only"]
 * ```
 *
 * @throws TypeError for a malformed option; QueryError for a mode the database lacks.
 */
export function beginStatements(
  dialect: Dialect,
  options: BeginOptions | undefined,
  capabilities: Capabilities,
): readonly string[] {
  if (dialect === "postgres") return [beginSql(options, capabilities)];
  const { isolation, readOnly } = checkBegin(options, capabilities, dialect);
  if (dialect === "sqlite") return ["begin"];
  const start =
    readOnly === undefined
      ? "start transaction"
      : `start transaction ${readOnly ? "read only" : "read write"}`;
  return isolation === undefined ? [start] : [`set transaction ${ISOLATION_SQL.get(isolation)}`, start];
}

function checkSavepointName(method: string, name: unknown): string {
  if (typeof name !== "string" || name.length === 0 || name.includes("\u0000")) {
    throw new TypeError(
      `connection.${method}(name): the savepoint name must be a non-empty string without NUL characters.`,
    );
  }
  return name;
}

/** The parameters of a transaction statement: there are none. */
const NO_PARAMS: readonly unknown[] = /* @__PURE__ */ Object.freeze([]);

/**
 * Checks the execution options of a transaction statement. They are those of `execute`,
 * except `statementName`: a transaction statement is never prepared.
 */
function checkTransactionOptions(method: string, options: ExecuteOptions | undefined): void {
  if (own(options, "statementName") !== undefined) {
    throw new TypeError(
      `connection.${method}(…, options): statementName is not accepted here; transaction statements are never prepared.`,
    );
  }
}

function checkTimeout(timeoutMs: unknown): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError(
      `The timeoutMs option must be a non-negative number of milliseconds, but it is ${String(timeoutMs)}.`,
    );
  }
  return timeoutMs;
}

function checkBatchSize(batchSize: unknown): number {
  if (batchSize === undefined) return DEFAULT_BATCH_SIZE;
  if (typeof batchSize !== "number" || !Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new TypeError(
      `The batchSize option must be a positive whole number, but it is ${String(batchSize)}.`,
    );
  }
  return batchSize;
}

function checkSignal(signal: unknown): AbortSignal | undefined {
  if (signal === undefined || signal instanceof AbortSignal) return signal;
  throw new TypeError("The signal option must be an AbortSignal.");
}

/**
 * The error of a statement stopped by its caller's signal or by its `timeoutMs`, while it
 * ran or (`waiting`) while it waited for a connection.
 */
function interruption(
  kind: "aborted" | "timeout",
  sql: string,
  timeoutMs: number | undefined,
  cause: unknown,
  waiting = false,
  cancelFailure?: unknown,
): DatabaseError {
  const details = { code: kind, sql, cause };
  if (cancelFailure !== undefined) {
    // The cancel request failed (or cancelling is not possible here, e.g. no node:net):
    // the statement ran to its end. The cause is the cancel's error; when the statement
    // then failed by itself as well (a constraint, a lost connection), it is an
    // AggregateError of both, the cancel's error first, so the caller learns of each.
    const failed = {
      code: kind,
      sql,
      cause:
        cause === undefined
          ? cancelFailure
          : new AggregateError(
              [cancelFailure, cause],
              "Cancelling the statement failed, and the statement then failed by itself.",
            ),
    };
    return kind === "aborted"
      ? new DatabaseError(
          "database.abortedNotCancelled",
          "The call was aborted by its AbortSignal, but cancelling the statement failed, so it ran to its end.",
          failed,
        )
      : new DatabaseError(
          "database.timeoutNotCancelled",
          `The statement ran longer than its timeoutMs (${timeoutMs} ms), but cancelling it failed, so it ran to its end.`,
          failed,
        );
  }
  if (waiting) {
    return kind === "aborted"
      ? new DatabaseError(
          "database.abortedWaiting",
          "The statement was not run: its AbortSignal fired while it waited for a free connection.",
          details,
        )
      : new DatabaseError(
          "database.timeoutWaiting",
          `The statement was not run: it waited longer than its timeoutMs (${timeoutMs} ms) for a free connection.`,
          details,
        );
  }
  return kind === "aborted"
    ? new DatabaseError(
        "database.aborted",
        "The statement was cancelled because its AbortSignal fired.",
        details,
      )
    : new DatabaseError(
        "database.timeout",
        `The statement was cancelled because it ran longer than its timeoutMs (${timeoutMs} ms).`,
        details,
      );
}

/**
 * The error of a statement whose `timeoutMs` was spent before it could start (the budget of
 * the call it belongs to ran out on earlier statements, or it was given 0): it is not sent.
 * A database whose statements cannot be cancelled once started (SQLite) relies on this check
 * to keep the budget between statements.
 */
function spent(sql: string, timeoutMs: number | undefined): DatabaseError {
  return new DatabaseError(
    "database.timeoutSpent",
    `The statement was not run: its timeoutMs (${timeoutMs} ms) was spent before it could start.`,
    { code: "timeout", sql },
  );
}

function closedError(sql: string | undefined): DatabaseError {
  return new DatabaseError(
    "database.adapterClosed",
    "This adapter is closed: adapter.close() was called.",
    sql === undefined ? { code: "connection" } : { code: "connection", sql },
  );
}

/** Whether a normalised error means the connection can no longer be trusted. */
function isFatal(error: unknown): boolean {
  return error instanceof DatabaseError && error.code === "connection";
}

const now = (): number => performance.now();

/** Swallows a rejection; one function for every caller, so that no closure is made per statement. */
const ignoreError = (): undefined => undefined;

/**
 * Connections whose cancel request failed. The request may have reached the server
 * anyway, late, so it could still cancel whatever runs next on that connection: such a
 * connection is closed when it is returned, never reused.
 */
const cancelFailed = /* @__PURE__ */ new WeakSet<DriverConnection>();

/** For streams on a pooled connection, which the stream itself holds until it ends. */
const alwaysOpen = (): boolean => true;

/**
 * Runs `work` (one round trip on `connection`) so that `signal` and `timeoutMs` can stop
 * it (after `delayMs`, which is `timeoutMs` unless part of it was spent waiting).
 * Stopping sends the server a cancel request; the call then waits for the statement to
 * end **and** for the cancel request to be delivered before it rejects, so that a late
 * cancel can never reach the next statement on the same connection. The rejection is a
 * `DatabaseError` with the code `"aborted"` or `"timeout"`, whose `cause` is the driver's
 * error (`undefined` when the statement completed anyway).
 */
function interruptible<T>(
  connection: DriverConnection,
  sql: string,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  work: () => Promise<T>,
  delayMs: number | undefined = timeoutMs,
): Promise<T> {
  if (signal === undefined && timeoutMs === undefined) return work();
  if (signal?.aborted === true) return Promise.reject(interruption("aborted", sql, timeoutMs, undefined));
  if (delayMs !== undefined && delayMs <= 0) return Promise.reject(spent(sql, timeoutMs));
  return new Promise<T>((resolve, reject) => {
    let reason: "aborted" | "timeout" | undefined;
    let cancelled: Promise<unknown> = Promise.resolve();
    let cancelFailure: unknown;
    const interrupt = (kind: "aborted" | "timeout"): void => {
      if (reason !== undefined) return;
      reason = kind;
      // A failed cancel request leaves the statement running to its end; the call still
      // rejects, and the connection is not reused (`cancelFailed`).
      cancelled = connection.cancel().catch((error: unknown) => {
        cancelFailed.add(connection);
        cancelFailure = error ?? new Error("The cancel request failed.");
      });
    };
    const onAbort = (): void => interrupt("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = delayMs === undefined ? undefined : setTimeout(interrupt, delayMs, "timeout");
    const settle = (failed: boolean, value: T | undefined, error: unknown): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const kind = reason;
      if (kind === undefined) {
        if (failed) reject(error);
        else resolve(value as T);
        return;
      }
      void cancelled.then(() =>
        reject(interruption(kind, sql, timeoutMs, failed ? error : undefined, false, cancelFailure)),
      );
    };
    work().then(
      (value) => settle(false, value, undefined),
      (error: unknown) => settle(true, undefined, error),
    );
  });
}

/** Counts the rows a stream yielded, for its query event. */
interface StreamTally {
  rows: number;
  /** Set when a read failed or the cursor could not be closed: the connection is then not reused. */
  broken: boolean;
}

/** Yields the rows of a statement through a server-side cursor on `connection`. */
async function* cursorRows(
  connection: DriverConnection,
  sql: string,
  params: readonly unknown[],
  batchSize: number,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  tally: StreamTally,
  open: () => boolean,
): AsyncGenerator<Record<string, unknown>, void, undefined> {
  const cursor = await interruptible(connection, sql, signal, timeoutMs, () =>
    connection.cursor(sql, params),
  );
  try {
    for (;;) {
      // An abort between reads stops the stream without touching the connection: no read
      // is in flight, so the cursor is closed normally and the connection stays healthy.
      if (signal?.aborted === true) throw interruption("aborted", sql, timeoutMs, undefined);
      // A dedicated connection released (or destroyed) mid-stream is gone: a read sent on it
      // would never be answered.
      if (!open()) {
        throw new DatabaseError(
          "database.streamConnectionGone",
          "The connection of this stream was released or destroyed while the stream was open.",
          { code: "connection", sql },
        );
      }
      let rows: readonly Record<string, unknown>[];
      try {
        rows = await interruptible(connection, sql, signal, timeoutMs, () => cursor.read(batchSize));
      } catch (error) {
        // A cursor that failed or was cancelled mid-read leaves the protocol state of the
        // connection uncertain; it is closed rather than reused.
        tally.broken = true;
        throw error;
      }
      if (rows.length === 0) return;
      tally.rows += rows.length;
      for (const row of rows) yield row;
    }
  } finally {
    // Closing a cursor on a connection that has ended would wait forever for its answer.
    if (open()) {
      try {
        await cursor.close();
      } catch {
        tally.broken = true;
      }
    }
  }
}

/**
 * Creates an adapter from a dialect's definition, internal to the Egon packages. It is how
 * `@egon-orm/postgres`, `@egon-orm/sqlite` and `@egon-orm/mysql` build their adapters, and
 * it is exported only for them. An application calls `postgres(...)` and the like instead.
 * It is not a supported way to write a third-party dialect: the driver contract its
 * definition takes is not exported, and it may change in any release.
 *
 * Nothing connects until the adapter is first used.
 *
 * @example
 * ```ts
 * declare const definition: AdapterDefinition;
 * const adapter = createAdapter(definition);
 * const { rows } = await adapter.execute("select 1 as one", []);
 * ```
 *
 * @throws TypeError when `planCacheSize` is not a positive whole number.
 */
export function createAdapter(definition: AdapterDefinition): DatabaseAdapter {
  return new SharedAdapter(definition);
}

class SharedAdapter implements DatabaseAdapter {
  readonly dialect: Dialect;
  readonly capabilities: Capabilities;
  readonly typeOverrides: (type: AnyFieldType) => Codec | undefined;

  private readonly definition: AdapterDefinition;
  private readonly compiler: StatementCompiler;
  private readonly telemetry = new Telemetry();
  /**
   * The driver wrapper, once started. An ES private field: the wrapper holds the driver's
   * pool and its configuration (a connection string, a password), which `util.inspect` and
   * `JSON.stringify` of the adapter, the repo or a transaction must not reach.
   */
  #driver: DriverWrapper | undefined = undefined;
  /** Pooled executions, streams and checked-out connections that have not finished. */
  private active = 0;
  private whenIdle: (() => void) | undefined = undefined;
  private closing: Promise<void> | undefined = undefined;

  constructor(definition: AdapterDefinition) {
    const planCacheSize = own(definition, "planCacheSize") ?? DEFAULT_PLAN_CACHE_SIZE;
    if (!Number.isSafeInteger(planCacheSize) || planCacheSize < 1) {
      throw new TypeError(
        `planCacheSize must be a positive whole number, but it is ${String(planCacheSize)}.`,
      );
    }
    this.definition = definition;
    this.dialect = definition.dialect;
    this.capabilities = definition.capabilities;
    // Shared with every adapter of the same configuration (see ./compiler.ts).
    const shared = sharedStatementCompiler({
      dialect: definition.dialect,
      capabilities: definition.capabilities,
      quoteIdentifier: definition.quoteIdentifier,
      planCacheSize,
      driverCodecs: definition.driverCodecs,
    });
    this.typeOverrides = shared.typeOverrides;
    this.compiler = shared.compiler;
  }

  // --- compiling ---------------------------------------------------------------------

  compile(ast: QueryAst, operation: QueryOperation, schema: string | undefined): CompiledQuery {
    return this.compiler.compile(ast, operation, schema);
  }

  compileExplain(
    ast: QueryAst,
    operation: QueryOperation,
    schema: string | undefined,
    options: ExplainOptions,
  ): CompiledQuery {
    return this.compiler.compileExplain(ast, operation, schema, options);
  }

  compileFragment(fragment: FragmentNode): CompiledQuery {
    return this.compiler.compileFragment(fragment);
  }

  compileInsert(
    meta: SchemaMeta,
    columns: readonly FieldMeta[],
    options: InsertPlanOptions,
    schema: string | undefined,
  ): CompiledQuery {
    return this.compiler.compileInsert(meta, columns, options, schema);
  }

  compileUpdate(
    meta: SchemaMeta,
    set: readonly FieldMeta[],
    where: readonly FieldMeta[],
    returning: readonly FieldMeta[],
    schema: string | undefined,
  ): CompiledQuery {
    return this.compiler.compileUpdate(meta, set, where, returning, schema);
  }

  compileDelete(
    meta: SchemaMeta,
    where: readonly FieldMeta[],
    returning: readonly FieldMeta[],
    schema: string | undefined,
  ): CompiledQuery {
    return this.compiler.compileDelete(meta, where, returning, schema);
  }

  // --- events and health -------------------------------------------------------------

  on<E extends keyof AdapterEvents>(
    event: E,
    listener: (payload: AdapterEvents[E]) => void,
    options?: E extends "query" ? QueryListenerOptions : never,
  ): () => void {
    return this.telemetry.on(event, listener, options);
  }

  planCacheStats(): PlanCacheStats {
    return this.compiler.stats();
  }

  poolStats(): PoolStats {
    const driver = this.#driver;
    return driver === undefined ? { size: 0, idle: 0, waiting: 0 } : driver.stats();
  }

  async ping(): Promise<void> {
    await this.execute("select 1", []);
  }

  normalizeError(error: unknown): unknown {
    return this.normalize(error, undefined);
  }

  // --- execution ---------------------------------------------------------------------

  async execute(sql: string, params: readonly unknown[], options?: ExecuteOptions): Promise<RawResult> {
    const signal = checkSignal(own(options, "signal"));
    const timeoutMs = checkTimeout(own(options, "timeoutMs"));
    const driver = this.open(sql);
    const timed = this.telemetry.query;
    const start = timed ? now() : 0;
    let sent = start;
    this.active++;
    let connection: DriverConnection | undefined;
    try {
      // timeoutMs is one budget for the whole call: the wait for a connection, then the statement.
      const deadline = timeoutMs === undefined ? 0 : now() + timeoutMs;
      const checkedOut = await this.checkout(driver, sql, signal, timeoutMs);
      connection = checkedOut;
      if (timed) sent = now();
      const name = own(options, "statementName");
      // The common case (no signal, no timeout) calls the driver directly: no closure, no timer.
      const pending =
        signal === undefined && timeoutMs === undefined
          ? checkedOut.query(sql, params, name)
          : interruptible(
              checkedOut,
              sql,
              signal,
              timeoutMs,
              () => checkedOut.query(sql, params, name),
              timeoutMs === undefined ? undefined : Math.max(0, deadline - now()),
            );
      const result = await pending;
      await this.checkin(driver, checkedOut, false);
      if (timed) this.report(sql, params, options, now() - sent, sent - start, result.rowCount, undefined);
      return result;
    } catch (error) {
      const normalized = this.normalize(error, sql);
      if (connection !== undefined) await this.checkin(driver, connection, isFatal(normalized));
      if (timed) {
        const end = now();
        const queued = connection === undefined ? end - start : sent - start;
        this.report(sql, params, options, connection === undefined ? 0 : end - sent, queued, 0, normalized);
      }
      throw normalized;
    } finally {
      this.finished();
    }
  }

  stream(
    sql: string,
    params: readonly unknown[],
    options?: StreamOptions,
  ): AsyncIterable<Record<string, unknown>> {
    return this.pooledStream(sql, params, options);
  }

  private async *pooledStream(
    sql: string,
    params: readonly unknown[],
    options: StreamOptions | undefined,
  ): AsyncGenerator<Record<string, unknown>, void, undefined> {
    const signal = checkSignal(own(options, "signal"));
    const timeoutMs = checkTimeout(own(options, "timeoutMs"));
    const batchSize = checkBatchSize(own(options, "batchSize"));
    const driver = this.open(sql);
    const timed = this.telemetry.query;
    const start = timed ? now() : 0;
    let sent = start;
    const tally: StreamTally = { rows: 0, broken: false };
    let failure: unknown;
    this.active++;
    let connection: DriverConnection | undefined;
    try {
      connection = await this.checkout(driver, sql, signal, timeoutMs);
      if (timed) sent = now();
      yield* cursorRows(connection, sql, params, batchSize, signal, timeoutMs, tally, alwaysOpen);
    } catch (error) {
      failure = this.normalize(error, sql);
      throw failure;
    } finally {
      if (connection !== undefined) await this.checkin(driver, connection, tally.broken || isFatal(failure));
      if (timed) {
        const end = now();
        const queued = connection === undefined ? end - start : sent - start;
        this.report(
          sql,
          params,
          options,
          connection === undefined ? 0 : end - sent,
          queued,
          tally.rows,
          failure,
        );
      }
      this.finished();
    }
  }

  async acquire(): Promise<Connection> {
    const driver = this.open(undefined);
    this.active++;
    try {
      // Without a signal, the statement text is never needed.
      const connection = await this.checkout(driver, "", undefined, undefined);
      return new SharedConnection(this, driver, connection);
    } catch (error) {
      this.finished();
      throw this.normalize(error, undefined);
    }
  }

  close(): Promise<void> {
    if (this.closing === undefined) this.closing = this.shutdown();
    return this.closing;
  }

  // --- shared with SharedConnection --------------------------------------------------

  /** Maps a driver error to an Egon error; Egon's own errors pass through. */
  normalize(error: unknown, sql: string | undefined): unknown {
    return isEgonError(error) ? error : this.definition.normalizeError(error, sql);
  }

  quote(name: string): string {
    return this.definition.quoteIdentifier(name);
  }

  get queryTelemetry(): boolean {
    return this.telemetry.query;
  }

  /** Emits one `query` event. */
  report(
    sql: string,
    params: readonly unknown[],
    options: ExecuteOptions | undefined,
    durationMs: number,
    queueMs: number,
    rowCount: number,
    error: unknown,
  ): void {
    this.telemetry.emitQuery(
      sql,
      params,
      own(options, "slots"),
      durationMs,
      queueMs,
      rowCount,
      error,
      own(options, "context"),
    );
  }

  /**
   * Returns a connection to the pool, or closes it when it failed fatally, a cancel
   * request for it failed, or it is still inside a transaction (none of which may be
   * handed to the next caller).
   */
  async checkin(driver: DriverWrapper, connection: DriverConnection, fatal: boolean): Promise<void> {
    let destroy = fatal || cancelFailed.has(connection);
    if (!destroy) {
      try {
        destroy = connection.inTransaction();
      } catch {
        destroy = true;
      }
    }
    try {
      await driver.release(connection, destroy);
    } catch {
      // The connection is gone either way; the statement's own outcome is what the caller needs.
    }
  }

  /** Marks one pooled execution, stream or checked-out connection as finished. */
  finished(): void {
    this.active--;
    if (this.active === 0 && this.whenIdle !== undefined) {
      const resolve = this.whenIdle;
      this.whenIdle = undefined;
      resolve();
    }
  }

  // --- private -----------------------------------------------------------------------

  /** The driver, created on first use; throws once the adapter is closing. */
  private open(sql: string | undefined): DriverWrapper {
    if (this.closing !== undefined) throw closedError(sql);
    let driver = this.#driver;
    if (driver === undefined) {
      const hooks: DriverHooks = {
        connected: () => {
          if (this.telemetry.connect) this.telemetry.emitPool("connect", this.poolStats());
        },
        disconnected: () => {
          if (this.telemetry.disconnect) this.telemetry.emitPool("disconnect", this.poolStats());
        },
      };
      driver = this.definition.driver(hooks);
      driver.init();
      this.#driver = driver;
    }
    return driver;
  }

  /**
   * Checks a connection out. Reports `poolExhausted` when the caller has to wait. A signal
   * or a `timeoutMs` bounds the wait: when it fires first, the call rejects (code
   * `"aborted"` or `"timeout"`) and a connection that arrives afterwards goes straight back
   * to the pool (keeping the adapter open until it has).
   */
  private checkout(
    driver: DriverWrapper,
    sql: string,
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
  ): Promise<DriverConnection> {
    if (this.telemetry.poolExhausted && driver.saturated()) {
      this.telemetry.emitPool("poolExhausted", driver.stats());
    }
    if (signal === undefined && timeoutMs === undefined) return driver.acquire();
    if (signal?.aborted === true) {
      return Promise.reject(interruption("aborted", sql, timeoutMs, undefined, true));
    }
    if (timeoutMs !== undefined && timeoutMs <= 0) return Promise.reject(spent(sql, timeoutMs));
    return new Promise<DriverConnection>((resolve, reject) => {
      let settled = false;
      const stop = (): void => {
        signal?.removeEventListener("abort", onAbort);
        if (timer !== undefined) clearTimeout(timer);
      };
      // Runs at most once: settling stops the timer and the abort listener, and so does this.
      const giveUp = (kind: "aborted" | "timeout"): void => {
        settled = true;
        stop();
        // The abandoned checkout counts as running work until its connection is back.
        this.active++;
        reject(interruption(kind, sql, timeoutMs, undefined, true));
      };
      const onAbort = (): void => giveUp("aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = timeoutMs === undefined ? undefined : setTimeout(giveUp, timeoutMs, "timeout");
      driver.acquire().then(
        (connection) => {
          if (!settled) {
            settled = true;
            stop();
            resolve(connection);
            return;
          }
          void this.checkin(driver, connection, false).then(() => this.finished());
        },
        (error: unknown) => {
          if (!settled) {
            settled = true;
            stop();
            reject(error);
          } else {
            this.finished();
          }
        },
      );
    });
  }

  private async shutdown(): Promise<void> {
    if (this.active > 0) {
      await new Promise<void>((resolve) => {
        this.whenIdle = resolve;
      });
    }
    const driver = this.#driver;
    if (driver !== undefined) await driver.destroy();
  }
}

/** One checked-out connection. Every statement runs on it, in the order it was issued. */
class SharedConnection implements Connection {
  private state: "open" | "released" | "destroyed" = "open";
  /** Set when a statement failed fatally: the connection is then closed, not returned. */
  private broken = false;
  /** The most recent statement; `release` waits for it so that nothing is still running. */
  private last: Promise<unknown> = Promise.resolve();
  /** Streams that were started and have not finished. */
  private openStreams = 0;
  /** Whether the connection is still checked out; read by its streams before each fetch. */
  private readonly isOpen = (): boolean => this.state === "open";

  // ES private fields, as SharedAdapter's driver: the driver's connection and its pool hold
  // the connection's configuration, which inspecting a transaction must not reach.
  readonly #driver: DriverWrapper;
  readonly #connection: DriverConnection;

  constructor(
    private readonly adapter: SharedAdapter,
    driver: DriverWrapper,
    connection: DriverConnection,
  ) {
    this.#driver = driver;
    this.#connection = connection;
  }

  execute(sql: string, params: readonly unknown[], options?: ExecuteOptions): Promise<RawResult> {
    const promise = this.run(sql, params, options);
    this.last = promise.catch(ignoreError);
    return promise;
  }

  inTransaction(): boolean {
    return this.#connection.inTransaction();
  }

  stream(
    sql: string,
    params: readonly unknown[],
    options?: StreamOptions,
  ): AsyncIterable<Record<string, unknown>> {
    return this.streamRows(sql, params, options);
  }

  begin(options?: BeginOptions, execute?: ExecuteOptions): Promise<void> {
    // Checked before anything is sent, as a statement's own arguments are.
    const statements = beginStatements(this.adapter.dialect, options, this.adapter.capabilities);
    checkTransactionOptions("begin", execute);
    if (statements.length === 1) return this.statement(statements[0] as string, execute);
    return this.statements(statements, execute);
  }

  /**
   * The statements of one `begin`, in order. `timeoutMs` is one budget for all of them:
   * each gets what the ones before it left.
   */
  private async statements(
    statements: readonly string[],
    execute: ExecuteOptions | undefined,
  ): Promise<void> {
    const timeoutMs = checkTimeout(own(execute, "timeoutMs"));
    const deadline = timeoutMs === undefined ? 0 : now() + timeoutMs;
    for (let i = 0; i < statements.length; i++) {
      const options =
        i === 0 || timeoutMs === undefined
          ? execute
          : { ...execute, timeoutMs: Math.max(0, deadline - now()) };
      try {
        await this.statement(statements[i] as string, options);
      } catch (error) {
        // What the statements before it set (MySQL's `set transaction` applies to the next
        // transaction on the connection) must not reach the next transaction, on this
        // connection or after it goes back to the pool: `ROLLBACK` clears it (and ends the
        // transaction, if a statement stopped too late had begun one). When that fails too,
        // the connection is closed on release instead of reused.
        if (i > 0) await this.clearPending();
        throw error;
      }
    }
  }

  /** After a `begin` that failed part way: `ROLLBACK`, with no options; on failure, the connection is not reused. */
  private async clearPending(): Promise<void> {
    try {
      await this.statement("rollback", undefined);
    } catch {
      this.broken = true;
    }
  }

  commit(options?: ExecuteOptions): Promise<void> {
    checkTransactionOptions("commit", options);
    return this.statement("commit", options);
  }

  rollback(options?: ExecuteOptions): Promise<void> {
    checkTransactionOptions("rollback", options);
    return this.statement("rollback", options);
  }

  savepoint(name: string, options?: ExecuteOptions): Promise<void> {
    const sql = `savepoint ${this.adapter.quote(checkSavepointName("savepoint", name))}`;
    checkTransactionOptions("savepoint", options);
    return this.statement(sql, options);
  }

  rollbackTo(name: string, options?: ExecuteOptions): Promise<void> {
    const sql = `rollback to savepoint ${this.adapter.quote(checkSavepointName("rollbackTo", name))}`;
    checkTransactionOptions("rollbackTo", options);
    return this.statement(sql, options);
  }

  releaseSavepoint(name: string, options?: ExecuteOptions): Promise<void> {
    const sql = `release savepoint ${this.adapter.quote(checkSavepointName("releaseSavepoint", name))}`;
    checkTransactionOptions("releaseSavepoint", options);
    return this.statement(sql, options);
  }

  /** Returns the connection to the pool; it is closed instead when it failed fatally or still has a stream open. */
  release(): Promise<void> {
    return this.end("released");
  }

  destroy(): Promise<void> {
    return this.end("destroyed");
  }

  private async end(state: "released" | "destroyed"): Promise<void> {
    if (this.state !== "open") return;
    this.state = state;
    await this.last;
    const destroy = state === "destroyed" || this.broken || this.openStreams > 0;
    await this.adapter.checkin(this.#driver, this.#connection, destroy);
    this.adapter.finished();
  }

  private async statement(sql: string, options: ExecuteOptions | undefined): Promise<void> {
    await this.execute(sql, NO_PARAMS, options);
  }

  private usable(sql: string): void {
    if (this.state !== "open") {
      throw new DatabaseError(
        "database.connectionReleased",
        `This connection was ${this.state === "released" ? "released" : "destroyed"}.`,
        { code: "connection", sql },
      );
    }
    if (cancelFailed.has(this.#connection)) {
      throw new DatabaseError(
        "database.cancelFailed",
        "A cancel request for this connection failed, and it may still reach the server and cancel whatever runs next.",
        { code: "connection", sql },
      );
    }
    // A statement sent now would queue behind the open cursor and wait for the stream to
    // end, which may never happen (the loop that reads it may be the one waiting).
    if (this.openStreams > 0) {
      throw new QueryError("query.streamOpen", "A stream is still open on this connection.");
    }
  }

  private async run(
    sql: string,
    params: readonly unknown[],
    options: ExecuteOptions | undefined,
  ): Promise<RawResult> {
    const signal = checkSignal(own(options, "signal"));
    const timeoutMs = checkTimeout(own(options, "timeoutMs"));
    this.usable(sql);
    const timed = this.adapter.queryTelemetry;
    const start = timed ? now() : 0;
    try {
      const name = own(options, "statementName");
      const connection = this.#connection;
      const pending =
        signal === undefined && timeoutMs === undefined
          ? connection.query(sql, params, name)
          : interruptible(connection, sql, signal, timeoutMs, () => connection.query(sql, params, name));
      const result = await pending;
      if (timed) this.adapter.report(sql, params, options, now() - start, 0, result.rowCount, undefined);
      return result;
    } catch (error) {
      const normalized = this.adapter.normalize(error, sql);
      if (isFatal(normalized)) this.broken = true;
      if (timed) this.adapter.report(sql, params, options, now() - start, 0, 0, normalized);
      throw normalized;
    }
  }

  private async *streamRows(
    sql: string,
    params: readonly unknown[],
    options: StreamOptions | undefined,
  ): AsyncGenerator<Record<string, unknown>, void, undefined> {
    const signal = checkSignal(own(options, "signal"));
    const timeoutMs = checkTimeout(own(options, "timeoutMs"));
    const batchSize = checkBatchSize(own(options, "batchSize"));
    this.usable(sql);
    const timed = this.adapter.queryTelemetry;
    const start = timed ? now() : 0;
    const tally: StreamTally = { rows: 0, broken: false };
    let failure: unknown;
    this.openStreams++;
    try {
      yield* cursorRows(this.#connection, sql, params, batchSize, signal, timeoutMs, tally, this.isOpen);
    } catch (error) {
      failure = this.adapter.normalize(error, sql);
      throw failure;
    } finally {
      this.openStreams--;
      if (tally.broken || isFatal(failure)) this.broken = true;
      if (timed) this.adapter.report(sql, params, options, now() - start, 0, tally.rows, failure);
    }
  }
}
