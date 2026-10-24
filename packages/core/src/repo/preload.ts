/**
 * Preloading: loading the associations of rows without one query per row.
 *
 * ## Separate-query preloads
 *
 * For each association at each level, the distinct, non-null keys of the parents are
 * collected and **one** statement reads the children of all of them
 * (`WHERE fk = ANY($1)`, or `IN` where the dialect expands lists; a composite key is
 * matched as a row against a list of key rows). Children are grouped by key and attached
 * to their parents; nested preloads then run once over all the children of the level. So
 * a preload three levels deep is three statements after the main one, whatever the
 * number of parents. Very large key sets are split into statements of at most
 * {@link preloadLimits}`.chunkKeys` keys (10,000).
 *
 * The statement of a level is the association's query (the callback's, or the plain
 * target) with the route of `query/assoc.ts` added: the key filter, the association's
 * `where`, the join table of a many-to-many and the chain of a has-through (whose owner
 * key is then selected beside each row). Its order is the callback's `orderBy`, else the
 * association's. A callback `limit` / `offset` applies per parent: the rows are ranked
 * with `row_number() over (partition by <owner key> order by …)` in a subquery joined
 * back on the target's primary key, and filtered on the rank.
 *
 * ## Join preloads
 *
 * The decoder builds each result row's parent with that row's child in place; here the
 * parents with equal primary keys are merged (first seen wins, in first-seen order), and
 * their children concatenated and de-duplicated by the child's primary key, at every
 * level of nesting.
 *
 * ## Identity
 *
 * Every attached value is its own object: a target row reached by several parents (the
 * author of many posts) is fetched once and copied for every parent after the first,
 * nested rows and arrays included.
 *
 * @module
 */
import { bindParams } from "../compiler/bind.js";
import type {
  CompiledQuery,
  ExecuteOptions,
  OutputPlan,
  ParamSlot,
  RawResult,
} from "../contracts/adapter.js";
import type {
  BoolNode,
  ExprNode,
  JoinNode,
  OrderNode,
  PreloadNode,
  QueryAst,
  SelectShape,
} from "../contracts/query.js";
import type { AnySchema, FieldMeta, SchemaMeta } from "../contracts/schema.js";
import { ROW } from "../contracts/schema.js";
import { QueryError } from "../errors.js";
import { own } from "../internal/own.js";
import { isPlainObject } from "../internal/plain-object.js";
import { type AssocRoute, checkRows, KeyIndex, rebuild, routeOf, schemaOfRow } from "../query/assoc.js";
import {
  aggregateNode,
  binaryNode,
  columnNode,
  fragmentNode,
  listNode,
  naryNode,
  orderNode,
  paramNode,
  subqueryNode,
  tupleNode,
  windowNode,
} from "../query/ast.js";
import { from } from "../query/builder.js";
import { selectNode } from "../query/select.js";
import { isRow } from "../schema/guards.js";
import { meta } from "../schema/schema.js";
import { arrayType } from "../types/index.js";
import { decodeRows, decoderFor } from "./hydrate.js";
import { READ_OPTION_KEYS, type ReadOptions } from "./options.js";
import { type AfterDecodeContext, Call, type ReadCore } from "./read.js";
import { overBudget } from "./write.js";

const now = (): number => performance.now();
const NONE: readonly never[] = /* @__PURE__ */ Object.freeze([]);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * The options of `repo.preload`: those of every read, and `force`.
 *
 * @example
 * ```ts
 * const options: PreloadOptions = { force: true, maxConcurrency: 2 };
 * ```
 */
export interface PreloadOptions extends Omit<ReadOptions, "schema"> {
  /** Loads the associations again even where a row has them loaded already. Default `false`. */
  readonly force?: boolean | undefined;
}

/**
 * The option keys of `repo.preload`: those of a read, without `schema` (each row says
 * where it was read), and `force`.
 *
 * @example
 * ```ts
 * checkReadOptions("preload", options, PRELOAD_OPTION_KEYS);
 * ```
 */
export const PRELOAD_OPTION_KEYS: readonly string[] = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ ["force"].concat(/* @__PURE__ */ READ_OPTION_KEYS.filter((key) => key !== "schema")),
);

/**
 * Internal limits of preloading. Not public API; tests lower `chunkKeys` to exercise the
 * split without tens of thousands of rows.
 *
 * @example
 * ```ts
 * preloadLimits.chunkKeys; // 10_000
 * ```
 */
export const preloadLimits = {
  /** The most keys one preload statement is sent. */
  chunkKeys: 10_000,
};

// ---------------------------------------------------------------------------
// The run of one call
// ---------------------------------------------------------------------------

/** What every statement of one call's preloads shares. */
interface Run {
  readonly core: ReadCore;
  readonly named: Readonly<Record<string, unknown>> | undefined;
  /** The call's options as given. */
  readonly options: ReadOptions | undefined;
  /** The call's deadline (`performance.now()` based) when it has a `timeoutMs`. */
  readonly deadline: number | undefined;
  /** How many statements may run at once: 1 unless `maxConcurrency` says more and the repo is not on one connection. */
  readonly concurrency: number;
  /**
   * The call's own database schema: the root query's `.schema(…)`, else the call's
   * `schema` option, else the repo's default. Children of parents whose schema class
   * declares a database schema are read with it (see {@link loadSeparate}).
   */
  readonly schema: string | undefined;
  /** The statements running now, and those waiting for a turn. */
  active: number;
  readonly waiting: (() => void)[];
  /** The first failure of a statement of the run: no statement starts after it. */
  failure: { readonly error: unknown } | undefined;
}

/**
 * The deadline of a call with a `timeoutMs`: every statement of the call (the main one,
 * each preload, each `reload` chunk) gets what is left of one budget.
 *
 * @example
 * ```ts
 * const deadline = deadlineOf({ timeoutMs: 500 });
 * ```
 */
export function deadlineOf(options: ReadOptions | undefined): number | undefined {
  const timeoutMs = own(options, "timeoutMs");
  return typeof timeoutMs === "number" ? now() + timeoutMs : undefined;
}

/**
 * The options of one statement of a call with a deadline: the call's, with `timeoutMs`
 * what is left of the budget.
 *
 * @example
 * ```ts
 * const statementOptions = withinBudget(options, deadline);
 * ```
 */
