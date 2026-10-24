/**
 * The driver wrapper over `better-sqlite3`: one database handle, shared by everything the
 * adapter runs, one statement at a time. Everything else (transactions, timeouts,
 * telemetry, errors) is the shared adapter's.
 *
 * `better-sqlite3` is synchronous. The wrapper keeps the adapter's `Promise` API and
 * serialises access to the handle: the handle is the pool's only connection, so a caller
 * that wants it while a transaction or a stream holds it waits in line, in order. Two
 * transactions therefore never interleave.
 *
 * @module
 */
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import type { createAdapter, PoolEvent, RawResult } from "egon-orm";
import type { OpenSettings } from "./options.js";
import { formatTimestamp } from "./values.js";

/** The driver interface of the shared adapter (not exported by name from `egon-orm`). */
type Definition = Parameters<typeof createAdapter>[0];
type DriverWrapper = ReturnType<Definition["driver"]>;
type DriverHooks = Parameters<Definition["driver"]>[0];
type DriverConnection = Awaited<ReturnType<DriverWrapper["acquire"]>>;
type DriverCursor = Awaited<ReturnType<DriverConnection["cursor"]>>;

/** A database handle of `better-sqlite3`. */
export type SqliteHandle = Database.Database;

type Statement = Database.Statement<unknown[], Record<string, unknown>>;

/**
 * Opens the database. Replaced in tests that check what happens when opening fails.
 */
export interface SqliteRuntime {
  readonly open: (settings: OpenSettings) => SqliteHandle;
}

/**
 * `better-sqlite3` 13 is built for Node-API 10 (Node.js 22.14 and later) and crashes the
 * process when it opens a database under an older one. Version 12 works on every Node.js
 * 22. The check turns the crash into an error that says what to do.
 *
 * @throws Error when the installed driver needs a newer Node.js.
 */
export function checkRuntime(driverVersion: string, napiVersion: string | undefined): void {
  const major = Number.parseInt(driverVersion, 10);
  const napi = Number.parseInt(napiVersion ?? "0", 10);
  if (major >= 13 && napi < 10) {
    throw new Error(
      `better-sqlite3 ${driverVersion} needs Node.js 22.14 or later (Node-API 10), and this is Node.js ${process.versions.node}. Upgrade Node.js, or install better-sqlite3 12: pnpm add better-sqlite3@12`,
    );
  }
}

/** A `require` function, as `createRequire` and CommonJS's own `require` both are. */
type RequireFunction = (id: string) => unknown;

/**
 * The `require` to read the driver's `package.json` with: one made from this module's URL,
 * or, when there is none, the CommonJS `require` of the code around it. A bundler that
 * turns this ES module into CommonJS (esbuild with `format: "cjs"`) leaves `import.meta`
 * empty, and `createRequire(undefined)` would throw before the database is opened.
 * `undefined` when neither exists: the version check is then skipped.
 */
export function requireFor(moduleUrl: unknown, commonJsRequire: unknown): RequireFunction | undefined {
  if (typeof moduleUrl === "string") return createRequire(moduleUrl);
  return typeof commonJsRequire === "function" ? (commonJsRequire as RequireFunction) : undefined;
}

/** The real runtime: checks the driver against Node.js once, then opens the file. */
export const SQLITE_RUNTIME: SqliteRuntime = {
  open: (settings) => {
    const load = requireFor(import.meta.url, typeof require === "function" ? require : undefined);
    const manifest = load?.("better-sqlite3/package.json") as { version?: unknown } | undefined;
    if (typeof manifest?.version === "string") checkRuntime(manifest.version, process.versions.napi);
    return new Database(settings.filename, databaseOptions(settings));
  },
};

/**
 * The options of `new Database(filename, options)`. better-sqlite3 tests each option with
 * `in` (checked against better-sqlite3 12.11.1, `lib/database.js` and `lib/util.js`), so an
 * option planted on `Object.prototype` would reach it: `nativeBinding` loads a native
 * addon, `verbose` is handed every statement. The object has no prototype, and every key
 * that version reads is set as an own property, with the driver's own default where Egon has
 * no value (owner decision, 2026-10-24). `readOnly` and `memory`, which it reads only to
 * refuse them, are left out: without a prototype they are absent.
 *
 * @example
 * ```ts
 * databaseOptions({ filename: ":memory:", readonly: false, pragmas: [], attach: [] });
 * // { readonly: false, fileMustExist: false, timeout: 5000, verbose: null, nativeBinding: null }
 * ```
 */
