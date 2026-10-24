/**
 * The read operations of the repo, as functions over a {@link ReadCore}: the adapter,
 * the executor statements run on, the defaults, and the telemetry hub.
 *
 * ## The pipeline of `all`
 *
 * normalise the queryable to a query AST, compile it (`adapter.compile`, which finds the
 * plan in the adapter's plan cache), bind its parameters (`bindParams`), execute, decode
 * every row with the plan's decoder (built once and kept on the plan), then hand the rows
 * to {@link afterDecode} when the query preloads associations. The array returned is a
 * fresh one, of fresh rows.
 *
 * `repo.all` is one call into {@link load}, an async function with one `await`
 * (`executor.execute`, whose own awaits are the adapter's), plus one on
 * {@link afterDecode} when the query has preloads. The methods that post-process the
 * rows (`one`, `oneOrThrow`, `first`, `get`, `getBy`, `count`, `aggregate`, `reload`)
 * await `load` once more. No options object is allocated when the call passes none and
 * nobody listens to `query` events, and no closure is made per call.
 *
 * ## Rewritten queries
 *
 * `first`, `exists`, `count` and `aggregate` run a query derived from the one given. The
 * derived AST is built from the original's parts (its `params` and `shape` recomputed
 * from them, as the AST contract asks of hand-built queries) and cached per original AST,
 * so a query defined once is rewritten once.
 *
 * @module
 */
import type { DatabaseAdapter } from "../adapter/adapter.js";
import { bindParams } from "../compiler/bind.js";
import type {
  CompiledQuery,
  ExecuteOptions,
  Executor,
  OutputPlan,
  ParamSlot,
  QueryEvent,
  RawResult,
  StreamOptions,
} from "../contracts/adapter.js";
import type {
  ExprNode,
  FragmentNode,
  QueryAst,
  SelectNode,
  SelectShape,
  SourceNode,
  SubquerySourceNode,
  TableSourceNode,
} from "../contracts/query.js";
import type { AnySchema, FieldMeta, SchemaMeta } from "../contracts/schema.js";
import { ROW } from "../contracts/schema.js";
import { MultipleResultsError, NoResultsError, QueryError } from "../errors.js";
import { own } from "../internal/own.js";
import { isPlainObject } from "../internal/plain-object.js";
import { schemaOfRow } from "../query/assoc.js";
import {
  binaryNode,
  caseNode,
  castNode,
  collectParams,
  columnNode,
  fragmentNode,
  literalNode,
  naryNode,
  paramNode,
  shapeOf,
} from "../query/ast.js";
import { from, type Query, render } from "../query/builder.js";
import { type AnyExpr, Col, isExpr } from "../query/expr.js";
import { avg, count, max, min, sum } from "../query/functions.js";
import { selectNode } from "../query/select.js";
import { isRow, isSchema } from "../schema/guards.js";
import { meta } from "../schema/schema.js";
import { arrayType, bigintType, integerType } from "../types/index.js";
import { decodeRows, decoderFor } from "./hydrate.js";
import {
  DEFAULT_STREAM_BATCH_SIZE,
  type ExplainReadOptions,
  namedParamsOf,
  type ReadOptions,
  type RepoOperation,
  type RepoQueryEvent,
  type StreamReadOptions,
} from "./options.js";
import {
  checkJoinLimit,
  checkPreloads,
  deadlineOf,
  reloadPreloads,
  runPreloads,
  withinBudget,
} from "./preload.js";

const now = (): number => performance.now();

const NONE: readonly never[] = /* @__PURE__ */ Object.freeze([]);

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/**
 * One repo call that is being reported: handed to the adapter as the execution's
 * `context`, so that the adapter's event for that statement finds its way back to the
 * call that ran it, even when executions overlap. The repo then reports it once, with
 * what only it knows (the operation, the table, the decoding time, the caller's context).
 */
export class Call {
  /** The adapter's event for this call's statement, once it has arrived. */
  event: QueryEvent | undefined;

  constructor(
    readonly hub: QueryHub,
    readonly operation: RepoOperation,
    readonly source: string | undefined,
    readonly context: Readonly<Record<string, unknown>> | undefined,
  ) {
    this.event = undefined;
  }
}

/** Calls one listener, isolating the statement from it: a listener's error is rethrown on a later microtask. */
function notify(listener: (event: RepoQueryEvent) => void, event: RepoQueryEvent): void {
  try {
    listener(event);
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}

/**
 * The `query` listeners of one repo (and of the transaction-scoped repos made from it).
 * It listens to the adapter only while it has listeners of its own, so that a repo nobody
 * listens to costs the adapter nothing; it subscribes with `{ params: true }` when the
 * repo logs parameters.
 */
export class QueryHub {
  /** Whether anyone listens: read before anything is measured or allocated. */
  listening = false;
  #listeners: readonly ((event: RepoQueryEvent) => void)[] = NONE;
  #unsubscribe: (() => void) | undefined = undefined;
  readonly #adapter: DatabaseAdapter;
  readonly #params: boolean;

  constructor(adapter: DatabaseAdapter, params: boolean) {
    this.#adapter = adapter;
    this.#params = params;
  }

  /** Subscribes; returns the function that unsubscribes (idempotent). */
  on(listener: (event: RepoQueryEvent) => void): () => void {
    if (typeof listener !== "function") {
      throw new TypeError('repo.on("query", listener): the listener must be a function.');
    }
    // Wrapped, so that the same function subscribed twice is two subscriptions.
    const entry = (event: RepoQueryEvent): void => listener(event);
    this.#set([...this.#listeners, entry]);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#set(this.#listeners.filter((other) => other !== entry));
    };
  }

  /** Stops listening to the adapter. */
  close(): void {
    this.#set(NONE);
  }

  #set(listeners: readonly ((event: RepoQueryEvent) => void)[]): void {
    this.#listeners = listeners;
    const listening = listeners.length > 0;
    if (listening && this.#unsubscribe === undefined) {
      this.#unsubscribe = this.#adapter.on(
        "query",
        this.#receive,
        this.#params ? { params: true } : undefined,
      );
    } else if (!listening && this.#unsubscribe !== undefined) {
      this.#unsubscribe();
      this.#unsubscribe = undefined;
    }
    this.listening = listening;
  }

  /** The adapter's listener: keeps the event of a statement this repo ran on its call. */
  readonly #receive = (event: QueryEvent): void => {
    const call = event.context;
    if (!(call instanceof Call) || call.hub !== this) return;
    // A call of several statements (a transaction's `BEGIN` is two on MySQL) reports each:
    // the one before is reported when the next one arrives.
    if (call.event !== undefined) this.emit(call, 0, undefined);
    call.event = event;
  };

  /**
   * Reports a call: its statement's event with the repo's facts added. `error` is the
   * call's failure, when it failed after the statement (a value that could not be
   * decoded); otherwise the statement's own. A call whose statement produced no event (it
   * never ran) is not reported.
   */
  emit(call: Call, decodeMs: number, error: unknown): void {
    const event = call.event;
    if (event === undefined) return;
    call.event = undefined;
    const listeners = this.#listeners;
    const report: RepoQueryEvent = {
      sql: event.sql,
      paramCount: event.paramCount,
      durationMs: event.durationMs,
      queueMs: event.queueMs,
      rowCount: event.rowCount,
      error: error === undefined ? event.error : error,
      params: event.params,
      context: call.context,
      operation: call.operation,
      source: call.source,
      decodeMs,
    };
    for (const listener of listeners) notify(listener, report);
  }
}

