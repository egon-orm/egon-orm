/**
 * The expression functions: `and`, `or`, `not`, the aggregates, `coalesce`, `caseWhen`,
 * `exists`, `now`, and the three ways to put a value or SQL into a query: `val` (a bound
 * parameter), `lit` (a literal written into the SQL, for the few kinds that are safe) and
 * `fragment` (raw SQL from a tagged template, whose interpolations are bound too).
 *
 * @module
 */
import type { AggregateNode, ExprNode, NamedParamNode, OrderNode } from "../contracts/query.js";
import type { FieldBuilder, FieldFlags } from "../contracts/schema.js";
import type { AnyFieldType } from "../contracts/type.js";
import { QueryError } from "../errors.js";
import { own } from "../internal/own.js";
import { fieldState } from "../schema/field.js";
import {
  arrayType,
  bigintType,
  booleanType,
  floatType,
  jsonType,
  stringType,
  timestampType,
} from "../types/index.js";
import {
  aggregateNode,
  caseBranch,
  caseNode,
  castNode,
  collectParams,
  endCase,
  existsNode,
  fnNode,
  foldShape,
  fragmentNode,
  IDENTIFIER,
  identNode,
  literalNode,
  namedParamNode,
  naryNode,
  orderNode,
  paramNode,
  STAR,
  shapeOf,
  shapeOfAggregate,
  shapeOfCast,
  shapeOfFragment,
  shapeOfIdent,
  shapeOfLiteral,
  shapeOfNamedParam,
  shapeOfParam,
  shapeOfSubquery,
  shapeOfUnary,
  startCase,
  startFn,
  startNary,
  unaryNode,
  windowNode,
} from "./ast.js";
import {
  type AnyExpr,
  AS_SUBQUERY,
  booleanLiteral,
  type Checked,
  type Compatible,
  type CompatibleParams,
  Expr,
  type HasNoType,
  isSubqueryOperand,
  join,
  joinNamed,
  type MergeParams,
  NONE,
  type NoParams,
  type NoType,
  type NoTypeIf,
  NULLABLE_PARAMS,
  type Operand,
  OrderExpr,
  type ParamsOf,
  type ParamsOfAll,
  type SomeParams,
  type SubqueryOperand,
  subqueryOf,
  toOperand,
  typeArgument,
  type Untyped,
  type UntypedIf,
  type ValueOf,
} from "./expr.js";

const BOOLEAN: AnyFieldType = /* @__PURE__ */ booleanType();
const STRING: AnyFieldType = /* @__PURE__ */ stringType();
const FLOAT: AnyFieldType = /* @__PURE__ */ floatType();
const JSON_VALUE: AnyFieldType = /* @__PURE__ */ jsonType();
const TIMESTAMP: AnyFieldType = /* @__PURE__ */ timestampType();
/** `count` and `sum` over integers: the database returns a 64-bit integer, read as a `number`. */
const BIG_COUNT: AnyFieldType = /* @__PURE__ */ bigintType({ mode: "number" });

/** `null` when `T` admits it. */
type NullOf<T> = null extends T ? null : never;

type Last<A extends readonly unknown[]> = A extends readonly [...unknown[], infer L] ? L : never;

/** A plain value's type widened to its primitive: a `caseWhen` branch of `"minor"` is a `string`. */
type Widen<V> = V extends string
  ? string
  : V extends number
    ? number
    : V extends boolean
      ? boolean
      : V extends bigint
        ? bigint
        : V;

/** The type a `caseWhen` value contributes: an expression's own type, or a plain value's widened type. */
type CaseValue<V> = V extends { readonly "~expr": { readonly type: infer T } } ? T : Widen<V>;

/**
 * The type-only mark of a `CASE` after another branch `V` (owner decision of 2026-10-15):
 * once {@link Untyped}, always; while it has no type ({@link NoType}), a value with none
 * that is not text makes it `Untyped`, and a typed expression gives it a type; a typed
 * `CASE` takes plain values with its type, but an `Untyped` expression stays untyped.
 */
type CaseMark<S, V> = [S] extends [Untyped]
  ? Untyped
  : [S] extends [NoType]
    ? UntypedIf<V> & NoTypeIf<V>
    : [V] extends [Untyped]
      ? Untyped
      : unknown;

/**
 * The type-only mark of `coalesce(...A)`: when no argument has a type, the result has
 * none either ({@link NoType}), and is {@link Untyped} when one of them is not text. With
 * any typed argument, that type applies to the rest.
 */
type CoalesceMark<A extends readonly unknown[]> = false extends { [K in keyof A]: HasNoType<A[K]> }[number]
  ? unknown
  : true extends { [K in keyof A]: [UntypedIf<A[K]>] extends [Untyped] ? true : false }[number]
    ? Untyped
    : NoType;