export function databaseOptions(settings: OpenSettings): Database.Options {
  const options = Object.create(null) as {
    -readonly [K in keyof Database.Options]-?: Database.Options[K] | null;
  };
  options.readonly = settings.readonly;
  options.fileMustExist = false;
  options.timeout = 5000;
  options.verbose = null;
  options.nativeBinding = null;
  return options as Database.Options;
}

const EMPTY_ROWS: readonly Record<string, unknown>[] = /* @__PURE__ */ Object.freeze([]);

/** The statements kept prepared, per handle. Plans repeat their SQL text, so most are found here. */
const STATEMENT_CACHE_SIZE = 500;

const MAX_SAFE = /* @__PURE__ */ BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = /* @__PURE__ */ BigInt(Number.MIN_SAFE_INTEGER);

/**
 * Every integer is read exactly, as a `bigint` (safe integers), and then given back as a
 * `number` when it fits one: rows look as the other drivers' do (`select 1` is `1`), and an
 * integer beyond `Number.MAX_SAFE_INTEGER` keeps every digit for `t.bigint()`. The rows
 * are the driver's own objects, changed in place.
 */
function numbersWhereSafe(rows: readonly Record<string, unknown>[]): void {
  for (const row of rows) {
    for (const key in row) {
      const value = row[key];
      if (typeof value === "bigint" && value <= MAX_SAFE && value >= MIN_SAFE) row[key] = Number(value);
    }
  }
}

/** A key the driver reported, as a number when it fits one. */
function insertedKey(rowid: number | bigint): number | bigint {
  return typeof rowid === "bigint" && rowid <= MAX_SAFE && rowid >= MIN_SAFE ? Number(rowid) : rowid;
}

/**
 * The parameters as better-sqlite3 binds them. It takes no booleans and no dates, so a value
 * with no type to convert it (an untyped value, `val(true)`, `val(new Date())`) is bound as
 * SQLite stores one: a boolean as 1 or 0, a `Date` as the text a `timestamptz` column
 * holds. The array is copied only when it holds one.
 *
 * @throws CastError for an invalid `Date`.
 */
function bindable(params: readonly unknown[]): unknown[] {
  let copy: unknown[] | undefined;
  for (let i = 0; i < params.length; i++) {
    const value = params[i];
    if (typeof value === "boolean") {
      if (copy === undefined) copy = params.slice();
      copy[i] = value ? 1 : 0;
    } else if (value instanceof Date) {
      if (copy === undefined) copy = params.slice();
      copy[i] = formatTimestamp(value, true);
    }
  }
  return copy ?? (params as unknown[]);
}

/** Whether `error` is better-sqlite3's refusal to prepare several statements at once. */
function isStatementList(error: unknown): boolean {
  return error instanceof RangeError && /more than one statement/.test(error.message);
}

/** The handle, as the shared adapter checks it out. There is only ever one. */
class SqliteConnection implements DriverConnection {
  constructor(private readonly driver: SqliteDriver) {}

