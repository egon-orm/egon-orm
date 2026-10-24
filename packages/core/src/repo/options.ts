/**
 * The options of {@link createRepo} and of the repo's read methods, and how a call's
 * arguments are split into named parameters and options.
 *
 * A read method takes `(queryable, params, options?)` when the query has named parameters
 * and `(queryable, options?)` when it has none (owner decision). Which form a call has is
 * decided by the query, never by guessing from the object passed: a query that needs
 * named parameters always takes them as its second argument.
 *
 * @module
 */
import type { DatabaseAdapter } from "../adapter/adapter.js";
import type { QueryEvent } from "../contracts/adapter.js";
import type { NamedParamNode, QueryAst } from "../contracts/query.js";
import { own } from "../internal/own.js";
import { isPlainObject } from "../internal/plain-object.js";
import { collectParams } from "../query/ast.js";

/**
 * What a repo method reports in its `query` events as `operation`: the method that ran the
 * statement. A throwing twin reports the method it is the twin of (`oneOrThrow` is
 * `"one"`), `count` is `"aggregate"`, and `insertOrUpdate` reports the write it made
 * (`"insert"` or `"update"`). The statements that load preloaded associations (of any
 * read, of `repo.preload` and of `reload`) report `"preload"`. The statements that begin
 * and end a transaction or a nested one (`BEGIN`, `SAVEPOINT`, `RELEASE SAVEPOINT`,
 * `ROLLBACK TO SAVEPOINT`, `COMMIT`, `ROLLBACK`) report `"transaction"`, with no `source`:
 * those of `repo.transaction`, and those of the transaction or savepoint a write of several
 * statements opens.
 *
 * @example
 * ```ts
 * const operation: RepoOperation = "all";
 * ```
 */
export type RepoOperation =
  | "all"
  | "one"
  | "first"
  | "get"
  | "getBy"
  | "exists"
  | "aggregate"
  | "stream"
  | "reload"
  | "preload"
  | "explain"
  | "raw"
  | "insert"
  | "update"
  | "delete"
  | "insertAll"
  | "updateAll"
  | "deleteAll"
  | "transaction";

/**
 * One statement the repo ran, as its `query` listeners receive it: the adapter's
 * {@link QueryEvent} plus what the repo knows about the call.
 *
 * - `operation`: the repo method ({@link RepoOperation}).
 * - `source`: the table the query reads from (its root), `undefined` when the root is not
 *   a table (a subquery, a fragment) and for `raw`.
 * - `decodeMs`: the time spent turning the result rows into what the query selected, in
 *   milliseconds. For a stream it is the total over every row it yielded.
 * - `context`: the `context` option of the call, untouched; `undefined` when it had none.
 * - `params`: the parameter values, only when the repo was created with
 *   `log: { params: true }` (a redacted field's value shows as `**redacted**`); otherwise
 *   `undefined`.
 *
 * @example
 * ```ts
 * repo.on("query", (event: RepoQueryEvent) => {
 *   if (event.durationMs > 100) process.stderr.write(`slow ${event.operation} on ${event.source}\n`);
 * });
 * ```
 */
export interface RepoQueryEvent extends QueryEvent {
  readonly context: Readonly<Record<string, unknown>> | undefined;
  readonly operation: RepoOperation;
  readonly source: string | undefined;
  readonly decodeMs: number;
}

/**
 * Logs each statement the repo runs.
 *
 * - `true`: one line per statement on standard error (the operation, the table, the
 *   timings, the row count and the SQL).
 * - a function: called with each {@link RepoQueryEvent}, like a `repo.on("query", …)`
 *   listener.
 * - `{ params: true }`: as `true`, and the lines (and every `query` event of the repo)
 *   include the parameter values. The value of a redacted field is never included.
 *
 * @example
 * ```ts
 * const log: LogOption = { params: true };
 * ```
 */
export type LogOption = boolean | ((event: RepoQueryEvent) => void) | { readonly params: true };

/**
 * The options of {@link createRepo}.
 *
 * @example
 * ```ts
 * import { postgres } from "@egon-orm/postgres";
 *
 * const options: RepoOptions = {
 *   adapter: postgres({ connectionString: process.env.DATABASE_URL }),
 *   schema: "tenant_1",
 *   log: true,
 * };
 * ```
 */
