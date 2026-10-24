/**
 * The query builder: {@link from} and the immutable {@link Query} value with its clauses.
 *
 * A `Query` wraps a {@link QueryAst}. Every method returns a new `Query` around a new AST
 * that shares every array and node the method did not change. Beside the AST, a query
 * keeps what lets a clause be added in time proportional to the clause, never to the
 * query: for each top-level property of the AST, the number of parameter values and of
 * lists it holds and its structural hash. A new clause's values are spliced into
 * `ast.params` at the offset those counts give, and `ast.shape` is the per-property hashes
 * combined, so both stay **canonical** (`contracts/query.ts`): they depend on what the
 * query is, not on the order its clauses were added.
 *
 * Clause callbacks run once, when the clause is added, with the query's bindings
 * (`bindings.ts`); their result is checked and turned into AST nodes there and then.
 *
 * @module
 */
import type {
  BinaryOp,
  BoolNode,
  DistinctNode,
  ExprNode,
  FragmentNode,
  JoinNode,
  JoinType,
  LockNode,
  NamedParamNode,
  OrderNode,
  PreloadNode,
  QueryAst,
  QueryNode,
  SelectNode,
  SelectShape,
  SourceNode,
  TableSourceNode,
  UnaryOp,
  WindowNode,
} from "../contracts/query.js";
import type {
  AnySchema,
  AssocKeys,
  AssocMeta,
  LoadedAs,
  LoadedUnchecked,
  PreloadElement,
  PreloadKey,
  Row,
  SchemaMeta,
  Target,
} from "../contracts/schema.js";
import type { AnyFieldType } from "../contracts/type.js";
import { QueryError, rewrap, shortMessageOf } from "../errors.js";
import { HASH_SEED, hashInt, hashString } from "../internal/hash.js";
import { own } from "../internal/own.js";
import { isPlainObject } from "../internal/plain-object.js";
import { isSchema } from "../schema/guards.js";
import { meta } from "../schema/schema.js";
import { integerType } from "../types/index.js";
import { assignments, RETURNING_SELECTS } from "./advanced/assignments.js";
import {
  checkCombination,
  combinationNode,
  combinationShape,
  type SetOperation,
} from "./advanced/set-operations.js";
import {
  checkNoWindows,
  checkWindow,
  checkWindows,
  collectWindows,
  type NoWindowCheck,
  selectExpressions,
  type WindowCheck,
  type WindowDefParams,
  type WindowDefs,
  windowDef,
  windowNames,
} from "./advanced/windows.js";
import { type CteOptions, cteShape, withCteNode } from "./advanced/with-cte.js";
import {
  collectParams,
  columnNode,
  combineQueryShape,
  optionalShape,
  orderNode,
  paramNode,
  shapeOf,
  shapeOfColumn,
  shapeOfOrder,
  shapeOfParam,
  shapeOfSubquery,
  subqueryNode,
} from "./ast.js";
import {
  type AnyBinding,
  type Binding,
  bindingInfo,
  bindingOf,
  type ColumnNames,
  type NullableBinding,
  type SchemaOfBinding,
} from "./bindings.js";
import {
  type AnyExpr,
  AS_SUBQUERY,
  Expr,
  isExpr,
  join,
  joinNamed,
  NONE,
  type NoParams,
  OrderExpr,
  type ParamsOf,
  type ParamsOfAll,
  type SomeParams,
  type SubqueryOperand,
  type Untyped,
} from "./expr.js";
import { and } from "./functions.js";
import { type BuiltSelect, buildSelect, mergeSelects, type Sel } from "./select.js";

// ---------------------------------------------------------------------------
// Sources (the protocol step 09's `subquery(q)` and `cte(...)` implement)
// ---------------------------------------------------------------------------

/**
 * The method by which a source wrapper (`subquery(q)`, `cte(name, shape)`) becomes the
 * source of a binding: `from(subquery(q), "s")`, `.join(cte("tree", Category), "t", …)`.
 * It is called once per use, with the binding's alias.
 *
 * @example
 * ```ts
 * class Cte {
 *   [AS_SOURCE](alias: string): SourceParts {
 *     return { node: cteSourceNode(this.name, meta, alias), binding, meta, params: [], lists: [], named: [] };
 *   }
 * }
 * ```
 */
export const AS_SOURCE: unique symbol = /* @__PURE__ */ Symbol.for("egon.asSource");

/**
 * What a source wrapper gives the builder for one binding: the source node, the binding
 * object the callbacks receive (registered with `registerBinding` when it can be selected
 * whole), the schema metadata of its rows when it has one, and the parameters of the
 * source node in canonical order.
 *
 * @example
 * ```ts
 * const parts: SourceParts = { node, binding, meta: undefined, params: [], lists: [], named: [] };
 * ```
 */
export interface SourceParts {
  readonly node: SourceNode;
  readonly binding: object;
  readonly meta: SchemaMeta | undefined;
  readonly params: readonly unknown[];
  readonly lists: readonly number[];
  readonly named: readonly NamedParamNode[];
}

/**
 * A source wrapper: something `from` and the joins take besides a schema class. `Bd` is
 * the binding the callbacks receive, `Rw` the row a query over it returns, `P` the named
 * parameters it needs.
 *
 * @example
 * ```ts
 * declare const recent: SourceOperand<{ readonly n: Col<number> } & AnyBinding, { n: number }, NoParams>;
 * from(recent, "r").where(({ r }) => r.n.gt(5));
 * ```
 */
export interface SourceOperand<Bd, Rw, P> {
  /** Type information only; there is no such property at run time. */
  readonly "~source": { readonly binding: Bd; readonly row: Rw; readonly params: (params: P) => void };
  [AS_SOURCE](alias: string): SourceParts;
}

/** What `from` and the joins take: a schema class or a source wrapper. */
type Source = AnySchema | SourceOperand<AnyBinding, unknown, SomeParams>;

/** The binding a source gives. */
type BindingOfSource<Src> = Src extends AnySchema
  ? Binding<Src>
  : Src extends { readonly "~source": { readonly binding: infer Bd } }
    ? Bd
    : never;

/** The row a query over a source returns when it selects nothing. */
type RowOfSource<Src> = Src extends AnySchema
  ? Row<Src>
  : Src extends { readonly "~source": { readonly row: infer Rw } }
    ? Rw
    : never;

/** The named parameters a source needs. */
type ParamsOfSource<Src> = Src extends AnySchema
  ? NoParams
  : Src extends { readonly "~source": { readonly params: (params: infer Q) => void } }
    ? Q
    : never;

// ---------------------------------------------------------------------------
// Type-level helpers
// ---------------------------------------------------------------------------

/** A condition: what `where`, `having` and `on` callbacks return. */
type Condition = Expr<boolean | null, SomeParams>;

/**
 * The query `Q` with the named parameters `X` added: `Q` itself when there are none.
 *
 * It is a conditional type that infers `Q`'s parts from its `"~query"` (matching the small
 * `"~query"` object, not the class, keeps it cheap for the compiler when `Q` is the
 * intersection `hasNamedBinding` narrows to). Inside a reusable scope, where `Q` is a type
 * parameter, the compiler reads such a type through `Q`'s constraint, so the next clause in
 * the scope sees the bindings the scope declared; once the scope is called, the result is
 * exact. The inferred bindings are constrained to `object`, so the result is provably a
 * `QueryWith`: a scope called inside another scope then infers its `Q` from it, instead of
 * falling back to its own constraint. Unlike an intersection with `Q`, the result is not
 * assignable to `Q`'s type, so a query cannot be assigned where its params are not required.
 */
type AddParams<Q extends QueryLike, X> = [keyof X] extends [never]
  ? Q
  : Q extends {
        readonly "~query": {
          readonly bindings: infer B2 extends object;
          readonly result: infer R2;
          readonly params: (params: infer P2) => void;
          readonly root: infer A2 extends string;
        };
      }
    ? Query<B2, R2, JoinParams<P2, X>, A2, WindowsOf<Q>>
    : never;

/** `P` with the named parameters `X` added. */
type WithParams<P, X> = [keyof X] extends [never] ? P : JoinParams<P, X>;

/** Whether `A` and `B` are each assignable to the other: one type for a named parameter. */
type SameType<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * The named parameters of a query with those of a clause added. A name both use keeps its
 * type only when the two types are the same (each assignable to the other); otherwise it is
 * `never`, so no value can be given and the query cannot run. A plain intersection would
 * accept a narrower common type instead (`number` for `number` and `number | null`, `"a"`
 * for two enums sharing `"a"`). Unknown parameters (`never`) stay unknown.
 */
type JoinParams<A, B> = [A] extends [never]
  ? never
  : [B] extends [never]
    ? never
    : {
        [K in keyof A | keyof B]: K extends keyof A
          ? K extends keyof B
            ? SameType<A[K], B[K]> extends true
              ? A[K]
              : never
            : A[K]
          : K extends keyof B
            ? B[K]
            : never;
      };

/** Refuses an alias that the query already has, at compile time. */
type NewAlias<A extends string, B> = A extends keyof B
  ? { readonly "~error": `the alias "${A}" is already used in this query` }
  : unknown;

/** The binding of the root of a query. */
type RootBinding<B, A extends string> = A extends keyof B ? B[A] : never;

/**
 * The schema of the root binding. When the root is not known (`A` is `string`, as in
 * {@link QueryWith}), any schema.
 */
type RootSchema<B, A extends string> = string extends A ? AnySchema : SchemaOfBinding<RootBinding<B, A>>;

/** The row of the root binding (`| null` once a right or full join makes it optional); `unknown` when the root is not known. */
type RootRow<B, A extends string> = string extends A
  ? unknown
  : RootBinding<B, A> extends { readonly "~binding": { readonly row: infer Rw; readonly nullable: infer N } }
    ? [N] extends [false]
      ? Rw
      : Rw | null
    : never;

/** Every binding of `B` made nullable (a right or full join). */
type NullableAll<B> = { readonly [K in keyof B]: NullableBinding<B[K]> };

/**
 * A value of the object form of `where`: the field's value, `null` when the field is
 * nullable, and for a scalar field a list of values (`IN`). A field whose value is an
 * array or an object (an array column, JSON, an embed) is compared as a whole value, so an
 * array there is that value, never a list.
 */
type WhereValue<T> =
  NonNullable<T> extends Date | Uint8Array
    ? NonNullable<T> | readonly NonNullable<T>[] | (null extends T ? null : never)
    : NonNullable<T> extends object
      ? NonNullable<T> | (null extends T ? null : never)
      : NonNullable<T> | readonly NonNullable<T>[] | (null extends T ? null : never);

/**
 * The object form of `where` for schema `S`: field name to value. A value means equals,
 * `null` means `IS NULL`, and an array means `IN` on a scalar field; an array or JSON field
 * is compared with a whole value.
 *
 * @example
 * ```ts
 * const filter: WhereObject<typeof User> = { role: "admin", name: null, id: [1, 2, 3] };
 * ```
 */
export type WhereObject<S extends AnySchema> = {
  readonly [K in ColumnNames<S>]?: WhereValue<K extends keyof Row<S> ? Row<S>[K] : never>;
};

/**
 * The object form of `where` on a query with root `A`: none when the root binding has no
 * schema (a subquery or CTE source), so that a callback passed to `where` is never taken
 * for an object (which left its bindings untyped).
 */
type RootWhere<B, A extends string> = [RootSchema<B, A>] extends [never]
  ? never
  : WhereObject<RootSchema<B, A>>;

/** What `orderBy` callbacks may return. */
type OrderItem = Expr<unknown, SomeParams> | OrderExpr<SomeParams>;

/**
 * What `groupBy` and `distinct` callbacks may return. `readonly []` makes the compiler infer
 * an array literal as a tuple, so each element keeps its own named parameters: as an array
 * its element type would be reduced to one expression type, and a clash between two of them
 * (`number` and `number | null` under one name) would be lost.
 */
type ExprList = Expr<unknown, SomeParams> | readonly Expr<unknown, SomeParams>[] | readonly [];

/**
 * What a `select` callback may return: anything. The tuple and the index signature are
 * there only so that the compiler infers array literals in it as tuples (see
 * {@link ExprList}); `Sel` types a tuple element by element. It is written out to a fixed
 * depth, not recursively: a recursive constraint makes `Sel` of the constraint itself (an
 * uninferred select) infinitely deep. Deeper arrays infer as arrays, as they would anyway.
 */
type SelectInput = SelectLevel<SelectLevel<SelectLevel<SelectLevel<unknown>>>>;

/** One level of {@link SelectInput}: a tuple, an array or an object of `Inner`, or any other value. */
type SelectLevel<Inner> =
  | readonly []
  | readonly Inner[]
  | { readonly [key: string]: Inner }
  | object
  | string
  | number
  | bigint
  | boolean
  | symbol
  | null
  | undefined;

/** The named parameters of every element of `X`, or of `X` itself when it is not an array. */
type ParamsOfList<X> = X extends readonly unknown[] ? ParamsOfAll<X> : ParamsOf<X>;

/** Every expression inside what a select returned, as a union. */
type SelectLeaves<X> = X extends { readonly "~expr": unknown }
  ? X
  : X extends { readonly "~tuple": unknown }
    ? TupleLeaf
    : X extends
          | { readonly "~binding": unknown }
          | { readonly "~order": unknown }
          | { readonly "~query": unknown }
          | Date
          | Uint8Array
      ? never
      : X extends readonly unknown[]
        ? SelectLeaves<X[number]>
        : X extends object
          ? { [K in keyof X]: SelectLeaves<X[K]> }[keyof X]
          : never;

/**
 * `unknown` when what a select returned holds no {@link Untyped} expression; otherwise an
 * error type, so that the callback's result does not fit and the call does not compile.
 */
type SelectTypes<X> = [Extract<SelectLeaves<X>, Untyped>] extends [never]
  ? [Extract<SelectLeaves<X>, TupleLeaf>] extends [never]
    ? unknown
    : {
        readonly "~error": "a row value (tuple) cannot be selected: compare it with another row, or select its items";
      }
  : {
      readonly "~error": "a selected value has no type, so the database would return it as text: give it one, val(value, t.integer())";
    };

/** Type only: a row value (`tuple(…)`) found in what a select returned, which is refused. */
interface TupleLeaf {
  readonly "~tupleLeaf": true;
}

/** The named parameters of the expressions a select returned. */
type SelectParams<X> = ParamsOfAll<SelectLeaves<X>[]>;

/** The expressions an `orderBy` callback returned: one item, or each of an array. */
type OrderLeaves<X> = X extends readonly unknown[] ? X[number] : X;

/** `unknown` when `A` and `B` are the same type; otherwise an error type, so the call does not compile. */
type SameResult<A, B> =
  SameType<A, B> extends true
    ? unknown
    : {
        readonly "~error": "both sides of a set operation must return the same type: select the same keys, with the same types";
      };

/** The value a bulk update may assign to a field of type `T`: a value of it, or an expression of it. */
type SetValue<T> = T | Expr<T, SomeParams>;

/**
 * What `set` takes for schema `S`: field name to value, for the fields that are columns.
 *
 * @example
 * ```ts
 * const values: SetInput<typeof Post> = { published: true, views: 0 };
 * ```
 */
export type SetInput<S extends AnySchema> = {
  readonly [K in ColumnNames<S>]?: SetValue<K extends keyof Row<S> ? Row<S>[K] : never>;
};

/**
 * The checks of a `set` argument `X` on schema `S`: every key is a column (an object
 * literal assigned to a type parameter is not checked for extra keys otherwise), and no
 * value holds a window function. A value without a type is fine: the field gives it one
 * (a `CASE` or `coalesce` of bound values is cast to the field's type).
 */
type SetChecks<X, S> = ([Exclude<keyof X, ColumnNames<S>>] extends [never]
  ? unknown
  : {
      readonly "~error": `set() was given "${Exclude<keyof X, ColumnNames<S>> & string}", which is not a column of the root binding`;
    }) &
  NoWindowCheck<X[keyof X]>;

/** The named parameters of the expressions among the values of a `set` argument. */
type SetParams<X> = ParamsOfAll<readonly X[keyof X][]>;

/** The named windows a query declares; `never` for a query that declares none. */
type WindowsOf<Q extends QueryLike> = Q["~query"] extends { readonly windows: infer W extends string }
  ? W
  : never;

/** `A` with the keys of `B` replaced and added. */
type Merge<A, B> = { [K in keyof A as K extends keyof B ? never : K]: A[K] } & B extends infer M
  ? { [K in keyof M]: M[K] }
  : never;

/**
 * The row lock modes: `FOR UPDATE`, `FOR SHARE`, `FOR NO KEY UPDATE`, `FOR KEY SHARE`.
 *
 * @example
 * ```ts
 * const mode: LockMode = "noKeyUpdate";
 * ```
 */
export type LockMode = "update" | "share" | "noKeyUpdate" | "keyShare";

