/**
 * Window functions (`rowNumber`, `rank`, `lag`, …) and the named windows a query declares
 * with `.windows({ … })`: the nodes, the checks a clause runs on the window functions it
 * holds, and the types that check window names at compile time.
 *
 * A window function is an aggregate node whose name is one of {@link WINDOW_FUNCTION_NAMES};
 * it gets `OVER (…)` with the `over` method every aggregate has. Any aggregate (`sum`,
 * `count`, …) can be computed over a window the same way.
 *
 * This module is imported by the query builder, so it does not import the builder.
 *
 * @module
 */
import type {
  ExprNode,
  NamedParamNode,
  OrderNode,
  SelectShape,
  WindowDefNode,
} from "../../contracts/query.js";
import type { AnyFieldType } from "../../contracts/type.js";
import { QueryError } from "../../errors.js";
import { HASH_SEED, hashInt, hashString } from "../../internal/hash.js";
import { own } from "../../internal/own.js";
import { isPlainObject } from "../../internal/plain-object.js";
import { bigintType, floatType, integerType } from "../../types/index.js";
import {
  aggregateNode,
  collectParams,
  IDENTIFIER,
  orderNode,
  shapeOf,
  shapeOfAggregate,
  windowNode,
} from "../ast.js";
import {
  type AnyExpr,
  type Checked,
  type Expr,
  isExpr,
  join,
  joinNamed,
  type MergeParams,
  NONE,
  type NoParams,
  type Operand,
  OrderExpr,
  type ParamsOf,
  type ParamsOfAll,
  type SomeParams,
  toOperand,
  type ValueOf,
} from "../expr.js";
import { Aggregate, type WindowSpec } from "../functions.js";

/** `row_number`, `rank` and `dense_rank` return a 64-bit integer: read as a `number`. */
const BIG_COUNT: AnyFieldType = /* @__PURE__ */ bigintType({ mode: "number" });
const FLOAT: AnyFieldType = /* @__PURE__ */ floatType();
const INTEGER: AnyFieldType = /* @__PURE__ */ integerType();

/**
 * The names a window function puts in its aggregate node: keys of the compiler's
 * aggregate table (`rowNumber` is `row_number` on Postgres). These are window functions
 * only: each needs `OVER (…)`, and none takes `FILTER`.
 *
 * @example
 * ```ts
 * WINDOW_FUNCTION_NAMES.includes("rowNumber"); // true
 * ```
 */
export const WINDOW_FUNCTION_NAMES = [
  "rowNumber",
  "rank",
  "denseRank",
  "percentRank",
  "cumeDist",
  "ntile",
  "lag",
  "lead",
  "firstValue",
  "lastValue",
  "nthValue",
] as const;

const WINDOW_ONLY: ReadonlySet<string> = /* @__PURE__ */ new Set(WINDOW_FUNCTION_NAMES);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Type only: a window function that has no window yet. It is an {@link Aggregate}, so it
 * has `over`; until `over` is called a `select` does not accept it, since the database
 * refuses a window function without `OVER`. The property never exists at run time.
 *
 * @example
 * ```ts
 * const n: WindowFunction<number> = rowNumber();
 * n.over({ orderBy: [p.createdAt] });
 * ```
 */
export interface NeedsWindow {
  readonly "~needsWindow": true;
}

/**
 * A window function before `over(…)`: `rowNumber()`, `lag(p.views)`. Call `over` to give
 * it a window; the result is an ordinary expression.
 *
 * @example
 * ```ts
 * const ranked: WindowFunction<number> = rank();
 * ```
 */
export type WindowFunction<T, P = NoParams> = Aggregate<T, P> & NeedsWindow;

/**
 * The named windows of `.windows({ … })`: name to a callback that receives the bindings
 * and returns the window.
 *
 * @example
 * ```ts
 * const defs: WindowDefs<{ p: Binding<typeof Post> }> = {
 *   byAuthor: ({ p }) => ({ partitionBy: [p.authorId], orderBy: [p.createdAt.desc()] }),
 * };
 * ```
 */
export type WindowDefs<B> = { readonly [name: string]: (bindings: B) => WindowSpec };

type ElementOf<X> = X extends readonly (infer E)[] ? E : never;