// ---------------------------------------------------------------------------
// The core
// ---------------------------------------------------------------------------

/**
 * What every read operation needs. A transaction-scoped repo (step 16) shares the
 * adapter, the defaults and the hub of its root repo, and has its own executor (the
 * transaction's connection).
 */
export class ReadCore {
  /**
   * Whether `executor` is the pool (the adapter itself, or the development-mode wrapper
   * over it that step 16 installs) rather than one connection. A call that needs several
   * statements on one connection checks one out only when this is true.
   */
  pooled: boolean;

  constructor(
    readonly adapter: DatabaseAdapter,
    /** Where statements run: the adapter (any pooled connection) or one connection. */
    public executor: Executor,
    /** The repo's default database schema. */
    readonly schema: string | undefined,
    readonly codegen: boolean,
    readonly hub: QueryHub,
  ) {
    this.pooled = executor === adapter;
  }
}

/** What the repo keeps per compiled plan, besides its decoder (which is on the plan). */
interface PlanInfo {
  /** The execution options used when a call passes none and nobody listens: the slots only. */
  readonly bare: ExecuteOptions;
  /** Whether a row of the output carries preloads, which {@link afterDecode} completes. */
  readonly preloads: boolean;
  /** The names of the plan's named slots. */
  readonly names: ReadonlySet<string>;
}

const planInfos = /* @__PURE__ */ new WeakMap<CompiledQuery, PlanInfo>();

function hasPreloads(plan: OutputPlan | undefined): boolean {
  if (plan === undefined) return false;
  switch (plan.kind) {
    case "row":
      return plan.preloads.length > 0;
    case "object":
      return plan.values.some(hasPreloads);
    case "tuple":
      return plan.items.some(hasPreloads);
    default:
      return false;
  }
}

function infoOf(plan: CompiledQuery): PlanInfo {
  let info = planInfos.get(plan);
  if (info === undefined) {
    const names = new Set<string>();
    for (const slot of plan.slots) if (slot.kind === "named") names.add(slot.name);
    const bare: CallOptions = {
      signal: undefined,
      timeoutMs: undefined,
      slots: plan.slots,
      context: undefined,
      batchSize: undefined,
    };
    info = { bare: bare as ExecuteOptions, preloads: hasPreloads(plan.output), names };
    planInfos.set(plan, info);
  }
  return info;
}

/** The execution options of one call, in one shape. */
interface CallOptions {
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number | undefined;
  readonly slots: readonly ParamSlot[];
  readonly context: Call | undefined;
  readonly batchSize: number | undefined;
}

function executeOptions(
  plan: CompiledQuery,
  info: PlanInfo,
  options: ReadOptions | undefined,
  call: Call | undefined,
  batchSize: number | undefined,
): ExecuteOptions {
  if (options === undefined && call === undefined && batchSize === undefined) return info.bare;
  const shaped: CallOptions = {
    signal: own(options, "signal"),
    timeoutMs: own(options, "timeoutMs"),
    slots: plan.slots,
    context: call,
    batchSize,
  };
  return shaped as StreamOptions;
}

// ---------------------------------------------------------------------------
// Queryables
// ---------------------------------------------------------------------------

/** A query as a read operation sees it. */
export interface QueryInput {
  readonly ast: QueryAst;
  /** The named parameters the query needs (its preload callbacks' included). */
  readonly names: readonly string[];
  /** The builder query, when there is one (a schema class gives `from(Schema, alias)`). */
  readonly query: Query<unknown, unknown, never, string> | undefined;
}

/** The alias of the root binding of `repo.all(Schema)`: the table's name. */
function rootAlias(schemaMeta: SchemaMeta): string {
  const source = schemaMeta.source as string;
  return source.startsWith("$") ? "t" : source;
}

/** `from(Schema, <table name>)`, for a read of a schema class. */
export function rootQuery(schema: AnySchema): Query<unknown, unknown, never, string> {
  const schemaMeta = meta(schema);
  if (schemaMeta.source === null) {
    throw new QueryError(
      "query.readEmbedded",
      `${schemaMeta.name} is an embedded schema: it is stored inside its parent's row and has no table to read.`,
    );
  }
  return from(schema, rootAlias(schemaMeta)) as unknown as Query<unknown, unknown, never, string>;
}

function isQueryLike(value: unknown): value is { readonly ast: QueryAst } {
  if (typeof value !== "object" || value === null) return false;
  const ast = (value as { readonly ast?: unknown }).ast;
  return typeof ast === "object" && ast !== null && (ast as { readonly kind?: unknown }).kind === "query";
}

/**
 * Normalises what a read method was given: a schema class reads all of its rows, a query
 * is used as it is.
 *
 * @throws TypeError when `queryable` is neither.
 */
export function inputOf(method: string, queryable: unknown): QueryInput {
  if (isSchema(queryable)) {
    const query = rootQuery(queryable);
    return { ast: query.ast, names: NONE, query };
  }
  if (isQueryLike(queryable)) {
    const query = typeof (queryable as { where?: unknown }).where === "function" ? queryable : undefined;
    return {
      ast: queryable.ast,
      names: namedParamsOf(queryable),
      query: query as Query<unknown, unknown, never, string> | undefined,
    };
  }
  throw new TypeError(
    `repo.${method}() takes a schema class or a query: repo.${method}(User) or repo.${method}(from(User, "u")…).`,
  );
}

/** The table a query reads from, for telemetry. */
function sourceOf(ast: QueryAst): string | undefined {
  return ast.from.kind === "table" ? ast.from.source : undefined;
}

function constantsOf(ast: QueryAst): readonly unknown[] {
  return ast.select === undefined ? NONE : ast.select.constants;
}

function schemaFor(core: ReadCore, options: ReadOptions | undefined): string | undefined {
  const schema = own(options, "schema");
  return schema === undefined ? core.schema : schema;
}

/**
 * Binds the parameters of a plan compiled from a query **derived** from the one the
 * caller gave (`first`, `exists`, `count`, …). The caller's named values are checked
 * against the original query's names; only those the derived plan uses are bound (a name
 * used only in a clause the derivation dropped, an `orderBy`, has no slot).
 */
function bindDerived(
  plan: CompiledQuery,
  info: PlanInfo,
  ast: QueryAst,
  named: Readonly<Record<string, unknown>> | undefined,
  original: readonly string[],
): unknown[] {
  if (named === undefined) return bindParams(plan.slots, ast.params);
  const used: Record<string, unknown> = {};
  const extra: string[] = [];
  for (const name in named) {
    if (!Object.hasOwn(named, name)) continue;
    if (!original.includes(name)) extra.push(name);
    else if (info.names.has(name)) used[name] = named[name];
  }
  if (extra.length > 0) {
    throw new QueryError(
      "query.paramsUnknown",
      `The query has no named parameter${extra.length > 1 ? "s" : ""} ${extra.map((name) => `"${name}"`).join(", ")}; it takes ${original.map((name) => `"${name}"`).join(", ")}.`,
    );
  }
  for (const name of original) {
    if (!Object.hasOwn(named, name) || named[name] === undefined) {
      throw new QueryError(
        "query.paramsMissing",
        `The query needs the named parameter "${name}", which was not given a value.`,
        { params: { name } },
      );
    }
  }
  return bindParams(plan.slots, ast.params, used);
}