export interface RepoOptions {
  /** The database: what `postgres(...)` (from `@egon-orm/postgres`) and the other dialect packages return. */
  readonly adapter: DatabaseAdapter;
  /**
   * The default database schema (a Postgres schema, a MySQL database). The weakest of the
   * places a database schema can come from: a query's own `.schema(…)`, a schema class's
   * declared one and the per-call `schema` option all win over it.
   */
  readonly schema?: string | undefined;
  /** See {@link LogOption}. Default `false`. */
  readonly log?: LogOption | undefined;
  /** Development only; used by transactions. Default `false`. */
  readonly warnOnRootUseInTransaction?: boolean | undefined;
  /**
   * Whether the row decoders are generated with `new Function` (the fast path). `false`
   * builds them without generating code, for a Content Security Policy without
   * `unsafe-eval`; the rows are the same, only slower to build. Default `true`.
   *
   * A decoder is kept on its compiled plan, and plans are shared by every adapter of the
   * same configuration: a `codegen: false` repo never calls `new Function` itself, but may
   * use a generated decoder that a repo with `codegen` on built for the same plan.
   */
  readonly codegen?: boolean | undefined;
}

/**
 * The options every read method takes, last.
 *
 * @example
 * ```ts
 * const options: ReadOptions = { timeoutMs: 500, context: { requestId: "r-1" } };
 * ```
 */
export interface ReadOptions {
  /**
   * The database schema for this call. It is weaker than a query's own `.schema(…)` and
   * than a schema class's declared one, and stronger than the repo's default.
   */
  readonly schema?: string | undefined;
  /**
   * The time budget of the whole call, in milliseconds: the wait for a connection counts.
   * A call that runs out rejects with `DatabaseError`, code `"timeout"`.
   */
  readonly timeoutMs?: number | undefined;
  /** Cancels the call; it rejects with `DatabaseError`, code `"aborted"`. */
  readonly signal?: AbortSignal | undefined;
  /** Anything to pass through to this call's `query` events, as `event.context`. */
  readonly context?: Readonly<Record<string, unknown>> | undefined;
  /**
   * How many preload statements of this call may run at once (sibling associations).
   * Default 1: one at a time, so a call holds one connection. Inside a transaction they
   * always run one at a time, on its connection.
   */
  readonly maxConcurrency?: number | undefined;
}

/**
 * The options of `repo.stream`.
 *
 * @example
 * ```ts
 * const options: StreamReadOptions = { batchSize: 1_000 };
 * ```
 */
export interface StreamReadOptions extends ReadOptions {
  /**
   * How many rows to fetch from the database at a time. Default 500. With a `timeoutMs`,
   * the budget bounds the wait for a connection and then each fetch.
   */
  readonly batchSize?: number | undefined;
}

/**
 * The options of `repo.explain`.
 *
 * @example
 * ```ts
 * const options: ExplainReadOptions = { analyze: true, format: "json" };
 * ```
 */
export interface ExplainReadOptions extends ReadOptions {
  /** Runs the query and reports what it actually did. */
  readonly analyze?: boolean | undefined;
  /** `"text"` (the default) returns a string; `"json"` the database's structured plan. */
  readonly format?: "text" | "json" | undefined;
}

/** The default `batchSize` of `repo.stream`. */
export const DEFAULT_STREAM_BATCH_SIZE = 500;

/** The keys each kind of call accepts, for the message of an unknown option. */
export const READ_OPTION_KEYS: readonly string[] = /* @__PURE__ */ Object.freeze([
  "schema",
  "timeoutMs",
  "signal",
  "context",
  "maxConcurrency",
]);
export const STREAM_OPTION_KEYS: readonly string[] = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ READ_OPTION_KEYS.concat(["batchSize"]),
);
export const EXPLAIN_OPTION_KEYS: readonly string[] = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ READ_OPTION_KEYS.concat(["analyze", "format"]),
);
export const SQL_OPTION_KEYS: readonly string[] = /* @__PURE__ */ Object.freeze(["schema"]);

/** The checked options of {@link createRepo}. */
export interface RepoSettings {
  readonly adapter: DatabaseAdapter;
  readonly schema: string | undefined;
  /** The function that receives every query event, from `log`; `undefined` without `log`. */
  readonly logger: ((event: RepoQueryEvent) => void) | undefined;
  /** Whether query events carry parameter values (`log: { params: true }`). */
  readonly logParams: boolean;
  readonly warnOnRootUseInTransaction: boolean;
  readonly codegen: boolean;
}

const REPO_OPTION_KEYS = ["adapter", "schema", "log", "warnOnRootUseInTransaction", "codegen"];

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `${typeof value} ${String(value)}`;
}