/** Anything but `undefined`: what a branch of `caseWhen` and an interpolation of `fragment` take. */
type Value = NonNullable<unknown> | null;

/**
 * What a `fragment` interpolation takes: an expression, a query, or a value bound as a
 * parameter. Not an order item, and not a plain object (no type to write it with).
 */
type FragmentValue = Expr<unknown, SomeParams> | SubqueryOperand<unknown, SomeParams> | BoundValue;

/**
 * A value a fragment binds as one parameter: a scalar, or an array of them (one array
 * parameter). An array never holds an expression: it would be sent as an object, not as SQL.
 */
type BoundValue = string | number | bigint | boolean | Date | Uint8Array | null | readonly BoundValue[];

/** A boolean expression, as `filter`, `caseWhen` and the logical functions take it. */
type Condition = Expr<boolean | null, SomeParams>;

/** What `sum` and `avg` take: numbers, and decimals (which are strings). */
type Summable = Expr<number | bigint | string | null, SomeParams>;

type SumOf<T> = NonNullable<T> extends bigint ? bigint : NonNullable<T> extends number ? number : string;

type AvgOf<T> = NonNullable<T> extends string ? string : number;

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

/**
 * The window an aggregate is computed over (`OVER (…)`), when it is not a named one.
 *
 * @example
 * ```ts
 * const window: WindowSpec = { partitionBy: [p.authorId], orderBy: [p.createdAt.desc()] };
 * ```
 */
export interface WindowSpec {
  /** `PARTITION BY`. */
  readonly partitionBy?: readonly Expr<unknown, SomeParams>[];
  /** `ORDER BY`; a bare expression is ascending. */
  readonly orderBy?: readonly (Expr<unknown, SomeParams> | OrderExpr<SomeParams>)[];
  /** The frame clause, as a fragment: fragment`ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`. */
  readonly frame?: Expr<unknown, SomeParams>;
}

type ElementOf<X> = X extends readonly (infer E)[] ? E : never;

/** One member of a window spec, `never` when the spec does not have it. */
type Member<W, K extends string> = W extends { readonly [P in K]?: infer V } ? Exclude<V, undefined> : never;

/** The named parameters of a window spec's expressions: `partitionBy`, `orderBy` and `frame`. */
type WindowParams<W extends WindowSpec> = ParamsOfAll<
  readonly (ElementOf<Member<W, "partitionBy">> | ElementOf<Member<W, "orderBy">> | Member<W, "frame">)[]
>;

/**
 * Type only: marks an expression computed over the named window `N` (`over("w")`), so
 * that a clause can check the name against the windows its query declares. The property
 * never exists at run time.
 *
 * @example
 * ```ts
 * type Ranked = Aggregate<number> & UsesWindow<"w">; // what rowNumber().over("w") is
 * ```
 */
export interface UsesWindow<N extends string> {
  readonly "~window": N;
}

/**
 * An aggregate call: `count(p.id)`, `sum(p.views)`. Beside every expression method it has
 * `filter`, and `over` to become a window function.
 *
 * @example
 * ```ts
 * const published: Aggregate<number | null> = sum(p.views).filter(p.published);
 * ```
 */
export class Aggregate<T, P = NoParams> extends Expr<T, P> {
  /**
   * `FILTER (WHERE condition)`: aggregate only the rows that match. A second `filter`
   * is ANDed with the first.
   *
   * @example
   * ```ts
   * count(p.id).filter(p.published);
   * ```
   *
   * @throws QueryError when `condition` is not an expression.
   */
  filter<C extends Condition>(condition: C & Compatible<P, C>): Aggregate<T, MergeParams<P, ParamsOf<C>>> {
    if (!(condition instanceof Expr)) {
      throw new QueryError("query.filterCondition", "filter() takes a boolean expression.");
    }
    const agg = aggregatePart(this);
    const filter = agg.filter === undefined ? condition.node : naryNode("and", [agg.filter, condition.node]);
    return rebuild(this, aggregateNode(agg.name, agg.args, agg.distinct, filter, agg.over)) as never;
  }

  /**
   * `OVER (…)`: computes the aggregate over a window of rows instead of a group. With no
   * argument the window is every row of the result; a string names a window declared on
   * the query; an object gives `partitionBy`, `orderBy` and `frame`.
   *
   * @example
   * ```ts
   * sum(p.views).over({ partitionBy: [p.authorId] });
   * count().over("w");
   * ```
   *
   * @throws QueryError when the aggregate already has a window, or the window is malformed.
   */
  over(): Aggregate<T, P>;
  over<const N extends string>(name: N): Aggregate<T, P> & UsesWindow<N>;
  over<W extends WindowSpec>(
    spec: W & CompatibleParams<P, WindowParams<W>>,
  ): Aggregate<T, MergeParams<P, WindowParams<W>>>;
  over(window?: string | WindowSpec): AnyExpr {
    const agg = aggregatePart(this);
    if (agg.over !== undefined)
      throw new QueryError("query.overTwice", "over() was already called on this aggregate.");
    return rebuild(this, aggregateNode(agg.name, agg.args, agg.distinct, agg.filter, windowOf(window)));
  }
}