// ---------------------------------------------------------------------------
// Running a statement
// ---------------------------------------------------------------------------

/**
 * Turns a result into what a statement-level read returns. Each is a module-level
 * function, so no closure is made per call.
 */
type Finish<T> = (result: RawResult) => T;

/**
 * Executes a compiled statement whose rows are not decoded (`exists`, `explain`, `raw`)
 * and turns its result into `T` with `finish`, reporting the call to the repo's `query`
 * listeners (the time `finish` took is `decodeMs`).
 */
async function run<T>(
  core: ReadCore,
  operation: RepoOperation,
  source: string | undefined,
  plan: CompiledQuery,
  info: PlanInfo,
  values: readonly unknown[],
  options: ReadOptions | undefined,
  finish: Finish<T>,
): Promise<T> {
  const hub = core.hub;
  const call = hub.listening ? new Call(hub, operation, source, own(options, "context")) : undefined;
  let result: RawResult;
  try {
    result = await core.executor.execute(
      plan.sql,
      values,
      executeOptions(plan, info, options, call, undefined),
    );
  } catch (error) {
    if (call !== undefined) hub.emit(call, 0, undefined);
    throw error;
  }
  if (call === undefined) return finish(result);
  const start = now();
  let value: T;
  try {
    value = finish(result);
  } catch (error) {
    hub.emit(call, now() - start, error);
    throw error;
  }
  hub.emit(call, now() - start, undefined);
  return value;
}

/** What {@link afterDecode} receives besides the rows and the plan. */
export interface AfterDecodeContext {
  readonly core: ReadCore;
  /** The AST that was executed. */
  readonly ast: QueryAst;
  readonly named: Readonly<Record<string, unknown>> | undefined;
  readonly options: ReadOptions | undefined;
  /** The call's deadline, taken before its first statement, when it has a `timeoutMs`. */
  readonly deadline: number | undefined;
}

/**
 * The stage after decoding, for queries that preload associations: it merges the parents
 * of join preloads and runs the queries of separate preloads (`preload.ts`). It is called
 * only when a row of the plan's output carries preloads.
 *
 * @example
 * ```ts
 * const rows = decodeRows(result.rows, decoder, constants);
 * const users = await afterDecode(rows, plan, { core, ast, named, options, deadline });
 * ```
 */
export function afterDecode(
  rows: unknown[],
  plan: CompiledQuery,
  context: AfterDecodeContext,
): Promise<unknown[]> {
  return runPreloads(rows, plan, context);
}

/**
 * Runs a query and returns its decoded rows: the pipeline of `all`, in one async function
 * with one `await` (on `executor.execute`), plus one on {@link afterDecode} for a query
 * with preloads.
 *
 * `original` is given for a query derived from the caller's (`first`, `count`, …): the
 * caller's named values are then checked against the original query's names
 * ({@link bindDerived}).
 */
export async function load(
  core: ReadCore,
  operation: RepoOperation,
  ast: QueryAst,
  named: Readonly<Record<string, unknown>> | undefined,
  options: ReadOptions | undefined,
  source: string | undefined = sourceOf(ast),
  original: readonly string[] | undefined = undefined,
): Promise<unknown[]> {
  const adapter = core.adapter;
  const plan = adapter.compile(ast, "all", schemaFor(core, options));
  const info = infoOf(plan);
  // A query with preloads is given the named values of its preloads' queries too: each
  // statement binds those it uses, and all are checked here, before anything runs.
  const values =
    original === undefined && !info.preloads
      ? bindParams(plan.slots, ast.params, named)
      : bindDerived(plan, info, ast, named, original ?? namedParamsOf({ ast }));
  const deadline = info.preloads ? deadlineOf(options) : undefined;
  if (info.preloads) {
    const rootMeta = (plan.output as Extract<OutputPlan, { readonly kind: "row" }>).meta;
    checkPreloads(rootMeta, ast.preloads);
    checkJoinLimit(ast, rootMeta, operation);
  }
  const decoder = decoderFor(plan, adapter, core.codegen);
  const constants = constantsOf(ast);
  const hub = core.hub;
  const call = hub.listening ? new Call(hub, operation, source, own(options, "context")) : undefined;
  let result: RawResult;
  try {
    result = await core.executor.execute(
      plan.sql,
      values,
      executeOptions(plan, info, options, call, undefined),
    );
  } catch (error) {
    if (call !== undefined) hub.emit(call, 0, undefined);
    throw error;
  }
  let rows: unknown[];
  if (call === undefined) {
    rows = decodeRows(result.rows, decoder, constants);
  } else {
    const start = now();
    try {
      rows = decodeRows(result.rows, decoder, constants);
    } catch (error) {
      hub.emit(call, now() - start, error);
      throw error;
    }
    hub.emit(call, now() - start, undefined);
  }
  return info.preloads ? afterDecode(rows, plan, { core, ast, named, options, deadline }) : rows;
}

/** At most one row: `null` for none, {@link MultipleResultsError} for more. */
export function single(rows: readonly unknown[], ast: QueryAst): unknown {
  if (rows.length > 1) throw new MultipleResultsError({ count: rows.length, query: render(ast) });
  return rows.length === 0 ? null : rows[0];
}

/** Exactly one row: {@link NoResultsError} for none, {@link MultipleResultsError} for more. */
export function exactlyOne(rows: readonly unknown[], ast: QueryAst): unknown {
  if (rows.length === 0) throw new NoResultsError({ query: render(ast) });
  return single(rows, ast);
}

// ---------------------------------------------------------------------------
// Derived queries
// ---------------------------------------------------------------------------

/** The parts of a query AST a derivation replaces; everything else is kept. */
interface Changes {
  readonly from?: SourceNode;
  readonly select?: SelectNode | undefined;
  readonly distinct?: undefined;
  readonly orderBys?: readonly never[];
  readonly limit?: ExprNode | undefined;
  readonly preloads?: readonly never[];
}

/** A copy of `ast` with `changes`, its `params`, `listLengths` and `shape` recomputed. */
function derive(ast: QueryAst, changes: Changes): QueryAst {
  const has = (key: keyof Changes): boolean => Object.hasOwn(changes, key);
  const draft: QueryAst = {
    kind: "query",
    from: changes.from ?? ast.from,
    joins: ast.joins,
    wheres: ast.wheres,
    select: has("select") ? changes.select : ast.select,
    distinct: has("distinct") ? undefined : ast.distinct,
    groupBys: ast.groupBys,
    havings: ast.havings,
    orderBys: changes.orderBys ?? ast.orderBys,
    limit: has("limit") ? changes.limit : ast.limit,
    offset: ast.offset,
    lock: ast.lock,
    combinations: ast.combinations,
    ctes: ast.ctes,
    windows: ast.windows,
    preloads: changes.preloads ?? ast.preloads,
    updates: ast.updates,
    schema: ast.schema,
    hints: ast.hints,
    params: NONE,
    listLengths: NONE,
    shape: 0,
  };
  return finalize(draft);
}