/** One member of a window spec, `never` when the spec does not have it. */
type Member<W, K extends string> = W extends { readonly [P in K]?: infer V } ? Exclude<V, undefined> : never;

/** The expressions of a window spec: its `partitionBy` and `orderBy` items and its `frame`. */
type SpecParts<W> =
  | ElementOf<Member<W, "partitionBy">>
  | ElementOf<Member<W, "orderBy">>
  | Member<W, "frame">;

/**
 * The named parameters of every window of a `.windows({ … })` argument.
 *
 * @example
 * ```ts
 * type P = WindowDefParams<{ w: () => { frame: Expr<unknown, { n: number }> } }>; // { n: number }
 * ```
 */
export type WindowDefParams<D> = ParamsOfAll<
  readonly { [K in keyof D]: D[K] extends (...args: never[]) => infer W ? SpecParts<W> : never }[keyof D][]
>;

/**
 * The names of the named windows `X` (what a `select` returned) uses: those of every
 * `over("name")` among its expressions.
 */
export type WindowNamesUsed<L> = L extends { readonly "~window": infer N extends string } ? N : never;

/**
 * `unknown` when the expressions `L` (a union) use only windows in `W` and every window
 * function among them has a window; otherwise an error type, so the clause does not
 * compile.
 *
 * @example
 * ```ts
 * type Ok = WindowCheck<Expr<number> & { "~window": "w" }, "w">; // unknown
 * ```
 */
export type WindowCheck<L, W extends string> = [Extract<L, NeedsWindow>] extends [never]
  ? [Exclude<WindowNamesUsed<L>, W>] extends [never]
    ? unknown
    : {
        readonly "~error": `the window "${Exclude<WindowNamesUsed<L>, W>}" is not declared on this query: declare it first with windows({ ${Exclude<WindowNamesUsed<L>, W>}: … })`;
      }
  : {
      readonly "~error": "a window function needs a window: add .over(…), such as rowNumber().over({ orderBy: [p.createdAt] })";
    };

/**
 * `unknown` when the expressions `L` hold no window function and no named window;
 * otherwise an error type: for `returning` and `set`, where no window function may
 * appear. (An aggregate over an inline window carries no mark; it is refused at run time.)
 *
 * @example
 * ```ts
 * type Refused = NoWindowCheck<WindowFunction<number>>; // an error type
 * ```
 */
export type NoWindowCheck<L> = [Extract<L, NeedsWindow | { readonly "~window": string }>] extends [never]
  ? unknown
  : {
      readonly "~error": "window functions cannot be used here: they are computed after the rows are filtered";
    };

// ---------------------------------------------------------------------------
// Window functions
// ---------------------------------------------------------------------------

function windowFunction(
  name: (typeof WINDOW_FUNCTION_NAMES)[number],
  args: readonly AnyExpr[],
  type: AnyFieldType | undefined,
  redact: boolean,
): AnyExpr {
  const nodes: ExprNode[] = [];
  const shapes: number[] = [];
  let params: readonly unknown[] = NONE;
  let lists: readonly number[] = NONE;
  let named: readonly NamedParamNode[] = NONE;
  for (const arg of args) {
    nodes.push(arg.node);
    shapes.push(arg.shape);
    params = join(params, arg.params);
    lists = join(lists, arg.lists);
    named = joinNamed(named, arg.named);
  }
  return new Aggregate(
    aggregateNode(name, nodes, false, undefined, undefined),
    type,
    redact,
    params,
    lists,
    named,
    shapeOfAggregate(name, shapes, false, undefined, undefined),
  );
}

function expressionArgument(value: unknown, method: string): AnyExpr {
  if (isExpr(value)) return value;
  throw new QueryError("query.windowArgument", `${method}() takes an expression.`);
}