/**
 * Options of `lock`: skip rows another transaction holds, or fail at once instead of
 * waiting for them. At most one of the two.
 *
 * @example
 * ```ts
 * const options: LockOptions = { skipLocked: true };
 * ```
 */
export interface LockOptions {
  readonly skipLocked?: boolean;
  readonly noWait?: boolean;
}

/**
 * The clauses `exclude` can remove.
 *
 * @example
 * ```ts
 * const clause: ExcludableClause = "orderBy";
 * ```
 */
export type ExcludableClause =
  | "where"
  | "select"
  | "distinct"
  | "groupBy"
  | "having"
  | "orderBy"
  | "limit"
  | "offset"
  | "lock"
  | "preload"
  | "set"
  | "windows"
  | "withCte"
  | "setOperations";

/**
 * The result type after `exclude(clause)`: without its select a query returns its root's
 * rows (with the associations it preloads, which a select of the whole root kept), and
 * without its preloads the bare root row.
 */
type ExcludedResult<C, R, Root> = C extends "select"
  ? [R] extends [Root]
    ? R
    : Root
  : C extends "preload"
    ? [R] extends [Root]
      ? Root
      : R
    : R;

/**
 * Anything with a query's type information: what the type helpers read. Every
 * {@link Query} is one.
 *
 * @example
 * ```ts
 * function resultOf<Q extends QueryLike>(query: Q): QueryResult<Q>[] { … }
 * ```
 */
export interface QueryLike {
  readonly "~query": {
    readonly bindings: unknown;
    readonly result: unknown;
    readonly params: (params: never) => void;
    readonly root: string;
  };
  readonly ast: QueryAst;
}

/**
 * The type of the rows a query returns.
 *
 * @example
 * ```ts
 * type R = QueryResult<typeof q>; // { id: number; email: string }
 * ```
 */
export type QueryResult<Q extends QueryLike> = Q["~query"]["result"];

/**
 * The named parameters a query needs when it runs: `{}` when it has none.
 *
 * @example
 * ```ts
 * type P = QueryParams<typeof adults>; // { minAge: number }
 * ```
 */
export type QueryParams<Q extends QueryLike> = Q["~query"]["params"] extends (params: infer P) => void
  ? P
  : never;

/**
 * What a repo method reads: a schema class (all of its rows) or a query.
 *
 * @example
 * ```ts
 * function describe(queryable: Queryable): string { … }
 * ```
 */
export type Queryable = AnySchema | QueryLike;

/**
 * A query that has a binding of schema `S` under each alias of `Bs`, whatever else it has:
 * the type of a reusable scope's argument.
 *
 * @example
 * ```ts
 * const published = <Q extends QueryWith<{ p: typeof Post }>>(q: Q) => q.where(({ p }) => p.published);
 * ```
 */
export type QueryWith<Bs extends { readonly [alias: string]: AnySchema } = Record<never, never>> = Query<
  { readonly [K in keyof Bs]: Binding<Bs[K], boolean> },
  unknown,
  SomeParams,
  string,
  string
>;

/**
 * The query a preload callback receives, and what `assoc()` returns: rooted at the
 * association's target, with the association's name as its alias.
 *
 * @example
 * ```ts
 * type PostsQuery = PreloadQuery<typeof User, "posts">;
 * ```
 */
export type PreloadQuery<S, K extends string> = K extends keyof S
  ? Query<{ readonly [N in K]: Binding<Target<S, K>> }, Row<Target<S, K>>, NoParams, K>
  : never;

/**
 * Refuses a preload callback whose select lacks the association's key: `unknown` when the
 * callback's query is fine, an object with an `"~error"` member otherwise.
 *
 * @example
 * ```ts
 * type Ok = PreloadCheck<typeof User, "posts", typeof postsQuery>; // unknown
 * ```
 */
export type PreloadCheck<S, K extends string, Q extends QueryLike> = K extends keyof S
  ? [PreloadElement<S, K, QueryResult<Q>>] extends [never]
    ? {
        readonly "~error": `preload "${K}" selects without its key: add ${PreloadKey<S, K> & string} to the select`;
      }
    : unknown
  : unknown;

/** A query as the implementation handles it, whatever its type parameters. */
type AnyInternal = Query<unknown, unknown, never, string, string>;

/** The bindings of a query. */
type BindingsOf<Q extends QueryLike> = Q["~query"]["bindings"];

/** The alias of a query's root binding. */
type RootOf<Q extends QueryLike> = Q["~query"]["root"];

/** The schema of a query's root binding. */
type RootSchemaOf<Q extends QueryLike> = RootSchema<BindingsOf<Q>, RootOf<Q>>;

/** The row of a query's root binding. */
type RootRowOf<Q extends QueryLike> = RootRow<BindingsOf<Q>, RootOf<Q>>;

/**
 * The result of `select` returning `X` on `Q`: the shape's type, except that a select of
 * the whole root binding keeps the root's rows as they are (with what they preload, and
 * `null` after a right or full join).
 */
type SelectResult<Q extends QueryLike, X> = [X] extends [RootBinding<BindingsOf<Q>, RootOf<Q>>]
  ? [RootBinding<BindingsOf<Q>, RootOf<Q>>] extends [X]
    ? QueryResult<Q>
    : Sel<X>
  : Sel<X>;

/** What a method of `Q` returns: the bindings `B2`, the result `R2`, and the named parameters `X` added. */
type Next<Q extends QueryLike, B2, R2, X> = Query<
  B2,
  R2,
  WithParams<QueryParams<Q>, X>,
  RootOf<Q>,
  WindowsOf<Q>
>;

/** `Q` with the result type `R2`, and the named parameters `X` added. Read from `"~query"`, without matching `Q` against the class. */
type WithResult<Q extends QueryLike, R2, X = NoParams> = Next<Q, BindingsOf<Q>, R2, X>;

/** The aliases of `B` whose binding is of schema `T`. */
type AliasesOf<B, T> = {
  [K in keyof B]: [SchemaOfBinding<B[K]>] extends [T]
    ? [T] extends [SchemaOfBinding<B[K]>]
      ? K
      : never
    : never;
}[keyof B] &
  string;

/**
 * A preload spec as {@link ValidPreload} checks it (`contracts/schema.ts`), extended with
 * the join form: under an association, a string that is the alias of a binding of the
 * target schema means "fill it from that binding", and `$from` names that binding for a
 * nested object.
 */
type ValidSpec<S, P, B> = P extends string
  ? P extends AssocKeys<S>
    ? P
    : never
  : P extends readonly (infer E)[]
    ? readonly ValidSpec<S, E, B>[]
    : P extends object
      ? {
          readonly [K in keyof P]: K extends "$from"
            ? P[K] & keyof B
            : K extends AssocKeys<S>
              ? P[K] extends true
                ? true
                : P[K] extends AliasesOf<B, Target<S, K>>
                  ? P[K]
                  : ValidSpec<Target<S, K>, P[K], B>
              : never;
        }
      : never;

/** The canonical preload spec of a join-form spec: an alias becomes `true`, `$from` is dropped. */
type NormalizeSpec<S, P, B> = P extends string
  ? P
  : P extends readonly (infer E)[]
    ? readonly NormalizeSpec<S, E, B>[]
    : P extends object
      ? {
          readonly [K in keyof P as K extends "$from" ? never : K]: K extends AssocKeys<S>
            ? P[K] extends AliasesOf<B, Target<S, K>>
              ? true
              : NormalizeSpec<Target<S, K>, P[K], B>
            : never;
        }
      : never;

// ---------------------------------------------------------------------------
// The AST's top-level properties, and their shapes
// ---------------------------------------------------------------------------

// Indexes into the per-property counts and shapes, in QUERY_SHAPE_PROPERTIES order.
const FROM = 0;
const JOINS = 1;
const WHERES = 2;
const SELECT = 3;
const DISTINCT = 4;
const GROUP_BYS = 5;
const HAVINGS = 6;
const ORDER_BYS = 7;
const LIMIT = 8;
const OFFSET = 9;
const LOCK = 10;
const COMBINATIONS = 11;
const CTES = 12;
const WINDOWS = 13;
const PRELOADS = 14;
const UPDATES = 15;
const SCHEMA = 16;
const PROPERTIES = 18;

/**
 * The properties a combined query (one with a set operation) may still change: the order,
 * limit and offset of the combined rows, more set operations, its CTEs and its database
 * schema. Anything else would apply to the left side only.
 */
const AFTER_SET_OPERATION: ReadonlySet<number> = /* @__PURE__ */ new Set([
  ORDER_BYS,
  LIMIT,
  OFFSET,
  COMBINATIONS,
  CTES,
  SCHEMA,
]);

// The seeds of the clause kinds whose shapes the builder computes from the shapes its
// expressions already carry, as `shapeOf` in ast.ts defines them (the tests check
// `ast.shape === shapeOf(ast)` on built queries).
const BOOL_SEED = /* @__PURE__ */ hashString(HASH_SEED, "bool");
const JOIN_SEED = /* @__PURE__ */ hashString(HASH_SEED, "join");
const DISTINCT_SEED = /* @__PURE__ */ hashString(HASH_SEED, "distinct");
const LOCK_SEED = /* @__PURE__ */ hashString(HASH_SEED, "lock");
const BOOL_AND = /* @__PURE__ */ hashString(BOOL_SEED, "and");
const BOOL_OR = /* @__PURE__ */ hashString(BOOL_SEED, "or");

function boolShape(op: "and" | "or", exprShape: number): number {
  return hashInt(op === "and" ? BOOL_AND : BOOL_OR, exprShape);
}

function joinShape(type: JoinType, source: SourceNode, on: number | undefined): number {
  return optionalShape(hashInt(hashString(JOIN_SEED, type), shapeOf(source)), on);
}

function distinctShape(shapes: readonly number[]): number {
  let hash = hashInt(DISTINCT_SEED, shapes.length);
  for (const shape of shapes) hash = hashInt(hash, shape);
  return hash;
}

function lockShape(clause: string | undefined, fragment: number | undefined): number {
  return clause !== undefined
    ? hashString(hashInt(LOCK_SEED, 0), clause)
    : hashInt(hashInt(LOCK_SEED, 1), fragment as number);
}

/** The shape of an optional top-level node from the node's own shape. */
function presentShape(shape: number): number {
  return optionalShape(HASH_SEED, shape);
}

const ABSENT_SHAPE = /* @__PURE__ */ optionalShape(HASH_SEED, undefined);

function schemaShape(schema: string | undefined): number {
  return schema === undefined ? hashInt(HASH_SEED, 0) : hashString(hashInt(HASH_SEED, 1), schema);
}

function listShape(nodes: readonly QueryNode[]): number {
  let hash = HASH_SEED;
  for (const node of nodes) hash = hashInt(hash, shapeOf(node));
  return hash;
}

/** The per-property shapes of a query with nothing but its root: lists are empty, optional parts absent. */
function emptyShapes(from: SourceNode): number[] {
  // Filled by push, so that the array is packed: copying it is then a fast slice.
  const shapes: number[] = [];
  for (let i = 0; i < PROPERTIES; i++) shapes.push(HASH_SEED);
  shapes[FROM] = shapeOf(from);
  shapes[SELECT] = ABSENT_SHAPE;
  shapes[DISTINCT] = ABSENT_SHAPE;
  shapes[LIMIT] = ABSENT_SHAPE;
  shapes[OFFSET] = ABSENT_SHAPE;
  shapes[LOCK] = ABSENT_SHAPE;
  shapes[SCHEMA] = schemaShape(undefined);
  return shapes;
}

/**
 * The per-property counts of a query with no parameters. Not frozen: a frozen array is
 * slow to copy, and every builder method copies the counts. Nothing writes to it.
 */
const ZEROS: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/** `values` with entry `index` set to `value`. */
function withEntry(values: readonly number[], index: number, value: number): readonly number[] {
  const out = values.slice();
  out[index] = value;
  return out;
}

/** The number of entries the properties before `index` contribute. */
function offsetOf(counts: readonly number[], index: number): number {
  let offset = 0;
  for (let i = 0; i < index; i++) offset += counts[i] as number;
  return offset;
}

/** `values` with `remove` entries at `offset` replaced by `insert`. */
function splice<V>(values: readonly V[], offset: number, remove: number, insert: readonly V[]): readonly V[] {
  if (remove === 0 && insert.length === 0) return values;
  if (remove === 0 && offset === values.length) return join(values, insert);
  const out: V[] = [];
  for (let i = 0; i < offset; i++) out.push(values[i] as V);
  for (const value of insert) out.push(value);
  for (let i = offset + remove; i < values.length; i++) out.push(values[i] as V);
  return out;
}

/**
 * A new AST: the previous one with top-level property `prop` (an index in
 * `QUERY_SHAPE_PROPERTIES` order) set to `value`, every property assigned in contract order.
 */
function patched(
  prev: QueryAst,
  prop: number,
  value: unknown,
  params: readonly unknown[],
  listLengths: readonly number[],
  shape: number,
): QueryAst {
  return {
    kind: "query",
    from: prev.from,
    joins: prop === JOINS ? (value as QueryAst["joins"]) : prev.joins,
    wheres: prop === WHERES ? (value as QueryAst["wheres"]) : prev.wheres,
    select: prop === SELECT ? (value as QueryAst["select"]) : prev.select,
    distinct: prop === DISTINCT ? (value as QueryAst["distinct"]) : prev.distinct,
    groupBys: prop === GROUP_BYS ? (value as QueryAst["groupBys"]) : prev.groupBys,
    havings: prop === HAVINGS ? (value as QueryAst["havings"]) : prev.havings,
    orderBys: prop === ORDER_BYS ? (value as QueryAst["orderBys"]) : prev.orderBys,
    limit: prop === LIMIT ? (value as QueryAst["limit"]) : prev.limit,
    offset: prop === OFFSET ? (value as QueryAst["offset"]) : prev.offset,
    lock: prop === LOCK ? (value as QueryAst["lock"]) : prev.lock,
    combinations: prop === COMBINATIONS ? (value as QueryAst["combinations"]) : prev.combinations,
    ctes: prop === CTES ? (value as QueryAst["ctes"]) : prev.ctes,
    windows: prop === WINDOWS ? (value as QueryAst["windows"]) : prev.windows,
    preloads: prop === PRELOADS ? (value as QueryAst["preloads"]) : prev.preloads,
    updates: prop === UPDATES ? (value as QueryAst["updates"]) : prev.updates,
    schema: prop === SCHEMA ? (value as QueryAst["schema"]) : prev.schema,
    hints: prev.hints,
    params,
    listLengths,
    shape,
  };
}

function distinctNode(on: readonly ExprNode[]): DistinctNode {
  return { kind: "distinct", on };
}

function lockNode(clause: string | FragmentNode): LockNode {
  return { kind: "lock", clause };
}

// ---------------------------------------------------------------------------
// Scope: the bindings of a query
// ---------------------------------------------------------------------------

/** One binding of a query. */
interface Entry {
  readonly alias: string;
  readonly schema: AnySchema | undefined;
  readonly meta: SchemaMeta | undefined;
  /** The binding object; the root of the bindings argument holds it under `alias` unless `internal`. */
  readonly binding: object | undefined;
  /** For a binding made by `joinAssoc`: the binding it starts from and the association. */
  readonly via: { readonly from: string; readonly assoc: string } | undefined;
  /** A binding the builder made itself (a many-to-many join table, a step of a `through` chain). */
  readonly internal: boolean;
}

/** The bindings of a query: what callbacks receive, and what is known about each. Shared by queries with the same bindings. */
interface Scope {
  /** The object passed to every callback: alias to binding. */
  readonly arg: Readonly<Record<string, object>>;
  readonly entries: readonly Entry[];
  /** The root binding. */
  readonly root: Entry;
}

function findEntry(scope: Scope, alias: string): Entry | undefined {
  for (const entry of scope.entries) if (entry.alias === alias) return entry;
  return undefined;
}

function checkAlias(scope: Scope | undefined, alias: unknown, clause: string): string {
  if (typeof alias !== "string" || alias === "") {
    throw new QueryError("query.aliasMissing", `${clause}() needs an alias for the binding.`, {
      params: { clause },
    });
  }
  if (alias.startsWith("$")) {
    throw new QueryError("query.aliasReserved", `${clause}() was given the alias "${alias}".`);
  }
  // The bindings are passed to callbacks as one object, keyed by alias: this one would
  // replace that object's prototype.
  if (alias === "__proto__") {
    throw new QueryError("query.aliasProto", `${clause}(): a binding cannot be named "__proto__".`);
  }
  if (scope !== undefined) {
    const taken = findEntry(scope, alias);
    if (taken !== undefined) {
      throw new QueryError(
        "query.aliasTaken",
        `${clause}() was given the alias "${alias}", which this query already uses${taken.meta === undefined ? "" : ` for ${taken.meta.name}`}.`,
      );
    }
  }
  return alias;
}