/** Computes `params`, `listLengths` and `shape` of a hand-built AST. */
function finalize(draft: QueryAst): QueryAst {
  const params: unknown[] = [];
  const lists: number[] = [];
  collectParams(draft, params, lists);
  return {
    kind: "query",
    from: draft.from,
    joins: draft.joins,
    wheres: draft.wheres,
    select: draft.select,
    distinct: draft.distinct,
    groupBys: draft.groupBys,
    havings: draft.havings,
    orderBys: draft.orderBys,
    limit: draft.limit,
    offset: draft.offset,
    lock: draft.lock,
    combinations: draft.combinations,
    ctes: draft.ctes,
    windows: draft.windows,
    preloads: draft.preloads,
    updates: draft.updates,
    schema: draft.schema,
    hints: draft.hints,
    params,
    listLengths: lists,
    shape: shapeOf(draft),
  };
}

/** The alias of the subquery a derivation wraps a query in. */
const WRAPPED = "s";

/** `SELECT … FROM (inner) AS "s"`, with `select` and `limit`. */
function wrap(inner: QueryAst, select: SelectNode, limit: ExprNode | undefined): QueryAst {
  const from: SubquerySourceNode = { kind: "subquerySource", query: inner, alias: WRAPPED };
  return finalize({
    kind: "query",
    from,
    joins: NONE,
    wheres: NONE,
    select,
    distinct: undefined,
    groupBys: NONE,
    havings: NONE,
    orderBys: NONE,
    limit,
    offset: undefined,
    lock: undefined,
    combinations: NONE,
    ctes: NONE,
    windows: NONE,
    preloads: NONE,
    updates: NONE,
    schema: undefined,
    hints: NONE,
    params: NONE,
    listLengths: NONE,
    shape: 0,
  });
}

const INTEGER = /* @__PURE__ */ integerType();
const BIGINT = /* @__PURE__ */ bigintType();

/** A `LIMIT 1`; a bound parameter, like every limit. */
const limitOne = (): ExprNode => paramNode(1, INTEGER, false);

/** `SELECT 1`. */
const SELECT_ONE: SelectNode = /* @__PURE__ */ selectNode(
  { kind: "expr", expr: /* @__PURE__ */ literalNode(1), type: undefined },
  NONE,
);

/** Derived ASTs, per original AST and derivation. */
const derived = /* @__PURE__ */ new WeakMap<QueryAst, Map<string, QueryAst>>();

function cached(ast: QueryAst, key: string, make: () => QueryAst): QueryAst {
  let byKey = derived.get(ast);
  if (byKey === undefined) {
    byKey = new Map();
    derived.set(ast, byKey);
  }
  let result = byKey.get(key);
  if (result === undefined) {
    result = make();
    byKey.set(key, result);
  }
  return result;
}

/**
 * The query of `first`: the same query with `LIMIT 1`, or, when it has a limit of its own,
 * `LIMIT CASE WHEN <own> < 1 THEN <own> ELSE 1 END` (`<own>` cast to bigint): never more
 * than one row, never more
 * than the query's own limit (`limit(0)` still returns nothing). Its offset is kept.
 *
 * On a database whose `LIMIT` takes only a value (`expressions` false, MySQL), an own
 * limit that is a value is replaced by the smaller of it and 1; a limit given as a named
 * parameter stays as it is, and the compiler refuses the `CASE` there.
 */
export function firstAst(ast: QueryAst, expressions = true): QueryAst {
  return cached(ast, expressions ? "first" : "firstValue", () => {
    const own = ast.limit;
    if (own === undefined) return derive(ast, { limit: limitOne() });
    if (!expressions && own.kind === "param" && typeof own.value === "number") {
      return derive(ast, { limit: paramNode(Math.min(own.value, 1), INTEGER, false) });
    }
    // As bigint: a CASE would otherwise type the limit as a 32-bit integer and refuse the
    // large limits a plain LIMIT takes.
    const limit = castNode(own, BIGINT);
    const one = literalNode(1);
    return derive(ast, { limit: caseNode([{ when: binaryNode("lt", limit, one), result: limit }], one) });
  });
}

/**
 * Whether a select computes an aggregate over the query's rows:
 *
 * - `"aggregate"`: an aggregate function that is not a window function (or a window
 *   function whose arguments aggregate). Such a select groups the rows by itself.
 * - `"unchecked"`: no aggregate the repo can see, but a fragment (or an expression kind
 *   it does not know), whose SQL could hold one.
 * - `undefined`: neither.
 *
 * Only expression children are walked: never the values of parameters, their types, or
 * subqueries (whose aggregates are their own).
 */
type Aggregation = "aggregate" | "unchecked" | undefined;

function stronger(a: Aggregation, b: Aggregation): Aggregation {
  return a === "aggregate" || b === "aggregate" ? "aggregate" : (a ?? b);
}

function selectAggregation(select: SelectNode | undefined): Aggregation {
  return select === undefined ? undefined : shapeAggregation(select.shape);
}

function shapeAggregation(shape: SelectShape): Aggregation {
  switch (shape.kind) {
    case "expr":
      return exprAggregation(shape.expr);
    case "object":
      return shape.values.reduce<Aggregation>(
        (found, value) => stronger(found, shapeAggregation(value)),
        undefined,
      );
    case "tuple":
      return shape.items.reduce<Aggregation>(
        (found, item) => stronger(found, shapeAggregation(item)),
        undefined,
      );
    default:
      return undefined;
  }
}

function listAggregation(nodes: readonly ExprNode[]): Aggregation {
  let found: Aggregation;
  for (const node of nodes) found = stronger(found, exprAggregation(node));
  return found;
}

function exprAggregation(node: ExprNode): Aggregation {
  switch (node.kind) {
    case "aggregate":
      // A window function does not group, but its arguments may.
      return node.over === undefined ? "aggregate" : listAggregation(node.args);
    case "fragment":
      return stronger("unchecked", listAggregation(node.args));
    case "unary":
      return exprAggregation(node.operand);
    case "binary":
      return stronger(exprAggregation(node.left), exprAggregation(node.right));
    case "between":
      return listAggregation([node.expr, node.low, node.high]);
    case "nary":
    case "fn":
      return listAggregation(node.args);
    case "tuple":
      return listAggregation(node.items);
    case "cast":
      return exprAggregation(node.expr);
    case "jsonPath":
      return stronger(exprAggregation(node.expr), listAggregation(node.path));
    case "case": {
      let found = node.else === undefined ? undefined : exprAggregation(node.else);
      for (const branch of node.whens) found = stronger(found, listAggregation([branch.when, branch.result]));
      return found;
    }
    case "selectedAs":
      return node.expr === undefined ? undefined : exprAggregation(node.expr);
    case "column":
    case "param":
    case "namedParam":
    case "list":
    case "literal":
    case "ident":
    case "star":
    case "subquery":
    case "exists":
      return undefined;
    default:
      // A node kind added by an extension: its SQL is not known here.
      return "unchecked";
  }
}

/**
 * Whether `exists` must look at the query's rows as they are, through a subquery: when
 * dropping its select, order and distinct, or replacing its limit, could change whether
 * it has a row. That is a limit of its own, a set operation (the branches' selects
 * decide an `INTERSECT` or `EXCEPT`), `distinct` with an offset (distinct rows decide
 * what the offset skips), and a select that aggregates without a `groupBy` (it returns a
 * row even over no rows).
 */