/** The aggregate node of an aggregate expression (`avg` wraps its node in a cast). */
function aggregatePart(expr: AnyExpr): AggregateNode {
  const node = expr.node;
  return (node.kind === "cast" ? node.expr : node) as AggregateNode;
}

/** A changed aggregate. It is small, so its params and shape are collected again by walking it. */
function rebuild(previous: AnyExpr, agg: AggregateNode): AnyExpr {
  const node: ExprNode = previous.node.kind === "cast" ? castNode(agg, previous.node.type) : agg;
  const params: unknown[] = [];
  const lists: number[] = [];
  const named: NamedParamNode[] = [];
  collectParams(node, params, lists, named);
  // The same check as joining expressions: one name, one type.
  for (let i = 0; i < named.length; i++) joinNamed(named.slice(0, i), named.slice(i, i + 1));
  return new Aggregate(
    node,
    previous.type,
    previous.redact,
    params.length === 0 ? NONE : params,
    lists.length === 0 ? NONE : lists,
    named.length === 0 ? NONE : named,
    shapeOf(node),
  );
}

function windowOf(window: string | WindowSpec | undefined): AggregateNode["over"] {
  if (window === undefined) return windowNode(NONE, NONE, undefined);
  if (typeof window === "string") {
    if (!IDENTIFIER.test(window)) {
      throw new QueryError(
        "query.overName",
        "over() takes the name of a window declared on the query, an identifier (/^[A-Za-z_][A-Za-z0-9_$]*$/), or a window.",
      );
    }
    return window;
  }
  if (typeof window !== "object" || window === null) {
    throw new QueryError(
      "query.overArgument",
      "over() takes the name of a window, or { partitionBy, orderBy, frame }.",
    );
  }
  const partitionBy: ExprNode[] = [];
  for (const item of own(window, "partitionBy") ?? NONE)
    partitionBy.push(expressionArgument(item, "over").node);
  const orderBy: OrderNode[] = [];
  for (const item of own(window, "orderBy") ?? NONE) {
    if (item instanceof OrderExpr) orderBy.push(item.node);
    else orderBy.push(orderNode(expressionArgument(item, "over").node, "asc", undefined));
  }
  let frame: ExprNode | undefined;
  const given = own(window, "frame");
  if (given !== undefined) {
    frame = expressionArgument(given, "over").node;
    if (frame.kind !== "fragment") {
      throw new QueryError("query.overFrame", "over(): frame is a fragment.");
    }
  }
  return windowNode(partitionBy, orderBy, frame?.kind === "fragment" ? frame : undefined);
}

function expressionArgument(value: unknown, method: string): AnyExpr {
  if (value instanceof Expr) return value;
  throw new QueryError("query.aggregateArgument", `${method}() takes an expression.`);
}

function aggregate(
  name: string,
  args: readonly AnyExpr[],
  distinct: boolean,
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
  if (args.length === 0) {
    nodes.push(STAR);
    shapes.push(STAR_SHAPE);
  }
  return new Aggregate(
    aggregateNode(name, nodes, distinct, undefined, undefined),
    type,
    redact,
    params,
    lists,
    named,
    shapeOfAggregate(name, shapes, distinct, undefined, undefined),
  );
}

const STAR_SHAPE = /* @__PURE__ */ shapeOf(STAR);

/** `count(*)`, shared: expressions are immutable, and it has no parts to vary. */
const COUNT_ROWS: AnyExpr = /* @__PURE__ */ aggregate("count", NONE, false, BIG_COUNT, false);

const NUMERIC_KINDS: ReadonlySet<string> = /* @__PURE__ */ new Set([
  "integer",
  "bigint",
  "float",
  "decimal",
  "custom",
]);

function numericArgument(value: unknown, method: string): AnyExpr {
  const expr = expressionArgument(value, method);
  if (expr.type !== undefined && !NUMERIC_KINDS.has(expr.type.db.kind)) {
    throw new QueryError(
      "query.sumType",
      `${method}() adds up numbers, and this expression has the type ${expr.type.name}.`,
    );
  }
  return expr;
}

/**
 * `count(*)` with no argument: the number of rows. `count(x)`: the number of rows where
 * `x` is not `null`. Always a `number`.
 *
 * @example
 * ```ts
 * count();
 * count(p.id);
 * ```
 *
 * @throws QueryError when the argument is not an expression.
 */