export function withinBudget(
  options: ReadOptions | undefined,
  deadline: number | undefined,
): ReadOptions | undefined {
  // A deadline comes from the options' timeoutMs, so there are options when there is one.
  if (deadline === undefined) return options;
  return { ...(options as ReadOptions), timeoutMs: Math.max(0, deadline - now()) };
}

function concurrencyOf(core: ReadCore, options: ReadOptions | undefined): number {
  const given = own(options, "maxConcurrency");
  if (given === undefined) return 1;
  if (typeof given !== "number" || !Number.isInteger(given) || given < 1) {
    throw new TypeError(
      `The maxConcurrency option must be a whole number of at least 1, but it is ${String(given)}.`,
    );
  }
  // On one connection (a transaction) statements cannot overlap.
  return core.pooled ? given : 1;
}

function newRun(
  core: ReadCore,
  named: Readonly<Record<string, unknown>> | undefined,
  options: ReadOptions | undefined,
  deadline: number | undefined,
  schema: string | undefined,
): Run {
  return {
    core,
    named,
    options,
    deadline,
    concurrency: concurrencyOf(core, options),
    schema,
    active: 0,
    waiting: [],
    failure: undefined,
  };
}

/**
 * Waits for a statement's turn. After a statement of the run failed, no other one starts:
 * a waiting or later statement rejects with that failure (the call has already rejected
 * with it).
 */
async function turn(run: Run): Promise<void> {
  stopIfFailed(run);
  if (run.active < run.concurrency) {
    run.active++;
    return;
  }
  await new Promise<void>((resolve) => run.waiting.push(resolve));
  stopIfFailed(run);
  run.active++;
}

function stopIfFailed(run: Run): void {
  const failure = run.failure;
  if (failure !== undefined) throw failure.error;
}

function done(run: Run): void {
  run.active--;
  run.waiting.shift()?.();
}

/** Records the run's first failure and wakes every waiting statement, so that none of them starts. */
function fail(run: Run, error: unknown): void {
  if (run.failure === undefined) run.failure = { error };
  for (const wake of run.waiting.splice(0)) wake();
}

/** Runs sibling tasks one at a time, or concurrently when the run allows it (statements are gated by {@link turn}). */
async function runTasks(run: Run, tasks: readonly (() => Promise<void>)[]): Promise<void> {
  if (run.concurrency === 1 || tasks.length < 2) {
    for (const task of tasks) await task();
    return;
  }
  await Promise.all(tasks.map((task) => task()));
}

// ---------------------------------------------------------------------------
// Running a statement
// ---------------------------------------------------------------------------

/** The execution options of a preload statement, in the shape every read uses. */
interface CallOptions {
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number | undefined;
  readonly slots: readonly ParamSlot[];
  readonly context: Call | undefined;
  readonly batchSize: undefined;
}

const namesBySlots = /* @__PURE__ */ new WeakMap<readonly ParamSlot[], readonly string[]>();

/** The named values a plan uses, out of all the call was given. */
function usedNames(
  slots: readonly ParamSlot[],
  named: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (named === undefined) return undefined;
  let names = namesBySlots.get(slots);
  if (names === undefined) {
    const found: string[] = [];
    for (const slot of slots) if (slot.kind === "named" && !found.includes(slot.name)) found.push(slot.name);
    names = found;
    namesBySlots.set(slots, names);
  }
  if (names.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const name of names) out[name] = named[name];
  return out;
}