function existsNeedsWrapping(ast: QueryAst): boolean {
  return (
    ast.limit !== undefined ||
    ast.combinations.length > 0 ||
    (ast.distinct !== undefined && ast.offset !== undefined) ||
    (ast.groupBys.length === 0 && selectAggregation(ast.select) !== undefined)
  );
}

/**
 * The query of `exists`: `SELECT 1 … LIMIT 1` without the select, order, distinct and
 * preloads, or, when that could change the answer ({@link existsNeedsWrapping}),
 * `SELECT 1 FROM (q) AS "s" LIMIT 1`.
 */
export function existsAst(ast: QueryAst): QueryAst {
  return cached(ast, "exists", () =>
    existsNeedsWrapping(ast)
      ? wrap(derive(ast, { preloads: NONE }), SELECT_ONE, limitOne())
      : derive(ast, {
          select: SELECT_ONE,
          distinct: undefined,
          orderBys: NONE,
          preloads: NONE,
          limit: limitOne(),
        }),
  );
}

/**
 * The aggregate functions of `repo.aggregate`.
 *
 * @example
 * ```ts
 * const fn: AggregateFunction = "sum";
 * const views = await repo.aggregate(Post, fn, "views");
 * ```
 */
export type AggregateFunction = "count" | "sum" | "avg" | "min" | "max";

const AGGREGATES: readonly AggregateFunction[] = ["count", "sum", "avg", "min", "max"];

/**
 * Why an aggregate over the query must be computed over its rows as a subquery, or
 * `undefined` when it need not: a limit, an offset, `distinct`, a set operation, a
 * `groupBy` or a `having` decide which rows there are; a row lock cannot be combined with
 * an aggregate; a select that aggregates by itself returns one row, not the rows it
 * reads; and a fragment in the select cannot be checked for aggregates.
 */
function wrapReason(ast: QueryAst): string | undefined {
  if (ast.limit !== undefined) return "it has a limit";
  if (ast.offset !== undefined) return "it has an offset";
  if (ast.distinct !== undefined) return "it is distinct";
  if (ast.combinations.length > 0) return "it has a set operation";
  if (ast.groupBys.length > 0) return "it has a groupBy";
  if (ast.havings.length > 0) return "it has a having";
  if (ast.lock !== undefined) return "it locks its rows";
  switch (selectAggregation(ast.select)) {
    case "aggregate":
      return "its select aggregates";
    case "unchecked":
      return "its select has a fragment, whose SQL cannot be checked for aggregates";
    default:
      return undefined;
  }
}

/** The schema metadata of the root binding of a query, for an aggregate over one of its fields. */
function rootMeta(ast: QueryAst): SchemaMeta | undefined {
  const root = ast.from;
  return root.kind === "table" || root.kind === "cteSource" ? root.meta : undefined;
}

function aggregateExpr(fn: AggregateFunction, column: Col<unknown> | undefined): AnyExpr {
  if (column === undefined) return count() as AnyExpr;
  switch (fn) {
    case "count":
      return count(column) as AnyExpr;
    case "sum":
      return sum(column as never) as AnyExpr;
    case "avg":
      return avg(column as never) as AnyExpr;
    case "min":
      return min(column) as AnyExpr;
    case "max":
      return max(column) as AnyExpr;
  }
}

function selectOf(expr: AnyExpr): SelectNode {
  return selectNode({ kind: "expr", expr: expr.node, type: expr.type }, NONE);
}

/**
 * The query of `aggregate(fn, field)`: the query's select replaced by the aggregate, its
 * order and preloads dropped. A query whose rows the aggregate must see as they are (one
 * with a limit, an offset, `distinct`, a set operation, a `groupBy` or a `having`) is
 * wrapped: `SELECT count(*) FROM (q) AS "s"`.
 *
 * @throws QueryError when `fn` is unknown, a function other than `count` has no field, the
 * field is not a column of the query's root binding, or a wrapped query does not select
 * the field.
 */
export function aggregateAst(ast: QueryAst, fn: AggregateFunction, field: string | undefined): QueryAst {
  if (!AGGREGATES.includes(fn)) {
    throw new QueryError(
      "query.aggregateFunction",
      `repo.aggregate() was given the function ${JSON.stringify(fn)}.`,
    );
  }
  if (field === undefined && fn !== "count") {
    throw new QueryError(
      "query.aggregateField",
      `repo.aggregate(query, "${fn}") needs the field to aggregate.`,
      { params: { fn } },
    );
  }
  return cached(ast, field === undefined ? fn : `${fn}:${field}`, () => {
    const reason = wrapReason(ast);
    const fieldMeta = field === undefined ? undefined : rootField(ast, field);
    if (reason === undefined) {
      const column = fieldMeta === undefined ? undefined : new Col<unknown>(ast.from.alias, fieldMeta);
      return derive(ast, { select: selectOf(aggregateExpr(fn, column)), orderBys: NONE, preloads: NONE });
    }
    const inner = derive(ast, { preloads: NONE });
    const column =
      fieldMeta === undefined ? undefined : new Col<unknown>(WRAPPED, wrappedColumn(ast, fieldMeta, reason));
    return wrap(inner, selectOf(aggregateExpr(fn, column)), undefined);
  });
}

function rootField(ast: QueryAst, field: string): FieldMeta {
  const schemaMeta = rootMeta(ast);
  if (schemaMeta === undefined) {
    throw new QueryError(
      "query.aggregateRootSchema",
      `repo.aggregate() over the field "${field}" needs a query whose root binding is a schema; this one reads ${ast.from.kind === "subquerySource" ? "a subquery" : `a ${ast.from.kind} source`}.`,
    );
  }
  const found = schemaMeta.fieldsByName.get(field);
  if (found === undefined || found.virtual) {
    const names = schemaMeta.persisted.map((each) => each.name).join(", ");
    throw new QueryError(
      "query.aggregateUnknownColumn",
      `repo.aggregate(): ${schemaMeta.name} has no column "${field}"${found === undefined ? "" : " (it is a virtual field)"}. Its columns are: ${names}.`,
    );
  }
  return found;
}

/**
 * The column of `field` in a wrapped query's output: its column name when the query
 * selects whole rows of its root, the key when it selects an object with that key.
 */
function wrappedColumn(ast: QueryAst, field: FieldMeta, reason: string): FieldMeta {
  const select = ast.select;
  if (select === undefined) return field;
  const shape = select.shape;
  if (shape.kind === "binding" && shape.binding === ast.from.alias) return field;
  if (shape.kind === "object") {
    const index = shape.keys.indexOf(field.name);
    const value = index < 0 ? undefined : shape.values[index];
    // The key counts only when its value is that very column of the root binding.
    if (
      value?.kind === "expr" &&
      value.expr.kind === "column" &&
      value.expr.binding === ast.from.alias &&
      value.expr.column === field.column
    ) {
      return { ...field, column: field.name };
    }
  }
  throw new QueryError(
    "query.aggregateSubquerySelect",
    `repo.aggregate() over "${field.name}": this query is aggregated as a subquery (${reason}).`,
    { params: { field: field.name, alias: ast.from.alias } },
  );
}

// ---------------------------------------------------------------------------
// The read operations
// ---------------------------------------------------------------------------