export function count(): Aggregate<number>;
export function count<X extends Expr<unknown, SomeParams>>(expr: X): Aggregate<number, ParamsOf<X>>;
export function count(...args: readonly unknown[]): AnyExpr {
  if (args.length === 0) return COUNT_ROWS;
  return aggregate("count", [expressionArgument(args[0], "count")], false, BIG_COUNT, false);
}

/**
 * `count(DISTINCT x)`: the number of different non-null values.
 *
 * @example
 * ```ts
 * countDistinct(p.authorId);
 * ```
 *
 * @throws QueryError when the argument is not an expression.
 */
export function countDistinct<X extends Expr<unknown, SomeParams>>(expr: X): Aggregate<number, ParamsOf<X>> {
  return aggregate("count", [expressionArgument(expr, "countDistinct")], true, BIG_COUNT, false) as never;
}

/**
 * `sum(x)`: `null` over no rows. Over integers the result is a `number`; a sum that may
 * pass `Number.MAX_SAFE_INTEGER` should be cast: `sum(p.views).cast(t.bigint())`.
 *
 * @example
 * ```ts
 * sum(p.views);
 * ```
 *
 * @throws QueryError when the argument is not an expression, or has a known type that is not a number.
 */
export function sum<X extends Summable>(expr: X): Aggregate<SumOf<ValueOf<X>> | null, ParamsOf<X>> {
  const arg = numericArgument(expr, "sum");
  // The database widens a sum of integers (to bigint on Postgres); read it back as a number.
  const type = arg.type?.db.kind === "integer" ? BIG_COUNT : arg.type;
  return aggregate("sum", [arg], false, type, arg.redact) as never;
}

/**
 * `avg(x)`: `null` over no rows. Over numbers the result is a `number` (the SQL casts the
 * average to a float, since the database computes it as a decimal); over decimals it stays
 * a decimal string.
 *
 * @example
 * ```ts
 * avg(u.age);
 * ```
 *
 * @throws QueryError when the argument is not an expression, or has a known type that is not a number.
 */
export function avg<X extends Summable>(expr: X): Aggregate<AvgOf<ValueOf<X>> | null, ParamsOf<X>> {
  const arg = numericArgument(expr, "avg");
  if (arg.type?.db.kind === "decimal") return aggregate("avg", [arg], false, arg.type, arg.redact) as never;
  const agg = aggregate("avg", [arg], false, FLOAT, arg.redact);
  return new Aggregate(
    castNode(agg.node, FLOAT),
    FLOAT,
    arg.redact,
    agg.params,
    agg.lists,
    agg.named,
    shapeOfCast(agg.shape, FLOAT),
  ) as never;
}

/**
 * `min(x)`: the smallest value; `null` over no rows.
 *
 * @example
 * ```ts
 * min(p.createdAt);
 * ```
 *
 * @throws QueryError when the argument is not an expression.
 */
export function min<X extends Expr<unknown, SomeParams>>(
  expr: X,
): Aggregate<NonNullable<ValueOf<X>> | null, ParamsOf<X>> {
  const arg = expressionArgument(expr, "min");
  return aggregate("min", [arg], false, arg.type, arg.redact) as never;
}

/**
 * `max(x)`: the largest value; `null` over no rows.
 *
 * @example
 * ```ts
 * max(p.createdAt);
 * ```
 *
 * @throws QueryError when the argument is not an expression.
 */
export function max<X extends Expr<unknown, SomeParams>>(
  expr: X,
): Aggregate<NonNullable<ValueOf<X>> | null, ParamsOf<X>> {
  const arg = expressionArgument(expr, "max");
  return aggregate("max", [arg], false, arg.type, arg.redact) as never;
}

/**
 * `array_agg(x)`: the values as an array; `null` over no rows.
 *
 * @example
 * ```ts
 * arrayAgg(p.title);
 * ```
 *
 * @throws QueryError when the argument is not an expression.
 */
export function arrayAgg<X extends Expr<unknown, SomeParams>>(
  expr: X,
): Aggregate<ValueOf<X>[] | null, ParamsOf<X>> {
  const arg = expressionArgument(expr, "arrayAgg");
  const type = arg.type === undefined ? undefined : arrayType(arg.type);
  return aggregate("arrayAgg", [arg], false, type, arg.redact) as never;
}

/**
 * `json_agg(x)`: the values as a JSON array; `null` over no rows. Values come back as
 * JSON (a date as a string), so the elements are `unknown`; assert them with `as`.
 *
 * @example
 * ```ts
 * jsonAgg(p.title).as<string[] | null>();
 * ```
 *
 * @throws QueryError when the argument is not an expression.
 */
export function jsonAgg<X extends Expr<unknown, SomeParams>>(
  expr: X,
): Aggregate<unknown[] | null, ParamsOf<X>> {
  const arg = expressionArgument(expr, "jsonAgg");
  return aggregate("jsonAgg", [arg], false, JSON_VALUE, arg.redact) as never;
}

