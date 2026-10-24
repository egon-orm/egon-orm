/**
 * The driver wrapper over `pg`: a `pg.Pool`, cursors from `pg-cursor`, and the protocol's
 * cancel requests. Everything else (transactions, timeouts, telemetry, errors) is the shared
 * adapter's.
 *
 * @module
 */
import type { createAdapter, PoolEvent, RawResult } from "egon-orm";
import { QueryError } from "egon-orm";
import pg from "pg";
import type Cursor from "pg-cursor";
import { type CancelTarget, sendCancelRequest } from "./cancel.js";
import type { PoolSource } from "./options.js";
import { own } from "./own.js";
import { PG_TYPES } from "./values.js";

/** The driver interface of the shared adapter (not exported by name from `egon-orm`). */
type Definition = Parameters<typeof createAdapter>[0];
type DriverWrapper = ReturnType<Definition["driver"]>;
type DriverHooks = Parameters<Definition["driver"]>[0];
type DriverConnection = Awaited<ReturnType<DriverWrapper["acquire"]>>;
type DriverCursor = Awaited<ReturnType<DriverConnection["cursor"]>>;

/** The `pg-cursor` class. */
export type CursorClass = typeof Cursor;

/**
 * What the wrapper creates its objects with. Replaced in unit tests, which have no
 * database.
 */
export interface PgRuntime {
  /** Creates the pool the adapter owns. */
  readonly createPool: (config: pg.PoolConfig) => pg.Pool;
  /** Sends a cancel request (`cancel.ts`), giving up after `timeoutMs`. */
  readonly sendCancel: (target: CancelTarget, timeoutMs: number) => Promise<void>;
  /** Loads `pg-cursor`, an optional peer dependency, the first time a stream starts. */
  readonly loadCursor: () => Promise<CursorClass>;
}

/** The real runtime. */
export const PG_RUNTIME: PgRuntime = {
  createPool: (config) => new pg.Pool(config),
  sendCancel: sendCancelRequest,
  loadCursor: async () => {
    try {
      const module = (await import("pg-cursor")) as { default: CursorClass };
      return module.default;
    } catch (error) {
      throw new QueryError(
        "query.pgCursorMissing",
        'Streaming rows from Postgres needs the "pg-cursor" package, which is not installed.',
        { cause: error },
      );
    }
  },
};

/** Ignores the error an idle client reports: pg-pool has already removed that client. */
const ignore = (): void => undefined;

/** The error a cursor close fails with when its connection has ended. */
function cursorOnEndedConnection(): Error {
  return new Error("Connection terminated: the connection ended before the cursor was closed.");
}

/** How long a cancel request may take when the pool sets no `connectionTimeoutMs`. */
const DEFAULT_CANCEL_TIMEOUT_MS = 10_000;

/** One checked-out `pg` client. */
class PgConnection implements DriverConnection {
  /**
   * Set when the client reported an error outside a statement: the server ended the
   * session (`pg_terminate_backend`, a restart) or the socket failed between statements.
   * The connection is then closed on release instead of being pooled.
   */
  broken = false;
  /**
   * pg-pool listens for client errors only while a client is idle in the pool. A
   * checked-out client that fails between statements emits "error" with no listener,
   * which would end the process, so each checkout listens itself until it is released.
   */
  readonly onError: () => void;
  /** Set when the client's connection has ended: the server closed it, or the socket failed. */
  ended = false;
  /**
   * Cursor closes waiting for an answer. pg-cursor's close() resolves on the connection's
   * next readyForQuery, which a connection that has ended never sends, so each waiting
   * close is failed when the connection ends instead of waiting forever.
   */
  private readonly closing = new Set<() => void>();
  readonly onEnd: () => void;

  constructor(
    readonly client: pg.PoolClient,
    private readonly driver: PgDriver,
  ) {
    this.onError = () => {
      this.broken = true;
    };
    this.onEnd = () => {
      this.ended = true;
      this.broken = true;
      for (const fail of this.closing) fail();
      this.closing.clear();
    };
    client.on("error", this.onError);
    client.on("end", this.onEnd);
  }

  async query(
    sql: string,
    params: readonly unknown[],
    statementName: string | undefined,
  ): Promise<RawResult> {
    const config: pg.QueryConfig =
      statementName === undefined
        ? { text: sql, values: params as unknown[], types: PG_TYPES }
        : { text: sql, values: params as unknown[], types: PG_TYPES, name: statementName };
    const outcome: pg.QueryResult | pg.QueryResult[] = await this.client.query(config);
    // A statement list without parameters runs in one round trip and reports one result per
    // statement; the last one is the answer.
    const result = Array.isArray(outcome) ? (outcome[outcome.length - 1] as pg.QueryResult) : outcome;
    return { rows: result.rows, rowCount: result.rowCount ?? 0, insertId: undefined };
  }

  async cursor(sql: string, params: readonly unknown[]): Promise<DriverCursor> {
    const CursorConstructor = await this.driver.cursorClass();
    const cursor = this.client.query(new CursorConstructor(sql, params as unknown[], { types: PG_TYPES }));
    return {
      read: (count) => cursor.read(count) as Promise<Record<string, unknown>[]>,
      close: () => this.closeCursor(cursor),
    };
  }

  /** Closes a cursor; fails, rather than waiting forever, when the connection has ended. */
  private closeCursor(cursor: Cursor): Promise<void> {
    if (this.ended) return Promise.reject(cursorOnEndedConnection());
    return new Promise<void>((resolve, reject) => {
      const fail = (): void => reject(cursorOnEndedConnection());
      this.closing.add(fail);
      cursor.close().then(
        () => {
          this.closing.delete(fail);
          resolve();
        },
        (error: unknown) => {
          this.closing.delete(fail);
          reject(error);
        },
      );
    });
  }