/**
 * `repo.first`: the first row of the query, or `null`. It reads at most one row: `LIMIT 1`,
 * or the query's own limit when smaller, with its offset kept ({@link firstAst}).
 */
export async function first(
  core: ReadCore,
  input: QueryInput,
  named: Readonly<Record<string, unknown>> | undefined,
  options: ReadOptions | undefined,
): Promise<unknown> {
  const rows = await firstRows(core, input, named, options);
  return rows.length === 0 ? null : rows[0];
}

/**
 * `repo.firstOrThrow`: the first row of the query, read as `first` reads it; {@link NoResultsError},
 * with the query's rendering, when there is none. It counts the rows rather than testing
 * the row for `null`, so a selected value that is `null` is returned, not refused.
 */
export async function firstOrThrow(
  core: ReadCore,
  input: QueryInput,
  named: Readonly<Record<string, unknown>> | undefined,
  options: ReadOptions | undefined,
): Promise<unknown> {
  const rows = await firstRows(core, input, named, options);
  if (rows.length === 0) throw new NoResultsError({ query: render(input.ast) });
  return rows[0];
}

/** The rows of the query of `first` (at most one), reported as the operation `"first"`. */
function firstRows(
  core: ReadCore,
  input: QueryInput,
  named: Readonly<Record<string, unknown>> | undefined,
  options: ReadOptions | undefined,
): Promise<readonly unknown[]> {
  return load(
    core,
    "first",
    firstAst(input.ast, core.adapter.capabilities.limitExpressions),
    named,
    options,
    sourceOf(input.ast),
    input.names,
  );
}

/** `repo.exists`. */
export async function exists(
  core: ReadCore,
  input: QueryInput,
  named: Readonly<Record<string, unknown>> | undefined,
  options: ReadOptions | undefined,
): Promise<boolean> {
  const ast = existsAst(input.ast);
  const plan = core.adapter.compile(ast, "all", schemaFor(core, options));
  const info = infoOf(plan);
  const values = bindDerived(plan, info, ast, named, input.names);
  return run(core, "exists", sourceOf(input.ast), plan, info, values, options, hasRows);
}

/** `repo.aggregate` and `repo.count`. */
export async function aggregate(
  core: ReadCore,
  input: QueryInput,
  fn: AggregateFunction,
  field: string | undefined,
  named: Readonly<Record<string, unknown>> | undefined,
  options: ReadOptions | undefined,
): Promise<unknown> {
  const ast = aggregateAst(input.ast, fn, field);
  const rows = await load(core, "aggregate", ast, named, options, sourceOf(input.ast), input.names);
  return rows.length === 0 ? null : rows[0];
}

/** The query of `get(Schema, id)`. */
export function byKey(schema: AnySchema, id: unknown): Query<unknown, unknown, never, string> {
  const schemaMeta = meta(schema);
  const key = schemaMeta.primaryKey;
  if (key.length === 0) {
    throw new QueryError(
      "query.getNoPrimaryKey",
      `repo.get(${schemaMeta.name}, id): ${schemaMeta.name} has no primary key, so it cannot be read by id.`,
      { params: { name: schemaMeta.name } },
    );
  }
  if (id === undefined || id === null) {
    throw new QueryError(
      "query.getMissingId",
      `repo.get(${schemaMeta.name}, ${String(id)}): the id is ${String(id)}.`,
    );
  }
  const query = rootQuery(schema);
  if (key.length === 1) {
    const field = key[0] as FieldMeta;
    checkKeyValue(schemaMeta, field, id);
    if (typeof id === "object" && isPlainObject(id)) {
      throw new QueryError(
        "query.getIdObject",
        `repo.get(${schemaMeta.name}, id): the primary key of ${schemaMeta.name} is the single field "${field.name}".`,
        { params: { schema: schemaMeta.name } },
      );
    }
    return query.where({ [field.name]: id } as never) as Query<unknown, unknown, never, string>;
  }
  const names = key.map((field) => field.name);
  const expected = `{ ${names.map((name) => `${name}: …`).join(", ")} }`;
  if (typeof id !== "object" || !isPlainObject(id)) {
    throw new QueryError(
      "query.getCompositeId",
      `repo.get(${schemaMeta.name}, id): ${schemaMeta.name} has a composite primary key, so the id is an object of its fields: ${expected}.`,
    );
  }
  const given = id as Readonly<Record<string, unknown>>;
  const clauses: Record<string, unknown> = {};
  for (const name of names) {
    const value = Object.hasOwn(given, name) ? given[name] : undefined;
    if (value === undefined || value === null) {
      throw new QueryError(
        "query.getIdField",
        `repo.get(${schemaMeta.name}, id): the id has no value for the key field "${name}" (it is ${String(value)}); the id is ${expected}.`,
      );
    }
    checkKeyValue(schemaMeta, schemaMeta.fieldsByName.get(name) as FieldMeta, value);
    clauses[name] = value;
  }
  for (const name of Object.keys(given)) {
    if (!names.includes(name)) {
      throw new QueryError(
        "query.getIdUnknownField",
        `repo.get(${schemaMeta.name}, id): "${name}" is not a field of the primary key of ${schemaMeta.name}; the id is ${expected}.`,
      );
    }
  }
  return query.where(clauses as never) as Query<unknown, unknown, never, string>;
}

/**
 * Refuses an array as the value of a key field whose type is not an array: the object
 * form of `where` would read it as a list (`IN`), and `get` would return whichever of
 * those rows matched instead of failing.
 */
function checkKeyValue(schemaMeta: SchemaMeta, field: FieldMeta, value: unknown): void {
  if (Array.isArray(value) && !comparedWhole(field)) {
    throw new QueryError(
      "query.getIdArray",
      `repo.get(${schemaMeta.name}, id): the key field "${field.name}" holds one value, but it was given an array.`,
      { params: { name: schemaMeta.name, name1: field.name } },
    );
  }
}

/** The query of `getBy(queryable, clauses)`. */
export function byClauses(input: QueryInput, clauses: unknown, method: string): QueryInput {
  if (input.query === undefined) {
    throw new QueryError(
      "query.readQueryWhere",
      `repo.${method}() adds its clauses with the query's where(); this query object has no where() method.`,
    );
  }
  if (typeof clauses !== "object" || clauses === null || !isPlainObject(clauses)) {
    throw new QueryError("query.getByValues", `repo.${method}() takes an object of field values.`, {
      params: { method },
    });
  }
  const query = input.query.where(clauses as never) as Query<unknown, unknown, never, string>;
  return { ast: query.ast, names: input.names, query };
}