/**
 * `string_agg(x, separator)`: the values joined with `separator`; `null` over no rows.
 *
 * @example
 * ```ts
 * stringAgg(p.title, ", ");
 * ```
 *
 * @throws QueryError when the first argument is not an expression, or the separator is `null` or `undefined`.
 */
export function stringAgg<
  X extends Expr<string | null, SomeParams>,
  S extends string | Expr<string | null, SomeParams>,
>(
  expr: X,
  separator: S & Checked<ParamsOf<X>, S>,
): Aggregate<string | null, MergeParams<ParamsOf<X>, ParamsOf<S>>> {
  const arg = expressionArgument(expr, "stringAgg");
  const sep = toOperand(separator, STRING, false, "stringAgg", false);
  return aggregate("stringAgg", [arg, sep], false, STRING, arg.redact) as never;
}

// ---------------------------------------------------------------------------
// Logic
// ---------------------------------------------------------------------------

function conditions(values: readonly unknown[], method: string): AnyExpr[] {
  const out: AnyExpr[] = [];
  for (const value of values) {
    if (!(value instanceof Expr)) {
      throw new QueryError("query.booleanArguments", `${method}() takes boolean expressions.`);
    }
    out.push(value);
  }
  return out;
}

function nary(op: "and" | "or", values: readonly unknown[]): AnyExpr {
  const args = conditions(values, op);
  const first = args[0];
  if (first === undefined) return booleanLiteral(op === "and");
  if (args.length === 1) return first;
  const nodes: ExprNode[] = [];
  let params: readonly unknown[] = NONE;
  let lists: readonly number[] = NONE;
  let named: readonly NamedParamNode[] = NONE;
  let shape = startNary(op);
  for (const arg of args) {
    nodes.push(arg.node);
    params = join(params, arg.params);
    lists = join(lists, arg.lists);
    named = joinNamed(named, arg.named);
    shape = foldShape(shape, arg.shape);
  }
  return new Expr(naryNode(op, nodes), BOOLEAN, false, params, lists, named, shape);
}

/**
 * `a AND b AND …`. With no argument it is `true`; with one, that argument.
 *
 * @example
 * ```ts
 * and(u.age.gte(18), u.role.eq("admin"), p.published);
 * ```
 *
 * @throws QueryError when an argument is not an expression.
 */
export function and<const A extends readonly Condition[]>(...conditions: A): Expr<boolean, ParamsOfAll<A>> {
  return nary("and", conditions) as never;
}

/**
 * `a OR b OR …`. With no argument it is `false`; with one, that argument.
 *
 * @example
 * ```ts
 * or(u.role.eq("admin"), u.age.gte(65));
 * ```
 *
 * @throws QueryError when an argument is not an expression.
 */
export function or<const A extends readonly Condition[]>(...conditions: A): Expr<boolean, ParamsOfAll<A>> {
  return nary("or", conditions) as never;
}

/**
 * `NOT x`.
 *
 * @example
 * ```ts
 * not(p.published);
 * ```
 *
 * @throws QueryError when the argument is not an expression.
 */
export function not<X extends Condition>(condition: X): Expr<boolean, ParamsOf<X>> {
  const [arg] = conditions([condition], "not");
  const operand = arg as AnyExpr;
  return new Expr(
    unaryNode("not", operand.node),
    BOOLEAN,
    false,
    operand.params,
    operand.lists,
    operand.named,
    shapeOfUnary("not", operand.shape),
  ) as never;
}

// ---------------------------------------------------------------------------
// Other functions
// ---------------------------------------------------------------------------

/**
 * `coalesce(a, b, …)`: the first argument that is not `null`. The result is nullable only
 * when the last argument is. Plain values are bound with the type of `first`.
 *
 * @example
 * ```ts
 * coalesce(u.name, u.email); // Expr<string>
 * coalesce(sum(p.views), 0); // Expr<number>
 * ```
 *
 * @throws QueryError when `first` is not an expression or an argument is `null` or `undefined`.
 */
export function coalesce<
  F extends Expr<unknown, SomeParams>,
  const R extends readonly [Operand<ValueOf<F>>, ...Operand<ValueOf<F>>[]],
>(
  first: F,
  ...rest: R
): Expr<NonNullable<ValueOf<F>> | NullOf<ValueOf<Last<R>>>, ParamsOfAll<[F, ...R]>> &
  CoalesceMark<[F, ...R]> {
  const head = expressionArgument(first, "coalesce");
  if (rest.length === 0)
    throw new QueryError("query.coalesceArguments", "coalesce() needs at least two arguments.");
  const nodes: ExprNode[] = [head.node];
  let params = head.params;
  let lists = head.lists;
  let named = head.named;
  let shape = foldShape(startFn("coalesce"), head.shape);
  for (const value of rest) {
    const arg = toOperand(value, head.type, head.redact, "coalesce", false);
    nodes.push(arg.node);
    params = join(params, arg.params);
    lists = join(lists, arg.lists);
    named = joinNamed(named, arg.named);
    shape = foldShape(shape, arg.shape);
  }
  return new Expr(fnNode("coalesce", nodes), head.type, head.redact, params, lists, named, shape) as never;
}