function addEntries(scope: Scope, added: readonly Entry[]): Scope {
  const arg: Record<string, object> = {};
  for (const key of Object.keys(scope.arg)) arg[key] = scope.arg[key] as object;
  for (const entry of added)
    if (!entry.internal && entry.binding !== undefined) arg[entry.alias] = entry.binding;
  return { arg, entries: [...scope.entries, ...added], root: scope.root };
}

/** The source node, binding and parameters of a schema class or a source wrapper under `alias`. */
function sourceParts(
  source: unknown,
  alias: string,
  clause: string,
): SourceParts & { readonly schema: AnySchema | undefined } {
  if (isSchema(source)) {
    const schemaMeta = meta(source);
    if (schemaMeta.source === null) {
      throw new QueryError(
        "query.sourceEmbedded",
        `${clause}() was given ${schemaMeta.name}, an embedded schema: it is stored inside its parent's row and has no table to query.`,
      );
    }
    return {
      node: tableNode(schemaMeta.source, schemaMeta, undefined, alias),
      binding: bindingOf(schemaMeta, source, alias),
      meta: schemaMeta,
      schema: source,
      params: NONE,
      lists: NONE,
      named: NONE,
    };
  }
  if (source instanceof Query) {
    throw new QueryError("query.sourceIsQuery", `${clause}() does not take a query.`, {
      params: { clause, alias },
    });
  }
  if (
    typeof source === "object" &&
    source !== null &&
    typeof (source as Partial<SourceOperand<unknown, unknown, never>>)[AS_SOURCE] === "function"
  ) {
    const parts = (source as SourceOperand<unknown, unknown, never>)[AS_SOURCE](alias);
    return {
      node: parts.node,
      binding: parts.binding,
      meta: parts.meta,
      schema: undefined,
      params: parts.params,
      lists: parts.lists,
      named: parts.named,
    };
  }
  throw new QueryError(
    "query.sourceInvalid",
    `${clause}() takes a schema class (${clause}(User, "${alias}")) or a source such as subquery(q) or cte(name, Schema).`,
    { params: { clause, alias } },
  );
}

function tableNode(
  source: string,
  schemaMeta: SchemaMeta | undefined,
  schema: string | undefined,
  alias: string,
): TableSourceNode {
  return { kind: "table", source, meta: schemaMeta, schema, alias };
}

function joinNode(type: JoinType, source: SourceNode, on: ExprNode | undefined): JoinNode {
  return { kind: "join", type, source, on };
}

function boolNode(op: "and" | "or", expr: ExprNode): BoolNode {
  return { kind: "bool", op, expr };
}

function preloadNode(
  assoc: string,
  fromAlias: string | undefined,
  query: QueryAst | undefined,
  nested: readonly PreloadNode[],
): PreloadNode {
  return { kind: "preload", assoc, from: fromAlias, query, nested };
}

// ---------------------------------------------------------------------------
// Checking what callbacks return
// ---------------------------------------------------------------------------

/** Runs a clause callback, naming the clause in any `QueryError` it throws. */
function run<V>(clause: string, fn: unknown, arg: unknown): V {
  if (typeof fn !== "function") {
    throw new QueryError(
      "query.callbackExpected",
      `${clause}() takes a callback that receives the bindings.`,
      { params: { clause } },
    );
  }
  try {
    return (fn as (bindings: unknown) => V)(arg);
  } catch (error) {
    // A clause inside the callback (a subquery's) has already named itself.
    if (error instanceof QueryError && shortMessageOf(error).startsWith(`${clause}(`)) throw error;
    return rethrow(error, `${clause}(): `);
  }
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (value instanceof OrderExpr) return "an order item";
  if (typeof value === "object") return bindingInfo(value) !== undefined ? "a whole binding" : "an object";
  return `a ${typeof value}`;
}

/** A condition from a callback's result: a boolean expression. */
function condition(value: unknown, clause: string): AnyExpr {
  if (!isExpr(value)) {
    throw new QueryError(
      "query.conditionExpected",
      `${clause}() needs its callback to return a condition; it returned ${describeValue(value)}.`,
    );
  }
  const type = value.type;
  if (type !== undefined && type.db.kind !== "boolean") {
    const column = value.node.kind === "column" ? ` ${value.node.binding}.${value.node.field}` : "";
    throw new QueryError(
      "query.conditionNotBoolean",
      `${clause}() needs a condition, and its callback returned the ${type.name} expression${column}.`,
      { params: { clause } },
    );
  }
  return value;
}

/** One expression or an array of them, from a `groupBy` or `distinct` callback. */
function expressions(value: unknown, clause: string): readonly AnyExpr[] {
  const items = Array.isArray(value) ? (value as readonly unknown[]) : [value];
  for (const item of items) {
    if (!isExpr(item)) {
      throw new QueryError(
        "query.expressionExpected",
        `${clause}() needs its callback to return an expression or an array of them, such as ({ u }) => [u.id]; it returned ${describeValue(item)}${Array.isArray(value) ? " in its array" : ""}.`,
      );
    }
  }
  return items as readonly AnyExpr[];
}

/** One order item or an array of them, from an `orderBy` callback; a bare expression is ascending. */
function orderItems(value: unknown, clause: string): readonly OrderExpr<SomeParams>[] {
  const items = Array.isArray(value) ? (value as readonly unknown[]) : [value];
  const out: OrderExpr<SomeParams>[] = [];
  for (const item of items) {
    if (item instanceof OrderExpr) out.push(item);
    else if (isExpr(item)) out.push(item.asc());
    else {
      throw new QueryError(
        "query.orderExpected",
        `${clause}() needs its callback to return an expression, an order item (u.createdAt.desc()) or an array of them; it returned ${describeValue(item)}${Array.isArray(value) ? " in its array" : ""}.`,
      );
    }
  }
  return out;
}

/**
 * The condition one key of a filter object stands for: a value is `=`, `null` is
 * `IS NULL`, an array is `IN`. An error from the operator is reported after `prefix`,
 * which names the clause and the key.
 */
function conditionOf(column: AnyExpr, value: unknown, prefix: string): AnyExpr {
  try {
    if (value === null) return column.isNull();
    // A list of values only for a scalar column: an array or JSON column holds arrays
    // itself, so an array there is the value it is compared with.
    if (Array.isArray(value) && !WHOLE_VALUE_KINDS.has(column.type?.db.kind ?? ""))
      return column.in(value as never);
    return column.eq(value as never);
  } catch (error) {
    return rethrow(error, prefix);
  }
}

/** The column kinds whose values are compared whole by the object form of `where`, arrays included. */
const WHOLE_VALUE_KINDS: ReadonlySet<string> = /* @__PURE__ */ new Set(["array", "json", "jsonb"]);

/** Rethrows `error`, with `prefix` before its message when it is a `QueryError`. */
function rethrow(error: unknown, prefix: string): never {
  if (error instanceof QueryError) throw rewrap(error, (short) => `${prefix}${short}`);
  throw error;
}

/**
 * The conditions of an association's `where` (fields of the target) or `joinWhere`
 * (columns of the join table), one per key. Both were checked when the association was
 * resolved, so every key has a column and no value is `undefined`.
 */
function assocFilter(
  columnFor: (key: string) => AnyExpr,
  filter: Readonly<Record<string, unknown>>,
  label: string,
): readonly AnyExpr[] {
  const parts: AnyExpr[] = [];
  for (const key of Object.keys(filter)) {
    parts.push(conditionOf(columnFor(key), filter[key], `${label}, ${key}: `));
  }
  return parts;
}