/** `repo.stream`: decodes lazily, row by row; leaving the loop early closes the cursor. */
export async function* stream(
  core: ReadCore,
  input: QueryInput,
  named: Readonly<Record<string, unknown>> | undefined,
  options: StreamReadOptions | undefined,
): AsyncGenerator<unknown, void, undefined> {
  const ast = input.ast;
  const adapter = core.adapter;
  const plan = adapter.compile(ast, "all", schemaFor(core, options));
  const info = infoOf(plan);
  if (info.preloads) {
    throw new QueryError(
      "query.streamPreload",
      "repo.stream() cannot preload associations: the rows are yielded one at a time, before their associations could be loaded.",
    );
  }
  const values = bindParams(plan.slots, ast.params, named);
  const decoder = decoderFor(plan, adapter, core.codegen);
  const constants = constantsOf(ast);
  const batchSize = own(options, "batchSize") ?? DEFAULT_STREAM_BATCH_SIZE;
  const hub = core.hub;
  const call = hub.listening ? new Call(hub, "stream", sourceOf(ast), own(options, "context")) : undefined;
  const rows = core.executor.stream(plan.sql, values, executeOptions(plan, info, options, call, batchSize));
  if (call === undefined) {
    for await (const row of rows) yield decoder(row, constants);
    return;
  }
  let decodeMs = 0;
  let failure: unknown;
  try {
    for await (const row of rows) {
      const start = now();
      let value: unknown;
      try {
        value = decoder(row, constants);
      } finally {
        decodeMs += now() - start;
      }
      yield value;
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // The adapter reported the stream when it ended, just before this.
    hub.emit(call, decodeMs, failure);
  }
}

/** `repo.toSql`: the SQL and the parameters as they would be sent. */
export function toSql(
  core: ReadCore,
  input: QueryInput,
  named: Readonly<Record<string, unknown>> | undefined,
  options: ReadOptions | undefined,
): { readonly sql: string; readonly params: unknown[] } {
  const plan = core.adapter.compile(input.ast, "all", schemaFor(core, options));
  return { sql: plan.sql, params: bindParams(plan.slots, input.ast.params, named) };
}

/** `repo.explain`: the database's plan, as text or (format `"json"`) as the parsed structure. */
export async function explain(
  core: ReadCore,
  input: QueryInput,
  named: Readonly<Record<string, unknown>> | undefined,
  options: ExplainReadOptions | undefined,
): Promise<unknown> {
  const ast = input.ast;
  const format = own(options, "format");
  const analyze = own(options, "analyze");
  const explainOptions = {
    ...(analyze === undefined ? {} : { analyze }),
    ...(format === undefined ? {} : { format }),
  };
  const plan = core.adapter.compileExplain(ast, "all", schemaFor(core, options), explainOptions);
  const info = infoOf(plan);
  const values = bindParams(plan.slots, ast.params, named);
  return run(
    core,
    "explain",
    sourceOf(ast),
    plan,
    info,
    values,
    options,
    format === "json" ? explainJson : explainText,
  );
}

/** Whether a statement returned any row. */
const hasRows: Finish<boolean> = (result) => result.rows.length > 0;

/** The first cell of each row, as text, one line per row. */
const explainText: Finish<string> = (result) =>
  result.rows
    .map((row) => {
      const cell = Object.values(row)[0];
      return typeof cell === "string" ? cell : JSON.stringify(cell);
    })
    .join("\n");

/** The first cell of the first row, parsed when the driver gave it as text. */
const explainJson: Finish<unknown> = (result) => {
  const row = result.rows[0];
  const cell = row === undefined ? undefined : Object.values(row)[0];
  return typeof cell === "string" ? JSON.parse(cell) : cell;
};

/** The rows of a raw statement, as the driver gave them. */
const rawRows: Finish<RawRows> = (result) => ({ rows: result.rows, rowCount: result.rowCount });

/**
 * What `repo.raw` returns: the rows exactly as the driver gave them, and the row count it
 * reported (rows returned, or rows affected by a write).
 *
 * @example
 * ```ts
 * const { rows, rowCount }: RawRows = await repo.raw(fragment`select now() as now`);
 * ```
 */
export interface RawRows {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number;
}

/** Whether `value` is an expression made by the `fragment` tag. */
export function isFragment(value: unknown): value is AnyExpr & { readonly node: FragmentNode } {
  return isExpr(value) && value.node.kind === "fragment";
}

/** `repo.raw(fragment)`. */
export async function raw(
  core: ReadCore,
  statement: AnyExpr & { readonly node: FragmentNode },
  named: Readonly<Record<string, unknown>> | undefined,
  options: ReadOptions | undefined,
): Promise<RawRows> {
  const plan = core.adapter.compileFragment(statement.node);
  const info = infoOf(plan);
  const values = bindParams(plan.slots, statement.params, named);
  return run(core, "raw", undefined, plan, info, values, options, rawRows);
}

// ---------------------------------------------------------------------------
// reload
// ---------------------------------------------------------------------------

/**
 * `repo.reload`: a fresh copy of each row, read where it was read (its `RowMeta.schema`
 * is the source's database schema), `null` for a row that is gone; the result keeps the
 * order of the input. The associations a given row had loaded are loaded again on its
 * fresh copy (`reloadPreloads` in `preload.ts`); `timeoutMs` is one budget for every
 * statement of the call.
 *
 * The database matches the rows, not JavaScript: the given rows' keys are joined to the
 * table as a list that carries each key's position, and each row read back carries the
 * position of the key it matched. So a key is found exactly when the database's own
 * equality says so (a decimal whose scale changed, a custom type, bytes, arrays). The one
 * limit is what the given row holds: a key value the row could not hold exactly (a
 * timestamp with microseconds, read into a millisecond `Date`) no longer equals the
 * stored one, and that row comes back `null`.
 *
 * Rows of one schema and database schema are read together: with array columns and array
 * parameters in one statement (`unnest($1, $2) with ordinality`), otherwise in statements
 * of at most {@link RELOAD_CHUNK_ROWS} rows (a `values` list).
 *
 * @throws TypeError when an element is not a loaded row.
 * @throws QueryError when its schema has no primary key or a key field is `null`.
 * @throws NoResultsError when `strict` and a row is gone.
 */
export async function reload(
  core: ReadCore,
  rows: readonly unknown[],
  options: ReadOptions | undefined,
  strict: boolean,
): Promise<unknown[]> {
  interface Group {
    readonly schemaMeta: SchemaMeta;
    readonly databaseSchema: string | undefined;
    readonly indexes: number[];
  }
  const groups = new Map<SchemaMeta, Map<string | undefined, Group>>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const schema = typeof row === "object" && row !== null && isRow(row) ? schemaOfRow(row) : undefined;
    if (schema === undefined) {
      throw new TypeError(
        `repo.reload() takes rows read from the database (or an array of them); ${rows.length === 1 ? "it was given" : `element ${i} is`} ${row === null ? "null" : typeof row === "object" ? "a plain object" : typeof row}.`,
      );
    }
    const schemaMeta = meta(schema);
    if (schemaMeta.primaryKey.length === 0) {
      throw new QueryError(
        "query.reloadNoPrimaryKey",
        `repo.reload(): ${schemaMeta.name} has no primary key, so its rows cannot be found again.`,
      );
    }
    const databaseSchema = (row as { readonly [ROW]: { readonly schema: string | undefined } })[ROW].schema;
    let bySchema = groups.get(schemaMeta);
    if (bySchema === undefined) {
      bySchema = new Map();
      groups.set(schemaMeta, bySchema);
    }
    let group = bySchema.get(databaseSchema);
    if (group === undefined) {
      group = { schemaMeta, databaseSchema, indexes: [] };
      bySchema.set(databaseSchema, group);
    }
    group.indexes.push(i);
  }
  const deadline = deadlineOf(options);
  const out = new Array<unknown>(rows.length).fill(null);
  for (const bySchema of groups.values()) {
    for (const group of bySchema.values()) {
      const size = reloadChunkSize(core, group.schemaMeta.primaryKey);
      for (let from = 0; from < group.indexes.length; from += size) {
        const indexes = group.indexes.slice(from, from + size);
        const given = indexes.map((index) => rows[index] as Readonly<Record<string, unknown>>);
        const ast = reloadAst(core, group.schemaMeta, group.databaseSchema, given);
        const found = (await load(
          core,
          "reload",
          ast,
          undefined,
          withinBudget(options, deadline),
        )) as readonly Reloaded[];
        const matched = new Array<boolean>(given.length).fill(false);
        for (const each of found) {
          // Positions are 1-based, as `with ordinality` numbers them.
          out[indexes[each.position - 1] as number] = each.row;
          matched[each.position - 1] = true;
        }
        if (strict && matched.includes(false)) throw new NoResultsError({ query: render(ast) });
      }
    }
  }
  // The associations the given rows had loaded are loaded again on the fresh rows.
  return reloadPreloads(core, rows, out, options, deadline);
}