const NOW: AnyExpr = /* @__PURE__ */ new Expr(
  /* @__PURE__ */ fnNode("now", NONE),
  TIMESTAMP,
  false,
  NONE,
  NONE,
  NONE,
  /* @__PURE__ */ startFn("now"),
);

/**
 * `now()`: the database's current time (the start of the transaction on Postgres).
 *
 * @example
 * ```ts
 * p.publishedAt.lte(now());
 * ```
 */
export function now(): Expr<Date> {
  return NOW as never;
}

/**
 * `CASE WHEN … THEN … [WHEN …] [ELSE …] END`. Without `else` the result is `null` when no
 * branch matches. Plain values are bound, with the type of an earlier expression branch.
 *
 * @example
 * ```ts
 * caseWhen(u.age.lt(13), "child").when(u.age.lt(18), "teen").else("adult");
 * ```
 *
 * @throws QueryError when a condition is not an expression or a value is `undefined`.
 */
export class Case<T, P = NoParams> extends Expr<T | null, P> {
  /** The shape of the branches so far, before the `ELSE`. */
  readonly branchesShape: number;

  /**
   * Internal: made by {@link caseWhen}.
   *
   * @example
   * ```ts
   * new Case(node, type, false, params, lists, named, shape, branchesShape);
   * ```
   */
  constructor(
    node: ExprNode,
    type: AnyFieldType | undefined,
    redact: boolean,
    params: readonly unknown[],
    lists: readonly number[],
    named: readonly NamedParamNode[],
    shape: number,
    branchesShape: number,
  ) {
    super(node, type, redact, params, lists, named, shape);
    this.branchesShape = branchesShape;
  }

  /**
   * Another `WHEN condition THEN value`.
   *
   * @example
   * ```ts
   * caseWhen(u.age.lt(13), "child").when(u.age.lt(18), "teen");
   * ```
   *
   * @throws QueryError when `condition` is not an expression or `value` is `undefined`.
   */
  when<C extends Condition, V extends Value>(
    condition: C & Compatible<P, C>,
    value: V & Compatible<MergeParams<P, ParamsOf<C>>, V>,
  ): Case<T | CaseValue<V>, MergeParams<P, MergeParams<ParamsOf<C>, ParamsOf<V>>>> & CaseMark<this, V> {
    return branch(this, condition, value) as never;
  }

  /**
   * `ELSE value`, which ends the expression.
   *
   * @example
   * ```ts
   * caseWhen(u.age.lt(18), "minor").else("adult");
   * ```
   *
   * @throws QueryError when `value` is `undefined`.
   */
  else<V extends Value>(
    value: V & Compatible<P, V>,
  ): Expr<T | CaseValue<V>, MergeParams<P, ParamsOf<V>>> & CaseMark<this, V> {
    const node = this.node as Extract<ExprNode, { kind: "case" }>;
    const otherwise = toOperand(value, this.type, this.redact, "else", false, true);
    return new Expr(
      caseNode(node.whens, otherwise.node),
      this.type ?? otherwise.type,
      this.redact || otherwise.redact,
      join(this.params, otherwise.params),
      join(this.lists, otherwise.lists),
      joinNamed(this.named, otherwise.named),
      endCase(this.branchesShape, otherwise.shape),
    ) as never;
  }
}

function branch(
  previous: Case<unknown, SomeParams> | undefined,
  condition: unknown,
  value: unknown,
): AnyExpr {
  const method = previous === undefined ? "caseWhen" : "when";
  if (!(condition instanceof Expr)) {
    throw new QueryError("query.caseCondition", `${method}() takes a boolean expression as its condition.`);
  }
  // A plain value is bound with the type and redaction of the branches before it.
  const then = toOperand(value, previous?.type, previous?.redact ?? false, method, false, true);
  const whens =
    previous === undefined ? [] : (previous.node as Extract<ExprNode, { kind: "case" }>).whens.slice();
  whens.push({ when: condition.node, result: then.node });
  const branchesShape = caseBranch(previous?.branchesShape ?? startCase(), condition.shape, then.shape);
  return new Case(
    caseNode(whens, undefined),
    previous?.type ?? then.type,
    (previous?.redact ?? false) || then.redact,
    join(join(previous?.params ?? NONE, condition.params), then.params),
    join(join(previous?.lists ?? NONE, condition.lists), then.lists),
    joinNamed(joinNamed(previous?.named ?? NONE, condition.named), then.named),
    endCase(branchesShape, undefined),
    branchesShape,
  );
}