/** A whole-number argument (`ntile(4)`, the offset of `lag`): a value bound as an integer, or an integer expression. */
function countArgument(value: unknown, method: string, what: string): AnyExpr {
  if (isExpr(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) {
    return toOperand(value, INTEGER, false, method, false);
  }
  throw new QueryError(
    "query.windowCount",
    `${method}() takes ${what} as a whole number of at least 1, or an integer expression; it was given ${typeof value === "number" ? String(value) : typeof value}.`,
    { params: { what } },
  );
}

/**
 * `row_number()`: the number of the current row in its partition, from 1, in the
 * window's order. Needs `.over(…)`.
 *
 * @example
 * ```ts
 * rowNumber().over({ partitionBy: [p.authorId], orderBy: [p.createdAt.desc()] });
 * ```
 */
export function rowNumber(): WindowFunction<number> {
  return windowFunction("rowNumber", NONE, BIG_COUNT, false) as never;
}

/**
 * `rank()`: the rank of the current row in its partition, with gaps after ties. Needs
 * `.over(…)`.
 *
 * @example
 * ```ts
 * rank().over({ orderBy: [p.views.desc()] });
 * ```
 */
export function rank(): WindowFunction<number> {
  return windowFunction("rank", NONE, BIG_COUNT, false) as never;
}

/**
 * `dense_rank()`: the rank of the current row in its partition, without gaps. Needs
 * `.over(…)`.
 *
 * @example
 * ```ts
 * denseRank().over({ orderBy: [p.views.desc()] });
 * ```
 */
export function denseRank(): WindowFunction<number> {
  return windowFunction("denseRank", NONE, BIG_COUNT, false) as never;
}

/**
 * `percent_rank()`: the relative rank of the current row, from 0 to 1. Needs `.over(…)`.
 *
 * @example
 * ```ts
 * percentRank().over({ orderBy: [p.views] });
 * ```
 */
export function percentRank(): WindowFunction<number> {
  return windowFunction("percentRank", NONE, FLOAT, false) as never;
}

/**
 * `cume_dist()`: the fraction of rows of the partition up to and including the current
 * row's peers, above 0 and up to 1. Needs `.over(…)`.
 *
 * @example
 * ```ts
 * cumeDist().over({ orderBy: [p.views] });
 * ```
 */
export function cumeDist(): WindowFunction<number> {
  return windowFunction("cumeDist", NONE, FLOAT, false) as never;
}

/**
 * `ntile(buckets)`: which of `buckets` nearly equal groups the current row falls in, from
 * 1. Needs `.over(…)`.
 *
 * @example
 * ```ts
 * ntile(4).over({ orderBy: [p.views] });
 * ```
 *
 * @throws QueryError when `buckets` is not a whole number of at least 1 or an expression.
 */
export function ntile<N extends number | Expr<number | null, SomeParams>>(
  buckets: N,
): WindowFunction<number, ParamsOf<N>> {
  return windowFunction(
    "ntile",
    [countArgument(buckets, "ntile", "the number of buckets")],
    INTEGER,
    false,
  ) as never;
}

/** `lag` and `lead`: the value, the offset, and the default. */
function shifted(
  name: "lag" | "lead",
  expr: unknown,
  offset: unknown,
  fallback: unknown,
  given: number,
): AnyExpr {
  const value = expressionArgument(expr, name);
  const args: AnyExpr[] = [value];
  if (given >= 2) args.push(countArgument(offset, name, "the offset"));
  if (given >= 3) args.push(toOperand(fallback, value.type, value.redact, name, false, true));
  return windowFunction(name, args, value.type, value.redact);
}

/**
 * `lag(value, offset = 1, default)`: `value` at the row `offset` rows before the current
 * one in the window's order; `default` (else `null`) when there is none. Needs `.over(…)`.
 *
 * @example
 * ```ts
 * lag(p.views).over({ partitionBy: [p.authorId], orderBy: [p.createdAt] });
 * lag(p.views, 1, 0).over({ orderBy: [p.createdAt] });
 * ```
 *
 * @throws QueryError when `value` is not an expression, `offset` not a whole number of at
 * least 1, or `default` is `undefined`.
 */
export function lag<X extends Expr<unknown, SomeParams>>(
  value: X,
): WindowFunction<ValueOf<X> | null, ParamsOf<X>>;
export function lag<X extends Expr<unknown, SomeParams>, N extends number | Expr<number | null, SomeParams>>(
  value: X,
  offset: N & Checked<ParamsOf<X>, N>,
): WindowFunction<ValueOf<X> | null, MergeParams<ParamsOf<X>, ParamsOf<N>>>;
export function lag<
  X extends Expr<unknown, SomeParams>,
  N extends number | Expr<number | null, SomeParams>,
  D extends Operand<ValueOf<X>> | null,
>(
  value: X,
  offset: N & Checked<ParamsOf<X>, N>,
  fallback: D & Checked<MergeParams<ParamsOf<X>, ParamsOf<N>>, D>,
): WindowFunction<
  ValueOf<X> | (null extends ValueOf<D> ? null : never),
  MergeParams<ParamsOf<X>, MergeParams<ParamsOf<N>, ParamsOf<D>>>
>;
export function lag(...args: readonly unknown[]): AnyExpr {
  return shifted("lag", args[0], args[1], args[2], args.length);
}

/**
 * `lead(value, offset = 1, default)`: `value` at the row `offset` rows after the current
 * one; `default` (else `null`) when there is none. Needs `.over(…)`.
 *
 * @example
 * ```ts
 * lead(p.title).over({ orderBy: [p.createdAt] });
 * ```
 *
 * @throws QueryError as {@link lag}.
 */
export function lead<X extends Expr<unknown, SomeParams>>(
  value: X,
): WindowFunction<ValueOf<X> | null, ParamsOf<X>>;
export function lead<X extends Expr<unknown, SomeParams>, N extends number | Expr<number | null, SomeParams>>(
  value: X,
  offset: N & Checked<ParamsOf<X>, N>,
): WindowFunction<ValueOf<X> | null, MergeParams<ParamsOf<X>, ParamsOf<N>>>;
export function lead<
  X extends Expr<unknown, SomeParams>,
  N extends number | Expr<number | null, SomeParams>,
  D extends Operand<ValueOf<X>> | null,
>(
  value: X,
  offset: N & Checked<ParamsOf<X>, N>,
  fallback: D & Checked<MergeParams<ParamsOf<X>, ParamsOf<N>>, D>,
): WindowFunction<
  ValueOf<X> | (null extends ValueOf<D> ? null : never),
  MergeParams<ParamsOf<X>, MergeParams<ParamsOf<N>, ParamsOf<D>>>
>;
export function lead(...args: readonly unknown[]): AnyExpr {
  return shifted("lead", args[0], args[1], args[2], args.length);
}

/**
 * `first_value(value)`: `value` at the first row of the window frame. Needs `.over(…)`.
 *
 * @example
 * ```ts
 * firstValue(p.title).over({ partitionBy: [p.authorId], orderBy: [p.createdAt] });
 * ```
 *
 * @throws QueryError when `value` is not an expression.
 */
export function firstValue<X extends Expr<unknown, SomeParams>>(
  value: X,
): WindowFunction<ValueOf<X>, ParamsOf<X>> {
  const arg = expressionArgument(value, "firstValue");
  return windowFunction("firstValue", [arg], arg.type, arg.redact) as never;
}

/**
 * `last_value(value)`: `value` at the last row of the window frame. With an `orderBy` and
 * no frame, the frame ends at the current row's last peer.
 *
 * @example
 * ```ts
 * lastValue(p.title).over({ orderBy: [p.createdAt], frame: fragment`rows between unbounded preceding and unbounded following` });
 * ```
 *
 * @throws QueryError when `value` is not an expression.
 */
export function lastValue<X extends Expr<unknown, SomeParams>>(
  value: X,
): WindowFunction<ValueOf<X>, ParamsOf<X>> {
  const arg = expressionArgument(value, "lastValue");
  return windowFunction("lastValue", [arg], arg.type, arg.redact) as never;
}

/**
 * `nth_value(value, n)`: `value` at the `n`th row of the window frame, from 1; `null`
 * when the frame has fewer rows. Needs `.over(…)`.
 *
 * @example
 * ```ts
 * nthValue(p.title, 2).over({ orderBy: [p.createdAt] });
 * ```
 *
 * @throws QueryError when `value` is not an expression or `n` not a whole number of at least 1.
 */
export function nthValue<
  X extends Expr<unknown, SomeParams>,
  N extends number | Expr<number | null, SomeParams>,
>(
  value: X,
  n: N & Checked<ParamsOf<X>, N>,
): WindowFunction<ValueOf<X> | null, MergeParams<ParamsOf<X>, ParamsOf<N>>> {
  const arg = expressionArgument(value, "nthValue");
  return windowFunction(
    "nthValue",
    [arg, countArgument(n, "nthValue", "the row number")],
    arg.type,
    arg.redact,
  ) as never;
}

// ---------------------------------------------------------------------------
// Named windows
// ---------------------------------------------------------------------------

const WINDOW_DEF_SEED = /* @__PURE__ */ hashString(HASH_SEED, "windowDef");

/** What `.windows({ … })` adds to a query: the definitions and their parameters in canonical order. */
export interface BuiltWindows {
  readonly nodes: readonly WindowDefNode[];
  readonly params: readonly unknown[];
  readonly lists: readonly number[];
  readonly named: readonly NamedParamNode[];
  /** The shapes of the new definitions, in order. */
  readonly shapes: readonly number[];
}

/**
 * The names of a `.windows({ … })` argument, checked: an object of at least one window,
 * each name an identifier not already declared.
 *
 * @example
 * ```ts
 * windowNames({ w: () => ({}) }, []); // ["w"]
 * ```
 *
 * @throws QueryError when the argument is not such an object, or a name is not an
 * identifier, is declared already, or has no callback.
 */
export function windowNames(defs: unknown, existing: readonly WindowDefNode[]): readonly string[] {
  if (typeof defs !== "object" || defs === null || !isPlainObject(defs)) {
    throw new QueryError("query.windowsObject", "windows() takes an object of named windows.");
  }
  const names = Object.keys(defs);
  if (names.length === 0) throw new QueryError("query.windowsEmpty", "windows() was given no window.");
  for (const name of names) {
    if (!IDENTIFIER.test(name)) {
      throw new QueryError("query.windowName", `windows() was given the name "${name}".`);
    }
    if (existing.some((node) => node.name === name)) {
      throw new QueryError(
        "query.windowTwice",
        `windows() declares "${name}", which this query already declares.`,
      );
    }
    if (typeof (defs as Record<string, unknown>)[name] !== "function") {
      throw new QueryError(
        "query.windowCallback",
        `windows({ ${name} }) takes a callback that receives the bindings and returns the window.`,
        { params: { name } },
      );
    }
  }
  return names;
}

/**
 * The definition node of window `name` from what its callback returned, `{ partitionBy,
 * orderBy, frame }` (each optional; a bare expression in `orderBy` is ascending, `frame`
 * is a fragment).
 *
 * @example
 * ```ts
 * windowDef("w", { partitionBy: [p.authorId] });
 * ```
 *
 * @throws QueryError when the value is not such a window.
 */
export function windowDef(name: string, spec: unknown): WindowDefNode {
  const where = `windows({ ${name} })`;
  if (typeof spec !== "object" || spec === null || !isPlainObject(spec)) {
    throw new QueryError("query.windowShape", `${where}: the callback must return a window.`);
  }
  const extra = Object.keys(spec).filter(
    (key) => key !== "partitionBy" && key !== "orderBy" && key !== "frame",
  );
  if (extra.length > 0) {
    throw new QueryError(
      "query.windowUnknownKey",
      `${where}: a window has no ${extra.map((key) => `"${key}"`).join(", ")}.`,
    );
  }
  const given = spec as Readonly<Record<string, unknown>>;
  const partitionBy = own(given, "partitionBy");
  const orderBy = own(given, "orderBy");
  const frame = own(given, "frame");
  const partition: ExprNode[] = [];
  for (const item of listOf(partitionBy, where, "partitionBy")) {
    if (!isExpr(item))
      throw new QueryError(
        "query.windowPartition",
        `${where}: partitionBy holds something that is not an expression.`,
      );
    partition.push(item.node);
  }
  const order: OrderNode[] = [];
  for (const item of listOf(orderBy, where, "orderBy")) {
    if (item instanceof OrderExpr) order.push(item.node);
    else if (isExpr(item)) order.push(orderNode(item.node, "asc", undefined));
    else
      throw new QueryError(
        "query.windowOrder",
        `${where}: orderBy holds something that is not an expression or an order item.`,
      );
  }
  let frameNode: ExprNode | undefined;
  if (frame !== undefined) {
    if (!isExpr(frame) || frame.node.kind !== "fragment") {
      throw new QueryError("query.windowFrame", `${where}: frame is a fragment.`);
    }
    frameNode = frame.node;
  }
  return {
    kind: "windowDef",
    name,
    spec: windowNode(partition, order, frameNode?.kind === "fragment" ? frameNode : undefined),
  };
}

function listOf(value: unknown, where: string, member: string): readonly unknown[] {
  if (value === undefined) return NONE;
  if (!Array.isArray(value))
    throw new QueryError("query.windowMemberArray", `${where}: ${member} is not an array.`, {
      params: { member },
    });
  return value;
}

/**
 * The window definitions built, with their parameters in canonical order and their
 * shapes (as `shapeOf` gives them).
 *
 * @example
 * ```ts
 * collectWindows([windowDef("w", { partitionBy: [p.authorId] })]);
 * ```
 *
 * @throws QueryError when one named parameter is used with two types.
 */
export function collectWindows(nodes: readonly WindowDefNode[]): BuiltWindows {
  const params: unknown[] = [];
  const lists: number[] = [];
  const collected: NamedParamNode[] = [];
  const shapes: number[] = [];
  for (const node of nodes) {
    collectParams(node, params, lists, collected);
    shapes.push(hashInt(hashString(WINDOW_DEF_SEED, node.name), shapeOf(node.spec)));
  }
  let named: readonly NamedParamNode[] = NONE;
  for (const node of collected) named = joinNamed(named, [node]);
  return {
    nodes,
    params: params.length === 0 ? NONE : params,
    lists: lists.length === 0 ? NONE : lists,
    named,
    shapes,
  };
}

// ---------------------------------------------------------------------------
// Checking the window functions of a clause
// ---------------------------------------------------------------------------

/**
 * Checks the window functions among `nodes` (the expressions of one clause, not entering
 * subqueries, which have windows of their own): each window-only function has `OVER` and
 * no `FILTER`, and each named window is one of `windows`.
 *
 * @example
 * ```ts
 * checkWindows("select", [rowNumber().over("w").node], ast.windows);
 * ```
 *
 * @throws QueryError naming the clause and the function or window.
 */
export function checkWindows(
  clause: string,
  nodes: readonly ExprNode[],
  windows: readonly WindowDefNode[],
): void {
  for (const node of nodes) visit(clause, node, windows);
}

/**
 * {@link checkWindows} for one expression.
 *
 * @example
 * ```ts
 * checkWindow("orderBy", item.node.expr, ast.windows);
 * ```
 *
 * @throws QueryError as {@link checkWindows}.
 */
export function checkWindow(clause: string, node: ExprNode, windows: readonly WindowDefNode[]): void {
  visit(clause, node, windows);
}

/**
 * The expressions of a select's output tree, for {@link checkWindows}.
 *
 * @example
 * ```ts
 * selectExpressions(ast.select.shape);
 * ```
 */
export function selectExpressions(shape: SelectShape, out: ExprNode[] = []): ExprNode[] {
  switch (shape.kind) {
    case "expr":
      out.push(shape.expr);
      break;
    case "object":
      for (const value of shape.values) selectExpressions(value, out);
      break;
    case "tuple":
      for (const item of shape.items) selectExpressions(item, out);
      break;
    default:
      break;
  }
  return out;
}

/**
 * What a clause may hold: the named windows it may use (`select`, `orderBy`), or, for a
 * clause where no window function may appear, whether it may refer to a selected value by
 * its `selectedAs` name (`groupBy` may; `where`, `having`, `on`, `set` and
 * `returning` may not), and whether to suggest filtering from a query over this one.
 */
type Windows = readonly WindowDefNode[] | NoWindows;

interface NoWindows {
  readonly references: boolean;
  readonly filters: boolean;
}

/** The clauses that filter rows: a window function there is best filtered from a query over this one. */
const FILTERING: ReadonlySet<string> = /* @__PURE__ */ new Set([
  "where",
  "orWhere",
  "having",
  "join",
  "leftJoin",
  "rightJoin",
  "fullJoin",
  "joinAssoc",
  "leftJoinAssoc",
]);

/**
 * Refuses any window function, or aggregate over a window, in `node` (not entering
 * subqueries): for the clauses computed before windows are, `where`, `having`,
 * `groupBy`, a join's `on`, `set` and `returning`.
 *
 * @example
 * ```ts
 * checkNoWindows("where", condition.node);
 * ```
 *
 * @throws QueryError naming the clause and the function.
 */
export function checkNoWindows(clause: string, node: ExprNode): void {
  visit(clause, node, { references: clause === "groupBy", filters: FILTERING.has(clause) });
}

function visitAll(clause: string, nodes: readonly ExprNode[], windows: Windows): void {
  for (const node of nodes) visit(clause, node, windows);
}

function visit(clause: string, node: ExprNode, windows: Windows): void {
  switch (node.kind) {
    case "aggregate": {
      if (!Array.isArray(windows)) {
        // A clause that is computed before windows are (where, having, groupBy, set, returning).
        if (node.over !== undefined || WINDOW_ONLY.has(node.name)) {
          const what =
            node.over === undefined ? `${node.name}() is a window function` : `${node.name}() over a window`;
          throw (windows as NoWindows).filters
            ? new QueryError(
                "query.windowInFilter",
                `${clause}(): ${what}, which cannot be used in ${clause}().`,
              )
            : new QueryError(
                "query.windowInClause",
                `${clause}(): ${what}, which cannot be used in ${clause}().`,
              );
        }
        visitAll(clause, node.args, windows);
        if (node.filter !== undefined) visit(clause, node.filter, windows);
        return;
      }
      if (WINDOW_ONLY.has(node.name)) {
        if (node.over === undefined) {
          throw new QueryError(
            "query.windowFunctionOver",
            `${clause}(): ${node.name}() is a window function and needs a window.`,
            { params: { name: node.name } },
          );
        }
        if (node.filter !== undefined) {
          throw new QueryError(
            "query.windowFunctionFilter",
            `${clause}(): ${node.name}() is a window function, which takes no filter().`,
          );
        }
      }
      const over = node.over;
      if (typeof over === "string") {
        if (!windows.some((def) => def.name === over)) {
          const declared = windows.map((def) => def.name);
          throw new QueryError(
            "query.windowUndeclared",
            `${clause}(): over("${over}") names a window this query does not declare${declared.length === 0 ? "" : ` (it declares ${declared.join(", ")})`}.`,
            { params: { over } },
          );
        }
      } else if (over !== undefined) {
        visitAll(clause, over.partitionBy, windows);
        for (const item of over.orderBy) visit(clause, item.expr, windows);
      }
      visitAll(clause, node.args, windows);
      if (node.filter !== undefined) visit(clause, node.filter, windows);
      return;
    }
    case "unary":
      visit(clause, node.operand, windows);
      return;
    case "binary":
      visit(clause, node.left, windows);
      visit(clause, node.right, windows);
      return;
    case "between":
      visit(clause, node.expr, windows);
      visit(clause, node.low, windows);
      visit(clause, node.high, windows);
      return;
    case "nary":
    case "fn":
    case "fragment":
      visitAll(clause, node.args, windows);
      return;
    case "tuple":
      visitAll(clause, node.items, windows);
      return;
    case "cast":
      visit(clause, node.expr, windows);
      return;
    case "case":
      for (const branch of node.whens) {
        visit(clause, branch.when, windows);
        visit(clause, branch.result, windows);
      }
      if (node.else !== undefined) visit(clause, node.else, windows);
      return;
    case "jsonPath":
      visit(clause, node.expr, windows);
      return;
    case "selectedAs":
      if (node.expr !== undefined) visit(clause, node.expr, windows);
      else if (!Array.isArray(windows) && !(windows as NoWindows).references) {
        throw new QueryError(
          "query.selectedAsInClause",
          `${clause}(): selectedAs("${node.name}") refers to a selected value by its name, which ${clause}() cannot read: the database names selected values after this clause is computed.`,
        );
      }
      return;
    default:
      // Columns, values, literals, identifiers, `*`; and subqueries, whose windows are their own.
      return;
  }
}