  cancel(): Promise<void> {
    return this.driver.cancel(this.client);
  }

  inTransaction(): boolean {
    const status = this.client.getTransactionStatus();
    return status === "T" || status === "E";
  }
}

/** The `pg` driver wrapper. */
export class PgDriver implements DriverWrapper {
  private pool: pg.Pool | undefined = undefined;
  private max = 10;
  private cursorLoading: Promise<CursorClass> | undefined = undefined;
  private readonly onConnect: () => void;
  private readonly onRemove: () => void;

  constructor(
    private readonly source: PoolSource,
    hooks: DriverHooks,
    private readonly runtime: PgRuntime = PG_RUNTIME,
  ) {
    this.onConnect = () => hooks.connected();
    this.onRemove = () => hooks.disconnected();
  }

  init(): void {
    const source = this.source;
    const pool = source.owned ? this.runtime.createPool(source.config) : source.pool;
    // An owned pool must have an error listener: pg-pool emits "error" for an idle
    // connection that fails, and an unhandled "error" would end the process. The failed
    // connection is already removed by then (a "remove", reported as `disconnect`).
    if (source.owned) pool.on("error", ignore);
    pool.on("connect", this.onConnect);
    pool.on("remove", this.onRemove);
    const max: unknown = pool.options?.max;
    this.max = typeof max === "number" && max > 0 ? max : 10;
    this.pool = pool;
  }

  async acquire(): Promise<DriverConnection> {
    const client = await this.started().connect();
    return new PgConnection(client, this);
  }

  async release(connection: DriverConnection, destroy: boolean): Promise<void> {
    const checkedOut = connection as PgConnection;
    checkedOut.client.off("error", checkedOut.onError);
    checkedOut.client.off("end", checkedOut.onEnd);
    checkedOut.client.release(destroy || checkedOut.broken);
  }

  async destroy(): Promise<void> {
    const pool = this.pool;
    if (pool === undefined) return;
    pool.off("connect", this.onConnect);
    pool.off("remove", this.onRemove);
    // The error listener of an owned pool stays: pg-pool's end() resolves as soon as it has
    // asked its idle clients to end, before their sockets have closed, and a client that
    // reports an error meanwhile (the server terminated its session: a restart,
    // pg_terminate_backend, DROP DATABASE ... WITH (FORCE)) makes the pool emit "error",
    // which would end the process with no listener. The pool is discarded either way.
    if (this.source.owned) await pool.end();
  }

  stats(): PoolEvent {
    const pool = this.started();
    return { size: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
  }

  saturated(): boolean {
    const pool = this.started();
    return pool.idleCount === 0 && pool.totalCount >= this.max;
  }

  /** `pg-cursor`, loaded once. A failed load is not remembered, so installing it later works. */
  cursorClass(): Promise<CursorClass> {
    if (this.cursorLoading === undefined) {
      const loading = this.runtime.loadCursor();
      this.cursorLoading = loading;
      // Only one load is ever in flight, so a failure always belongs to the current one.
      loading.catch(() => {
        this.cursorLoading = undefined;
      });
    }
    return this.cursorLoading;
  }

  /**
   * Cancels what `client` is running with the protocol's cancel request, sent to the
   * server `client` is connected to, with the backend key `pg` received when it connected.
   * Bounded by the pool's `connectionTimeoutMs` (10 s when it has none).
   *
   * @throws Error when the client has no backend key, or the request fails or times out.
   */
  async cancel(client: pg.PoolClient): Promise<void> {
    const fields = client as unknown as {
      readonly processID?: unknown;
      readonly secretKey?: unknown;
      readonly host?: unknown;
      readonly port?: unknown;
      readonly ssl?: unknown;
      readonly sslNegotiation?: unknown;
      readonly connection?: {
        readonly stream?: { readonly remoteAddress?: unknown; readonly remotePort?: unknown };
      };
    };
    const { processID, secretKey } = fields;
    if (typeof processID !== "number" || typeof secretKey !== "number") {
      throw new Error("The connection has no backend key to cancel its statement with.");
    }
    const configuredHost = typeof fields.host === "string" && fields.host !== "" ? fields.host : "localhost";
    const configuredPort = typeof fields.port === "number" ? fields.port : 5432;
    // Aim at the server this connection is actually connected to, as libpq does: the host
    // name may resolve elsewhere now (DNS round-robin, several poolers, a load balancer).
    // A Unix socket has no remote address, and falls back to the configured path.
    const stream = fields.connection?.stream;
    const address = stream?.remoteAddress;
    const remotePort = stream?.remotePort;
    const connected = typeof address === "string" && address !== "" && typeof remotePort === "number";
    const ssl = fields.ssl;
    const target: CancelTarget = {
      host: connected ? address : configuredHost,
      port: connected ? remotePort : configuredPort,
      serverName: configuredHost,
      processId: processID,
      secretKey,
      ssl: ssl === undefined || ssl === null || ssl === false ? false : (ssl as CancelTarget["ssl"]),
      sslNegotiation: fields.sslNegotiation === "direct" ? "direct" : "postgres",
    };
    await this.runtime.sendCancel(target, this.cancelTimeoutMs());
  }

  private cancelTimeoutMs(): number {
    const source = this.source;
    // Own properties only: a value planted on Object.prototype is no timeout.
    const configured: unknown = source.owned
      ? own(source.config, "connectionTimeoutMillis")
      : own(source.pool.options, "connectionTimeoutMillis");
    return typeof configured === "number" && configured > 0 ? configured : DEFAULT_CANCEL_TIMEOUT_MS;
  }

  private started(): pg.Pool {
    const pool = this.pool;
    if (pool === undefined) throw new Error("The pg driver wrapper was used before init().");
    return pool;
  }
}