/**
 * Starts a `CASE` expression: `WHEN condition THEN value`. Chain `.when(…)` for more
 * branches and `.else(…)` for the value when none matches.
 *
 * @example
 * ```ts
 * caseWhen(u.age.lt(18), "minor").else("adult");
 * ```
 *
 * @throws QueryError when `condition` is not an expression or `value` is `undefined`.
 */
export function caseWhen<C extends Condition, V extends Value>(
  condition: C,
  value: V & Compatible<ParamsOf<C>, V>,
): Case<CaseValue<V>, MergeParams<ParamsOf<C>, ParamsOf<V>>> & UntypedIf<V> & NoTypeIf<V> {
  return branch(undefined, condition, value) as never;
}

/**
 * `EXISTS (query)`: whether the query returns any row.
 *
 * @example
 * ```ts
 * exists(from(Post, "p").where(({ p }) => p.authorId.eq(outerRef("u", User).id)));
 * ```
 *
 * @throws QueryError when the argument is not a query.
 */
export function exists<Q extends SubqueryOperand<unknown, SomeParams>>(query: Q): Expr<boolean, ParamsOf<Q>> {
  if (typeof query !== "object" || query === null || typeof query[AS_SUBQUERY] !== "function") {
    throw new QueryError("query.existsQuery", "exists() takes a query.");
  }
  const sub = subqueryOf(query, "exists");
  return new Expr(
    existsNode(sub.node.query),
    BOOLEAN,
    false,
    sub.params,
    sub.lists,
    sub.named,
    shapeOfSubquery("exists", sub.node.query.shape),
  ) as never;
}

// ---------------------------------------------------------------------------
// Values and raw SQL
// ---------------------------------------------------------------------------

/**
 * An explicit bound parameter, for a value whose type cannot come from the other side of
 * an operator (in a `select`, in a fragment, as the first argument). Pass a field type to
 * dump the value with it. Without one, the expression has the value's plain TypeScript
 * type (`val(5)` is an `Expr<number>`), or a literal one where the other side asks for it
 * (`u.role.eq(val("admin"))`).
 *
 * @example
 * ```ts
 * val(new Date(), t.timestamp());
 * val("member");
 * ```
 *
 * @throws QueryError when `value` is `undefined`, or `type` is not a field type.
 */
export function val<T, F extends FieldFlags>(value: NoInfer<T>, type: FieldBuilder<T, F>): Expr<T>;
export function val<T>(value: T): Expr<T> & ([T] extends [string | null] ? NoType : Untyped);
export function val(value: unknown, type?: unknown): AnyExpr {
  if (value === undefined) throw new QueryError("query.valUndefined", "val() was given undefined.");
  const fieldType = type === undefined ? undefined : typeArgument(type, "val");
  return new Expr(
    paramNode(value, fieldType, false),
    fieldType,
    false,
    [value],
    NONE,
    NONE,
    shapeOfParam(fieldType, false),
  );
}

/**
 * A literal written into the SQL text, for the kinds that are safe there: `true`, `false`,
 * `null` and finite numbers. Everything else is a bound parameter (`val`).
 *
 * @example
 * ```ts
 * lit(true);
 * lit(0);
 * ```
 *
 * @throws QueryError for any other value.
 */
export function lit<const V extends boolean | number | null>(
  value: V,
): Expr<V extends boolean ? boolean : V extends number ? number : null> {
  const node = literalNode(value);
  return new Expr(
    node,
    typeof value === "boolean" ? BOOLEAN : undefined,
    false,
    NONE,
    NONE,
    NONE,
    shapeOfLiteral(node.value),
  ) as never;
}

/**
 * A named parameter: a placeholder whose value is supplied when the query runs,
 * `repo.all(q, { minAge: 18 })`. The query's type requires every name it uses.
 *
 * @example
 * ```ts
 * u.age.gte(param("minAge", t.integer()));
 * ```
 *
 * @throws QueryError when `name` is empty or `type` is not a field type.
 */
export function param<const N extends string, T, F extends FieldFlags>(
  name: N,
  type: FieldBuilder<T, F>,
): Expr<T, { [K in N]: T }> {
  if (typeof name !== "string" || name === "") {
    throw new QueryError("query.paramArguments", "param() takes a name and a field type.");
  }
  const fieldType = typeArgument(type, "param");
  const node = namedParamNode(name, fieldType, false);
  // Whether the value may be null is part of the parameter's type, like the field type.
  if (fieldState(type)?.nullable === true) NULLABLE_PARAMS.add(node);
  return new Expr(
    node,
    fieldType,
    false,
    NONE,
    NONE,
    [node],
    shapeOfNamedParam(name, fieldType, false),
  ) as never;
}