/** One row `reload` read back: the row, and the 1-based position of the given row it matched. */
interface Reloaded {
  readonly row: unknown;
  readonly position: number;
}

/** The most rows a `reload` statement lists in a `values` list. */
export const RELOAD_CHUNK_ROWS = 1_000;

/**
 * Whether `reload` passes each key field as one array parameter
 * (`unnest($1, $2) with ordinality`), so that one statement of fixed size reads any number
 * of rows: on a dialect with array columns and array parameters, unless a key field holds
 * arrays or JSON (`unnest` would flatten a two-dimensional array).
 */
function keysAsArrays(core: ReadCore, key: readonly FieldMeta[]): boolean {
  const capabilities = core.adapter.capabilities;
  return capabilities.arrayParams && capabilities.arrays && !key.some(comparedWhole);
}

/** Whether a key field holds a value that is compared whole: an array, JSON. */
function comparedWhole(field: FieldMeta): boolean {
  return WHOLE_KINDS.has(field.type.db.kind);
}

const WHOLE_KINDS: ReadonlySet<string> = /* @__PURE__ */ new Set(["array", "json", "jsonb"]);

/**
 * How many rows one `reload` statement reads: all of them when the keys go as arrays;
 * otherwise at most {@link RELOAD_CHUNK_ROWS}, and never more parameters than
 * `capabilities.maxParams` allows (one per key field and one for the position, per row).
 */
function reloadChunkSize(core: ReadCore, key: readonly FieldMeta[]): number {
  if (keysAsArrays(core, key)) return Number.POSITIVE_INFINITY;
  const perRow = key.length + 1;
  return Math.max(1, Math.min(RELOAD_CHUNK_ROWS, Math.floor(core.adapter.capabilities.maxParams / perRow)));
}

/**
 * The alias of the list of given keys in a `reload` statement, and its position column.
 * Aliases that start with `$` are reserved for the library (the builder refuses them), so
 * this one never meets a table's alias; its columns are always qualified by it.
 */
const KEYS = "$keys";
const POSITION = "position";

/** The type the position is read with: 64-bit, read as a number. */
const POSITION_TYPE = /* @__PURE__ */ bigintType({ mode: "number" });

/**
 * The statement of `reload`:
 *
 * ```sql
 * select <the row's columns>, "$keys"."position"
 * from "<schema>"."<table>" as "t"
 * join unnest($1, $2) with ordinality as "$keys" ("k0", "k1", "position")   -- or (values …)
 *   on "t"."<key 0>" = "$keys"."k0" and "t"."<key 1>" = "$keys"."k1"
 * ```
 *
 * The table source carries the rows' database schema (the strongest position). Every key
 * value is a bound parameter, typed by its field (arrays of it for `unnest`), so the
 * database casts and compares it as it does the column.
 */
function reloadAst(
  core: ReadCore,
  schemaMeta: SchemaMeta,
  databaseSchema: string | undefined,
  rows: readonly Readonly<Record<string, unknown>>[],
): QueryAst {
  const key = schemaMeta.primaryKey;
  for (const row of rows) {
    for (const field of key) {
      const value = row[field.name];
      if (value === null || value === undefined) {
        throw new QueryError(
          "query.reloadNoKeyValue",
          `repo.reload(): a row of ${schemaMeta.name} has no value for its key field "${field.name}", so it cannot be found again.`,
        );
      }
    }
  }
  const alias = rootAlias(schemaMeta);
  const columns = key.map((_, i) => `k${i}`);
  columns.push(POSITION);
  const keys = keysAsArrays(core, key) ? unnestSource(key, rows, columns) : valuesSource(key, rows, columns);
  const matches: ExprNode[] = key.map((field, i) =>
    binaryNode("eq", columnNode(alias, field.name, field.column), columnNode(KEYS, `k${i}`, `k${i}`)),
  );
  const on = matches.length === 1 ? (matches[0] as ExprNode) : naryNode("and", matches);
  const table: TableSourceNode = {
    kind: "table",
    source: schemaMeta.source as string,
    meta: schemaMeta,
    schema: databaseSchema,
    alias,
  };
  const select = selectNode(
    {
      kind: "object",
      keys: ["row", POSITION],
      values: [
        { kind: "binding", binding: alias, meta: schemaMeta },
        { kind: "expr", expr: columnNode(KEYS, POSITION, POSITION), type: POSITION_TYPE },
      ],
    },
    NONE,
  );
  return finalize({
    kind: "query",
    from: table,
    joins: [{ kind: "join", type: "inner", source: keys, on }],
    wheres: NONE,
    select,
    distinct: undefined,
    groupBys: NONE,
    havings: NONE,
    orderBys: NONE,
    limit: undefined,
    offset: undefined,
    lock: undefined,
    combinations: NONE,
    ctes: NONE,
    windows: NONE,
    preloads: NONE,
    updates: NONE,
    schema: undefined,
    hints: NONE,
    params: NONE,
    listLengths: NONE,
    shape: 0,
  });
}

/**
 * `unnest($1, $2, …) with ordinality as "$keys" ("k0", "k1", …, "position")`: each key field's
 * values as one typed array parameter; the SQL text is the constant strings below.
 */
function unnestSource(
  key: readonly FieldMeta[],
  rows: readonly Readonly<Record<string, unknown>>[],
  columns: readonly string[],
): SourceNode {
  const strings = ["unnest(", ...key.slice(1).map(() => ", "), ") with ordinality"];
  const args: ExprNode[] = key.map((field) =>
    paramNode(
      rows.map((row) => row[field.name]),
      arrayType(field.type),
      field.redact,
    ),
  );
  return { kind: "fragmentSource", fragment: fragmentNode(strings, args), columns, alias: KEYS };
}

/** `(values ($1, $2, $3), …) as "$keys" ("k0", "k1", "position")`: one row per given row, every cell bound. */
function valuesSource(
  key: readonly FieldMeta[],
  rows: readonly Readonly<Record<string, unknown>>[],
  columns: readonly string[],
): SourceNode {
  const cells = rows.map((row, i) => {
    const cellsOfRow: ExprNode[] = key.map((field) => paramNode(row[field.name], field.type, field.redact));
    cellsOfRow.push(paramNode(i + 1, POSITION_TYPE, false));
    return cellsOfRow;
  });
  return { kind: "values", columns, rows: cells, alias: KEYS };
}