  query(sql: string, params: readonly unknown[], _statementName: string | undefined): Promise<RawResult> {
    try {
      return Promise.resolve(this.driver.run(sql, params));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  cursor(sql: string, params: readonly unknown[]): Promise<DriverCursor> {
    try {
      return Promise.resolve(this.driver.iterate(sql, params));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** A statement runs to its end before anything else can happen: there is nothing to cancel. */
  cancel(): Promise<void> {
    return Promise.resolve();
  }

  inTransaction(): boolean {
    return this.driver.handle().inTransaction;
  }
}

/** Rows read one batch at a time from `Statement.iterate`. */
class SqliteCursor implements DriverCursor {
  private done = false;

  constructor(
    private readonly rows: IterableIterator<Record<string, unknown>>,
    private readonly open: Set<SqliteCursor>,
  ) {
    open.add(this);
  }

  read(count: number): Promise<readonly Record<string, unknown>[]> {
    if (this.done) return Promise.resolve(EMPTY_ROWS);
    try {
      const batch: Record<string, unknown>[] = [];
      while (batch.length < count) {
        const next = this.rows.next();
        if (next.done === true) {
          this.finish();
          break;
        }
        batch.push(next.value);
      }
      numbersWhereSafe(batch);
      return Promise.resolve(batch);
    } catch (error) {
      this.finish();
      return Promise.reject(error);
    }
  }

  close(): Promise<void> {
    if (!this.done) {
      this.finish();
      // Ends the statement, so that the handle can run the next one.
      this.rows.return?.();
    }
    return Promise.resolve();
  }

  private finish(): void {
    this.done = true;
    this.open.delete(this);
  }
}

/** The `better-sqlite3` driver wrapper: a pool of one handle. */
export class SqliteDriver implements DriverWrapper {
  private database: SqliteHandle | undefined = undefined;
  private readonly connection: SqliteConnection;
  private busy = false;
  private readonly waiting: ((connection: DriverConnection) => void)[] = [];
  private readonly statements = new Map<string, Statement>();
  private readonly cursors = new Set<SqliteCursor>();

  constructor(
    private readonly settings: OpenSettings,
    private readonly hooks: DriverHooks,
    private readonly runtime: SqliteRuntime = SQLITE_RUNTIME,
  ) {
    this.connection = new SqliteConnection(this);
  }

  /** Nothing is opened here: opening can fail, and a failure belongs to the first statement. */
  init(): void {}

  acquire(): Promise<DriverConnection> {
    if (this.busy) {
      return new Promise((resolve) => {
        this.waiting.push(resolve);
      });
    }
    try {
      this.handle();
    } catch (error) {
      return Promise.reject(error);
    }
    this.busy = true;
    return Promise.resolve(this.connection);
  }

  /**
   * Hands the handle to the next caller in line. With `destroy`, the connection could not be
   * trusted (it was left inside a transaction, or failed): the handle is the only one, so
   * instead of closing it, a transaction left open is rolled back.
   */
  async release(_connection: DriverConnection, destroy: boolean): Promise<void> {
    // A stream left open (its connection released midway) would keep the handle busy.
    for (const cursor of [...this.cursors]) await cursor.close();
    const database = this.database;
    if (destroy && database?.open === true && database.inTransaction) {
      try {
        database.exec("rollback");
      } catch {
        // Nothing more can be done for it; the next statement reports the state.
      }
    }
    const next = this.waiting.shift();
    if (next === undefined) this.busy = false;
    else next(this.connection);
  }

  async destroy(): Promise<void> {
    const database = this.database;
    this.database = undefined;
    this.statements.clear();
    if (database?.open === true) {
      database.close();
      this.hooks.disconnected();
    }
  }

  stats(): PoolEvent {
    const open = this.database?.open === true ? 1 : 0;
    return { size: open, idle: open === 1 && !this.busy ? 1 : 0, waiting: this.waiting.length };
  }

  saturated(): boolean {
    return this.busy;
  }

  /**
   * The open handle, opened (with the settings' pragmas, its attached databases and safe
   * integers) the first time.
   *
   * @throws the driver's error when the file cannot be opened or a pragma fails.
   */
  handle(): SqliteHandle {
    const current = this.database;
    if (current !== undefined) return current;
    const database = this.runtime.open(this.settings);
    try {
      // Every integer is read as a bigint, so that none loses a digit; the codecs convert.
      database.defaultSafeIntegers(true);
      for (const pragma of this.settings.pragmas) database.exec(pragma);
      // The file name is bound; the schema name was checked to be a plain name.
      for (const [name, file] of this.settings.attach)
        database.prepare(`attach database ? as "${name}"`).run(file);
    } catch (error) {
      database.close();
      throw error;
    }
    this.database = database;
    this.hooks.connected();
    return database;
  }

  /** Runs one statement. A statement list without parameters runs as a script. */
  run(sql: string, params: readonly unknown[]): RawResult {
    const database = this.handle();
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      try {
        statement = database.prepare<unknown[], Record<string, unknown>>(sql);
      } catch (error) {
        if (params.length === 0 && isStatementList(error)) {
          database.exec(sql);
          return { rows: EMPTY_ROWS, rowCount: 0, insertId: undefined };
        }
        throw error;
      }
      if (this.statements.size >= STATEMENT_CACHE_SIZE) {
        const oldest = this.statements.keys().next().value as string;
        this.statements.delete(oldest);
      }
      this.statements.set(sql, statement);
    }
    const values = bindable(params);
    if (statement.reader) {
      const rows = statement.all(values);
      numbersWhereSafe(rows);
      return { rows, rowCount: rows.length, insertId: undefined };
    }
    const info = statement.run(values);
    // lastInsertRowid keeps the previous insert's value when nothing was inserted.
    const insertId = info.changes > 0 ? insertedKey(info.lastInsertRowid) : undefined;
    return { rows: EMPTY_ROWS, rowCount: info.changes, insertId };
  }

  /** Opens an iterator over the rows of one statement, prepared for it alone. */
  iterate(sql: string, params: readonly unknown[]): DriverCursor {
    const statement = this.handle().prepare<unknown[], Record<string, unknown>>(sql);
    return new SqliteCursor(statement.iterate(bindable(params)), this.cursors);
  }
}