/**
 * The `fragment` tag, and `fragment.ident` for a dynamic identifier.
 *
 * @example
 * ```ts
 * const lowerEmail: Expr<unknown> = fragment`lower(${u.email})`;
 * ```
 */
export interface FragmentFunction {
  /** Raw SQL: the template's literal parts are SQL text, every interpolation is an expression or a bound value. */
  <const A extends readonly FragmentValue[]>(
    strings: TemplateStringsArray,
    ...args: A
  ): Expr<unknown, ParamsOfAll<A>>;
  /**
   * An identifier (a column, table or function name) chosen at run time, checked against
   * `/^[A-Za-z_][A-Za-z0-9_$]*$/` and quoted.
   */
  ident(name: string): Expr<unknown>;
}

function isTemplate(strings: unknown, args: number): strings is TemplateStringsArray {
  if (!Array.isArray(strings) || !Object.isFrozen(strings) || strings.length !== args + 1) return false;
  const raw: unknown = (strings as { readonly raw?: unknown }).raw;
  if (!Array.isArray(raw) || raw.length !== strings.length) return false;
  for (const text of strings as readonly unknown[]) if (typeof text !== "string") return false;
  return true;
}

function fragmentTag(strings: TemplateStringsArray, ...args: unknown[]): AnyExpr {
  if (!isTemplate(strings, args.length)) {
    throw new QueryError("query.fragmentCall", "fragment is a tagged template.");
  }
  const nodes: ExprNode[] = [];
  const shapes: number[] = [];
  let params: readonly unknown[] = NONE;
  let lists: readonly number[] = NONE;
  let named: readonly NamedParamNode[] = NONE;
  for (const value of args) {
    const arg = fragmentArgument(value);
    nodes.push(arg.node);
    shapes.push(arg.shape);
    params = join(params, arg.params);
    lists = join(lists, arg.lists);
    named = joinNamed(named, arg.named);
  }
  return new Expr(
    fragmentNode(strings, nodes),
    undefined,
    false,
    params,
    lists,
    named,
    shapeOfFragment(strings, shapes),
  );
}

/**
 * One interpolation of a fragment as an expression. An expression is used as it is, a
 * query becomes a subquery, and a value is bound: a string, number, bigint, boolean,
 * `Date`, bytes, an array (one array parameter) or `null`. Any other object is refused: an
 * order item is not an expression, and a plain object has no type to be written with
 * (pass `val(object, t.json())`).
 */
function fragmentArgument(value: unknown): AnyExpr {
  if (value instanceof Expr) return value;
  if (typeof value === "object" && value !== null && isSubqueryOperand(value))
    return subqueryOf(value, "fragment");
  if (value instanceof OrderExpr) {
    throw new QueryError(
      "query.fragmentOrderItem",
      "fragment() was given an order item (asc() or desc()), which is not an expression.",
    );
  }
  if (value !== undefined && !isBoundValue(value)) {
    throw new QueryError(
      "query.fragmentValue",
      "fragment() binds strings, numbers, bigints, booleans, dates, bytes, null, and arrays of those (one array parameter).",
    );
  }
  return toOperand(value, undefined, false, "fragment", false, true);
}

/** Whether `value` is a {@link BoundValue}: a scalar, or an array of them at any depth. */
function isBoundValue(value: unknown): boolean {
  switch (typeof value) {
    case "string":
    case "number":
    case "bigint":
    case "boolean":
      return true;
    case "object":
      if (value === null || value instanceof Date || value instanceof Uint8Array) return true;
      if (!Array.isArray(value)) return false;
      for (const item of value as readonly unknown[]) if (!isBoundValue(item)) return false;
      return true;
    default:
      return false;
  }
}

function ident(name: string): AnyExpr {
  const node = identNode(name);
  return new Expr(node, undefined, false, NONE, NONE, NONE, shapeOfIdent(node.name));
}

/**
 * Raw SQL, as a tagged template. The literal parts become SQL text; every interpolation
 * becomes an expression or a bound parameter, never text. The result is `unknown` until
 * typed with `.as<T>()` or `.cast(type)`.
 *
 * @example
 * ```ts
 * fragment`lower(${u.email})`.as<string>();
 * fragment`similarity(${u.name}, ${search}) > ${0.3}`.as<boolean>();
 * fragment`${fragment.ident(column)} @@ plainto_tsquery(${query})`.as<boolean>();
 * ```
 *
 * @throws QueryError when called as an ordinary function, when an interpolation is
 * `undefined`, and (`ident`) when a name is not a plain identifier.
 */
export const fragment: FragmentFunction = /* @__PURE__ */ Object.assign(fragmentTag, {
  ident,
}) as FragmentFunction;