/** Conditions ANDed into one flat `and`; one condition as it is. */
function allOf(parts: readonly AnyExpr[]): AnyExpr {
  if (parts.length === 1) return parts[0] as AnyExpr;
  return and(...(parts as Expr<boolean, NoParams>[])) as AnyExpr;
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

const LOCK_CLAUSES: Readonly<Record<LockMode, string>> = {
  update: "FOR UPDATE",
  share: "FOR SHARE",
  noKeyUpdate: "FOR NO KEY UPDATE",
  keyShare: "FOR KEY SHARE",
};

function lockClause(mode: unknown, options: unknown): string {
  if (typeof mode !== "string" || !Object.hasOwn(LOCK_CLAUSES, mode)) {
    throw new QueryError(
      "query.lockMode",
      'lock() takes "update", "share", "noKeyUpdate" or "keyShare", optionally with { skipLocked } or { noWait }, or a fragment for any other lock clause.',
    );
  }
  const base = LOCK_CLAUSES[mode as LockMode];
  if (options === undefined) return base;
  if (typeof options !== "object" || options === null || !isPlainObject(options)) {
    throw new QueryError("query.lockOptions", "lock() takes its options as an object.");
  }
  const given = options as LockOptions;
  const unknownKeys = Object.keys(given).filter((key) => key !== "skipLocked" && key !== "noWait");
  if (unknownKeys.length > 0) {
    throw new QueryError(
      "query.lockUnknownOption",
      `lock() has no option ${unknownKeys.map((k) => `"${k}"`).join(", ")}.`,
    );
  }
  const skipLocked = own(given, "skipLocked");
  const noWait = own(given, "noWait");
  if (skipLocked === true && noWait === true) {
    throw new QueryError("query.lockSkipAndNoWait", "lock() takes skipLocked or noWait, not both.");
  }
  if (skipLocked === true) return `${base} SKIP LOCKED`;
  if (noWait === true) return `${base} NOWAIT`;
  return base;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

const INTEGER: AnyFieldType = /* @__PURE__ */ integerType();
/** Node's `util.inspect.custom`, looked up by name: no import of `node:util`. */
const INSPECT: unique symbol = /* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom");

/** The internal constructor token: a `Query` is made by `from` and by its own methods. */
const TOKEN: unique symbol = /* @__PURE__ */ Symbol("egon.query");

/**
 * A query: an immutable description of what to read. `B` is its bindings (alias to
 * binding), `R` the type of the rows it returns, `P` the named parameters it needs when it
 * runs, `A` the alias of its root binding and `W` the names of the windows it declares
 * with {@link Query.windows}.
 *
 * Every method returns a new query and leaves this one unchanged, so a base query can be
 * kept and extended in several directions. Building runs nothing; a repo runs it.
 *
 * @example
 * ```ts
 * const q = from(User, "u")
 *   .where(({ u }) => u.age.gte(18))
 *   .orderBy(({ u }) => u.createdAt.desc())
 *   .limit(10);
 * ```
 */
export class Query<B, R, P = NoParams, A extends string = string, W extends string = never>
  implements SubqueryOperand<R, P>
{
  /** Type information only; there is no such property at run time. */
  declare readonly "~query": {
    readonly bindings: B;
    readonly result: R;
    readonly params: (params: P) => void;
    readonly root: A;
    readonly windows: W;
  };
  /** The query as data: what the compiler reads. */
  readonly ast: QueryAst;
  /** Per top-level AST property: how many parameter values it holds. */
  readonly #counts: readonly number[];
  /** Per top-level AST property: how many lists it holds. */
  readonly #lists: readonly number[];
  /** Per top-level AST property: its structural hash. */
  readonly #shapes: readonly number[];
  /** The named parameters of the AST, in the order clauses were added (a name may repeat): for refusing one name with two types. */
  readonly #named: readonly NamedParamNode[];
  /** The named parameters of preload callbacks' queries, which run as statements of their own. */
  readonly #preloadNamed: readonly NamedParamNode[];
  readonly #scope: Scope;
  /** {@link named}, computed on first use. */
  #canonicalNamed: readonly NamedParamNode[] | undefined;

  /**
   * Internal: queries are made by {@link from} and by the methods of a query.
   *
   * @example
   * ```ts
   * const q = from(User, "u");
   * ```
   */
  constructor(
    token: typeof TOKEN,
    ast: QueryAst,
    counts: readonly number[],
    lists: readonly number[],
    shapes: readonly number[],
    named: readonly NamedParamNode[],
    preloadNamed: readonly NamedParamNode[],
    scope: Scope,
  ) {
    if (token !== TOKEN)
      throw new QueryError("query.notFromFrom", 'A query is made with from(): from(User, "u").');
    this.ast = ast;
    this.#counts = counts;
    this.#lists = lists;
    this.#shapes = shapes;
    this.#named = named;
    this.#preloadNamed = preloadNamed;
    this.#scope = scope;
    this.#canonicalNamed = named.length === 0 ? NONE : undefined;
  }

  /**
   * The named parameters the query's AST uses, in canonical order with repeats (preload
   * callbacks' queries are separate statements: their names are in {@link namedParams}).
   *
   * @example
   * ```ts
   * from(User, "u").where(({ u }) => u.age.gte(param("minAge", t.integer()))).named[0]?.name; // "minAge"
   * ```
   */
  get named(): readonly NamedParamNode[] {
    let named = this.#canonicalNamed;
    if (named === undefined) {
      const collected: NamedParamNode[] = [];
      collectParams(this.ast, [], undefined, collected);
      named = collected;
      this.#canonicalNamed = named;
    }
    return named;
  }

  /**
   * The names of every named parameter the query needs, its preloads' included, each once.
   *
   * @example
   * ```ts
   * adults.namedParams(); // ["minAge"]
   * ```
   */
  namedParams(): readonly string[] {
    const names: string[] = [];
    for (const node of this.#named) if (!names.includes(node.name)) names.push(node.name);
    for (const node of this.#preloadNamed) if (!names.includes(node.name)) names.push(node.name);
    return names;
  }

  // --- internals --------------------------------------------------------------

  /**
   * The query's named parameters without those of `replaced`, the node a `limit`, `offset`
   * or `lock` replaces: a new value is checked against what remains, not against the
   * parameter it takes the place of.
   */
  #namedWithout(replaced: QueryNode | undefined): readonly NamedParamNode[] {
    if (replaced === undefined) return this.#named;
    const gone: NamedParamNode[] = [];
    collectParams(replaced, [], undefined, gone);
    if (gone.length === 0) return this.#named;
    const out: NamedParamNode[] = [];
    for (const node of this.#named) {
      const at = gone.indexOf(node);
      if (at === -1) out.push(node);
      else gone.splice(at, 1);
    }
    return out;
  }

  /**
   * `named` with the named parameters `extra` of a clause added. One name with two types is
   * refused, against the query's names and against those of its preloads' queries (which
   * run with the same values), with the clause named in the message.
   */
  #withNamed(
    clause: string,
    named: readonly NamedParamNode[],
    extra: readonly NamedParamNode[],
  ): readonly NamedParamNode[] {
    if (extra.length === 0) return named;
    try {
      if (this.#preloadNamed.length > 0) joinNamed(this.#preloadNamed, extra);
      return joinNamed(named, extra);
    } catch (error) {
      return rethrow(error, `${clause}(): `);
    }
  }

  /** A query with one property of the AST changed, its params spliced and its shape recombined. */
  #next(
    prop: number,
    value: unknown,
    replace: boolean,
    params: readonly unknown[],
    lists: readonly number[],
    shape: number,
    named: readonly NamedParamNode[],
    scope: Scope = this.#scope,
    preloadNamed: readonly NamedParamNode[] = this.#preloadNamed,
  ): Query<B, R, P, A, W> {
    const ast = this.ast;
    if (ast.combinations.length > 0 && !AFTER_SET_OPERATION.has(prop)) {
      throw new QueryError(
        "query.combinedClause",
        "This query is combined with union(), intersect() or except(), and only orderBy(), limit(), offset(), more set operations, withCte() and schema() apply to the combined rows.",
      );
    }
    const counts = this.#counts;
    const listCounts = this.#lists;
    const at = replace ? offsetOf(counts, prop) : offsetOf(counts, prop + 1);
    const listAt = replace ? offsetOf(listCounts, prop) : offsetOf(listCounts, prop + 1);
    const removed = replace ? (counts[prop] as number) : 0;
    const removedLists = replace ? (listCounts[prop] as number) : 0;
    const shapes = withEntry(this.#shapes, prop, shape);
    return new Query<B, R, P, A, W>(
      TOKEN,
      patched(
        ast,
        prop,
        value,
        splice(ast.params, at, removed, params),
        splice(ast.listLengths, listAt, removedLists, lists),
        combineQueryShape(shapes),
      ),
      withEntry(counts, prop, (replace ? 0 : (counts[prop] as number)) + params.length),
      lists.length === 0 && !replace
        ? listCounts
        : withEntry(listCounts, prop, (replace ? 0 : (listCounts[prop] as number)) + lists.length),
      shapes,
      named,
      preloadNamed,
      scope,
    );
  }

  /** Recomputes the named parameters of a query that lost a clause, refusing to drop one its type still requires. */
  #dropping(next: Query<unknown, unknown, never, string, string>, clause: string): Query<B, R, P, A, W> {
    const named: NamedParamNode[] = [];
    collectParams(next.ast, [], undefined, named);
    const before = this.namedParams();
    const kept = new Set(named.map((node) => node.name));
    for (const node of next.#preloadNamed) kept.add(node.name);
    for (const name of before) {
      if (!kept.has(name)) {
        throw new QueryError(
          "query.removesNamedParam",
          `${clause} would remove the named parameter "${name}", which the query's type still requires.`,
        );
      }
    }
    return new Query<B, R, P, A, W>(
      TOKEN,
      next.ast,
      next.#counts,
      next.#lists,
      next.#shapes,
      named.length === 0 ? NONE : named,
      next.#preloadNamed,
      next.#scope,
    );
  }

  #addBool(
    prop: typeof WHERES | typeof HAVINGS,
    op: "and" | "or",
    expr: AnyExpr,
    clause: string,
  ): Query<B, R, P, A, W> {
    checkNoWindows(clause, expr.node);
    const node = boolNode(op, expr.node);
    const list = prop === WHERES ? this.ast.wheres : this.ast.havings;
    const nodes = list.slice();
    nodes.push(node);
    return this.#next(
      prop,
      nodes,
      false,
      expr.params,
      expr.lists,
      hashInt(this.#shapes[prop] as number, boolShape(op, expr.shape)),
      this.#withNamed(clause, this.#named, expr.named),
    );
  }

  #whereObject(filter: unknown, clause: string): AnyExpr {
    if (typeof filter !== "object" || filter === null || !isPlainObject(filter)) {
      throw new QueryError(
        "query.filterArgument",
        `${clause}() takes a callback or an object of field values.`,
        { params: { clause } },
      );
    }
    const root = this.#scope.root;
    // The root binding of a query always has a binding object: from() made it.
    const binding = root.binding as Readonly<Record<string, unknown>>;
    const label = `the root binding "${root.alias}"${root.meta === undefined ? "" : ` (${root.meta.name})`}`;
    const parts: AnyExpr[] = [];
    for (const key of Object.keys(filter)) {
      const value = (filter as Record<string, unknown>)[key];
      const column = Object.hasOwn(binding, key) ? binding[key] : undefined;
      if (!isExpr(column)) {
        const names = Object.keys(binding).filter((name) => isExpr(binding[name]));
        throw new QueryError(
          "query.filterUnknownField",
          `${clause}({ ${key} }) names a field that ${label} does not have as a column. Its columns are: ${names.join(", ")}.`,
        );
      }
      if (value === undefined) {
        throw new QueryError(
          "query.filterUndefined",
          `${clause}({ ${key}: undefined }) on ${label}: undefined is not a value, and a filter that silently disappears matches every row.`,
          { params: { key } },
        );
      }
      parts.push(conditionOf(column, value, `${clause}({ ${key} }) on ${label}: `));
    }
    // An empty object is `TRUE`: a filter built from data may have nothing in it.
    return allOf(parts);
  }

  #bool(
    prop: typeof WHERES | typeof HAVINGS,
    op: "and" | "or",
    clause: string,
    input: unknown,
  ): Query<B, R, P, A, W> {
    if (typeof input === "function") {
      return this.#addBool(prop, op, condition(run(clause, input, this.#scope.arg), clause), clause);
    }
    if (prop === HAVINGS) {
      throw new QueryError("query.havingCallback", `${clause}() takes a callback.`, { params: { clause } });
    }
    return this.#addBool(prop, op, this.#whereObject(input, clause), clause);
  }

  #join(
    clause: string,
    type: JoinType,
    source: unknown,
    alias: unknown,
    on: unknown,
  ): Query<never, R, never, A> {
    if (
      (type === "right" || type === "full") &&
      (this.ast.select !== undefined || this.ast.preloads.length > 0)
    ) {
      throw new QueryError(
        "query.outerJoinAfterSelect",
        `${clause}() makes the rows of the bindings before it optional, and this query already has ${this.ast.select !== undefined ? "a select" : "preloads"} that take them as they are.`,
        { params: { clause, this: this.ast.select !== undefined ? "select()" : "preload()" } },
      );
    }
    const name = checkAlias(this.#scope, alias, clause);
    const parts = sourceParts(source, name, clause);
    const entry: Entry = {
      alias: name,
      schema: parts.schema,
      meta: parts.meta,
      binding: parts.binding,
      via: undefined,
      internal: false,
    };
    const scope = addEntries(this.#scope, [entry]);
    let named = this.#withNamed(clause, this.#named, parts.named);
    let params = parts.params;
    let lists = parts.lists;
    let onNode: ExprNode | undefined;
    let onShape: number | undefined;
    if (type !== "cross") {
      const expr = condition(run(clause, on, scope.arg), clause);
      checkNoWindows(clause, expr.node);
      onNode = expr.node;
      onShape = expr.shape;
      params = join(params, expr.params);
      lists = join(lists, expr.lists);
      named = this.#withNamed(clause, named, expr.named);
    }
    const node = joinNode(type, parts.node, onNode);
    const joins = this.ast.joins.slice();
    joins.push(node);
    return this.#next(
      JOINS,
      joins,
      false,
      params,
      lists,
      hashInt(this.#shapes[JOINS] as number, joinShape(type, parts.node, onShape)),
      named,
      scope,
    ) as never;
  }

  #joinAssoc(
    clause: string,
    type: "inner" | "left",
    fromAlias: unknown,
    assocName: unknown,
    alias: unknown,
    on: unknown,
  ): Query<never, R, never, A> {
    const scope0 = this.#scope;
    if (typeof fromAlias !== "string") {
      throw new QueryError(
        "query.assocJoinStart",
        `${clause}() takes the alias of the binding to start from first.`,
        { params: { clause } },
      );
    }
    const start = findEntry(scope0, fromAlias);
    if (start === undefined || start.internal) {
      throw new QueryError(
        "query.assocJoinUnknownStart",
        `${clause}("${fromAlias}", …) starts from a binding this query does not have. Its bindings are: ${visibleAliases(scope0).join(", ")}.`,
      );
    }
    const name = checkAlias(scope0, alias, clause);
    if (typeof assocName !== "string") {
      throw new QueryError("query.assocJoinName", `${clause}() takes the name of an association second.`, {
        params: { clause, from: fromAlias, name },
      });
    }
    const built = assocJoins(scope0, start, assocName, name, type, clause);
    const scope = addEntries(scope0, built.entries);
    let named = this.#named;
    let params: readonly unknown[] = NONE;
    let lists: readonly number[] = NONE;
    let shape = this.#shapes[JOINS] as number;
    const joins = this.ast.joins.slice();
    const last = built.joins.length - 1;
    let extra: AnyExpr | undefined;
    if (on !== undefined) {
      extra = condition(run(clause, on, scope.arg), clause);
      checkNoWindows(clause, extra.node);
    }
    for (let i = 0; i <= last; i++) {
      const step = built.joins[i] as BuiltJoin;
      let condExpr = step.on;
      if (i === last && extra !== undefined)
        condExpr = (condExpr as Condition).and(extra as never) as AnyExpr;
      const node = joinNode(type, step.source, condExpr.node);
      joins.push(node);
      params = join(params, condExpr.params);
      lists = join(lists, condExpr.lists);
      named = this.#withNamed(clause, named, condExpr.named);
      shape = hashInt(shape, joinShape(type, step.source, condExpr.shape));
    }
    return this.#next(JOINS, joins, false, params, lists, shape, named, scope) as never;
  }

  // --- joins ------------------------------------------------------------------
  //
  // The joins take the receiver as a `this` type parameter (`Q0`) and write their result
  // from its `"~query"`, so that inside a reusable scope (`<Q extends QueryWith<…>>`) the
  // result type and named parameters of the query passed in are kept. Their arguments are
  // checked against the class's own `B`, which a scope's constraint resolves, where
  // `Q0`'s bindings would stay unresolved until the scope is called.

  /**
   * `INNER JOIN source AS alias ON …`. The source is a schema class, or a source such as
   * `subquery(q)`; the callback receives every binding, the new one included.
   *
   * @example
   * ```ts
   * from(User, "u").join(Post, "p", ({ u, p }) => p.authorId.eq(u.id));
   * ```
   *
   * @throws QueryError when the alias is taken, the source is not one, or `on` does not return a condition.
   */
  join<Q0 extends QueryLike, const A2 extends string, Src extends Source, X extends Condition>(
    this: Q0,
    source: Src,
    alias: A2 & NewAlias<A2, B>,
    on: (bindings: B & { readonly [K in A2]: BindingOfSource<Src> }) => X,
  ): Next<
    Q0,
    BindingsOf<Q0> & { readonly [K in A2]: BindingOfSource<Src> },
    QueryResult<Q0>,
    JoinParams<ParamsOfSource<Src>, ParamsOf<X>>
  > {
    return (this as unknown as AnyInternal).#join("join", "inner", source, alias, on) as never;
  }

  /**
   * `LEFT JOIN`: the new binding's rows may be missing, so its columns are nullable, and
   * selecting it whole gives `Row | null`.
   *
   * @example
   * ```ts
   * from(User, "u").leftJoin(Profile, "pr", ({ u, pr }) => pr.userId.eq(u.id));
   * ```
   *
   * @throws QueryError as {@link join}.
   */
  leftJoin<Q0 extends QueryLike, const A2 extends string, Src extends Source, X extends Condition>(
    this: Q0,
    source: Src,
    alias: A2 & NewAlias<A2, B>,
    on: (bindings: B & { readonly [K in A2]: NullableBinding<BindingOfSource<Src>> }) => X,
  ): Next<
    Q0,
    BindingsOf<Q0> & { readonly [K in A2]: NullableBinding<BindingOfSource<Src>> },
    QueryResult<Q0>,
    JoinParams<ParamsOfSource<Src>, ParamsOf<X>>
  > {
    return (this as unknown as AnyInternal).#join("leftJoin", "left", source, alias, on) as never;
  }

  /**
   * `RIGHT JOIN`: the existing bindings' rows may be missing, so their columns become
   * nullable, and so do the rows of a query with no select (`Post | null`). It must come
   * before the select.
   *
   * @example
   * ```ts
   * from(Post, "p").rightJoin(User, "u", ({ u, p }) => p.authorId.eq(u.id));
   * ```
   *
   * @throws QueryError as {@link join}, and when the query already has a select.
   */
  rightJoin<Q0 extends QueryLike, const A2 extends string, Src extends Source, X extends Condition>(
    this: Q0,
    source: Src,
    alias: A2 & NewAlias<A2, B>,
    on: (bindings: NullableAll<B> & { readonly [K in A2]: BindingOfSource<Src> }) => X,
  ): Next<
    Q0,
    NullableAll<BindingsOf<Q0>> & { readonly [K in A2]: BindingOfSource<Src> },
    QueryResult<Q0> | null,
    JoinParams<ParamsOfSource<Src>, ParamsOf<X>>
  > {
    return (this as unknown as AnyInternal).#join("rightJoin", "right", source, alias, on) as never;
  }

  /**
   * `FULL JOIN`: rows of either side may be missing, so every binding's columns become
   * nullable, and so do the rows of a query with no select. It must come before the select.
   *
   * @example
   * ```ts
   * from(User, "u").fullJoin(Profile, "pr", ({ u, pr }) => pr.userId.eq(u.id));
   * ```
   *
   * @throws QueryError as {@link join}, and when the query already has a select.
   */
  fullJoin<Q0 extends QueryLike, const A2 extends string, Src extends Source, X extends Condition>(
    this: Q0,
    source: Src,
    alias: A2 & NewAlias<A2, B>,
    on: (bindings: NullableAll<B> & { readonly [K in A2]: NullableBinding<BindingOfSource<Src>> }) => X,
  ): Next<
    Q0,
    NullableAll<BindingsOf<Q0>> & { readonly [K in A2]: NullableBinding<BindingOfSource<Src>> },
    QueryResult<Q0> | null,
    JoinParams<ParamsOfSource<Src>, ParamsOf<X>>
  > {
    return (this as unknown as AnyInternal).#join("fullJoin", "full", source, alias, on) as never;
  }

  /**
   * `CROSS JOIN`: every row with every row, no condition.
   *
   * @example
   * ```ts
   * from(User, "u").crossJoin(Tag, "t");
   * ```
   *
   * @throws QueryError when the alias is taken or the source is not one.
   */
  crossJoin<Q0 extends QueryLike, const A2 extends string, Src extends Source>(
    this: Q0,
    source: Src,
    alias: A2 & NewAlias<A2, B>,
  ): Next<
    Q0,
    BindingsOf<Q0> & { readonly [K in A2]: BindingOfSource<Src> },
    QueryResult<Q0>,
    ParamsOfSource<Src>
  > {
    return (this as unknown as AnyInternal).#join("crossJoin", "cross", source, alias, undefined) as never;
  }

  /**
   * `INNER JOIN` through an association: starting from binding `from`, follow association
   * `assoc` and call the joined table `alias`. The `ON` condition comes from the
   * association: its keys, its `where`, a many-to-many's join table and a `through` chain.
   * An extra condition may be given as a fourth argument; it is ANDed into the `ON`.
   *
   * @example
   * ```ts
   * from(User, "u").joinAssoc("u", "posts", "p");
   * from(User, "u").joinAssoc("u", "posts", "p", ({ p }) => p.published);
   * ```
   *
   * @throws QueryError when the binding, the association or the alias is wrong.
   */
  joinAssoc<
    Q0 extends QueryLike,
    F extends keyof B & string,
    K extends AssocKeys<SchemaOfBinding<B[F]>>,
    const A2 extends string,
    X extends Condition = Expr<boolean, NoParams>,
  >(
    this: Q0,
    from: F,
    assoc: K,
    alias: A2 & NewAlias<A2, B>,
    on?: (bindings: B & { readonly [N in A2]: Binding<Target<SchemaOfBinding<B[F]>, K>> }) => X,
  ): Next<
    Q0,
    BindingsOf<Q0> & { readonly [N in A2]: Binding<Target<SchemaOfBinding<B[F]>, K>> },
    QueryResult<Q0>,
    ParamsOf<X>
  > {
    return (this as unknown as AnyInternal).#joinAssoc("joinAssoc", "inner", from, assoc, alias, on) as never;
  }

  /**
   * `LEFT JOIN` through an association; the new binding is nullable. See {@link joinAssoc}.
   *
   * @example
   * ```ts
   * from(Post, "p").leftJoinAssoc("p", "comments", "c", ({ c }) => c.body.isNotNull());
   * ```
   *
   * @throws QueryError when the binding, the association or the alias is wrong.
   */
  leftJoinAssoc<
    Q0 extends QueryLike,
    F extends keyof B & string,
    K extends AssocKeys<SchemaOfBinding<B[F]>>,
    const A2 extends string,
    X extends Condition = Expr<boolean, NoParams>,
  >(
    this: Q0,
    from: F,
    assoc: K,
    alias: A2 & NewAlias<A2, B>,
    on?: (
      bindings: B & {
        readonly [N in A2]: Binding<Target<SchemaOfBinding<B[F]>, K>, true>;
      },
    ) => X,
  ): Next<
    Q0,
    BindingsOf<Q0> & { readonly [N in A2]: Binding<Target<SchemaOfBinding<B[F]>, K>, true> },
    QueryResult<Q0>,
    ParamsOf<X>
  > {
    return (this as unknown as AnyInternal).#joinAssoc(
      "leftJoinAssoc",
      "left",
      from,
      assoc,
      alias,
      on,
    ) as never;
  }

  // --- filters ----------------------------------------------------------------

  /**
   * Adds a condition. Several `where` calls are combined with `AND`. The object form
   * filters the root binding: a value means equals, `null` means `IS NULL`, an array means
   * `IN`; `undefined` throws.
   *
   * @example
   * ```ts
   * from(User, "u").where(({ u }) => u.age.gte(18));
   * from(User, "u").where({ role: "admin", name: null, id: [1, 2, 3] });
   * ```
   *
   * @throws QueryError when the callback does not return a condition, or the object names
   * a field the root binding has no column for or holds `undefined`.
   */
  where(conditions: RootWhere<B, A>): this;
  where<X extends Condition>(fn: (bindings: B) => X): AddParams<this, ParamsOf<X>>;
  where(input: unknown): unknown {
    return this.#bool(WHERES, "and", "where", input);
  }

  /**
   * Adds a condition combined with `OR` against everything before it:
   * `.where(a).where(b).orWhere(c)` is `(a AND b) OR c`.
   *
   * @example
   * ```ts
   * from(User, "u").where(({ u }) => u.age.gte(18)).orWhere(({ u }) => u.role.eq("admin"));
   * ```
   *
   * @throws QueryError as {@link where}.
   */
  orWhere(conditions: RootWhere<B, A>): this;
  orWhere<X extends Condition>(fn: (bindings: B) => X): AddParams<this, ParamsOf<X>>;
  orWhere(input: unknown): unknown {
    return this.#bool(WHERES, "or", "orWhere", input);
  }

  /**
   * Adds a condition on groups. Needs a `groupBy` before it.
   *
   * @example
   * ```ts
   * from(Post, "p").groupBy(({ p }) => p.authorId).having(({ p }) => count(p.id).gt(3));
   * ```
   *
   * @throws QueryError when the query has no `groupBy`, or the callback does not return a condition.
   */
  having<X extends Condition>(fn: (bindings: B) => X): AddParams<this, ParamsOf<X>> {
    if (this.ast.groupBys.length === 0) {
      throw new QueryError(
        "query.havingWithoutGroupBy",
        "having() filters groups, and this query has no groupBy() yet.",
      );
    }
    return this.#bool(HAVINGS, "and", "having", fn) as never;
  }

  // --- select -----------------------------------------------------------------

  /**
   * Says what the query returns, and so its result type: an expression, a whole binding,
   * an object or array of those (nested), or plain values, which are returned as they are.
   * A query has one select; `selectMerge` adds keys to it.
   *
   * @example
   * ```ts
   * from(User, "u").select(({ u }) => ({ id: u.id, email: u.email }));
   * ```
   *
   * @throws QueryError when the query already has a select or preloads, or the value holds
   * something that cannot be selected.
   */
  select<Q0 extends QueryLike, X extends SelectInput>(
    this: Q0,
    fn: (bindings: BindingsOf<Q0>) => X & SelectTypes<X> & WindowCheck<SelectLeaves<X>, WindowsOf<Q0>>,
  ): WithResult<Q0, SelectResult<Q0, X>, SelectParams<X>> {
    return (this as unknown as AnyInternal).#select(fn) as never;
  }

  #select(fn: unknown): unknown {
    if (this.ast.updates.length > 0) {
      throw new QueryError(
        "query.selectOnUpdate",
        "select() was called on a query with set(…) assignments, an update.",
      );
    }
    if (this.ast.select !== undefined) {
      throw new QueryError(
        "query.selectTwice",
        `select() was called on a query that already has a ${RETURNING_SELECTS.has(this.ast.select) ? "returning()" : "select"}.`,
      );
    }
    const built = buildSelect(run("select", fn, this.#scope.arg), "select");
    checkWindows("select", selectExpressions(built.node.shape), this.ast.windows);
    this.#checkPreloadSelect(built.node, "select");
    return this.#setSelect(built, this.#withNamed("select", this.#named, built.named)) as never;
  }

  /**
   * Adds keys to an object select; a key the select already has is replaced.
   *
   * @example
   * ```ts
   * from(Post, "p").select(({ p }) => ({ id: p.id })).selectMerge(({ p }) => ({ views: p.views }));
   * ```
   *
   * @throws QueryError when the query's select is not an object, or the callback does not return one.
   */
  selectMerge<Q0 extends QueryLike, X extends SelectInput & object>(
    this: Q0,
    fn: (bindings: BindingsOf<Q0>) => X & SelectTypes<X> & WindowCheck<SelectLeaves<X>, WindowsOf<Q0>>,
  ): WithResult<Q0, Merge<QueryResult<Q0>, Sel<X>>, SelectParams<X>> {
    return (this as unknown as AnyInternal).#selectMerge(fn) as never;
  }

  #selectMerge(fn: unknown): unknown {
    const current = this.ast.select;
    if (current === undefined || current.shape.kind !== "object") {
      throw new QueryError(
        "query.selectMergeShape",
        `selectMerge() adds keys to an object select, and this query ${current === undefined ? "has no select" : `selects ${describeShape(current.shape)}`}.`,
      );
    }
    const extra = buildSelect(run("selectMerge", fn, this.#scope.arg), "selectMerge");
    if (extra.node.shape.kind !== "object") {
      throw new QueryError(
        "query.selectMergeResult",
        `selectMerge() needs its callback to return an object of keys to add; it returned ${describeShape(extra.node.shape)}.`,
      );
    }
    checkWindows("selectMerge", selectExpressions(extra.node.shape), this.ast.windows);
    const named = this.#withNamed("selectMerge", this.#named, extra.named);
    const merged = mergeSelects(current, extra.node);
    // Keys merged into a returning() list stay a returning() list.
    if (RETURNING_SELECTS.has(current)) RETURNING_SELECTS.add(merged.node);
    const next = this.#setSelect(merged, named);
    const replaced = (extra.node.shape.keys as readonly string[]).some((key) =>
      (current.shape as { readonly keys: readonly string[] }).keys.includes(key),
    );
    return (replaced ? this.#dropping(next as never, "selectMerge() replacing a key") : next) as never;
  }

  #setSelect(built: BuiltSelect, named: readonly NamedParamNode[]): Query<B, R, P, A, W> {
    return this.#next(
      SELECT,
      built.node,
      true,
      built.params,
      built.lists,
      presentShape(shapeOf(built.node)),
      named,
    );
  }

  /** Preloads need whole rows of the root: refuses a select that is not the root binding once preloads exist. */
  #checkPreloadSelect(select: SelectNode | undefined, clause: string): void {
    if (this.ast.preloads.length === 0 || selectsRoot(select, this.#scope.root.alias)) return;
    throw new QueryError(
      "query.selectWithPreloads",
      `${clause}() was given a select that is not the whole root binding "${this.#scope.root.alias}", and the query preloads ${this.ast.preloads.map((p) => `"${p.assoc}"`).join(", ")}.`,
      { params: { this: this.#scope.root.alias } },
    );
  }

  /**
   * `SELECT DISTINCT`, or with a callback `DISTINCT ON (…)` (Postgres).
   *
   * @example
   * ```ts
   * from(User, "u").distinct();
   * from(User, "u").distinct(({ u }) => [u.email]).orderBy(({ u }) => [u.email, u.createdAt.desc()]);
   * ```
   *
   * @throws QueryError when the query already has a `distinct`, or the callback does not return expressions.
   */
  distinct(): this;
  distinct<X extends ExprList>(fn: (bindings: B) => X): AddParams<this, ParamsOfList<X>>;
  distinct(fn?: unknown): unknown {
    if (this.ast.distinct !== undefined) {
      throw new QueryError(
        "query.distinctTwice",
        "distinct() was called on a query that already has a distinct.",
      );
    }
    if (fn === undefined) {
      return this.#next(
        DISTINCT,
        distinctNode(NONE),
        true,
        NONE,
        NONE,
        presentShape(distinctShape(NONE)),
        this.#named,
      );
    }
    const items = expressions(run("distinct", fn, this.#scope.arg), "distinct");
    let params: readonly unknown[] = NONE;
    let lists: readonly number[] = NONE;
    let named = this.#named;
    const nodes: ExprNode[] = [];
    const shapes: number[] = [];
    for (const item of items) {
      nodes.push(item.node);
      shapes.push(item.shape);
      params = join(params, item.params);
      lists = join(lists, item.lists);
      named = this.#withNamed("distinct", named, item.named);
    }
    return this.#next(
      DISTINCT,
      distinctNode(nodes),
      true,
      params,
      lists,
      presentShape(distinctShape(shapes)),
      named,
    );
  }

  // --- grouping and order -----------------------------------------------------

  /**
   * `GROUP BY`: one expression or an array of them. Several calls add to the list.
   *
   * @example
   * ```ts
   * from(Post, "p").groupBy(({ p }) => p.authorId);
   * ```
   *
   * @throws QueryError when the callback does not return expressions.
   */
  groupBy<X extends ExprList>(fn: (bindings: B) => X): AddParams<this, ParamsOfList<X>> {
    const items = expressions(run("groupBy", fn, this.#scope.arg), "groupBy");
    const nodes = this.ast.groupBys.slice();
    let params: readonly unknown[] = NONE;
    let lists: readonly number[] = NONE;
    let named = this.#named;
    let shape = this.#shapes[GROUP_BYS] as number;
    for (const item of items) {
      checkNoWindows("groupBy", item.node);
      nodes.push(item.node);
      params = join(params, item.params);
      lists = join(lists, item.lists);
      named = this.#withNamed("groupBy", named, item.named);
      shape = hashInt(shape, item.shape);
    }
    return this.#next(GROUP_BYS, nodes, false, params, lists, shape, named) as never;
  }

  /**
   * `ORDER BY`: one item or an array; a bare expression sorts ascending. Several calls add
   * to the list.
   *
   * @example
   * ```ts
   * from(User, "u").orderBy(({ u }) => [u.createdAt.desc(), u.id]);
   * ```
   *
   * @throws QueryError when the callback does not return expressions or order items.
   */
  orderBy<X extends OrderItem | readonly OrderItem[] | readonly []>(
    fn: (bindings: B) => X & WindowCheck<OrderLeaves<X>, W>,
  ): AddParams<this, ParamsOfList<X>> {
    const items = orderItems(run("orderBy", fn, this.#scope.arg), "orderBy");
    for (const item of items) checkWindow("orderBy", item.node.expr, this.ast.windows);
    const nodes = this.ast.orderBys.slice();
    let params: readonly unknown[] = NONE;
    let lists: readonly number[] = NONE;
    let named = this.#named;
    let shape = this.#shapes[ORDER_BYS] as number;
    for (const item of items) {
      nodes.push(item.node);
      params = join(params, item.params);
      lists = join(lists, item.lists);
      named = this.#withNamed("orderBy", named, item.named);
      shape = hashInt(shape, item.shape);
    }
    return this.#next(ORDER_BYS, nodes, false, params, lists, shape, named) as never;
  }

  /**
   * Reverses every `ORDER BY` item: `ASC` and `DESC` swap, and so do `NULLS FIRST` and
   * `NULLS LAST`. A query with no order is ordered by its root's primary key, descending.
   *
   * @example
   * ```ts
   * from(User, "u").orderBy(({ u }) => u.createdAt).reverseOrder(); // ORDER BY u.created_at DESC
   * ```
   *
   * @throws QueryError when the query has no order and its root has no primary key.
   */
  reverseOrder(): this {
    const current = this.ast.orderBys;
    if (current.length === 0) {
      const root = this.#scope.root;
      const key = root.meta?.primaryKey ?? [];
      if (key.length === 0) {
        throw new QueryError(
          "query.reverseOrderNone",
          `reverseOrder() reverses the query's orderBy, and this query has none; its root "${root.alias}" has no primary key to order by either.`,
        );
      }
      const nodes: OrderNode[] = [];
      let shape = HASH_SEED;
      for (const field of key) {
        const column = shapeOfColumn(root.alias, field.column);
        nodes.push(orderNode(columnNode(root.alias, field.name, field.column), "desc", undefined));
        shape = hashInt(shape, shapeOfOrder(column, "desc", undefined));
      }
      return this.#next(ORDER_BYS, nodes, true, NONE, NONE, shape, this.#named) as never;
    }
    const nodes = current.map((node) =>
      orderNode(
        node.expr,
        node.direction === "asc" ? "desc" : "asc",
        node.nulls === undefined ? undefined : node.nulls === "first" ? "last" : "first",
      ),
    );
    const ast = this.ast;
    const shapes = withEntry(this.#shapes, ORDER_BYS, listShape(nodes));
    return new Query<B, R, P, A, W>(
      TOKEN,
      patched(ast, ORDER_BYS, nodes, ast.params, ast.listLengths, combineQueryShape(shapes)),
      this.#counts,
      this.#lists,
      shapes,
      this.#named,
      this.#preloadNamed,
      this.#scope,
    ) as never;
  }

  // --- paging and locks -------------------------------------------------------

  #bound(prop: typeof LIMIT | typeof OFFSET, clause: string, value: unknown): Query<B, R, P, A, W> {
    let expr: AnyExpr;
    if (isExpr(value)) expr = value;
    else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      return this.#next(
        prop,
        paramNode(value, INTEGER, false),
        true,
        [value],
        NONE,
        presentShape(shapeOfParam(INTEGER, false)),
        this.#named,
      );
    } else {
      throw new QueryError(
        "query.limitValue",
        `${clause}() takes a non-negative whole number or a named parameter, ${clause}(param("${clause}", t.integer())); it was given ${typeof value === "number" ? String(value) : describeValue(value)}.`,
        { params: { clause } },
      );
    }
    const next = this.#next(
      prop,
      expr.node,
      true,
      expr.params,
      expr.lists,
      presentShape(expr.shape),
      this.#withNamed(
        clause,
        this.#namedWithout(prop === LIMIT ? this.ast.limit : this.ast.offset),
        expr.named,
      ),
    );
    return next;
  }

  /**
   * `LIMIT n`: a bound parameter, so every page size shares one plan. A later call
   * replaces an earlier one.
   *
   * @example
   * ```ts
   * from(User, "u").orderBy(({ u }) => u.id).limit(10);
   * from(User, "u").limit(param("pageSize", t.integer()));
   * ```
   *
   * @throws QueryError when `n` is not a non-negative whole number or an expression.
   */
  limit<N extends number | Expr<number | bigint, SomeParams>>(n: N): AddParams<this, ParamsOf<N>> {
    const replacing = this.ast.limit !== undefined;
    const next = this.#bound(LIMIT, "limit", n);
    return (replacing ? this.#dropping(next as never, "limit() replacing the earlier limit") : next) as never;
  }

  /**
   * `OFFSET n`: a bound parameter. A later call replaces an earlier one.
   *
   * @example
   * ```ts
   * from(User, "u").orderBy(({ u }) => u.id).limit(10).offset(20);
   * ```
   *
   * @throws QueryError when `n` is not a non-negative whole number or an expression.
   */
  offset<N extends number | Expr<number | bigint, SomeParams>>(n: N): AddParams<this, ParamsOf<N>> {
    const replacing = this.ast.offset !== undefined;
    const next = this.#bound(OFFSET, "offset", n);
    return (
      replacing ? this.#dropping(next as never, "offset() replacing the earlier offset") : next
    ) as never;
  }

  /**
   * A row lock: `FOR UPDATE`, `FOR SHARE`, `FOR NO KEY UPDATE` or `FOR KEY SHARE`, with
   * `SKIP LOCKED` or `NOWAIT`; any other lock clause as a fragment. A later call replaces
   * an earlier one. SQLite ignores locks.
   *
   * @example
   * ```ts
   * from(Post, "p").lock("update", { skipLocked: true });
   * from(Post, "p").lock(fragment`FOR UPDATE OF ${fragment.ident("p")}`);
   * ```
   *
   * @throws QueryError for an unknown mode or option, or both options at once.
   */
  lock(mode: LockMode, options?: LockOptions): this;
  lock<X extends Expr<unknown, SomeParams>>(clause: X): AddParams<this, ParamsOf<X>>;
  lock(mode: unknown, options?: unknown): unknown {
    const replacing = this.ast.lock !== undefined;
    let next: Query<B, R, P, A, W>;
    if (isExpr(mode)) {
      if (mode.node.kind !== "fragment" || options !== undefined) {
        throw new QueryError(
          "query.lockArgument",
          'lock() takes a mode ("update", "share", "noKeyUpdate", "keyShare") or a fragment of SQL for any other lock clause.',
        );
      }
      const node = lockNode(mode.node as FragmentNode);
      next = this.#next(
        LOCK,
        node,
        true,
        mode.params,
        mode.lists,
        presentShape(lockShape(undefined, mode.shape)),
        this.#withNamed("lock", this.#namedWithout(this.ast.lock), mode.named),
      );
    } else {
      const clause = lockClause(mode, options);
      next = this.#next(
        LOCK,
        lockNode(clause),
        true,
        NONE,
        NONE,
        presentShape(lockShape(clause, undefined)),
        this.#named,
      );
    }
    return replacing ? this.#dropping(next as never, "lock() replacing the earlier lock") : next;
  }

  /**
   * The database schema (a Postgres schema, a MySQL database) for this query's tables. A
   * schema class that declares its own keeps it.
   *
   * @example
   * ```ts
   * from(User, "u").schema("tenant_1");
   * ```
   *
   * @throws QueryError when `name` is not a non-empty string.
   */
  schema(name: string): this {
    if (typeof name !== "string" || name === "") {
      throw new QueryError("query.schemaName", "schema() takes the name of a database schema.");
    }
    return this.#next(SCHEMA, name, true, NONE, NONE, schemaShape(name), this.#named) as never;
  }

  // --- set operations ---------------------------------------------------------
  //
  // The query a set operation is called on is the left side. The combined query's
  // orderBy, limit and offset apply to the combined rows; any other clause belongs on a
  // side before the two are combined (advanced/set-operations.ts).

  #combine(method: string, op: SetOperation, all: boolean, other: unknown): unknown {
    if (!(other instanceof Query)) {
      throw new QueryError("query.setOperationArgument", `${method}() takes another query.`, {
        params: { method },
      });
    }
    const right = other.ast;
    checkCombination(method, this.ast, right);
    const node = combinationNode(op, all, right);
    const nodes = this.ast.combinations.slice();
    nodes.push(node);
    return this.#next(
      COMBINATIONS,
      nodes,
      false,
      right.params,
      right.listLengths,
      hashInt(this.#shapes[COMBINATIONS] as number, combinationShape(op, all, right.shape)),
      this.#withNamed(method, this.#named, other.named),
    );
  }

  /**
   * `UNION`: the rows of this query and of `other`, without duplicates. Both must return
   * the same type, with keys in the same order. An `orderBy`, `limit` or `offset` added
   * after it applies to the combined rows.
   *
   * @example
   * ```ts
   * from(User, "u").select(({ u }) => ({ email: u.email }))
   *   .union(from(Invite, "i").select(({ i }) => ({ email: i.email })))
   *   .orderBy(({ u }) => u.email);
   * ```
   *
   * @throws QueryError when `other` is not a query, this query has an `orderBy`, `limit`,
   * `offset` or lock, either side has preloads, a plain selected value or `set(…)`, or the
   * two sides select different shapes.
   */
  union<Q0 extends QueryLike, Q2 extends QueryLike>(
    this: Q0,
    other: Q2 & SameResult<QueryResult<Q0>, QueryResult<Q2>>,
  ): WithResult<Q0, QueryResult<Q0>, QueryParams<Q2>> {
    return (this as unknown as AnyInternal).#combine("union", "union", false, other) as never;
  }

  /**
   * `UNION ALL`: the rows of this query and of `other`, duplicates kept. See {@link union}.
   *
   * @example
   * ```ts
   * roots.unionAll(children);
   * ```
   *
   * @throws QueryError as {@link union}.
   */
  unionAll<Q0 extends QueryLike, Q2 extends QueryLike>(
    this: Q0,
    other: Q2 & SameResult<QueryResult<Q0>, QueryResult<Q2>>,
  ): WithResult<Q0, QueryResult<Q0>, QueryParams<Q2>> {
    return (this as unknown as AnyInternal).#combine("unionAll", "union", true, other) as never;
  }

  /**
   * `INTERSECT`: the rows both queries return, without duplicates. See {@link union}.
   *
   * @example
   * ```ts
   * authors.intersect(commenters);
   * ```
   *
   * @throws QueryError as {@link union}.
   */
  intersect<Q0 extends QueryLike, Q2 extends QueryLike>(
    this: Q0,
    other: Q2 & SameResult<QueryResult<Q0>, QueryResult<Q2>>,
  ): WithResult<Q0, QueryResult<Q0>, QueryParams<Q2>> {
    return (this as unknown as AnyInternal).#combine("intersect", "intersect", false, other) as never;
  }

  /**
   * `INTERSECT ALL`: the rows both queries return, as often as both have them. See {@link union}.
   *
   * @example
   * ```ts
   * authors.intersectAll(commenters);
   * ```
   *
   * @throws QueryError as {@link union}.
   */
  intersectAll<Q0 extends QueryLike, Q2 extends QueryLike>(
    this: Q0,
    other: Q2 & SameResult<QueryResult<Q0>, QueryResult<Q2>>,
  ): WithResult<Q0, QueryResult<Q0>, QueryParams<Q2>> {
    return (this as unknown as AnyInternal).#combine("intersectAll", "intersect", true, other) as never;
  }

  /**
   * `EXCEPT`: the rows of this query that `other` does not return, without duplicates.
   * See {@link union}.
   *
   * @example
   * ```ts
   * everyone.except(banned);
   * ```
   *
   * @throws QueryError as {@link union}.
   */
  except<Q0 extends QueryLike, Q2 extends QueryLike>(
    this: Q0,
    other: Q2 & SameResult<QueryResult<Q0>, QueryResult<Q2>>,
  ): WithResult<Q0, QueryResult<Q0>, QueryParams<Q2>> {
    return (this as unknown as AnyInternal).#combine("except", "except", false, other) as never;
  }

  /**
   * `EXCEPT ALL`: the rows of this query that `other` does not return, counting
   * duplicates. See {@link union}.
   *
   * @example
   * ```ts
   * everyone.exceptAll(banned);
   * ```
   *
   * @throws QueryError as {@link union}.
   */
  exceptAll<Q0 extends QueryLike, Q2 extends QueryLike>(
    this: Q0,
    other: Q2 & SameResult<QueryResult<Q0>, QueryResult<Q2>>,
  ): WithResult<Q0, QueryResult<Q0>, QueryParams<Q2>> {
    return (this as unknown as AnyInternal).#combine("exceptAll", "except", true, other) as never;
  }

  // --- CTEs and windows -------------------------------------------------------

  /**
   * Attaches a common table expression (`WITH name AS (query)`), which the query reads as
   * a source with `cte(name, shape)`. With `{ recursive: true }` the CTE's query may read
   * the CTE itself (`WITH RECURSIVE`); `materialized` asks the database to compute it
   * once, or (`false`) to inline it.
   *
   * @example
   * ```ts
   * from(cte("tree", Category), "t").withCte("tree", roots.unionAll(children), { recursive: true });
   * ```
   *
   * @throws QueryError when the name is empty or taken, the options are not
   * `{ recursive?, materialized? }`, or the query has preloads or `set(…)`.
   */
  withCte<Q0 extends QueryLike, Q2 extends QueryLike>(
    this: Q0,
    name: string,
    query: Q2,
    options?: CteOptions,
  ): WithResult<Q0, QueryResult<Q0>, QueryParams<Q2>> {
    return (this as unknown as AnyInternal).#withCte(name, query, options) as never;
  }

  #withCte(name: unknown, query: unknown, options: unknown): unknown {
    if (!(query instanceof Query)) {
      throw new QueryError(
        "query.withCteQuery",
        `withCte(${typeof name === "string" ? `"${name}"` : "name"}, query) takes a query as its second argument.`,
      );
    }
    const node = withCteNode(name, query.ast, options, this.ast.ctes);
    const nodes = this.ast.ctes.slice();
    nodes.push(node);
    return this.#next(
      CTES,
      nodes,
      false,
      query.ast.params,
      query.ast.listLengths,
      hashInt(this.#shapes[CTES] as number, cteShape(node, query.ast.shape)),
      this.#withNamed("withCte", this.#named, query.named),
    );
  }

  /**
   * Declares named windows (`WINDOW w AS (…)`), each a callback that receives the bindings
   * and returns `{ partitionBy, orderBy, frame }`. Window functions and aggregates use one
   * with `.over("w")`; the name is checked against the windows declared, so declare them
   * before the select that uses them.
   *
   * @example
   * ```ts
   * from(Post, "p")
   *   .windows({ byAuthor: ({ p }) => ({ partitionBy: [p.authorId], orderBy: [p.createdAt.desc()] }) })
   *   .select(({ p }) => ({ id: p.id, n: rowNumber().over("byAuthor") }));
   * ```
   *
   * @throws QueryError when a name is not an identifier or is declared already, or a
   * callback does not return a window.
   */
  windows<Q0 extends QueryLike, const D extends WindowDefs<B>>(
    this: Q0,
    defs: D,
  ): Query<
    BindingsOf<Q0>,
    QueryResult<Q0>,
    WithParams<QueryParams<Q0>, WindowDefParams<D>>,
    RootOf<Q0>,
    WindowsOf<Q0> | (keyof D & string)
  > {
    return (this as unknown as AnyInternal).#windows(defs) as never;
  }

  #windows(defs: unknown): unknown {
    const names = windowNames(defs, this.ast.windows);
    const added = [];
    for (const name of names) {
      const fn = (defs as Readonly<Record<string, unknown>>)[name];
      added.push(windowDef(name, run(`windows({ ${name} })`, fn, this.#scope.arg)));
    }
    const built = collectWindows(added);
    const nodes = this.ast.windows.slice();
    let shape = this.#shapes[WINDOWS] as number;
    for (let i = 0; i < added.length; i++) {
      nodes.push(added[i] as (typeof added)[number]);
      shape = hashInt(shape, built.shapes[i] as number);
    }
    return this.#next(
      WINDOWS,
      nodes,
      false,
      built.params,
      built.lists,
      shape,
      this.#withNamed("windows", this.#named, built.named),
    );
  }

  // --- bulk updates and deletes -------------------------------------------------

  /**
   * Makes the query a bulk update (`repo.updateAll`): `UPDATE … SET field = value` for
   * every row the query matches. Values are plain values (bound with the field's type) or
   * expressions, given as an object or by a callback that receives the bindings. A later
   * call adds fields, and a field set again takes the later value. Joins become
   * `UPDATE … FROM`.
   *
   * @example
   * ```ts
   * from(Post, "p").where(({ p }) => p.authorId.eq(1)).set({ published: true });
   * from(Post, "p").set(({ p }) => ({ views: p.views.add(1), tagList: p.tagList.append("hot") }));
   * ```
   *
   * @throws QueryError when the root is not a schema's table, the query has a select
   * (declare `RETURNING` with {@link returning}) or preloads, or a key is not a column, a
   * value `undefined`, or `null` for a field that is not nullable.
   */
  set<Q0 extends QueryLike, const X extends SetInput<RootSchemaOf<Q0>>>(
    this: Q0,
    values: X & SetChecks<X, RootSchemaOf<Q0>>,
  ): WithResult<Q0, QueryResult<Q0>, SetParams<X>>;
  set<Q0 extends QueryLike, X extends SetInput<RootSchemaOf<Q0>>>(
    this: Q0,
    fn: (bindings: BindingsOf<Q0>) => X & SetChecks<X, RootSchemaOf<Q0>>,
  ): WithResult<Q0, QueryResult<Q0>, SetParams<X>>;
  set(input: unknown): unknown {
    const root = this.#scope.root;
    if (root.meta === undefined || this.ast.from.kind !== "table") {
      throw new QueryError(
        "query.setNotTable",
        `set() updates the rows of a table, and the root binding "${root.alias}" is not a schema's table.`,
      );
    }
    if (this.ast.preloads.length > 0) {
      throw new QueryError("query.setWithPreloads", "set() was called on a query with preloads.");
    }
    const select = this.ast.select;
    if (select !== undefined && !RETURNING_SELECTS.has(select)) {
      throw new QueryError("query.setWithSelect", "set() was called on a query with a select.");
    }
    const values = typeof input === "function" ? run("set", input, this.#scope.arg) : input;
    const built = assignments(values, root.meta, this.ast.updates, this.#updateShapes());
    const params: unknown[] = [];
    const lists: number[] = [];
    const collected: NamedParamNode[] = [];
    for (const node of built.nodes) collectParams(node, params, lists, collected);
    let shape = HASH_SEED;
    for (const value of built.shapes) shape = hashInt(shape, value);
    // The new assignments' named parameters (the earlier ones are the query's already),
    // checked against the rest of the query.
    let named = this.#named;
    for (const node of collected)
      if (!this.#named.includes(node)) named = this.#withNamed("set", named, [node]);
    const next = this.#next(
      UPDATES,
      built.nodes,
      true,
      params.length === 0 ? NONE : params,
      lists.length === 0 ? NONE : lists,
      shape,
      named,
    );
    return built.replaced ? this.#dropping(next as never, "set() replacing a field") : next;
  }

  /** The shapes of the query's assignments, in order. */
  #updateShapes(): readonly number[] {
    const out: number[] = [];
    for (const node of this.ast.updates) out.push(shapeOf(node));
    return out;
  }

  /**
   * What a bulk update or delete returns (`RETURNING …`), in the shapes `select` takes:
   * `repo.updateAll` and `repo.deleteAll` then return those rows. On an update use this
   * instead of `select`.
   *
   * @example
   * ```ts
   * from(Post, "p").where(({ p }) => p.authorId.eq(1)).set({ published: true }).returning(({ p }) => p.id);
   * ```
   *
   * @throws QueryError when the query already has a select or `returning`, or has preloads,
   * or the value holds something that cannot be selected.
   */
  returning<Q0 extends QueryLike, X extends SelectInput>(
    this: Q0,
    fn: (bindings: BindingsOf<Q0>) => X & SelectTypes<X> & NoWindowCheck<SelectLeaves<X>>,
  ): WithResult<Q0, SelectResult<Q0, X>, SelectParams<X>> {
    return (this as unknown as AnyInternal).#returning(fn) as never;
  }

  #returning(fn: unknown): unknown {
    if (this.ast.select !== undefined) {
      throw new QueryError(
        "query.returningTwice",
        `returning() was called on a query that already has a ${RETURNING_SELECTS.has(this.ast.select) ? "returning()" : "select"}.`,
      );
    }
    if (this.ast.preloads.length > 0) {
      throw new QueryError("query.returningWithPreloads", "returning() was called on a query with preloads.");
    }
    const built = buildSelect(run("returning", fn, this.#scope.arg), "returning");
    for (const node of selectExpressions(built.node.shape)) checkNoWindows("returning", node);
    RETURNING_SELECTS.add(built.node);
    return this.#setSelect(built, this.#withNamed("returning", this.#named, built.named));
  }

  // --- composition ------------------------------------------------------------

  /**
   * Removes a clause: every `where` (and `orWhere`), the select (or `returning`),
   * `distinct`, every `groupBy`, `having` or `orderBy`, `limit`, `offset`, the lock, every
   * preload, every `set` assignment, every named window (`"windows"`), every CTE
   * (`"withCte"`), or every set operation (`"setOperations"`).
   *
   * @example
   * ```ts
   * const unordered = q.exclude("orderBy");
   * ```
   *
   * @throws QueryError for another clause name, when the clause holds a named parameter
   * that the query's type still requires, or when a named window removed is still used.
   */
  exclude<Q0 extends QueryLike, C extends ExcludableClause>(
    this: Q0,
    clause: C,
  ): C extends "windows"
    ? Query<BindingsOf<Q0>, QueryResult<Q0>, QueryParams<Q0>, RootOf<Q0>>
    : WithResult<Q0, ExcludedResult<C, QueryResult<Q0>, RootRowOf<Q0>>> {
    return (this as unknown as AnyInternal).#exclude(clause) as never;
  }

  #exclude(clause: unknown): unknown {
    if (
      this.ast.combinations.length > 0 &&
      typeof clause === "string" &&
      !["orderBy", "limit", "offset", "withCte", "setOperations"].includes(clause)
    ) {
      throw new QueryError(
        "query.excludeCombined",
        `exclude("${clause}") on a query combined with union(), intersect() or except() would change its left side only.`,
      );
    }
    let next: Query<B, R, P, A, W>;
    switch (clause as ExcludableClause) {
      case "where":
        next = this.#next(WHERES, NONE, true, NONE, NONE, HASH_SEED, this.#named);
        break;
      case "select":
        next = this.#next(SELECT, undefined, true, NONE, NONE, ABSENT_SHAPE, this.#named);
        break;
      case "distinct":
        next = this.#next(DISTINCT, undefined, true, NONE, NONE, ABSENT_SHAPE, this.#named);
        break;
      case "groupBy":
        if (this.ast.havings.length > 0) {
          throw new QueryError(
            "query.excludeGroupByHaving",
            'exclude("groupBy") would leave a having() without its groupBy().',
          );
        }
        next = this.#next(GROUP_BYS, NONE, true, NONE, NONE, HASH_SEED, this.#named);
        break;
      case "having":
        next = this.#next(HAVINGS, NONE, true, NONE, NONE, HASH_SEED, this.#named);
        break;
      case "orderBy":
        next = this.#next(ORDER_BYS, NONE, true, NONE, NONE, HASH_SEED, this.#named);
        break;
      case "limit":
        next = this.#next(LIMIT, undefined, true, NONE, NONE, ABSENT_SHAPE, this.#named);
        break;
      case "offset":
        next = this.#next(OFFSET, undefined, true, NONE, NONE, ABSENT_SHAPE, this.#named);
        break;
      case "lock":
        next = this.#next(LOCK, undefined, true, NONE, NONE, ABSENT_SHAPE, this.#named);
        break;
      case "preload":
        next = this.#next(PRELOADS, NONE, true, NONE, NONE, HASH_SEED, this.#named, this.#scope, NONE);
        break;
      case "set":
        next = this.#next(UPDATES, NONE, true, NONE, NONE, HASH_SEED, this.#named);
        break;
      case "windows": {
        // A named window still used by the select or the order would be left undeclared.
        const select = this.ast.select;
        if (select !== undefined) checkWindows("exclude", selectExpressions(select.shape), NONE);
        for (const order of this.ast.orderBys) checkWindow("exclude", order.expr, NONE);
        next = this.#next(WINDOWS, NONE, true, NONE, NONE, HASH_SEED, this.#named);
        break;
      }
      case "withCte":
        next = this.#next(CTES, NONE, true, NONE, NONE, HASH_SEED, this.#named);
        break;
      case "setOperations":
        next = this.#next(COMBINATIONS, NONE, true, NONE, NONE, HASH_SEED, this.#named);
        break;
      default:
        throw new QueryError(
          "query.excludeUnknown",
          `exclude() was given ${typeof clause === "string" ? `"${clause}"` : describeValue(clause)}, which is not a clause it removes.`,
        );
    }
    return this.#dropping(next as never, `exclude("${clause}")`) as never;
  }

  /**
   * Passes the query to a function and returns what it returns: `q.pipe(f)` is `f(q)`.
   * For reusable scopes in a chain.
   *
   * @example
   * ```ts
   * from(Post, "p").pipe(published).pipe((q) => paginate(q, 2));
   * ```
   */
  pipe<T>(fn: (query: this) => T): T {
    if (typeof fn !== "function")
      throw new QueryError("query.pipeFunction", "pipe() takes a function from query to query.");
    return fn(this);
  }

  // --- preload ----------------------------------------------------------------

  /**
   * Declares associations to load with the rows: a name, an array, a nested object, or
   * the alias of a binding joined through the association (`{ posts: "p" }`). With a name
   * and a callback, the callback receives a query rooted at the association's target, its
   * binding named after the association, and returns the query that loads it. The repo
   * runs the preloads; the result type says what is loaded.
   *
   * @example
   * ```ts
   * from(User, "u").preload(["profile", { posts: "comments" }]);
   * from(User, "u").preload("posts", (q) => q.orderBy(({ posts }) => posts.createdAt.desc()).limit(3));
   * ```
   *
   * @throws QueryError when an association does not exist, the select is not the whole
   * root row, a callback's `limit` or `offset` has no order to go by, or its select lacks
   * the association's key.
   */
  preload<Q0 extends QueryLike, const Spec>(
    this: Q0,
    spec: Spec & ValidSpec<RootSchemaOf<Q0>, Spec, BindingsOf<Q0>>,
  ): WithResult<
    Q0,
    QueryResult<Q0> & LoadedUnchecked<RootSchemaOf<Q0>, NormalizeSpec<RootSchemaOf<Q0>, Spec, BindingsOf<Q0>>>
  >;
  preload<Q0 extends QueryLike, K extends AssocKeys<RootSchemaOf<Q0>>, Q extends QueryLike>(
    this: Q0,
    assoc: K,
    fn: (query: PreloadQuery<RootSchemaOf<Q0>, K>) => Q & PreloadCheck<RootSchemaOf<Q0>, K, Q>,
  ): WithResult<Q0, QueryResult<Q0> & LoadedAs<RootSchemaOf<Q0>, K, QueryResult<Q>>, QueryParams<Q>>;
  preload(spec: unknown, fn?: unknown): unknown {
    const root = this.#scope.root;
    const rootMeta = root.meta;
    if (rootMeta === undefined || root.schema === undefined) {
      throw new QueryError(
        "query.preloadNoAssociations",
        `preload() loads associations of a schema, and the root binding "${root.alias}" has none.`,
      );
    }
    if (hasOptionalRoot(this.ast)) {
      throw new QueryError(
        "query.preloadOptionalRoot",
        `preload() attaches associations to the rows of the root binding "${root.alias}", which a right or full join makes optional.`,
      );
    }
    if (!selectsRoot(this.ast.select, root.alias)) {
      throw new QueryError(
        "query.preloadSelectedShape",
        `preload() attaches associations to whole rows, and this query selects ${describeShape((this.ast.select as SelectNode).shape)}.`,
        { params: { alias: root.alias } },
      );
    }
    let nodes: readonly PreloadNode[];
    let preloadNamed = this.#preloadNamed;
    if (fn !== undefined) {
      const built = callbackPreload(rootMeta, spec, fn);
      nodes = [built.node];
      // The preload's query runs with the same params object as this one: one name, one type.
      try {
        preloadNamed = joinNamed(joinNamed(preloadNamed, built.query.#named), built.query.#preloadNamed);
        joinNamed(this.#named, preloadNamed);
      } catch (error) {
        rethrow(error, `preload("${spec as string}"): `);
      }
    } else {
      nodes = parseSpec(this.#scope, rootMeta, spec, root.alias, "");
    }
    let preloads = this.ast.preloads;
    for (const node of nodes) preloads = mergePreload(preloads, node);
    preloads = sortPreloads(rootMeta, preloads);
    return this.#next(
      PRELOADS,
      preloads,
      true,
      NONE,
      NONE,
      listShape(preloads),
      this.#named,
      this.#scope,
      preloadNamed,
    );
  }

  // --- subqueries and inspection ----------------------------------------------

  /**
   * The query as an operand of an expression, `(SELECT …)`: `u.id.in(q)`, `exists(q)`. Its
   * value is the single expression it selects.
   *
   * @example
   * ```ts
   * from(User, "u").where(({ u }) => u.id.in(from(Post, "p").select(({ p }) => p.authorId)));
   * ```
   *
   * @throws QueryError when the query has preloads, which a subquery cannot run.
   */
  [AS_SUBQUERY](): Expr<R, P> {
    const ast = this.ast;
    if (ast.preloads.length > 0) {
      throw new QueryError("query.subqueryWithPreloads", "A query with preloads was used as a subquery.");
    }
    if (ast.updates.length > 0) {
      throw new QueryError(
        "query.subqueryIsUpdate",
        "A query with set(…) assignments, an update, was used as a subquery.",
      );
    }
    const select = ast.select;
    const type = select !== undefined && select.shape.kind === "expr" ? select.shape.type : undefined;
    return new Expr(
      subqueryNode(ast),
      type,
      false,
      ast.params,
      ast.listLengths,
      this.named,
      shapeOfSubquery("subquery", ast.shape),
    );
  }

  /**
   * Whether the query has a binding with this alias (its own, not the ones the builder adds).
   *
   * @example
   * ```ts
   * from(User, "u").hasBinding("u"); // true
   * ```
   */
  hasBinding(alias: string): boolean {
    const entry = findEntry(this.#scope, alias);
    return entry !== undefined && !entry.internal;
  }

  /**
   * The schema class of a binding, `undefined` when there is none (or no such binding).
   *
   * @example
   * ```ts
   * from(User, "u").schemaOf("u") === User; // true
   * ```
   */
  schemaOf(alias: string): AnySchema | undefined {
    const entry = findEntry(this.#scope, alias);
    return entry === undefined || entry.internal ? undefined : entry.schema;
  }

  /**
   * A compact, SQL-like rendering for debugging. Values are never shown, only `?` (and
   * `:name` for named parameters), so nothing redacted can leak.
   *
   * @example
   * ```ts
   * from(User, "u").where(({ u }) => u.age.gte(18)).toString();
   * // "from users as u where u.age >= ?"
   * ```
   */
  toString(): string {
    return render(this.ast);
  }

  /**
   * What `console.log` and `util.inspect` print: the rendering of {@link toString}.
   *
   * @example
   * ```ts
   * console.log(from(User, "u")); // Query<from users as u>
   * ```
   */
  [INSPECT](): string {
    return `Query<${this.toString()}>`;
  }
}

function visibleAliases(scope: Scope): string[] {
  return scope.entries.filter((entry) => !entry.internal).map((entry) => entry.alias);
}

function hasOptionalRoot(ast: QueryAst): boolean {
  for (const join of ast.joins) if (join.type === "right" || join.type === "full") return true;
  return false;
}

function selectsRoot(select: SelectNode | undefined, rootAlias: string): boolean {
  return select === undefined || (select.shape.kind === "binding" && select.shape.binding === rootAlias);
}

function describeShape(shape: SelectShape): string {
  switch (shape.kind) {
    case "expr":
      return "one expression";
    case "binding":
      return `the whole binding "${shape.binding}"`;
    case "constant":
      return "a plain value";
    case "object":
      return "an object";
    case "tuple":
      return "an array";
  }
}

// ---------------------------------------------------------------------------
// from
// ---------------------------------------------------------------------------

/**
 * Starts a query: `from(User, "u")` reads the `users` table and names its binding `u`.
 * The source is a schema class, or a source wrapper such as `subquery(q)` or
 * `cte(name, Schema)`; a query itself is not a source (continue it by calling more methods
 * on it). The alias is required.
 *
 * @example
 * ```ts
 * const q = from(User, "u").where(({ u }) => u.age.gte(18));
 * ```
 *
 * @throws QueryError when the source is not a schema class or a source wrapper (a query
 * included), or the alias is missing.
 */
export function from<Src extends Source, const A extends string>(
  source: Src,
  alias: A,
): Query<{ readonly [K in A]: BindingOfSource<Src> }, RowOfSource<Src>, ParamsOfSource<Src>, A> {
  if (isSchema(source) && typeof alias === "string") {
    const cached = roots.get(meta(source))?.get(alias);
    if (cached !== undefined) return cached as never;
  }
  const name = checkAlias(undefined, alias, "from");
  const parts = sourceParts(source, name, "from");
  const entry: Entry = {
    alias: name,
    schema: parts.schema,
    meta: parts.meta,
    binding: parts.binding,
    via: undefined,
    internal: false,
  };
  const scope: Scope = { arg: { [name]: parts.binding }, entries: [entry], root: entry };
  const shapes = emptyShapes(parts.node);
  const ast: QueryAst = {
    kind: "query",
    from: parts.node,
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
    params: parts.params,
    listLengths: parts.lists,
    shape: combineQueryShape(shapes),
  };
  const counts = parts.params.length === 0 ? ZEROS : withEntry(ZEROS, FROM, parts.params.length);
  const lists = parts.lists.length === 0 ? ZEROS : withEntry(ZEROS, FROM, parts.lists.length);
  const query = new Query<never, unknown, never, string>(
    TOKEN,
    ast,
    counts,
    lists,
    shapes,
    parts.named,
    NONE,
    scope,
  );
  if (parts.meta !== undefined && parts.schema !== undefined) {
    let byAlias = roots.get(parts.meta);
    if (byAlias === undefined) {
      byAlias = new Map();
      roots.set(parts.meta, byAlias);
    }
    byAlias.set(name, query);
  }
  return query as never;
}

/**
 * The query `from(Schema, alias)` returns, per schema and alias. A query is immutable, so
 * one value serves every caller; starting a query is then a lookup.
 */
const roots = /* @__PURE__ */ new WeakMap<SchemaMeta, Map<string, Query<never, unknown, never, string>>>();

/**
 * Whether `query` has a binding named `alias`, and with a schema class, whether that
 * binding is of that schema. Narrows the query's type, for code that receives a query it
 * did not build.
 *
 * @example
 * ```ts
 * if (hasNamedBinding(q, "p", Post)) q.where(({ p }) => p.published);
 * ```
 */
export function hasNamedBinding<Q extends QueryLike, const A extends string, S extends AnySchema>(
  query: Q,
  alias: A,
  schema: S,
): query is QueryWith<{ readonly [K in A]: S }> & Q;
export function hasNamedBinding<Q extends QueryLike, const A extends string>(
  query: Q,
  alias: A,
): query is Query<{ readonly [K in A]: AnyBinding }, unknown, SomeParams, string> & Q;
export function hasNamedBinding(query: unknown, alias: string, schema?: AnySchema): boolean {
  if (!(query instanceof Query) || !query.hasBinding(alias)) return false;
  return schema === undefined || query.schemaOf(alias) === schema;
}

// ---------------------------------------------------------------------------
// Joins through associations
// ---------------------------------------------------------------------------

interface BuiltJoin {
  readonly source: SourceNode;
  readonly on: AnyExpr;
}

interface AssocJoins {
  readonly joins: readonly BuiltJoin[];
  readonly entries: readonly Entry[];
}

/** An expression for a column of the join table of a many-to-many association, which has no binding. */
function rawColumn(alias: string, field: string, column: string, type: AnyFieldType | undefined): AnyExpr {
  return new Expr(
    columnNode(alias, field, column),
    type,
    false,
    NONE,
    NONE,
    NONE,
    shapeOfColumn(alias, column),
  );
}

/**
 * The column of a field of a binding made from a schema. Association keys and filters are
 * field names that were checked against the schemas when the association was resolved.
 */
function columnOf(entry: Entry, field: string): AnyExpr {
  return (entry.binding as Readonly<Record<string, AnyExpr>>)[field] as AnyExpr;
}

function andMaybe(base: AnyExpr, extra: readonly AnyExpr[]): AnyExpr {
  return extra.length === 0 ? base : allOf([base, ...extra]);
}

/** The joins, and the new bindings, for following association `assocName` from `start` under `alias`. */
function assocJoins(
  scope: Scope,
  start: Entry,
  assocName: string,
  alias: string,
  type: "inner" | "left",
  clause: string,
): AssocJoins {
  const startMeta = start.meta;
  if (startMeta === undefined) {
    throw new QueryError(
      "query.assocJoinNoSchema",
      `${clause}("${start.alias}", "${assocName}", …): the binding "${start.alias}" has no schema, so it has no associations.`,
    );
  }
  const assoc = startMeta.assocs().get(assocName);
  if (assoc === undefined) {
    const known = [...startMeta.assocs().keys()];
    throw new QueryError(
      "query.assocJoinUnknown",
      `${clause}("${start.alias}", "${assocName}", …): ${startMeta.name} has no association "${assocName}". Its associations are: ${known.length === 0 ? "none" : known.join(", ")}.`,
    );
  }
  const label = `${clause}("${start.alias}", "${assocName}", "${alias}"): the association ${startMeta.name}.${assocName}`;
  const joins: BuiltJoin[] = [];
  const entries: Entry[] = [];
  const via = { from: start.alias, assoc: assocName };

  if (assoc.through !== undefined) {
    // A chain: each step is a join of its own; the bindings of the inner steps are internal.
    // (A has-through association has no `where` of its own: its steps say how rows are found.)
    let current = start;
    const steps = assoc.through;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] as string;
      const last = i === steps.length - 1;
      const stepAlias = last ? alias : `$${alias}_${i}_${step}`;
      const inner = assocJoins(scope, current, step, stepAlias, type, clause);
      for (const built of inner.joins) joins.push(built);
      for (const entry of inner.entries) {
        entries.push(entry.alias === stepAlias && !last ? { ...entry, internal: true } : entry);
      }
      current = entries[entries.length - 1] as Entry;
    }
    entries[entries.length - 1] = { ...current, via };
    return { joins, entries };
  }

  const target = assoc.target();
  const targetMeta = meta(target);
  const targetEntry: Entry = {
    alias,
    schema: target,
    meta: targetMeta,
    binding: bindingOf(targetMeta, target, alias),
    via,
    internal: false,
  };
  const targetSource = tableNode(targetMeta.source as string, targetMeta, undefined, alias);
  const where =
    assoc.where === undefined ? NONE : assocFilter((key) => columnOf(targetEntry, key), assoc.where, label);

  if (assoc.kind !== "manyToMany") {
    // belongsTo: the target's referenced key equals the owner's foreign key; hasOne and
    // hasMany: the target's foreign key equals the owner's key. Both are relatedKey = ownerKey.
    const keys: AnyExpr[] = [];
    for (let i = 0; i < assoc.relatedKey.length; i++) {
      keys.push(
        columnOf(targetEntry, assoc.relatedKey[i] as string).eq(
          columnOf(start, assoc.ownerKey[i] as string) as never,
        ),
      );
    }
    joins.push({ source: targetSource, on: andMaybe(allOf(keys), where) });
    entries.push(targetEntry);
    return { joins, entries };
  }

  // Many-to-many: the join table under an internal alias, then the target. Internal aliases
  // start with "$", which a caller's alias cannot, and derive from the caller's (unique)
  // alias, so they cannot collide.
  const through = assoc.joinThrough as NonNullable<AssocMeta["joinThrough"]>;
  const [ownerSide, targetSide] = assoc.joinKeys as NonNullable<AssocMeta["joinKeys"]>;
  const tableAlias = `$${alias}_join`;
  const joinSchema = through.model?.();
  const joinMeta = joinSchema === undefined ? undefined : meta(joinSchema);
  // Columns of the join table: typed by the join schema's field, or by the field they point at.
  const joinColumn = (column: string, pointsAt: AnyExpr | undefined): AnyExpr => {
    const field = joinMeta?.persisted.find((f) => f.column === column);
    return rawColumn(tableAlias, field?.name ?? column, column, field?.type ?? pointsAt?.type);
  };
  const ownerField = columnOf(start, ownerSide.field);
  const targetField = columnOf(targetEntry, targetSide.field);
  const joinWhere =
    assoc.joinWhere === undefined
      ? NONE
      : assocFilter((column) => joinColumn(column, undefined), assoc.joinWhere, `${label}, its join table`);
  joins.push({
    source:
      joinMeta === undefined
        ? tableNode(through.source, undefined, through.schema, tableAlias)
        : tableNode(joinMeta.source as string, joinMeta, undefined, tableAlias),
    on: andMaybe(joinColumn(ownerSide.column, ownerField).eq(ownerField as never) as AnyExpr, joinWhere),
  });
  entries.push({
    alias: tableAlias,
    schema: joinSchema,
    meta: joinMeta,
    binding: undefined,
    via: undefined,
    internal: true,
  });
  joins.push({
    source: targetSource,
    on: andMaybe(targetField.eq(joinColumn(targetSide.column, targetField) as never) as AnyExpr, where),
  });
  entries.push(targetEntry);
  return { joins, entries };
}

// ---------------------------------------------------------------------------
// Preloads
// ---------------------------------------------------------------------------

function assocOf(schemaMeta: SchemaMeta, name: string, path: string): AssocMeta {
  const assoc = schemaMeta.assocs().get(name);
  if (assoc === undefined) {
    const known = [...schemaMeta.assocs().keys()];
    throw new QueryError(
      "query.preloadUnknown",
      `preload(${path === "" ? `"${name}"` : `{ ${path}${name} }`}): ${schemaMeta.name} has no association "${name}". Its associations are: ${known.length === 0 ? "none" : known.join(", ")}.`,
    );
  }
  return assoc;
}

/** Whether the binding `alias` was joined from `parent` through association `assoc`. */
function joinedThrough(scope: Scope, alias: string, parent: string | undefined, assoc: string): boolean {
  if (parent === undefined) return false;
  const entry = findEntry(scope, alias);
  return entry?.via !== undefined && entry.via.from === parent && entry.via.assoc === assoc;
}

/**
 * The preload nodes of a spec at one level. `parent` is the alias of the binding the rows
 * of this level come from when they come from a join, `undefined` when they are loaded by
 * a separate query.
 */
function parseSpec(
  scope: Scope,
  schemaMeta: SchemaMeta,
  spec: unknown,
  parent: string | undefined,
  path: string,
): readonly PreloadNode[] {
  if (typeof spec === "string") {
    assocOf(schemaMeta, spec, path);
    return [preloadNode(spec, undefined, undefined, NONE)];
  }
  if (Array.isArray(spec)) {
    const out: PreloadNode[] = [];
    for (const item of spec as readonly unknown[]) {
      for (const node of parseSpec(scope, schemaMeta, item, parent, path)) out.push(node);
    }
    return out;
  }
  if (typeof spec !== "object" || spec === null || !isPlainObject(spec)) {
    throw new QueryError(
      "query.preloadSpec",
      `preload() takes an association name, an array, an object of nested preloads, or a name and a callback; ${path === "" ? "it was" : `at ${path.replace(/[:{ ]+$/, "")} it was`} given ${describeValue(spec)}.`,
    );
  }
  const out: PreloadNode[] = [];
  for (const key of Object.keys(spec)) {
    if (key === "$from") continue;
    const assoc = assocOf(schemaMeta, key, path);
    const value = (spec as Record<string, unknown>)[key];
    const targetMeta = meta(assoc.target());
    const here = `${path}${key}: `;
    if (value === true) {
      out.push(preloadNode(key, undefined, undefined, NONE));
    } else if (typeof value === "string" && joinedThrough(scope, value, parent, key)) {
      out.push(preloadNode(key, value, undefined, NONE));
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.hasOwn(value, "$from")
    ) {
      const source = (value as { readonly $from?: unknown }).$from;
      if (typeof source !== "string" || !joinedThrough(scope, source, parent, key)) {
        throw new QueryError(
          "query.preloadFrom",
          `preload({ ${here}{ $from: ${typeof source === "string" ? `"${source}"` : describeValue(source)} } }): $from names the binding to fill "${key}" from, which must be joined through that association.`,
          { params: { parent: parent ?? "…", key, source: typeof source === "string" ? source : "alias" } },
        );
      }
      out.push(preloadNode(key, source, undefined, parseSpec(scope, targetMeta, value, source, `${here}{ `)));
    } else {
      if (typeof value === "string" && !targetMeta.assocs().has(value)) {
        const binding = findEntry(scope, value);
        if (binding !== undefined && !binding.internal) {
          throw new QueryError(
            "query.preloadBindingNotJoined",
            `preload({ ${here}"${value}" }): "${value}" is a binding of this query, but it was not joined through the association "${key}"${parent === undefined ? " from the rows this level is loaded from" : ` from "${parent}"`}, so it cannot fill it.`,
            { params: { parent: parent ?? "…", key, value1: value, name: targetMeta.name } },
          );
        }
      }
      out.push(preloadNode(key, undefined, undefined, parseSpec(scope, targetMeta, value, undefined, here)));
    }
  }
  return out;
}

/** Adds a preload to a list, merging it into an entry for the same association. */
function mergePreload(list: readonly PreloadNode[], node: PreloadNode): readonly PreloadNode[] {
  const at = list.findIndex((existing) => existing.assoc === node.assoc);
  if (at === -1) return [...list, node];
  const existing = list[at] as PreloadNode;
  if (existing.from !== node.from) {
    throw new QueryError(
      "query.preloadTwice",
      `preload "${node.assoc}" is declared twice, once from ${existing.from === undefined ? "a separate query" : `the binding "${existing.from}"`} and once from ${node.from === undefined ? "a separate query" : `the binding "${node.from}"`}.`,
    );
  }
  if (existing.query !== undefined && node.query !== undefined) {
    throw new QueryError("query.preloadCallbackTwice", `preload "${node.assoc}" is given a callback twice.`);
  }
  let nested = existing.nested;
  for (const child of node.nested) nested = mergePreload(nested, child);
  const merged = preloadNode(node.assoc, node.from, existing.query ?? node.query, nested);
  const out = list.slice();
  out[at] = merged;
  return out;
}

/**
 * The preloads in the order the schema declares its associations, at every level (step
 * 14): rows that carry one set of associations then have one shape, whatever order the
 * preloads were asked for in. Returns `list` itself when it is in that order already.
 */
function sortPreloads(schemaMeta: SchemaMeta, list: readonly PreloadNode[]): readonly PreloadNode[] {
  const assocs = schemaMeta.assocs();
  const order = [...assocs.keys()];
  let changed = false;
  const out = list.map((node) => {
    const nested =
      node.nested.length === 0
        ? node.nested
        : sortPreloads(meta((assocs.get(node.assoc) as AssocMeta).target()), node.nested);
    if (nested === node.nested) return node;
    changed = true;
    return preloadNode(node.assoc, node.from, node.query, nested);
  });
  out.sort((a, b) => order.indexOf(a.assoc) - order.indexOf(b.assoc));
  if (!changed && out.every((node, i) => node === list[i])) return list;
  return out;
}

/** The preload node of the callback form, with the checks that need the callback's query. */
function callbackPreload(
  rootMeta: SchemaMeta,
  name: unknown,
  fn: unknown,
): { readonly node: PreloadNode; readonly query: Query<unknown, unknown, never, string> } {
  if (typeof name !== "string") {
    throw new QueryError(
      "query.preloadCallbackName",
      "preload() with a callback takes one association name first.",
    );
  }
  const assoc = assocOf(rootMeta, name, "");
  if (typeof fn !== "function") {
    throw new QueryError(
      "query.preloadCallbackArgument",
      `preload("${name}", …) takes a function from query to query as its second argument.`,
      { params: { name } },
    );
  }
  const target = assoc.target();
  const base = from(target, name);
  const result: unknown = run("preload", fn, base);
  if (!(result instanceof Query)) {
    throw new QueryError(
      "query.preloadCallbackResult",
      `preload("${name}", callback): the callback must return a query, the one it receives with clauses added; it returned ${describeValue(result)}.`,
    );
  }
  const ast = result.ast;
  if (ast.from.alias !== name || result.schemaOf(name) !== target) {
    throw new QueryError(
      "query.preloadCallbackOtherQuery",
      `preload("${name}", callback): the callback must return the query it receives (rooted at ${meta(target).name} as "${name}"), with clauses added.`,
    );
  }
  if (hasOptionalRoot(ast)) {
    throw new QueryError(
      "query.preloadOptionalRows",
      `preload("${name}", callback): the callback's query has a right or full join, which makes the rows of "${name}" optional, and a preloaded association needs rows that exist.`,
    );
  }
  if (
    (ast.limit !== undefined || ast.offset !== undefined) &&
    ast.orderBys.length === 0 &&
    assoc.orderBy.length === 0
  ) {
    throw new QueryError(
      "query.preloadLimitOrder",
      `limit in preload "${name}" needs an orderBy: the limit and offset of a preload apply per parent, and pick rows by order.`,
      { params: { name } },
    );
  }
  const select = ast.select;
  if (
    select !== undefined &&
    !selectsRoot(select, name) &&
    assoc.kind !== "manyToMany" &&
    assoc.through === undefined
  ) {
    // The key the children are matched on, on the target: the foreign key of a hasOne or
    // hasMany, the referenced key of a belongsTo.
    for (const key of assoc.relatedKey) {
      if (!selectsKey(select.shape, name, key)) {
        throw new QueryError("query.preloadSelectKey", `preload "${name}" selects without its key.`, {
          params: { key, name },
        });
      }
    }
  }
  return { node: preloadNode(name, undefined, ast, ast.preloads), query: result as never };
}

function selectsKey(shape: SelectShape, alias: string, field: string): boolean {
  if (shape.kind !== "object") return false;
  const at = shape.keys.indexOf(field);
  if (at === -1) return false;
  const value = shape.values[at] as SelectShape;
  return (
    value.kind === "expr" &&
    value.expr.kind === "column" &&
    value.expr.binding === alias &&
    value.expr.field === field
  );
}

// ---------------------------------------------------------------------------
// toString
// ---------------------------------------------------------------------------

const BINARY_TEXT: Readonly<Record<Exclude<BinaryOp, "has">, string>> = {
  eq: "=",
  neq: "<>",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  isDistinctFrom: "is distinct from",
  like: "like",
  notLike: "not like",
  ilike: "ilike",
  in: "in",
  notIn: "not in",
  add: "+",
  sub: "-",
  mul: "*",
  div: "/",
  mod: "%",
  concat: "||",
  contains: "@>",
  containedBy: "<@",
  overlaps: "&&",
};

const UNARY_TEXT: Readonly<Record<UnaryOp, readonly [string, string]>> = {
  not: ["not ", ""],
  neg: ["-", ""],
  isNull: ["", " is null"],
  isNotNull: ["", " is not null"],
};

function show(node: ExprNode): string {
  switch (node.kind) {
    case "column":
      return `${node.binding}.${node.column}`;
    case "param":
    case "list":
      return "?";
    case "namedParam":
      return `:${node.name}`;
    case "literal":
      return node.value === null ? "null" : String(node.value);
    case "unary": {
      const [before, after] = UNARY_TEXT[node.op];
      return `${before}${wrap(node.operand)}${after}`;
    }
    case "binary":
      if (node.op === "has") return `${wrap(node.right)} = any(${show(node.left)})`;
      return `${wrap(node.left)} ${BINARY_TEXT[node.op]} ${wrap(node.right)}`;
    case "between":
      return `${wrap(node.expr)} between ${wrap(node.low)} and ${wrap(node.high)}`;
    case "nary":
      return node.args.length === 0
        ? node.op === "and"
          ? "true"
          : "false"
        : node.args.map(wrap).join(` ${node.op} `);
    case "fn":
      return `${node.name}(${node.args.map(show).join(", ")})`;
    case "aggregate": {
      const args = `${node.distinct ? "distinct " : ""}${node.args.map(show).join(", ")}`;
      const filter = node.filter === undefined ? "" : ` filter (where ${show(node.filter)})`;
      const over =
        node.over === undefined ? "" : typeof node.over === "string" ? ` over ${node.over}` : " over (…)";
      return `${node.name}(${args})${filter}${over}`;
    }
    case "ident":
      return node.name;
    case "fragment": {
      let text = node.strings[0] as string;
      for (let i = 0; i < node.args.length; i++)
        text += show(node.args[i] as ExprNode) + (node.strings[i + 1] as string);
      return `fragment\`${text}\``;
    }
    case "cast":
      return `cast(${show(node.expr)} as ${node.type.name})`;
    case "case": {
      const whens = node.whens.map((b) => `when ${show(b.when)} then ${show(b.result)}`).join(" ");
      return `case ${whens}${node.else === undefined ? "" : ` else ${show(node.else)}`} end`;
    }
    case "jsonPath":
      return `${wrap(node.expr)} ${node.asText ? "#>>" : "#>"} {${node.path.map(show).join(",")}}`;
    case "subquery":
      return `(${render(node.query)})`;
    case "exists":
      return `exists (${render(node.query)})`;
    case "tuple":
      return `(${node.items.map(show).join(", ")})`;
    case "selectedAs":
      return node.expr === undefined ? node.name : `${show(node.expr)} as ${node.name}`;
    case "star":
      return "*";
  }
}

function wrap(node: ExprNode): string {
  const text = show(node);
  return node.kind === "binary" || node.kind === "nary" || node.kind === "between" ? `(${text})` : text;
}

function showSource(source: SourceNode): string {
  switch (source.kind) {
    case "table":
      return `${source.schema === undefined ? "" : `${source.schema}.`}${source.source} as ${source.alias}`;
    case "cteSource":
      return `${source.name} as ${source.alias}`;
    case "subquerySource":
      return `(${render(source.query)}) as ${source.alias}`;
    case "values":
      return `(values …) as ${source.alias}`;
    case "fragmentSource":
      return `${show(source.fragment)} as ${source.alias}`;
  }
}

function showSelect(shape: SelectShape): string {
  switch (shape.kind) {
    case "expr":
      return show(shape.expr);
    case "binding":
      return shape.binding;
    case "constant":
      return "<value>";
    case "object":
      return `{ ${shape.keys.map((key, i) => `${key}: ${showSelect(shape.values[i] as SelectShape)}`).join(", ")} }`;
    case "tuple":
      return `[${shape.items.map(showSelect).join(", ")}]`;
  }
}

function showBools(nodes: readonly BoolNode[]): string {
  if (nodes.length === 1) return show((nodes[0] as BoolNode).expr);
  let text = "";
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as BoolNode;
    text = i === 0 ? wrap(node.expr) : `${i > 1 ? `(${text})` : text} ${node.op} ${wrap(node.expr)}`;
  }
  return text;
}

function showWindow(node: WindowNode): string {
  const parts: string[] = [];
  if (node.partitionBy.length > 0) parts.push(`partition by ${node.partitionBy.map(show).join(", ")}`);
  if (node.orderBy.length > 0) parts.push(`order by ${node.orderBy.map(showOrder).join(", ")}`);
  if (node.frame !== undefined) parts.push(show(node.frame));
  return parts.join(" ");
}

function showOrder(node: OrderNode): string {
  return `${show(node.expr)}${node.direction === "desc" ? " desc" : ""}${node.nulls === undefined ? "" : ` nulls ${node.nulls}`}`;
}

function showPreload(node: PreloadNode): string {
  const nested = node.nested.length === 0 ? "" : ` { ${node.nested.map(showPreload).join(", ")} }`;
  const source = node.from !== undefined ? ` from ${node.from}` : node.query !== undefined ? " (query)" : "";
  return `${node.assoc}${source}${nested}`;
}

/**
 * A compact, SQL-like rendering of a query, without values.
 *
 * @example
 * ```ts
 * render(from(User, "u").limit(1).ast); // "from users as u limit ?"
 * ```
 */
export function render(ast: QueryAst): string {
  const parts: string[] = [];
  if (ast.ctes.length > 0) {
    const recursive = ast.ctes.some((node) => node.recursive) ? "recursive " : "";
    const ctes = ast.ctes.map(
      (node) => `${node.name} as (${node.query.kind === "query" ? render(node.query) : show(node.query)})`,
    );
    parts.push(`with ${recursive}${ctes.join(", ")}`);
  }
  parts.push(`from ${showSource(ast.from)}`);
  for (const node of ast.joins) {
    parts.push(
      `${node.type} join ${showSource(node.source)}${node.on === undefined ? "" : ` on ${show(node.on)}`}`,
    );
  }
  if (ast.wheres.length > 0) parts.push(`where ${showBools(ast.wheres)}`);
  if (ast.groupBys.length > 0) parts.push(`group by ${ast.groupBys.map(show).join(", ")}`);
  if (ast.havings.length > 0) parts.push(`having ${showBools(ast.havings)}`);
  if (ast.distinct !== undefined) {
    parts.push(
      ast.distinct.on.length === 0 ? "distinct" : `distinct on (${ast.distinct.on.map(show).join(", ")})`,
    );
  }
  if (ast.windows.length > 0) {
    parts.push(
      `window ${ast.windows.map((node) => `${node.name} as (${showWindow(node.spec)})`).join(", ")}`,
    );
  }
  if (ast.updates.length > 0) {
    parts.push(`set ${ast.updates.map((node) => `${node.column} = ${show(node.value)}`).join(", ")}`);
  }
  if (ast.select !== undefined) {
    parts.push(
      `${RETURNING_SELECTS.has(ast.select) ? "returning" : "select"} ${showSelect(ast.select.shape)}`,
    );
  }
  for (const node of ast.combinations)
    parts.push(`${node.op}${node.all ? " all" : ""} (${render(node.query)})`);
  if (ast.orderBys.length > 0) parts.push(`order by ${ast.orderBys.map(showOrder).join(", ")}`);
  if (ast.limit !== undefined) parts.push(`limit ${show(ast.limit)}`);
  if (ast.offset !== undefined) parts.push(`offset ${show(ast.offset)}`);
  if (ast.lock !== undefined) {
    parts.push(
      typeof ast.lock.clause === "string" ? ast.lock.clause.toLowerCase() : `lock ${show(ast.lock.clause)}`,
    );
  }
  if (ast.schema !== undefined) parts.push(`schema ${ast.schema}`);
  if (ast.preloads.length > 0) parts.push(`preload ${ast.preloads.map(showPreload).join(", ")}`);
  return parts.join(" ");
}