/** Runs one preload statement, reports it as `"preload"` on `source`, and returns its decoded rows. */
async function execute(
  run: Run,
  ast: QueryAst,
  schema: string | undefined,
  source: string,
): Promise<unknown[]> {
  const core = run.core;
  const adapter = core.adapter;
  const plan: CompiledQuery = adapter.compile(ast, "all", schema);
  const values = bindParams(plan.slots, ast.params, usedNames(plan.slots, run.named));
  const decoder = decoderFor(plan, adapter, core.codegen);
  const constants = ast.select === undefined ? NONE : ast.select.constants;
  const hub = core.hub;
  await turn(run);
  let result: RawResult;
  const call = hub.listening ? new Call(hub, "preload", source, own(run.options, "context")) : undefined;
  try {
    const shaped: CallOptions = {
      signal: own(run.options, "signal"),
      timeoutMs: run.deadline === undefined ? undefined : Math.max(0, run.deadline - now()),
      slots: plan.slots,
      context: call,
      batchSize: undefined,
    };
    result = await core.executor.execute(plan.sql, values, shaped as ExecuteOptions);
  } catch (error) {
    if (call !== undefined) hub.emit(call, 0, undefined);
    const thrown = run.deadline === undefined ? error : overBudget(error, run.options);
    fail(run, thrown);
    throw thrown;
  } finally {
    done(run);
  }
  if (call === undefined) {
    try {
      return decodeRows(result.rows, decoder, constants);
    } catch (error) {
      fail(run, error);
      throw error;
    }
  }
  const start = now();
  let rows: unknown[];
  try {
    rows = decodeRows(result.rows, decoder, constants);
  } catch (error) {
    hub.emit(call, now() - start, error);
    fail(run, error);
    throw error;
  }
  hub.emit(call, now() - start, undefined);
  return rows;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * The stage after decoding of a query with preloads (step 12's `afterDecode`): merges the
 * parents of join preloads, then runs the separate preloads. `rows` are the decoded root
 * rows; they are completed in place and returned.
 *
 * @example
 * ```ts
 * const users = await runPreloads(rows, plan, { core, ast, named, options, deadline });
 * ```
 *
 * @throws QueryError when a join preload's rows cannot be merged (the parent schema has
 * no primary key) or a preload's statement cannot be built.
 */
export async function runPreloads(
  rows: unknown[],
  plan: CompiledQuery,
  context: AfterDecodeContext,
): Promise<unknown[]> {
  const leaf = plan.output as Extract<OutputPlan, { readonly kind: "row" }>;
  const nodes = context.ast.preloads;
  const core = context.core;
  const run = newRun(
    core,
    context.named,
    context.options,
    context.deadline,
    context.ast.schema ?? own(context.options, "schema") ?? core.schema,
  );
  const merged = hasJoin(nodes) ? dedupe(rows as object[], leaf.meta, nodes, true) : (rows as object[]);
  await loadNodes(run, merged, leaf.meta, nodes);
  const record: PreloadRecord = { nodes, named: context.named, schema: run.schema };
  for (const row of merged) records.set(row, record);
  return merged;
}

/**
 * What a row was preloaded with: the preloads (callbacks included) and the named values
 * of the call, so that `reload` can load the same again.
 */
interface PreloadRecord {
  readonly nodes: readonly PreloadNode[];
  readonly named: Readonly<Record<string, unknown>> | undefined;
  /** The call's own database schema ({@link Run.schema}). */
  readonly schema: string | undefined;
}

/**
 * Gives `to`, a row a write built from `from` with `from`'s loaded associations kept, the
 * preload record of `from`, so that a reload of it loads the same again.
 *
 * @example
 * ```ts
 * keepPreloads(previousRow, updatedRow);
 * ```
 */
export function keepPreloads(from: object, to: object): void {
  const record = records.get(from);
  if (record !== undefined) records.set(to, record);
}

/**
 * The preloads each loaded row was loaded with: a root row of a query or of
 * `repo.preload`, and every whole row a preload loaded with preloads below it. One shared
 * record per call and level; one entry per row.
 */
const records = /* @__PURE__ */ new WeakMap<object, PreloadRecord>();

const checked = /* @__PURE__ */ new WeakSet<readonly PreloadNode[]>();

/**
 * Builds (and caches) the statement parts of every separate preload of a query, so that
 * one that cannot run (a per-parent limit on a has-through chain whose rows can repeat,
 * for one) throws before any statement is sent. Called by `load` once per AST.
 *
 * @example
 * ```ts
 * checkPreloads(meta(User), query.ast.preloads);
 * ```
 *
 * @throws QueryError when a preload cannot be loaded.
 */
export function checkPreloads(schemaMeta: SchemaMeta, nodes: readonly PreloadNode[]): void {
  if (checked.has(nodes)) return;
  for (const node of nodes) {
    const route = routeOf(schemaMeta, node.assoc);
    if (node.from === undefined) levelOf(route, node);
    checkPreloads(route.targetMeta, node.nested);
  }
  checked.add(nodes);
}

/**
 * Refuses a limit or an offset (`repo.first` adds one) on a query with a to-many join
 * preload: it would count the joined rows, not the parents, and cut a parent's children
 * short while its type says they are loaded.
 *
 * @example
 * ```ts
 * checkJoinLimit(query.ast, meta(User), "first");
 * ```
 *
 * @throws QueryError naming the association, with the separate-query form to use instead.
 */
export function checkJoinLimit(ast: QueryAst, schemaMeta: SchemaMeta, operation: string): void {
  if (ast.limit === undefined && ast.offset === undefined) return;
  const many = toManyJoin(schemaMeta, ast.preloads);
  if (many === undefined) return;
  const what = operation === "first" ? "repo.first() (which adds a limit)" : "a limit or an offset";
  throw new QueryError(
    "query.joinPreloadLimit",
    `This query preloads "${many}" from a join, and ${what} would count the joined rows, not the parents, cutting their "${many}" short.`,
    { params: { many } },
  );
}

/** The name of a to-many association filled from a join, at any depth of join preloads. */
function toManyJoin(schemaMeta: SchemaMeta, nodes: readonly PreloadNode[]): string | undefined {
  for (const node of nodes) {
    if (node.from === undefined) continue;
    const route = routeOf(schemaMeta, node.assoc);
    if (route.cardinality === "many") return node.assoc;
    const below = toManyJoin(route.targetMeta, node.nested);
    if (below !== undefined) return below;
  }
  return undefined;
}

function hasJoin(nodes: readonly PreloadNode[]): boolean {
  for (const node of nodes) if (node.from !== undefined) return true;
  return false;
}

/**
 * `repo.preload(schema, rows, …)`: new rows with the associations loaded. `input` is one
 * row, an array or `null`; `nodes` the preloads, as a query's `preload(…)` built them.
 *
 * @example
 * ```ts
 * const loaded = await preloadRows(core, User, users, nodes, named, options);
 * ```
 *
 * @throws TypeError when an element is not a row.
 * @throws QueryError when an element is a row of another schema.
 */
export async function preloadRows(
  core: ReadCore,
  schema: AnySchema,
  input: unknown,
  nodes: readonly PreloadNode[],
  named: Readonly<Record<string, unknown>> | undefined,
  options: PreloadOptions | undefined,
): Promise<unknown> {
  if (input === null || input === undefined) return input;
  const single = !Array.isArray(input);
  const rows = checkRows("repo.preload()", schema, single ? [input] : (input as readonly unknown[]));
  const run = newRun(core, named, options, deadlineOf(options), core.schema);
  const out = await preloadInto(run, rows, meta(schema), nodes, own(options, "force") === true);
  return single ? out[0] : out;
}

/**
 * The preloads of `repo.preload`: written as a query's `preload(…)` is, on `from(schema, …)`,
 * which checks the spec (and runs a callback once).
 *
 * @example
 * ```ts
 * const { nodes, names } = preloadNodesOf(User, "posts", undefined);
 * ```
 */
export function preloadNodesOf(
  schema: AnySchema,
  spec: unknown,
  fn: unknown,
): { readonly nodes: readonly PreloadNode[]; readonly names: readonly string[] } {
  const base = from(schema, "t") as unknown as {
    preload(spec: unknown, fn?: unknown): { readonly ast: QueryAst; namedParams(): readonly string[] };
  };
  const query = fn === undefined ? base.preload(spec) : base.preload(spec, fn);
  return { nodes: query.ast.preloads, names: query.namedParams() };
}

/**
 * The second half of `repo.reload`: loads again, on each fresh row, what its given row
 * was loaded with. A row loaded by a query, by `repo.preload` or by a preload carries a
 * record of its preloads, callbacks included (and the call's named values), and gets
 * exactly those again, with the call's database schema; a join preload is loaded by a
 * separate query. A row a write returned keeps the record of the row it was built from.
 * A row without a record (associations put on it by hand) is reloaded with what it shows
 * loaded, by name, to the depth its loaded rows show.
 *
 * @example
 * ```ts
 * const fresh = await reloadPreloads(core, given, found, options, deadline);
 * ```
 */
export async function reloadPreloads(
  core: ReadCore,
  given: readonly unknown[],
  fresh: unknown[],
  options: ReadOptions | undefined,
  deadline: number | undefined,
): Promise<unknown[]> {
  // Rows of one schema reloaded with one record (or, without one, by what they show).
  interface Group {
    readonly schemaMeta: SchemaMeta;
    readonly record: PreloadRecord | undefined;
    readonly indexes: number[];
  }
  const groups = new Map<SchemaMeta, Map<PreloadRecord | undefined, Group>>();
  for (let i = 0; i < given.length; i++) {
    const row = given[i] as object;
    if (fresh[i] === null) continue;
    const schemaMeta = schemaMetaOf(row);
    const record = records.get(row);
    if (record === undefined && loadedNames(row, schemaMeta).length === 0) continue;
    let byRecord = groups.get(schemaMeta);
    if (byRecord === undefined) {
      byRecord = new Map();
      groups.set(schemaMeta, byRecord);
    }
    let group = byRecord.get(record);
    if (group === undefined) {
      group = { schemaMeta, record, indexes: [] };
      byRecord.set(record, group);
    }
    group.indexes.push(i);
  }
  for (const byRecord of groups.values()) {
    for (const group of byRecord.values()) {
      const nodes =
        group.record === undefined
          ? inferNodes(
              group.schemaMeta,
              group.indexes.map((i) => given[i] as object),
            )
          : separately(group.record.nodes);
      const run = newRun(
        core,
        group.record?.named,
        options,
        deadline,
        own(options, "schema") ?? group.record?.schema ?? core.schema,
      );
      const rebuilt = await preloadInto(
        run,
        group.indexes.map((i) => fresh[i] as object),
        group.schemaMeta,
        nodes,
        true,
      );
      for (let j = 0; j < group.indexes.length; j++) fresh[group.indexes[j] as number] = rebuilt[j];
    }
  }
  return fresh;
}

/** `nodes` with every join preload turned into a separate one (a reload has no join to fill it from). */
function separately(nodes: readonly PreloadNode[]): readonly PreloadNode[] {
  if (!nodes.some((node) => node.from !== undefined || node.nested.length > 0)) return nodes;
  return nodes.map((node) =>
    node.from === undefined && node.nested.length === 0
      ? node
      : {
          kind: "preload",
          assoc: node.assoc,
          from: undefined,
          query: node.query,
          nested: separately(node.nested),
        },
  );
}

/**
 * The preloads of a row that had `base` loaded and is now given `added`: an association
 * in both keeps the earlier one's query (it is kept loaded) with both nested preloads,
 * unless `replace` (a forced load), which takes the new one.
 */
function mergeNodes(
  base: readonly PreloadNode[],
  added: readonly PreloadNode[],
  replace: boolean,
): readonly PreloadNode[] {
  if (base.length === 0) return added;
  const out = base.slice();
  for (const node of added) {
    const at = out.findIndex((each) => each.assoc === node.assoc);
    if (at === -1) out.push(node);
    else if (replace) out[at] = node;
    else {
      const old = out[at] as PreloadNode;
      out[at] = {
        kind: "preload",
        assoc: old.assoc,
        from: old.from,
        query: old.query,
        nested: mergeNodes(old.nested, node.nested, false),
      };
    }
  }
  return out;
}

function schemaMetaOf(row: object): SchemaMeta {
  return meta(schemaOfRow(row) as AnySchema);
}

/** The associations loaded on `row`, in the order its properties hold them. */
function loadedNames(row: object, schemaMeta: SchemaMeta): string[] {
  const assocs = schemaMeta.assocs();
  const names: string[] = [];
  for (const key of Object.keys(row)) if (assocs.has(key)) names.push(key);
  return names;
}

/** The preloads that `rows` show loaded, to the depth their loaded rows show. */
function inferNodes(schemaMeta: SchemaMeta, rows: readonly object[]): PreloadNode[] {
  const assocs = schemaMeta.assocs();
  const nodes: PreloadNode[] = [];
  for (const name of assocs.keys()) {
    const children: object[] = [];
    let present = false;
    for (const row of rows) {
      if (!Object.hasOwn(row, name)) continue;
      present = true;
      for (const child of valuesOf((row as Record<string, unknown>)[name]))
        if (isRow(child)) children.push(child);
    }
    if (!present) continue;
    const target = meta((assocs.get(name) as { target(): AnySchema }).target());
    const nested = children.length === 0 ? [] : inferNodes(target, children);
    nodes.push({ kind: "preload", assoc: name, from: undefined, query: undefined, nested });
  }
  return nodes;
}

/** The elements of a loaded value: an array's, a single row, or none for `null`. */
function valuesOf(value: unknown): readonly object[] {
  if (Array.isArray(value)) return value as object[];
  return value === null || value === undefined ? NONE : [value as object];
}

// ---------------------------------------------------------------------------
// Loading levels
// ---------------------------------------------------------------------------

/** Loads `nodes` onto `parents`, rows of `schemaMeta` that already have a property for each. */
async function loadNodes(
  run: Run,
  parents: readonly object[],
  schemaMeta: SchemaMeta,
  nodes: readonly PreloadNode[],
): Promise<void> {
  if (parents.length === 0 || nodes.length === 0) return;
  const tasks: (() => Promise<void>)[] = [];
  for (const node of nodes) {
    if (node.from !== undefined) {
      // Filled from a join: its rows are in place; load what is nested below them.
      if (node.nested.length === 0) continue;
      const route = routeOf(schemaMeta, node.assoc);
      tasks.push(() => loadNodes(run, childrenOf(parents, node.assoc), route.targetMeta, node.nested));
    } else {
      tasks.push(() => loadSeparate(run, parents, schemaMeta, node));
    }
  }
  await runTasks(run, tasks);
}

function childrenOf(parents: readonly object[], assoc: string): object[] {
  const out: object[] = [];
  for (const parent of parents) {
    for (const child of valuesOf((parent as Record<string, unknown>)[assoc])) out.push(child);
  }
  return out;
}

/**
 * `rows` as new rows of `schemaMeta` with a property for every association they have
 * loaded and for every one of `nodes`, in the schema's declaration order (one shape per
 * set of associations). `rows` are not changed.
 */
function withSlots(
  rows: readonly object[],
  schemaMeta: SchemaMeta,
  nodes: readonly PreloadNode[],
  force: boolean,
): object[] {
  const assocs = schemaMeta.assocs();
  const wanted = new Set(nodes.map((node) => node.assoc));
  const present = new Set<string>();
  for (const row of rows) for (const name of loadedNames(row, schemaMeta)) present.add(name);
  const names = [...assocs.keys()].filter((name) => wanted.has(name) || present.has(name));
  const many = names.map((name) => routeOf(schemaMeta, name).cardinality === "many");
  const factory = schemaMeta.createWith(names);
  const persisted = schemaMeta.persisted;
  const virtual = schemaMeta.fields.filter((field) => field.virtual);
  return rows.map((row) => {
    const source = row as Record<string, unknown>;
    const values = new Array<unknown>(persisted.length);
    for (let i = 0; i < persisted.length; i++) values[i] = source[(persisted[i] as FieldMeta).name];
    const loaded = new Array<unknown>(names.length);
    for (let i = 0; i < names.length; i++) {
      const name = names[i] as string;
      const keep = Object.hasOwn(row, name) && !(force && wanted.has(name));
      loaded[i] = keep ? source[name] : many[i] ? [] : null;
    }
    const out = factory(values, loaded, (row as { readonly [ROW]: never })[ROW]) as Record<string, unknown>;
    for (const field of virtual) out[field.name] = source[field.name];
    return out;
  });
}

/** `repo.preload` on rows of `schemaMeta`: new rows, with `nodes` loaded. */
async function preloadInto(
  run: Run,
  rows: readonly object[],
  schemaMeta: SchemaMeta,
  nodes: readonly PreloadNode[],
  force: boolean,
): Promise<object[]> {
  const out = withSlots(rows, schemaMeta, nodes, force);
  // Each new row's record: what its given row had, with `nodes` added.
  const merged = new Map<PreloadRecord, PreloadRecord>();
  for (let i = 0; i < rows.length; i++) {
    const before = records.get(rows[i] as object);
    let record: PreloadRecord | undefined = before === undefined ? undefined : merged.get(before);
    if (record === undefined) {
      record = {
        nodes: mergeNodes(
          before === undefined ? inferNodes(schemaMeta, [rows[i] as object]) : before.nodes,
          nodes,
          force,
        ),
        named: before?.named ?? run.named,
        // What this call loads was read with its schema; a reload reads with the same.
        schema: run.schema,
      };
      if (before !== undefined) merged.set(before, record);
    }
    records.set(out[i] as object, record);
  }
  const tasks: (() => Promise<void>)[] = [];
  for (const node of nodes) {
    const missing: object[] = [];
    const kept: object[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (!force && Object.hasOwn(rows[i] as object, node.assoc)) kept.push(out[i] as object);
      else missing.push(out[i] as object);
    }
    if (missing.length > 0) tasks.push(() => loadSeparate(run, missing, schemaMeta, node));
    if (kept.length > 0 && node.nested.length > 0) {
      tasks.push(() => nestInto(run, kept, schemaMeta, node));
    }
  }
  await runTasks(run, tasks);
  return out;
}

/** Applies `node.nested` to children already loaded on `parents` (copies of the given rows). */
async function nestInto(
  run: Run,
  parents: readonly object[],
  schemaMeta: SchemaMeta,
  node: PreloadNode,
): Promise<void> {
  const route = routeOf(schemaMeta, node.assoc);
  const children = childrenOf(parents, node.assoc);
  for (const child of children) {
    if (!isRow(child)) {
      throw new QueryError(
        "query.preloadBelowSelected",
        `repo.preload(): "${node.assoc}" of ${schemaMeta.name} is loaded as selected values, not rows, so nothing can be preloaded below it.`,
      );
    }
  }
  const rebuilt = await preloadInto(run, children, route.targetMeta, node.nested, false);
  const replace = new Map<object, object>();
  for (let i = 0; i < children.length; i++) replace.set(children[i] as object, rebuilt[i] as object);
  for (const parent of parents) {
    const source = parent as Record<string, unknown>;
    const value = source[node.assoc];
    source[node.assoc] = Array.isArray(value)
      ? value.map((child: object) => replace.get(child))
      : value === null
        ? null
        : replace.get(value as object);
  }
}

/** Loads one separate-query preload onto `parents`: one statement per key chunk and database schema. */
async function loadSeparate(
  run: Run,
  parents: readonly object[],
  schemaMeta: SchemaMeta,
  node: PreloadNode,
): Promise<void> {
  const route = routeOf(schemaMeta, node.assoc);
  const level = levelOf(route, node);
  // A parent whose schema class declares a database schema was read from that one, which
  // says nothing about where its children are: they are read with the call's schema.
  if (schemaMeta.schema !== undefined) {
    await loadGroup(run, parents, route, level, node, run.schema);
    return;
  }
  // Other parents were read where the call put them; their children are read from there,
  // and parents read from different database schemas separately.
  const bySchema = new Map<string | undefined, object[]>();
  for (const parent of parents) {
    const schema = (parent as { readonly [ROW]: { readonly schema: string | undefined } })[ROW].schema;
    let group = bySchema.get(schema);
    if (group === undefined) {
      group = [];
      bySchema.set(schema, group);
    }
    group.push(parent);
  }
  for (const [schema, group] of bySchema) await loadGroup(run, group, route, level, node, schema);
}

async function loadGroup(
  run: Run,
  parents: readonly object[],
  route: AssocRoute,
  level: Level,
  node: PreloadNode,
  schema: string | undefined,
): Promise<void> {
  const keys = distinctKeys(parents, route.ownerFields);
  if (keys.length === 0) return;
  const capabilities = run.core.adapter.capabilities;
  const size = chunkSize(level, route.ownerFields.length, capabilities.arrayParams, capabilities.maxParams);
  const children: unknown[] = [];
  const childKeys: (readonly unknown[])[] = [];
  // Whole rows reached along several paths are kept once per parent, by primary key; a
  // selected shape has no key to tell them apart by, and is kept as it comes.
  const repeat = route.mayRepeat && level.whole && route.targetMeta.primaryKey.length > 0;
  const seen = repeat
    ? new KeyIndex<true>([
        ...route.ownerFields.map((field) => field.type),
        ...route.targetMeta.primaryKey.map((field) => field.type),
      ])
    : undefined;
  for (let start = 0; start < keys.length; start += size) {
    const chunk = keys.slice(start, start + size);
    const ast = levelAst(route, level, chunk, capabilities.arrayParams && capabilities.arrays);
    // A preloaded target is a table's schema: an embedded one has no associations to it.
    const rows = await execute(run, ast, schema, route.targetMeta.source as string);
    if (level.direct) {
      const fields = route.childFields as readonly FieldMeta[];
      for (const row of rows) {
        const record = row as Record<string, unknown>;
        children.push(row);
        childKeys.push(fields.map((field) => record[field.name]));
      }
    } else {
      const width = route.ownerFields.length;
      for (const row of rows) {
        const record = row as Record<string, unknown>;
        const key = new Array<unknown>(width);
        for (let i = 0; i < width; i++) key[i] = record[`$o${i}`];
        const child = record.$row;
        if (seen !== undefined) {
          const child0 = child as Record<string, unknown>;
          const full = [...key, ...route.targetMeta.primaryKey.map((field) => child0[field.name])];
          if (seen.get(full) !== undefined) continue;
          seen.set(full, true);
        }
        children.push(child);
        childKeys.push(key);
      }
    }
  }
  if (node.nested.length > 0 && level.whole) {
    let rows = children as object[];
    if (!level.direct) {
      // The rows of a joined route come out of an object; give them their nested slots.
      rows = withSlots(rows, route.targetMeta, node.nested, false);
      for (let i = 0; i < rows.length; i++) children[i] = rows[i];
    } else if (hasJoin(node.nested)) {
      const merged = dedupeKeyed(rows, childKeys, route.targetMeta, node.nested);
      rows = merged.rows;
      children.length = 0;
      childKeys.length = 0;
      for (let i = 0; i < merged.rows.length; i++) {
        children.push(merged.rows[i]);
        childKeys.push(merged.keys[i] as readonly unknown[]);
      }
    }
    await loadNodes(run, rows, route.targetMeta, node.nested);
    const record: PreloadRecord = { nodes: node.nested, named: run.named, schema: run.schema };
    for (const row of rows) records.set(row, record);
  }
  attach(parents, route, children, childKeys);
}

/** The distinct, complete owner keys of `parents` (a key with a `null` part matches nothing). */
function distinctKeys(parents: readonly object[], fields: readonly FieldMeta[]): (readonly unknown[])[] {
  const index = new KeyIndex<true>(fields.map((field) => field.type));
  const out: (readonly unknown[])[] = [];
  for (const parent of parents) {
    const key = keyOf(parent, fields);
    if (key === undefined || index.get(key) !== undefined) continue;
    index.set(key, true);
    out.push(key);
  }
  return out;
}

function keyOf(row: object, fields: readonly FieldMeta[]): unknown[] | undefined {
  const record = row as Record<string, unknown>;
  const key = new Array<unknown>(fields.length);
  for (let i = 0; i < fields.length; i++) {
    const value = record[(fields[i] as FieldMeta).name];
    if (value === null || value === undefined) return undefined;
    key[i] = value;
  }
  return key;
}

/** Groups the children by owner key and gives each parent its own: an array, a child or `null`. */
function attach(
  parents: readonly object[],
  route: AssocRoute,
  children: readonly unknown[],
  childKeys: readonly (readonly unknown[])[],
): void {
  interface Group {
    readonly list: unknown[];
    taken: boolean;
  }
  const index = new KeyIndex<Group>(route.ownerFields.map((field) => field.type));
  for (let i = 0; i < children.length; i++) {
    const key = childKeys[i] as readonly unknown[];
    let group = index.get(key);
    if (group === undefined) {
      group = { list: [], taken: false };
      index.set(key, group);
    }
    group.list.push(children[i]);
  }
  const many = route.cardinality === "many";
  const name = route.assoc.name;
  for (const parent of parents) {
    const key = keyOf(parent, route.ownerFields);
    const group = key === undefined ? undefined : index.get(key);
    if (group === undefined) continue;
    let value: unknown;
    if (many) value = group.taken ? group.list.map(copyValue) : group.list;
    else value = group.taken ? copyValue(group.list[0]) : group.list[0];
    group.taken = true;
    (parent as Record<string, unknown>)[name] = value;
  }
}

// ---------------------------------------------------------------------------
// Level statements
// ---------------------------------------------------------------------------

/** What is derived once from a preload node: its base query and how its rows come back. */
interface Level {
  /** The association's query: the callback's, or the target alone. */
  readonly base: QueryAst;
  /** Whether the children carry their key (a direct association), or it is selected beside them. */
  readonly direct: boolean;
  /** Whether the children are whole rows (not a selected shape). */
  readonly whole: boolean;
  /** The order of the children. */
  readonly orderBys: readonly OrderNode[];
  /** The parameters of the statement besides the keys, for chunking where lists are expanded. */
  readonly fixedParams: number;
  /** The preloads below this one, which a statement of whole rows of a direct association reserves on its rows. */
  readonly nested: readonly PreloadNode[];
}

const levels = /* @__PURE__ */ new WeakMap<PreloadNode, Level>();

function levelOf(route: AssocRoute, node: PreloadNode): Level {
  let level = levels.get(node);
  if (level === undefined) {
    level = buildLevel(route, node);
    levels.set(node, level);
  }
  return level;
}

function buildLevel(route: AssocRoute, node: PreloadNode): Level {
  const alias = route.alias;
  const base = node.query ?? (from(route.target, alias) as unknown as { readonly ast: QueryAst }).ast;
  const select = base.select;
  const whole = select === undefined || (select.shape.kind === "binding" && select.shape.binding === alias);
  const direct = route.childFields !== undefined;
  const label = `preload "${route.assoc.name}" of ${route.owner.name}`;
  if (!direct && node.nested.some((nested) => nested.from !== undefined)) {
    throw new QueryError(
      "query.joinPreloadUnderThrough",
      `${label}: a nested preload from a join is not supported under a ${route.assoc.kind === "manyToMany" ? "many-to-many" : "has-through"} association.`,
    );
  }
  const limited = base.limit !== undefined || base.offset !== undefined;
  if (limited) {
    if (route.mayRepeat) {
      throw new QueryError(
        "query.throughLimitAmbiguous",
        `${label}: limit and offset apply per parent, and a row of ${route.targetMeta.name} can be reached along more than one path of this has-through chain, so it would be counted more than once.`,
      );
    }
    if (route.targetMeta.primaryKey.length === 0) {
      throw new QueryError(
        "query.preloadLimitKey",
        `${label}: limit and offset apply per parent, which needs ${route.targetMeta.name} to have a primary key to rank its rows by.`,
        { params: { target: route.targetMeta.name } },
      );
    }
    const many = toManyJoin(route.targetMeta, node.nested);
    if (many !== undefined) {
      throw new QueryError(
        "query.joinPreloadCallbackLimit",
        `${label}: its callback preloads "${many}" from a join, and its limit or offset would count the joined rows, not the rows of ${route.targetMeta.name}, giving a parent fewer than it asks for.`,
        { params: { many } },
      );
    }
  }
  const orderBys =
    base.orderBys.length > 0
      ? base.orderBys
      : route.assoc.orderBy.map((entry) => {
          const field = route.targetMeta.fieldsByName.get(entry.field) as FieldMeta;
          return orderNode(columnNode(alias, field.name, field.column), entry.direction, undefined);
        });
  let fixedParams = base.params.length;
  for (const length of base.listLengths) fixedParams += length - 1;
  for (const filter of route.filters) fixedParams += countParams(filter);
  for (const join of route.joins) fixedParams += countParams(join.on as ExprNode);
  if (limited) fixedParams *= 2;
  return { base, direct, whole, orderBys, fixedParams, nested: node.nested };
}

function countParams(node: ExprNode): number {
  const probe = rebuild(EMPTY, { wheres: [{ kind: "bool", op: "and", expr: node }] });
  let count = probe.params.length;
  for (const length of probe.listLengths) count += length - 1;
  return count;
}

/** A blank query, the base of hand-built ones. */
const EMPTY: QueryAst = {
  kind: "query",
  from: { kind: "values", columns: ["k0"], rows: [], alias: "$keys" },
  joins: NONE,
  wheres: NONE,
  select: undefined,
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
};

/** How many keys one statement takes: `chunkKeys`, and where lists are expanded no more than the dialect's parameters allow. */
function chunkSize(level: Level, width: number, arrayParams: boolean, maxParams: number): number {
  const limit = preloadLimits.chunkKeys;
  if (arrayParams) return limit;
  const room = Math.floor(
    (maxParams - level.fixedParams) /
      (level.base.limit !== undefined || level.base.offset !== undefined ? 2 * width : width),
  );
  return Math.max(1, Math.min(limit, room));
}

function and(expr: ExprNode): BoolNode {
  return { kind: "bool", op: "and", expr };
}

/**
 * The filter on the owner key: `key = any($1)` (or `in (…)`), or for a composite key
 * `(a, b) in (select … from unnest($1, $2))` / a `values` list.
 */
function keyFilter(route: AssocRoute, keys: readonly (readonly unknown[])[], arrays: boolean): ExprNode {
  const fields = route.ownerFields;
  // A key value is hidden from logs when the field on either side is redacted.
  const redact = fields.map(
    (field, i) => field.redact || (route.childFields?.[i] as FieldMeta | undefined)?.redact === true,
  );
  if (fields.length === 1) {
    const field = (route.childFields?.[0] ?? fields[0]) as FieldMeta;
    return binaryNode(
      "in",
      route.keys[0] as ExprNode,
      listNode(
        keys.map((key) => key[0]),
        field.type,
        redact[0] as boolean,
      ),
    );
  }
  const columns = fields.map((_, i) => `k${i}`);
  const source = arrays
    ? {
        kind: "fragmentSource" as const,
        fragment: fragmentNode(
          ["unnest(", ...fields.slice(1).map(() => ", "), ")"],
          fields.map((field, i) =>
            paramNode(
              keys.map((key) => key[i]),
              arrayType(field.type),
              redact[i] as boolean,
            ),
          ),
        ),
        columns,
        alias: "$keys",
      }
    : {
        kind: "values" as const,
        columns,
        rows: keys.map((key) =>
          fields.map((field, i) => paramNode(key[i], field.type, redact[i] as boolean)),
        ),
        alias: "$keys",
      };
  const list = rebuild(EMPTY, {
    from: source,
    select: selectNode(
      {
        kind: "object",
        keys: columns,
        values: columns.map((column) => ({
          kind: "expr" as const,
          expr: columnNode("$keys", column, column),
          type: undefined,
        })),
      },
      NONE,
    ),
  });
  return binaryNode("in", tupleNode(route.keys), subqueryNode(list));
}

/** The select of a level: the base's for a direct association, `{ $o0, …, $row }` for a joined one. */
function levelSelect(route: AssocRoute, level: Level): QueryAst["select"] {
  if (level.direct) return level.base.select;
  const base = level.base.select;
  const row: SelectShape = base?.shape ?? { kind: "binding", binding: route.alias, meta: route.targetMeta };
  const keys: string[] = [];
  const values: SelectShape[] = [];
  route.keys.forEach((expr, i) => {
    keys.push(`$o${i}`);
    values.push({ kind: "expr", expr, type: (route.ownerFields[i] as FieldMeta).type });
  });
  keys.push("$row");
  values.push(row);
  return selectNode({ kind: "object", keys, values }, base?.constants ?? NONE);
}

/** The statement of one chunk of keys. */
function levelAst(
  route: AssocRoute,
  level: Level,
  keys: readonly (readonly unknown[])[],
  arrays: boolean,
): QueryAst {
  const base = level.base;
  const filter = keyFilter(route, keys, arrays);
  const joins: JoinNode[] = [...base.joins, ...route.joins];
  const wheres: BoolNode[] = [...base.wheres, ...route.filters.map(and)];
  const select = levelSelect(route, level);
  const preloads = level.direct && level.whole ? level.nested : NONE;
  if (base.limit === undefined && base.offset === undefined) {
    wheres.push(and(filter));
    return rebuild(base, { joins, wheres, select, orderBys: level.orderBys, preloads });
  }
  // Per parent: rank the rows in a subquery, join it back on the key, keep the ranks wanted.
  const alias = route.alias;
  const ranked = `$${alias}__ranked`;
  const pk = route.targetMeta.primaryKey;
  const rankKeys: string[] = [];
  const rankValues: SelectShape[] = [];
  const on: ExprNode[] = [];
  pk.forEach((field, i) => {
    rankKeys.push(`$k${i}`);
    rankValues.push({ kind: "expr", expr: columnNode(alias, field.name, field.column), type: undefined });
    on.push(
      binaryNode("eq", columnNode(ranked, `$k${i}`, `$k${i}`), columnNode(alias, field.name, field.column)),
    );
  });
  if (!level.direct) {
    route.keys.forEach((expr, i) => {
      rankKeys.push(`$o${i}`);
      rankValues.push({ kind: "expr", expr, type: undefined });
      on.push(binaryNode("eq", columnNode(ranked, `$o${i}`, `$o${i}`), expr));
    });
  }
  rankKeys.push("$rank");
  rankValues.push({
    kind: "expr",
    expr: aggregateNode("rowNumber", [], false, undefined, windowNode(route.keys, level.orderBys, undefined)),
    type: undefined,
  });
  const inner = rebuild(base, {
    joins,
    wheres: [...wheres, and(filter)],
    select: selectNode({ kind: "object", keys: rankKeys, values: rankValues }, NONE),
    orderBys: NONE,
    limit: undefined,
    offset: undefined,
    preloads: NONE,
  });
  const rank = columnNode(ranked, "$rank", "$rank");
  const conditions: ExprNode[] = [];
  if (base.offset !== undefined) conditions.push(binaryNode("gt", rank, base.offset));
  if (base.limit !== undefined) {
    conditions.push(
      binaryNode("lte", base.offset === undefined ? rank : binaryNode("sub", rank, base.offset), base.limit),
    );
  }
  return rebuild(base, {
    joins: [
      ...joins,
      {
        kind: "join",
        type: "inner",
        source: { kind: "subquerySource", query: inner, alias: ranked },
        on: on.length === 1 ? (on[0] as ExprNode) : naryNode("and", on),
      },
    ],
    wheres: [...wheres, ...conditions.map(and)],
    select,
    orderBys: [orderNode(rank, "asc", undefined)],
    limit: undefined,
    offset: undefined,
    preloads,
  });
}

// ---------------------------------------------------------------------------
// Join preloads: merging the parents
// ---------------------------------------------------------------------------

/**
 * `rows` of `schemaMeta` with equal primary keys merged into the first one seen, in
 * first-seen order, their join-preloaded children merged the same way below. `strict`
 * (the root rows of a query) refuses a schema without a primary key; children of such a
 * schema are kept as they are.
 */
function dedupe(
  rows: readonly object[],
  schemaMeta: SchemaMeta,
  nodes: readonly PreloadNode[],
  strict: boolean,
): object[] {
  if (strict && schemaMeta.primaryKey.length === 0) {
    throw new QueryError(
      "query.joinPreloadNoKey",
      `A join preload merges the result rows of each ${schemaMeta.name} by its primary key, and ${schemaMeta.name} has none.`,
    );
  }
  return dedupeKeyed(rows, NONE, schemaMeta, nodes).rows;
}

/**
 * {@link dedupe} of rows that each come with a key (the owner key of a separate
 * preload's children, `keys[i]` for `rows[i]`), which follows its row. Without key
 * fields the rows are kept as they are.
 */
function dedupeKeyed(
  rows: readonly object[],
  keys: readonly (readonly unknown[])[],
  schemaMeta: SchemaMeta,
  nodes: readonly PreloadNode[],
): { readonly rows: object[]; readonly keys: (readonly unknown[])[] } {
  const joins = nodes.filter((node) => node.from !== undefined);
  const pk = schemaMeta.primaryKey;
  if (pk.length === 0) {
    for (const row of rows) finish(row, schemaMeta, joins);
    return { rows: rows.slice(), keys: keys.slice() };
  }
  const index = new KeyIndex<object>(pk.map((field) => field.type));
  const out: object[] = [];
  const outKeys: (readonly unknown[])[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as object;
    const id = pk.map((field) => (row as Record<string, unknown>)[field.name]);
    const kept = index.get(id);
    if (kept === undefined) {
      index.set(id, row);
      out.push(row);
      outKeys.push(keys[i] as readonly unknown[]);
    } else {
      mergeInto(kept, row, schemaMeta, joins);
    }
  }
  for (const row of out) finish(row, schemaMeta, joins);
  return { rows: out, keys: outKeys };
}

/** Moves the join-preloaded children of `dup` (a later result row of the same parent) onto `kept`. */
function mergeInto(kept: object, dup: object, schemaMeta: SchemaMeta, joins: readonly PreloadNode[]): void {
  const target = kept as Record<string, unknown>;
  const source = dup as Record<string, unknown>;
  for (const node of joins) {
    const route = routeOf(schemaMeta, node.assoc);
    const name = node.assoc;
    if (route.cardinality === "many") {
      const list = target[name] as unknown[];
      for (const child of source[name] as unknown[]) list.push(child);
    } else if (target[name] === null) {
      target[name] = source[name];
    } else if (source[name] !== null) {
      mergeInto(
        target[name] as object,
        source[name] as object,
        route.targetMeta,
        node.nested.filter((nested) => nested.from !== undefined),
      );
    }
  }
}

/** De-duplicates the join-preloaded children of a merged row, at every level. */
function finish(row: object, schemaMeta: SchemaMeta, joins: readonly PreloadNode[]): void {
  const record = row as Record<string, unknown>;
  for (const node of joins) {
    const route = routeOf(schemaMeta, node.assoc);
    const value = record[node.assoc];
    if (route.cardinality === "many") {
      record[node.assoc] = dedupe(value as object[], route.targetMeta, node.nested, false);
    } else if (value !== null) {
      finish(
        value as object,
        route.targetMeta,
        node.nested.filter((nested) => nested.from !== undefined),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Copies
// ---------------------------------------------------------------------------

/**
 * A copy of an attached value for another parent: new rows (built by their schema's
 * factory, with their loaded associations copied too), new arrays and plain objects, and
 * new `Date`s and byte arrays. Other objects (a custom type's values) are shared.
 *
 * @example
 * ```ts
 * const second = copyValue(author);
 * second === author; // false
 * ```
 */
export function copyValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(copyValue);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Uint8Array) return Uint8Array.prototype.slice.call(value);
  if (isRow(value)) return copyRow(value);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = copyValue((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

function copyRow(row: object): object {
  const schema = schemaOfRow(row);
  if (schema === undefined) return row;
  const schemaMeta = meta(schema);
  const source = row as Record<string, unknown>;
  const persisted = schemaMeta.persisted;
  const values = new Array<unknown>(persisted.length);
  for (let i = 0; i < persisted.length; i++) values[i] = copyValue(source[(persisted[i] as FieldMeta).name]);
  const names = loadedNames(row, schemaMeta);
  const rowMeta = (row as { readonly [ROW]: never })[ROW];
  const out = (
    names.length === 0
      ? schemaMeta.create(values, rowMeta)
      : schemaMeta.createWith(names)(
          values,
          names.map((name) => copyValue(source[name])),
          rowMeta,
        )
  ) as Record<string, unknown>;
  for (const field of schemaMeta.fields) if (field.virtual) out[field.name] = copyValue(source[field.name]);
  keepPreloads(row, out);
  return out;
}