function checkSchemaName(where: string, schema: unknown): string | undefined {
  if (schema === undefined) return undefined;
  if (typeof schema !== "string" || schema.length === 0) {
    throw new TypeError(
      `${where}: schema must be a non-empty string (a database schema name), but it is ${describe(schema)}.`,
    );
  }
  return schema;
}

function checkBoolean(where: string, name: string, value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean")
    throw new TypeError(`${where}: ${name} must be true or false, but it is ${describe(value)}.`);
  return value;
}

/**
 * Checks the options of `createRepo`.
 *
 * @throws TypeError when an option is unknown or has the wrong type, or the adapter is not
 * a database adapter.
 */
export function repoSettings(options: unknown, writeLine: (line: string) => void): RepoSettings {
  const where = "createRepo(options)";
  if (typeof options !== "object" || options === null || !isPlainObject(options)) {
    throw new TypeError(
      `${where}: options must be an object with an adapter: createRepo({ adapter: postgres(...) }).`,
    );
  }
  const given = options as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!REPO_OPTION_KEYS.includes(key)) {
      throw new TypeError(
        `${where}: unknown option "${key}". The options are ${REPO_OPTION_KEYS.join(", ")}.`,
      );
    }
  }
  const adapter = own(given, "adapter") as Partial<DatabaseAdapter> | undefined;
  if (
    typeof adapter !== "object" ||
    adapter === null ||
    typeof adapter.compile !== "function" ||
    typeof adapter.execute !== "function" ||
    typeof adapter.ping !== "function" ||
    typeof adapter.poolStats !== "function" ||
    typeof adapter.on !== "function"
  ) {
    throw new TypeError(
      `${where}: adapter must be a database adapter, such as postgres({ connectionString }) from @egon-orm/postgres.`,
    );
  }
  const log = own(given, "log");
  let logger: ((event: RepoQueryEvent) => void) | undefined;
  let logParams = false;
  if (log === undefined || log === false) {
    logger = undefined;
  } else if (log === true) {
    logger = lineLogger(writeLine, false);
  } else if (typeof log === "function") {
    logger = log as (event: RepoQueryEvent) => void;
  } else if (
    typeof log === "object" &&
    log !== null &&
    isPlainObject(log) &&
    Object.keys(log).length === 1 &&
    own(log as { params?: unknown }, "params") === true
  ) {
    logger = lineLogger(writeLine, true);
    logParams = true;
  } else {
    throw new TypeError(
      `${where}: log must be true, false, a function or { params: true }, but it is ${describe(log)}.`,
    );
  }
  return {
    adapter: adapter as DatabaseAdapter,
    schema: checkSchemaName(where, own(given, "schema")),
    logger,
    logParams,
    warnOnRootUseInTransaction: checkBoolean(
      where,
      "warnOnRootUseInTransaction",
      own(given, "warnOnRootUseInTransaction"),
      false,
    ),
    codegen: checkBoolean(where, "codegen", own(given, "codegen"), true),
  };
}

/** Formats one parameter value for a log line. */
function formatParam(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return `${value}n`;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return Array.isArray(value) ? "[array]" : "[object]";
    }
  }
  return String(value);
}

/**
 * The line `log: true` writes for one event:
 * `egon all users 1.25 ms (queue 0.02 ms, decode 0.10 ms) 3 rows: select …`.
 */
export function formatLogLine(event: RepoQueryEvent, params: boolean): string {
  const ms = (value: number): string => value.toFixed(2);
  const outcome =
    event.error === undefined ? `${event.rowCount} row${event.rowCount === 1 ? "" : "s"}` : "failed";
  let line = `egon ${event.operation}${event.source === undefined ? "" : ` ${event.source}`} ${ms(event.durationMs)} ms (queue ${ms(event.queueMs)} ms, decode ${ms(event.decodeMs)} ms) ${outcome}: ${event.sql}`;
  if (params && event.params !== undefined)
    line += ` -- params: [${event.params.map(formatParam).join(", ")}]`;
  if (event.error !== undefined) {
    const error = event.error;
    line += ` -- error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
  }
  return line;
}

function lineLogger(writeLine: (line: string) => void, params: boolean): (event: RepoQueryEvent) => void {
  return (event) => writeLine(formatLogLine(event, params));
}

/**
 * Writes a line to standard error, where there is one (Node and the other server
 * runtimes); elsewhere the line is dropped.
 */
export function writeToStderr(line: string): void {
  const stderr = (globalThis as { process?: { stderr?: { write?: (text: string) => unknown } } }).process
    ?.stderr;
  if (typeof stderr?.write === "function") stderr.write(`${line}\n`);
}

/**
 * Checks a call's options object: an object with known keys only, and the types the repo
 * reads itself (`schema`, `context`, and `analyze` / `format` for explain). `timeoutMs`,
 * `signal` and `batchSize` are checked by the adapter, which uses them.
 *
 * @throws TypeError when the options are not an object, have an unknown key, or a wrong type.
 */
export function checkReadOptions<O extends ReadOptions>(
  method: string,
  options: unknown,
  keys: readonly string[],
): O | undefined {
  if (options === undefined) return undefined;
  if (typeof options !== "object" || options === null || !isPlainObject(options)) {
    throw new TypeError(
      `repo.${method}(): its options must be an object, but they are ${describe(options)}.`,
    );
  }
  const given = options as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (!keys.includes(key)) {
      throw new TypeError(
        `repo.${method}(): unknown option "${key}". The options are ${keys.join(", ")}. (A query without named parameters takes its options as the second argument; one with named parameters takes the parameters second and the options third.)`,
      );
    }
  }
  checkSchemaName(`repo.${method}()`, own(given, "schema"));
  const context = own(given, "context");
  if (context !== undefined && (typeof context !== "object" || context === null || !isPlainObject(context))) {
    throw new TypeError(
      `repo.${method}(): the context option must be a plain object, but it is ${describe(context)}.`,
    );
  }
  return options as O;
}

/**
 * The named parameters a query needs (its preload callbacks' included), each once.
 * Read from the query itself when it is a builder query; computed from the AST and
 * cached otherwise.
 */
export function namedParamsOf(queryable: { readonly ast: QueryAst }): readonly string[] {
  const method = (queryable as { readonly namedParams?: unknown }).namedParams;
  if (typeof method === "function") return (method as () => readonly string[]).call(queryable);
  const ast = queryable.ast;
  let names = namesByAst.get(ast);
  if (names === undefined) {
    const found: string[] = [];
    collectNames(ast, found);
    names = Object.freeze(found);
    namesByAst.set(ast, names);
  }
  return names;
}

const namesByAst = /* @__PURE__ */ new WeakMap<QueryAst, readonly string[]>();

function collectNames(ast: QueryAst, out: string[]): void {
  const named: NamedParamNode[] = [];
  collectParams(ast, [], undefined, named);
  for (const node of named) if (!out.includes(node.name)) out.push(node.name);
  for (const preload of ast.preloads) collectPreloadNames(preload, out);
}

function collectPreloadNames(preload: QueryAst["preloads"][number], out: string[]): void {
  if (preload.query !== undefined) collectNames(preload.query, out);
  for (const nested of preload.nested) collectPreloadNames(nested, out);
}

/** What a read call was given after the queryable: its named parameters and its options. */
export interface SplitArgs<O> {
  readonly named: Readonly<Record<string, unknown>> | undefined;
  readonly options: O | undefined;
}

/**
 * Splits `args` into named parameters and options: `[params, options?]` when the query
 * takes named parameters, `[options?]` when it takes none.
 *
 * @throws TypeError when there are more arguments than the form allows, the named
 * parameters are not an object, or the options are invalid (see {@link checkReadOptions}).
 */
export function splitArgs<O extends ReadOptions>(
  method: string,
  names: readonly string[],
  args: readonly unknown[],
  keys: readonly string[],
): SplitArgs<O> {
  if (names.length === 0) {
    if (args.length > 1) {
      throw new TypeError(
        `repo.${method}(): this query has no named parameters, so it takes only its options after the query, but it was given ${args.length} arguments.`,
      );
    }
    return { named: undefined, options: checkReadOptions<O>(method, args[0], keys) };
  }
  if (args.length > 2) {
    throw new TypeError(
      `repo.${method}(): this query takes its named parameters and then its options, but it was given ${args.length} arguments.`,
    );
  }
  const named = args[0];
  if (typeof named !== "object" || named === null || Array.isArray(named)) {
    throw new TypeError(
      `repo.${method}(): this query needs the named parameter${names.length > 1 ? "s" : ""} ${names.map((name) => `"${name}"`).join(", ")}, given as an object in the second argument: repo.${method}(query, { ${names[0]}: … }).`,
    );
  }
  return {
    named: named as Readonly<Record<string, unknown>>,
    options: checkReadOptions<O>(method, args[1], keys),
  };
}
