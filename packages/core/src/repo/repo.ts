/**
 * The repo: the one object that talks to the database. {@link createRepo} makes one over
 * an adapter; {@link Repo} is its type, and the type of the transaction-scoped repo too.
 *
 * @module
 */
import type { PoolStats } from "../adapter/adapter.js";
import type { Batch } from "../batch/batch.js";
import type { Changeset } from "../changeset/changeset.js";
import type { ChangesetSource, RowSchema } from "../changeset/types.js";
import type { PlanCacheStats } from "../compiler/index.js";
import type { PoolEvent } from "../contracts/adapter.js";
import type { Result } from "../contracts/result.js";
import type {
  AnySchema,
  AssocKeys,
  FieldNames,
  LoadedAs,
  LoadedUnchecked,
  PreloadMarker,
  PrimaryKeyOf,
  Row,
  ValidPreload,
} from "../contracts/schema.js";
import { QueryError } from "../errors.js";
import { own } from "../internal/own.js";
import type { ColumnNames, SchemaOfBinding } from "../query/bindings.js";
import type {
  PreloadCheck,
  PreloadQuery,
  Queryable,
  QueryLike,
  QueryParams,
  QueryResult,
  WhereObject,
} from "../query/builder.js";
import type { Expr, NoParams, ParamsOf, SomeParams } from "../query/expr.js";
import { isSchema } from "../schema/guards.js";
import { type BulkResult, type InsertAllOptions, type InsertAllRow, insertAll, modifyAll } from "./bulk.js";
import {
  checkReadOptions,
  EXPLAIN_OPTION_KEYS,
  type ExplainReadOptions,
  READ_OPTION_KEYS,
  type ReadOptions,
  type RepoOptions,
  type RepoQueryEvent,
  repoSettings,
  type SplitArgs,
  SQL_OPTION_KEYS,
  STREAM_OPTION_KEYS,
  type StreamReadOptions,
  splitArgs,
  writeToStderr,
} from "./options.js";
import { PRELOAD_OPTION_KEYS, type PreloadOptions, preloadNodesOf, preloadRows } from "./preload.js";
import {
  type AggregateFunction,
  aggregate,
  byClauses,
  byKey,
  exactlyOne,
  exists,
  explain,
  first,
  firstOrThrow,
  inputOf,
  isFragment,
  load,
  QueryHub,
  type QueryInput,
  type RawRows,
  ReadCore,
  raw,
  reload,
  single,
  stream,
  toSql,
} from "./read.js";
import {
  checkout,
  createRoot,
  inTransaction,
  Level,
  rollback,
  type Scope,
  type TransactionOptions,
  transaction,
} from "./transaction.js";
import {
  type DeleteOptions,
  type InsertOptions,
  type InsertOrUpdateOptions,
  insert,
  insertOrUpdate,
  type OnConflictOption,
  orThrow,
  provideUniqueCheck,
  remove,
  type UpdateOptions,
  update,
} from "./write.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What a read of `Q` returns per row: the rows of a schema class, or what a query selects.
 *
 * @example
 * ```ts
 * type U = ResultOf<typeof User>; // User
 * ```
 */
export type ResultOf<Q> = Q extends QueryLike ? QueryResult<Q> : Q extends AnySchema ? Row<Q> : never;

/** The named parameters a read of `Q` needs: none for a schema class. */
type ParamsOfQueryable<Q> = Q extends QueryLike ? QueryParams<Q> : NoParams;

/**
 * The arguments after the queryable: `[options?]` when the query has no named parameters,
 * `[params, options?]` when it has some (then `params` is required and typed).
 *
 * @example
 * ```ts
 * type A = ReadArgs<typeof adults, ReadOptions>; // [params: { minAge: number }, options?: ReadOptions]
 * ```
 */
export type ReadArgs<Q, O> = [keyof ParamsOfQueryable<Q>] extends [never]
  ? [options?: O]
  : [params: ParamsOfQueryable<Q>, options?: O];

/** Like {@link ReadArgs}, with the options required. */
type ReadArgsWith<Q, O> = [keyof ParamsOfQueryable<Q>] extends [never]
  ? [options: O]
  : [params: ParamsOfQueryable<Q>, options: O];

/** The arguments of `raw(fragment, …)`: its named parameters when it has some, then options. */
type RawArgs<X> = [keyof ParamsOf<X>] extends [never]
  ? [options?: ReadOptions]
  : [params: ParamsOf<X>, options?: ReadOptions];

/**
 * The schema class of the root binding of `Q`: `Q` itself for a schema class.
 *
 * @example
 * ```ts
 * type S = RootSchemaOf<typeof q>; // typeof User, for from(User, "u")…
 * ```
 */
export type RootSchemaOf<Q> = Q extends AnySchema
  ? Q
  : Q extends { readonly "~query": { readonly bindings: infer B; readonly root: infer A } }
    ? A extends keyof B
      ? SchemaOfBinding<B[A]>
      : never
    : never;

/** The object form of `where` over the root binding of `Q`: what `getBy` takes. */
type ClausesOf<Q> = RootSchemaOf<Q> extends infer S extends AnySchema ? WhereObject<S> : never;

/** The columns of the root binding of `Q`. */
type RootColumn<Q> = ColumnNames<RootSchemaOf<Q>>;

/** The application type of column `F` of the root binding of `Q`. */
type RootValue<Q, F> = F extends keyof Row<RootSchemaOf<Q>> ? Row<RootSchemaOf<Q>>[F] : never;

/** The root columns that `sum` and `avg` take: numbers, bigints and decimals. */
type NumericColumn<Q> = {
  [F in RootColumn<Q>]: RootValue<Q, F> extends number | bigint | string | null ? F : never;
}[RootColumn<Q>];

/** The type of `sum` over a column of type `T`, as the `sum` expression gives it. */
type SumOf<T> =
  | (NonNullable<T> extends bigint ? bigint : NonNullable<T> extends number ? number : string)
  | null;

/** The type of `avg` over a column of type `T`, as the `avg` expression gives it. */
type AvgOf<T> = (NonNullable<T> extends string ? string : number) | null;

/**
 * Nothing for a changeset that may be of a new record; for one that is certainly of a
 * loaded row, a member no changeset has, so that the call is a compile error naming why.
 */
type NewRecordOnly<N extends boolean> = [N] extends [false]
  ? {
      readonly "insert takes a changeset of a new record (cast(User, …)); this one is of a loaded row: use update() or insertOrUpdate()": never;
    }
  : unknown;

/** Like {@link NewRecordOnly}, for the writes that need a loaded row. */
type LoadedRowOnly<N extends boolean> = [N] extends [true]
  ? {
      readonly "update and delete take a changeset of a loaded row; this one is of a new record: use insert() or insertOrUpdate()": never;
    }
  : unknown;

/** Refuses a changeset where a row is expected (a changeset goes to the other overload). */
type NotAChangeset<R> =
  R extends Changeset<ChangesetSource, boolean>
    ? { readonly "delete takes a row read from the database, or a changeset of a loaded row": never }
    : unknown;

/** An `onConflict` that inserts or updates a row, so that the write always returns one. */
type UpdatingConflict<S extends AnySchema> = Exclude<OnConflictOption<S>, "nothing"> | undefined;

/** Refuses a `repo.preload` callback whose query has named parameters: it runs at once, so it takes values. */
type NoNamedParams<Q extends QueryLike> = [keyof QueryParams<Q>] extends [never]
  ? unknown
  : {
      readonly "~error": "repo.preload runs its callback at once: give the query values, not named parameters";
    };

/** The preloaded associations a `Loaded` type records (its type-only marker). */
type PreloadedOf<L> = L extends PreloadMarker<infer P> ? NonNullable<P> : never;

/**
 * What a preload adds to a row of `S`: the properties of `L` that are not fields, and the
 * marker that records them (kept as the named marker type, which the row's own marker,
 * if it has one, is merged with).
 */
type PreloadedProps<S extends AnySchema, L> = Omit<L, keyof Row<S> | "~preloaded"> &
  PreloadMarker<PreloadedOf<L>>;

/** `R` with the properties of `N`, which replace any of the same name; the preload markers of both are kept. */
type With<R, N> = [Exclude<keyof N & keyof R, "~preloaded">] extends [never]
  ? R & N
  : Omit<R, Exclude<keyof N, "~preloaded">> & N;

/** What `repo.preload` returns for `I`: rows with `N`, an array of them, or `null`. */
type RowsWith<I, N> = I extends null ? null : I extends readonly (infer E)[] ? With<E, N>[] : With<I, N>;

/** Options of `repo.toSql`: only the database schema matters there. */
type SqlOptions = Pick<ReadOptions, "schema">;

/**
 * What `repo.toSql` returns: the SQL text and the parameters exactly as they would be
 * sent, converted for the driver (redacted values included: it is a debugging tool).
 *
 * @example
 * ```ts
 * const { sql, params }: SqlAndParams = repo.toSql(q);
 * ```
 */
export interface SqlAndParams {
  readonly sql: string;
  readonly params: unknown[];
}

/**
 * The repo: reads (this step), and the writes, preloads and transactions the later steps
 * add to the same interface. A transaction-scoped repo has the same type.
 *
 * Every read takes a **queryable**, a schema class (all of its rows) or a query. A query
 * with named parameters takes them as the second argument and its options third; one
 * without takes its options second.
 *
 * @example
 * ```ts
 * const repo: Repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });
 * const adults = await repo.all(from(User, "u").where(({ u }) => u.age.gte(18)));
 * ```
 */
export interface Repo {
  /**
   * Every row the query returns, in a fresh array.
   *
   * @example
   * ```ts
   * const users = await repo.all(User);
   * const titles = await repo.all(from(Post, "p").select(({ p }) => p.title), { timeoutMs: 500 });
   * ```
   *
   * @throws QueryError when the query cannot be compiled, or a named parameter is missing.
   * @throws DatabaseError when the database fails, times out (`"timeout"`) or the call is aborted (`"aborted"`).
   */
  all<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, ReadOptions>): Promise<ResultOf<Q>[]>;

  /**
   * The only row the query returns, or `null`. It adds no `LIMIT`: a second row means the
   * query is wrong, and is an error.
   *
   * @example
   * ```ts
   * const ada = await repo.one(from(User, "u").where({ email: "ada@example.com" }));
   * ```
   *
   * @throws MultipleResultsError when the query returns more than one row.
   */
  one<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, ReadOptions>): Promise<ResultOf<Q> | null>;

  /**
   * The only row the query returns.
   *
   * @example
   * ```ts
   * const ada = await repo.oneOrThrow(from(User, "u").where({ email: "ada@example.com" }));
   * ```
   *
   * @throws NoResultsError when the query returns no row.
   * @throws MultipleResultsError when it returns more than one.
   */
  oneOrThrow<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, ReadOptions>): Promise<ResultOf<Q>>;

  /**
   * The first row of the query, or `null`. It reads at most one row: `LIMIT 1`, or the
   * query's own limit when that is smaller (`limit(0)` gives `null`); the query's offset is
   * kept. It never throws for extra rows; give the query an order to say which row is first.
   *
   * @example
   * ```ts
   * const newest = await repo.first(from(Post, "p").orderBy(({ p }) => p.createdAt.desc()));
   * ```
   */
  first<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, ReadOptions>): Promise<ResultOf<Q> | null>;

  /**
   * The first row of the query, read as {@link Repo.first} reads it: `LIMIT 1`, or the
   * query's own limit when that is smaller, with the query's offset kept. Like `first`, it
   * never throws for extra rows; it throws when there is no row (also for `limit(0)`).
   *
   * @example
   * ```ts
   * const newest = await repo.firstOrThrow(from(Post, "p").orderBy(({ p }) => p.createdAt.desc()));
   * ```
   *
   * @throws NoResultsError when the query returns no row.
   */
  firstOrThrow<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, ReadOptions>): Promise<ResultOf<Q>>;

  /**
   * The row with primary key `id`, or `null`. For a composite key, `id` is an object of
   * the key fields.
   *
   * @example
   * ```ts
   * const user = await repo.get(User, 1);
   * const membership = await repo.get(Membership, { orgId, userId: 1 });
   * ```
   *
   * @throws QueryError when `id` is `null` or `undefined`, has the wrong shape for the key,
   * or the schema has no primary key.
   */
  get<S extends AnySchema>(schema: S, id: PrimaryKeyOf<S>, options?: ReadOptions): Promise<Row<S> | null>;

  /**
   * The row with primary key `id`.
   *
   * @example
   * ```ts
   * const user = await repo.getOrThrow(User, 1);
   * ```
   *
   * @throws NoResultsError when there is no such row.
   * @throws QueryError as {@link Repo.get} does.
   */
  getOrThrow<S extends AnySchema>(schema: S, id: PrimaryKeyOf<S>, options?: ReadOptions): Promise<Row<S>>;

  /**
   * The only row matching `clauses` (the object form of `where`, on the root binding), or
   * `null`. Strict, like {@link Repo.one}.
   *
   * @example
   * ```ts
   * const ada = await repo.getBy(User, { email: "ada@example.com" });
   * ```
   *
   * @throws MultipleResultsError when more than one row matches.
   */
  getBy<Q extends Queryable>(
    queryable: Q,
    clauses: ClausesOf<Q>,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<ResultOf<Q> | null>;

  /**
   * The only row matching `clauses`.
   *
   * @example
   * ```ts
   * const ada = await repo.getByOrThrow(User, { email: "ada@example.com" });
   * ```
   *
   * @throws NoResultsError when no row matches.
   * @throws MultipleResultsError when more than one does.
   */
  getByOrThrow<Q extends Queryable>(
    queryable: Q,
    clauses: ClausesOf<Q>,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<ResultOf<Q>>;

  /**
   * Whether the query returns any row. It runs `SELECT 1 … LIMIT 1`, without the select,
   * the order and the preloads.
   *
   * @example
   * ```ts
   * const taken = await repo.exists(from(User, "u").where({ email }));
   * ```
   */
  exists<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, ReadOptions>): Promise<boolean>;

  /**
   * How many rows the query returns: `aggregate(queryable, "count")`.
   *
   * @example
   * ```ts
   * const published = await repo.count(from(Post, "p").where({ published: true }));
   * ```
   */
  count<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, ReadOptions>): Promise<number>;

  /**
   * An aggregate over the query's rows: `count` of the rows, or `count`, `sum`, `avg`,
   * `min`, `max` of a column of its root binding. A query with a limit, an offset,
   * `distinct`, a set operation, a `groupBy` or a `having` is aggregated as a subquery,
   * so the aggregate sees exactly its rows. Over no rows `count` is 0 and the others are
   * `null`.
   *
   * @example
   * ```ts
   * const users = await repo.aggregate(User, "count");
   * const views = await repo.aggregate(Post, "sum", "views"); // number | null
   * const newest = await repo.aggregate(Post, "max", "createdAt"); // Date | null
   * ```
   *
   * @throws QueryError when the field is not a column of the root binding, or (`sum`,
   * `avg`) not a number.
   */
  aggregate<Q extends Queryable>(
    queryable: Q,
    fn: "count",
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<number>;
  aggregate<Q extends Queryable, F extends RootColumn<Q>>(
    queryable: Q,
    fn: "count",
    field: F,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<number>;
  aggregate<Q extends Queryable, F extends NumericColumn<Q>>(
    queryable: Q,
    fn: "sum",
    field: F,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<SumOf<RootValue<Q, F>>>;
  aggregate<Q extends Queryable, F extends NumericColumn<Q>>(
    queryable: Q,
    fn: "avg",
    field: F,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<AvgOf<RootValue<Q, F>>>;
  aggregate<Q extends Queryable, F extends RootColumn<Q>>(
    queryable: Q,
    fn: "min" | "max",
    field: F,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<NonNullable<RootValue<Q, F>> | null>;

  /**
   * The query's rows, fetched in batches through a server-side cursor and decoded one at
   * a time. Leaving the loop early (`break`, `return`, an exception) closes the cursor and
   * returns the connection. A stream cannot preload associations.
   *
   * @example
   * ```ts
   * for await (const user of repo.stream(from(User, "u"), { batchSize: 1_000 })) {
   *   await sendNewsletter(user);
   * }
   * ```
   *
   * @throws QueryError (when iterated) for a query with preloads.
   */
  stream<Q extends Queryable>(
    queryable: Q,
    ...args: ReadArgs<Q, StreamReadOptions>
  ): AsyncIterable<ResultOf<Q>>;

  /**
   * A fresh copy of a row, read again from the table (and database schema) it was read
   * from, or `null` when it is gone. Given an array, the copies in the same order.
   * What the row was preloaded with is loaded again, callbacks and named values
   * included, at every depth (a join preload by a separate query); a row a write
   * returned remembers the preloads of the row it was given.
   *
   * The database matches the keys, with its own equality. Two limits:
   * - a key value the row could not hold exactly no longer equals the stored one, so such
   *   a row comes back `null` (a timestamp key with microseconds, read into a millisecond
   *   `Date`);
   * - the keys are sent cast to their fields' declared types, so a key column whose real
   *   type differs fails ("operator does not exist"): a `t.enum` key on a native Postgres
   *   enum column, for example. Declare such a field with `defineType` and the column's
   *   SQL type (`db: { kind: "custom", sql: "mood" }`), and the keys are cast to it.
   *
   * @example
   * ```ts
   * const fresh = await repo.reload(user);
   * const [a, b] = await repo.reload([first, second]);
   * ```
   *
   * @throws TypeError when given something that is not a row read from the database.
   */
  reload<R extends object>(rows: readonly R[], options?: ReadOptions): Promise<(R | null)[]>;
  reload<R extends object>(row: R, options?: ReadOptions): Promise<R | null>;

  /**
   * Loads associations onto rows already read: one row, an array, or `null` (returned as
   * it is). It returns **new** rows; the given ones are not changed. An association a row
   * already has loaded is skipped (its nested preloads still apply to the rows it holds)
   * unless `force: true`. The spec is that of a query's `preload`: a name, an array, a
   * nested object, or a name and a callback. The schema class comes first because a row's
   * type does not say which class it belongs to. The callback runs at once, so its query
   * uses values, not named parameters (`param(…)` there is a compile error and a
   * `QueryError`).
   *
   * @example
   * ```ts
   * const users = await repo.all(User);
   * const loaded = await repo.preload(User, users, "posts");
   * const top3 = await repo.preload(User, users, "posts", (q) => q.orderBy(({ posts }) => posts.createdAt.desc()).limit(3));
   * await repo.preload(User, user, { posts: "comments" }, { force: true });
   * ```
   *
   * @throws TypeError when an element is not a row read from the database.
   * @throws QueryError when an element is a row of another schema, the spec is not
   * valid, or the callback's query has named parameters.
   */
  preload<
    S extends AnySchema,
    I extends Row<S> | readonly Row<S>[] | null,
    K extends AssocKeys<S>,
    Q extends QueryLike,
  >(
    schema: S,
    rows: I,
    assoc: K,
    fn: (query: PreloadQuery<S, K>) => Q & PreloadCheck<S, K, Q> & NoNamedParams<Q>,
    options?: PreloadOptions,
  ): Promise<RowsWith<I, PreloadedProps<S, LoadedAs<S, K, QueryResult<Q>>>>>;
  preload<S extends AnySchema, I extends Row<S> | readonly Row<S>[] | null, const Spec>(
    schema: S,
    rows: I,
    spec: Spec & ValidPreload<S, Spec>,
    options?: PreloadOptions,
  ): Promise<RowsWith<I, PreloadedProps<S, LoadedUnchecked<S, Spec>>>>;

  /**
   * Like {@link Repo.reload}, but a row that is gone is an error.
   *
   * @example
   * ```ts
   * const fresh = await repo.reloadOrThrow(user);
   * ```
   *
   * @throws NoResultsError when a row is gone.
   */
  reloadOrThrow<R extends object>(rows: readonly R[], options?: ReadOptions): Promise<R[]>;
  reloadOrThrow<R extends object>(row: R, options?: ReadOptions): Promise<R>;

  /**
   * The SQL of the query and the parameters exactly as they would be sent. Redacted values
   * are included: this is a debugging tool, not a log.
   *
   * @example
   * ```ts
   * const { sql, params } = repo.toSql(from(User, "u").where(({ u }) => u.age.gte(18)));
   * ```
   */
  toSql<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, SqlOptions>): SqlAndParams;

  /**
   * The database's plan for the query: text by default, the database's structured plan
   * with `format: "json"`. With `analyze: true` the query really runs.
   *
   * @example
   * ```ts
   * const plan = await repo.explain(from(User, "u").where({ email }));
   * const json = await repo.explain(from(User, "u"), { format: "json", analyze: true });
   * ```
   */
  explain<Q extends Queryable>(
    queryable: Q,
    ...args: ReadArgsWith<Q, ExplainReadOptions & { readonly format: "json" }>
  ): Promise<unknown>;
  explain<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, ExplainReadOptions>): Promise<string>;

  /**
   * Runs a statement written as a `fragment`, whose interpolations are bound parameters,
   * and returns its rows as the driver gave them. A plain string is refused, by the types
   * and at run time: SQL text comes only from the template's own strings.
   *
   * @example
   * ```ts
   * const { rows } = await repo.raw(fragment`select count(*) as n from users where age >= ${18}`);
   * ```
   *
   * @throws QueryError when `statement` is not a fragment.
   */
  raw<X extends Expr<unknown, SomeParams>>(statement: X, ...args: RawArgs<X>): Promise<RawRows>;

  // --- writes ----------------------------------------------------------------------

  /**
   * Inserts a new record described by a changeset (from `cast(User, …)` or
   * `change(User, …)`) and returns the row, with what the database generated.
   *
   * An invalid changeset is returned as a failure without touching the database, and so
   * is one that leaves a required field without a value (`can't be blank`). A violation
   * of a constraint the changeset declares is a failure too; any other is thrown.
   *
   * @example
   * ```ts
   * const result = await repo.insert(cast(User, input, ["email", "name"]).uniqueConstraint("email"));
   * if (!result.success) return result.error.errorMessages();
   * const user = result.data; // User
   * ```
   *
   * @throws QueryError when the changeset is of a loaded row, has no schema class, or holds
   * nested changes; ConstraintError for a violation the changeset does not declare;
   * DatabaseError when the database fails.
   */
  insert<S extends AnySchema, N extends boolean, E extends string = never>(
    changeset: Changeset<S, N, E> & NewRecordOnly<N>,
    options: InsertOptions<S> & { readonly onConflict: "nothing" },
  ): Promise<Result<Row<S> | null, Changeset<S, N, E>>>;
  insert<S extends AnySchema, N extends boolean, E extends string = never>(
    changeset: Changeset<S, N, E> & NewRecordOnly<N>,
    options?: InsertOptions<S> & { readonly onConflict?: UpdatingConflict<S> },
  ): Promise<Result<Row<S>, Changeset<S, N, E>>>;
  insert<S extends AnySchema, N extends boolean, E extends string = never>(
    changeset: Changeset<S, N, E> & NewRecordOnly<N>,
    options?: InsertOptions<S>,
  ): Promise<Result<Row<S> | null, Changeset<S, N, E>>>;

  /**
   * Like {@link Repo.insert}, but returns the row and throws for an invalid changeset.
   *
   * @example
   * ```ts
   * const user = await repo.insertOrThrow(cast(User, input, ["email"]));
   * ```
   *
   * @throws InvalidChangesetError (it carries the changeset) where `insert` returns a failure.
   */
  insertOrThrow<S extends AnySchema, N extends boolean, E extends string = never>(
    changeset: Changeset<S, N, E> & NewRecordOnly<N>,
    options: InsertOptions<S> & { readonly onConflict: "nothing" },
  ): Promise<Row<S> | null>;
  insertOrThrow<S extends AnySchema, N extends boolean, E extends string = never>(
    changeset: Changeset<S, N, E> & NewRecordOnly<N>,
    options?: InsertOptions<S> & { readonly onConflict?: UpdatingConflict<S> },
  ): Promise<Row<S>>;
  insertOrThrow<S extends AnySchema, N extends boolean, E extends string = never>(
    changeset: Changeset<S, N, E> & NewRecordOnly<N>,
    options?: InsertOptions<S>,
  ): Promise<Row<S> | null>;

  /**
   * Writes the changes of a changeset of a loaded row and returns the updated row. With
   * no change it runs no query and returns the row (unless `force: true`). When no row
   * matched (it was deleted, or an optimistic lock failed) it throws `StaleEntryError`,
   * unless `allowStale` or `staleError` says otherwise.
   *
   * @example
   * ```ts
   * const result = await repo.update(cast(user, { name: "Ada" }, ["name"]));
   * ```
   *
   * @throws QueryError when the changeset is of a new record, or its row has no key;
   * StaleEntryError when no row matched; ConstraintError for an undeclared violation.
   */
  update<S extends AnySchema, N extends boolean, E extends string = never>(
    changeset: Changeset<S, N, E> & LoadedRowOnly<N>,
    options?: UpdateOptions<S>,
  ): Promise<Result<Row<S>, Changeset<S, N, E>>>;

  /**
   * Like {@link Repo.update}, but returns the row and throws for an invalid changeset.
   *
   * @example
   * ```ts
   * const renamed = await repo.updateOrThrow(cast(user, { name: "Ada" }, ["name"]));
   * ```
   *
   * @throws InvalidChangesetError where `update` returns a failure.
   */
  updateOrThrow<S extends AnySchema, N extends boolean, E extends string = never>(
    changeset: Changeset<S, N, E> & LoadedRowOnly<N>,
    options?: UpdateOptions<S>,
  ): Promise<Row<S>>;

  /**
   * Deletes a row by its primary key and returns it, in the `deleted` state. Pass a
   * changeset of the row to declare constraints (`noAssocConstraint`) or an optimistic
   * lock.
   *
   * @example
   * ```ts
   * await repo.delete(post);
   * const result = await repo.delete(change(user).noAssocConstraint("posts"));
   * ```
   *
   * @throws QueryError when the row has no primary key; StaleEntryError when no row
   * matched; ConstraintError for an undeclared violation.
   */
  delete<S extends AnySchema, N extends boolean, E extends string = never>(
    changeset: Changeset<S, N, E> & LoadedRowOnly<N>,
    options?: DeleteOptions,
  ): Promise<Result<Row<S>, Changeset<S, N, E>>>;
  delete<R extends object>(
    row: R & NotAChangeset<R>,
    options?: DeleteOptions,
  ): Promise<Result<R, Changeset<RowSchema<R>, false>>>;

  /**
   * Like {@link Repo.delete}, but returns the row and throws for a failure.
   *
   * @example
   * ```ts
   * await repo.deleteOrThrow(post);
   * ```
   *
   * @throws InvalidChangesetError where `delete` returns a failure.
   */
  deleteOrThrow<S extends AnySchema, N extends boolean, E extends string = never>(
    changeset: Changeset<S, N, E> & LoadedRowOnly<N>,
    options?: DeleteOptions,
  ): Promise<Row<S>>;
  deleteOrThrow<R extends object>(row: R & NotAChangeset<R>, options?: DeleteOptions): Promise<R>;

  /**
   * Inserts a changeset of a new record, updates a changeset of a loaded row. It is not
   * an upsert: the database is not asked whether the row exists.
   *
   * @example
   * ```ts
   * const saved = await repo.insertOrUpdate(User.changeset(userOrClass, input));
   * ```
   *
   * @throws as {@link Repo.insert} and {@link Repo.update} do.
   */
  insertOrUpdate<S extends AnySchema, N extends boolean, E extends string = never>(
    changeset: Changeset<S, N, E>,
    options: InsertOrUpdateOptions<S> & { readonly onConflict: "nothing" },
  ): Promise<Result<Row<S> | null, Changeset<S, N, E>>>;
  insertOrUpdate<S extends AnySchema, N extends boolean, E extends string = never>(
    changeset: Changeset<S, N, E>,
    options?: InsertOrUpdateOptions<S> & { readonly onConflict?: UpdatingConflict<S> },
  ): Promise<Result<Row<S>, Changeset<S, N, E>>>;
  insertOrUpdate<S extends AnySchema, N extends boolean, E extends string = never>(
    changeset: Changeset<S, N, E>,
    options?: InsertOrUpdateOptions<S>,
  ): Promise<Result<Row<S> | null, Changeset<S, N, E>>>;

  /**
   * Like {@link Repo.insertOrUpdate}, but returns the row and throws for an invalid changeset.
   *
   * @example
   * ```ts
   * const saved = await repo.insertOrUpdateOrThrow(User.changeset(userOrClass, input));
   * ```
   *
   * @throws InvalidChangesetError where `insertOrUpdate` returns a failure.
   */
  insertOrUpdateOrThrow<S extends AnySchema, N extends boolean, E extends string = never>(
    changeset: Changeset<S, N, E>,
    options: InsertOrUpdateOptions<S> & { readonly onConflict: "nothing" },
  ): Promise<Row<S> | null>;
  insertOrUpdateOrThrow<S extends AnySchema, N extends boolean, E extends string = never>(
    changeset: Changeset<S, N, E>,
    options?: InsertOrUpdateOptions<S> & { readonly onConflict?: UpdatingConflict<S> },
  ): Promise<Row<S>>;
  insertOrUpdateOrThrow<S extends AnySchema, N extends boolean, E extends string = never>(
    changeset: Changeset<S, N, E>,
    options?: InsertOrUpdateOptions<S>,
  ): Promise<Row<S> | null>;

  /**
   * Inserts many rows in as few statements as the database's parameter limit allows
   * (inside one transaction when it takes more than one), or the rows a query selects.
   * No changeset and no validation; field defaults and generated values are applied to
   * every row. `rows` is `null` unless `returning` asks for rows back.
   *
   * @example
   * ```ts
   * await repo.insertAll(Tag, [{ name: "news" }, { name: "sport" }]);
   * const { rows } = await repo.insertAll(User, people, { returning: ["id", "email"] });
   * ```
   *
   * @throws QueryError when a row names something that is not a field; ConstraintError
   * and DatabaseError from the database (nothing is inserted then).
   */
  insertAll<S extends AnySchema>(
    schema: S,
    rows: readonly InsertAllRow<S>[] | QueryLike,
    options?: InsertAllOptions<S> & { readonly returning?: undefined },
  ): Promise<{ readonly count: number; readonly rows: null }>;
  insertAll<S extends AnySchema, const F extends FieldNames<S>>(
    schema: S,
    rows: readonly InsertAllRow<S>[] | QueryLike,
    options: InsertAllOptions<S> & { readonly returning: readonly F[] },
  ): Promise<{ readonly count: number; readonly rows: Pick<Row<S>, F & keyof Row<S>>[] }>;
  insertAll<S extends AnySchema>(
    schema: S,
    rows: readonly InsertAllRow<S>[] | QueryLike,
    options: InsertAllOptions<S> & { readonly returning: true },
  ): Promise<{ readonly count: number; readonly rows: Row<S>[] }>;
  insertAll<S extends AnySchema>(
    schema: S,
    rows: readonly InsertAllRow<S>[] | QueryLike,
    options?: InsertAllOptions<S>,
  ): Promise<BulkResult<Partial<Row<S>>>>;

  /**
   * Runs a query built with `.set(...)` as an `UPDATE` of every row it matches. A query
   * with no `where` updates every row: there is no guard.
   *
   * @example
   * ```ts
   * const { count } = await repo.updateAll(from(Post, "p").where({ authorId: 1 }).set({ published: true }));
   * ```
   *
   * @throws QueryError when the query has no `.set(...)`, or a clause an update cannot have.
   */
  updateAll<Q extends QueryLike>(
    query: Q,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<BulkResult<ResultOf<Q>>>;

  /**
   * Deletes every row the query matches; `repo.deleteAll(User)` deletes every user (there
   * is no guard). Joins become `USING`.
   *
   * @example
   * ```ts
   * const { count } = await repo.deleteAll(from(Post, "p").where({ published: false }));
   * ```
   *
   * @throws QueryError when the query has a clause a delete cannot have.
   */
  deleteAll<Q extends Queryable>(
    queryable: Q,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<BulkResult<ResultOf<Q>>>;

  // --- transactions (step 16) ------------------------------------------------------

  /**
   * Whether this repo is inside a transaction: `true` for the `tx` of a transaction
   * callback, `false` for the repo `createRepo` made (also while a test sandbox routes it)
   * and for the repo of a `checkout`.
   *
   * @example
   * ```ts
   * await repo.transaction(async (tx) => tx.inTransaction); // true
   * ```
   */
  readonly inTransaction: boolean;

  /**
   * Runs `fn` in a transaction on one connection, with `tx`, a repo bound to it. Only
   * calls on `tx` are inside the transaction: the outer repo uses other connections.
   *
   * - `fn` returns: `COMMIT`, and the result is `{ success: true, data }`.
   * - `fn` calls `tx.rollback(reason)`: `ROLLBACK`, and the result is
   *   `{ success: false, error: reason }`.
   * - `fn` returns although a statement in it failed (an error it caught, or a write
   *   `Result` it did not check whose statement the database refused): `ROLLBACK`, and the
   *   result is `{ success: false, error }` with that statement's error.
   * - `fn` throws: `ROLLBACK`, and the error is rethrown.
   *
   * Inside a transaction (`tx.transaction(fn)`) it runs in a savepoint: only its own work
   * is undone when it fails, and the outer transaction carries on. Given a batch
   * (`createBatch()`), it runs the batch's steps; see {@link Batch}.
   *
   * @example
   * ```ts
   * const result = await repo.transaction(async (tx) => {
   *   const user = await tx.insertOrThrow(User.changeset(User, input));
   *   await tx.insertOrThrow(change(Profile, { userId: user.id }));
   *   return user;
   * });
   * if (result.success) result.data; // User
   * ```
   *
   * @throws whatever `fn` throws; TypeError for an unknown or wrong option; QueryError for
   * `isolation`, `readOnly` or `retries` on a nested transaction; DatabaseError (code
   * `"timeout"`) when `timeoutMs` runs out.
   */
  transaction<R extends object, F>(batch: Batch<R, F>, options?: TransactionOptions): Promise<Result<R, F>>;
  transaction<T>(
    fn: (tx: Repo) => T | PromiseLike<T>,
    options?: TransactionOptions,
  ): Promise<Result<T, unknown>>;

  /**
   * Like {@link Repo.transaction}, but returns the value of `fn` (the results of a batch),
   * and a rollback throws `RollbackError`, whose `reason` is what `transaction` would have
   * returned as `error`.
   *
   * @example
   * ```ts
   * const user = await repo.transactionOrThrow(async (tx) => tx.insertOrThrow(User.changeset(User, input)));
   * ```
   *
   * @throws RollbackError when the transaction was rolled back; otherwise as {@link Repo.transaction}.
   */
  transactionOrThrow<R extends object, F>(batch: Batch<R, F>, options?: TransactionOptions): Promise<R>;
  transactionOrThrow<T>(fn: (tx: Repo) => T | PromiseLike<T>, options?: TransactionOptions): Promise<T>;

  /**
   * Ends the transaction's callback; the transaction rolls back and `repo.transaction`
   * returns `{ success: false, error: reason }`. It never returns: nothing after it runs.
   *
   * @example
   * ```ts
   * await repo.transaction(async (tx) => {
   *   const order = await tx.insertOrThrow(change(Order, { total }));
   *   if (order.total > limit) tx.rollback("over the limit");
   *   return order;
   * });
   * ```
   *
   * @throws QueryError when called outside a transaction (on the repo `createRepo` made),
   * or after the transaction ended.
   */
  rollback(reason: unknown): never;

  /**
   * Runs `fn` with a repo bound to one connection, with no transaction, for session
   * settings or advisory locks that must run on the same connection as what follows.
   * On a transaction's repo, `fn` gets that same repo.
   *
   * @example
   * ```ts
   * await repo.checkout(async (r) => {
   *   await r.raw(fragment`select pg_advisory_lock(${42})`);
   *   try {
   *     return await r.all(User);
   *   } finally {
   *     await r.raw(fragment`select pg_advisory_unlock(${42})`);
   *   }
   * });
   * ```
   *
   * @throws whatever `fn` throws.
   */
  checkout<T>(fn: (repo: Repo) => T | PromiseLike<T>): Promise<T>;

  /**
   * Subscribes to the repo's events; returns the function that unsubscribes. `query`
   * reports each statement the repo ran ({@link RepoQueryEvent}); `connect`,
   * `disconnect` and `poolExhausted` come from the adapter's pool. A listener that throws
   * does not fail the statement; its error is rethrown as an uncaught exception.
   *
   * @example
   * ```ts
   * const off = repo.on("query", (event) => metrics.observe(event.operation, event.durationMs));
   * off();
   * ```
   *
   * @throws TypeError when the event is unknown or the listener is not a function.
   */
  on(event: "query", listener: (event: RepoQueryEvent) => void): () => void;
  on(event: "connect" | "disconnect" | "poolExhausted", listener: (event: PoolEvent) => void): () => void;

  /**
   * Checks that the database answers.
   *
   * @example
   * ```ts
   * await repo.ping();
   * ```
   *
   * @throws DatabaseError with the code `"connection"` when it cannot be reached.
   */
  ping(): Promise<void>;

  /**
   * The connection pool: `{ size, idle, waiting }`.
   *
   * @example
   * ```ts
   * const { size, idle } = repo.poolStats();
   * ```
   */
  poolStats(): PoolStats;

  /**
   * The counters of the adapter's plan cache: `{ hits, misses, collisions, size }`.
   *
   * @example
   * ```ts
   * const { hits, misses } = repo.planCacheStats();
   * ```
   */
  planCacheStats(): PlanCacheStats;

  /**
   * Waits for running queries, then closes the pool. Idempotent; calls made afterwards
   * reject with `DatabaseError` (code `"connection"`).
   *
   * @example
   * ```ts
   * await repo.close();
   * ```
   */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// createRepo
// ---------------------------------------------------------------------------

/**
 * Creates a repo over an adapter. Nothing connects until the first query.
 *
 * @example
 * ```ts
 * import { createRepo } from "egon-orm";
 * import { postgres } from "@egon-orm/postgres";
 *
 * export const repo = createRepo({
 *   adapter: postgres({ connectionString: process.env.DATABASE_URL }),
 * });
 * ```
 *
 * @throws TypeError when an option is unknown or has the wrong type.
 */
export function createRepo(options: RepoOptions): Repo {
  const settings = repoSettings(options, writeToStderr);
  provideUniqueCheck();
  const hub = new QueryHub(settings.adapter, settings.logParams);
  if (settings.logger !== undefined) hub.on(settings.logger);
  const core = new ReadCore(settings.adapter, settings.adapter, settings.schema, settings.codegen, hub);
  const repo = new DatabaseRepo(core, undefined);
  repo.bind(createRoot(repo, core, makeRepo, settings.warnOnRootUseInTransaction));
  return repo;
}

/** Makes the repo of a transaction, a savepoint, a checkout or a sandbox (step 16). */
const makeRepo = (core: ReadCore, scope: Scope): Repo => new DatabaseRepo(core, scope);

const POOL_EVENTS = ["connect", "disconnect", "poolExhausted"];

/** The repo of {@link createRepo}, and of the transactions made from it. */
class DatabaseRepo implements Repo {
  readonly #core: ReadCore;
  /** The root's scope, or the transaction (savepoint, checkout) this repo is bound to. */
  #scope: Scope | undefined;

  constructor(core: ReadCore, scope: Scope | undefined) {
    this.#core = core;
    this.#scope = scope;
  }

  /** Sets the root repo's scope, which needs the repo itself to be made. */
  bind(scope: Scope): void {
    this.#scope = scope;
  }

  get #bound(): Scope {
    return this.#scope as Scope;
  }

  // Not async: the call goes straight to `load`, the one async function of the pipeline.
  all<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, ReadOptions>): Promise<ResultOf<Q>[]> {
    let input: QueryInput;
    let split: SplitArgs<ReadOptions>;
    try {
      input = inputOf("all", queryable);
      split = splitArgs<ReadOptions>("all", input.names, args, READ_OPTION_KEYS);
    } catch (error) {
      return Promise.reject(error);
    }
    return load(this.#core, "all", input.ast, split.named, split.options) as Promise<ResultOf<Q>[]>;
  }

  async one<Q extends Queryable>(
    queryable: Q,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<ResultOf<Q> | null> {
    const input = inputOf("one", queryable);
    const { named, options } = splitArgs<ReadOptions>("one", input.names, args, READ_OPTION_KEYS);
    return single(await load(this.#core, "one", input.ast, named, options), input.ast) as ResultOf<Q> | null;
  }

  async oneOrThrow<Q extends Queryable>(
    queryable: Q,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<ResultOf<Q>> {
    const input = inputOf("oneOrThrow", queryable);
    const { named, options } = splitArgs<ReadOptions>("oneOrThrow", input.names, args, READ_OPTION_KEYS);
    return exactlyOne(await load(this.#core, "one", input.ast, named, options), input.ast) as ResultOf<Q>;
  }

  async first<Q extends Queryable>(
    queryable: Q,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<ResultOf<Q> | null> {
    const input = inputOf("first", queryable);
    const { named, options } = splitArgs<ReadOptions>("first", input.names, args, READ_OPTION_KEYS);
    return (await first(this.#core, input, named, options)) as ResultOf<Q> | null;
  }

  async firstOrThrow<Q extends Queryable>(
    queryable: Q,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<ResultOf<Q>> {
    const input = inputOf("firstOrThrow", queryable);
    const { named, options } = splitArgs<ReadOptions>("firstOrThrow", input.names, args, READ_OPTION_KEYS);
    return (await firstOrThrow(this.#core, input, named, options)) as ResultOf<Q>;
  }

  async get<S extends AnySchema>(
    schema: S,
    id: PrimaryKeyOf<S>,
    options?: ReadOptions,
  ): Promise<Row<S> | null> {
    const query = byKey(checkSchema("get", schema), id);
    const checked = checkReadOptions<ReadOptions>("get", options, READ_OPTION_KEYS);
    return single(await load(this.#core, "get", query.ast, undefined, checked), query.ast) as Row<S> | null;
  }

  async getOrThrow<S extends AnySchema>(
    schema: S,
    id: PrimaryKeyOf<S>,
    options?: ReadOptions,
  ): Promise<Row<S>> {
    const query = byKey(checkSchema("getOrThrow", schema), id);
    const checked = checkReadOptions<ReadOptions>("getOrThrow", options, READ_OPTION_KEYS);
    return exactlyOne(await load(this.#core, "get", query.ast, undefined, checked), query.ast) as Row<S>;
  }

  async getBy<Q extends Queryable>(
    queryable: Q,
    clauses: ClausesOf<Q>,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<ResultOf<Q> | null> {
    const input = byClauses(inputOf("getBy", queryable), clauses, "getBy");
    const { named, options } = splitArgs<ReadOptions>("getBy", input.names, args, READ_OPTION_KEYS);
    return single(
      await load(this.#core, "getBy", input.ast, named, options),
      input.ast,
    ) as ResultOf<Q> | null;
  }

  async getByOrThrow<Q extends Queryable>(
    queryable: Q,
    clauses: ClausesOf<Q>,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<ResultOf<Q>> {
    const input = byClauses(inputOf("getByOrThrow", queryable), clauses, "getByOrThrow");
    const { named, options } = splitArgs<ReadOptions>("getByOrThrow", input.names, args, READ_OPTION_KEYS);
    return exactlyOne(await load(this.#core, "getBy", input.ast, named, options), input.ast) as ResultOf<Q>;
  }

  async exists<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, ReadOptions>): Promise<boolean> {
    const input = inputOf("exists", queryable);
    const { named, options } = splitArgs<ReadOptions>("exists", input.names, args, READ_OPTION_KEYS);
    return exists(this.#core, input, named, options);
  }

  async count<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, ReadOptions>): Promise<number> {
    const input = inputOf("count", queryable);
    const { named, options } = splitArgs<ReadOptions>("count", input.names, args, READ_OPTION_KEYS);
    return (await aggregate(this.#core, input, "count", undefined, named, options)) as number;
  }

  aggregate<Q extends Queryable>(
    queryable: Q,
    fn: "count",
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<number>;
  aggregate<Q extends Queryable, F extends RootColumn<Q>>(
    queryable: Q,
    fn: "count",
    field: F,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<number>;
  aggregate<Q extends Queryable, F extends NumericColumn<Q>>(
    queryable: Q,
    fn: "sum",
    field: F,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<SumOf<RootValue<Q, F>>>;
  aggregate<Q extends Queryable, F extends NumericColumn<Q>>(
    queryable: Q,
    fn: "avg",
    field: F,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<AvgOf<RootValue<Q, F>>>;
  aggregate<Q extends Queryable, F extends RootColumn<Q>>(
    queryable: Q,
    fn: "min" | "max",
    field: F,
    ...args: ReadArgs<Q, ReadOptions>
  ): Promise<NonNullable<RootValue<Q, F>> | null>;
  async aggregate(
    queryable: Queryable,
    fn: AggregateFunction,
    ...rest: readonly unknown[]
  ): Promise<unknown> {
    const input = inputOf("aggregate", queryable);
    const field = typeof rest[0] === "string" ? rest[0] : undefined;
    const args = field === undefined ? rest : rest.slice(1);
    const { named, options } = splitArgs<ReadOptions>("aggregate", input.names, args, READ_OPTION_KEYS);
    return aggregate(this.#core, input, fn, field, named, options);
  }

  stream<Q extends Queryable>(
    queryable: Q,
    ...args: ReadArgs<Q, StreamReadOptions>
  ): AsyncIterable<ResultOf<Q>> {
    const input = inputOf("stream", queryable);
    const { named, options } = splitArgs<StreamReadOptions>("stream", input.names, args, STREAM_OPTION_KEYS);
    return stream(this.#core, input, named, options) as AsyncIterable<ResultOf<Q>>;
  }

  reload<R extends object>(rows: readonly R[], options?: ReadOptions): Promise<(R | null)[]>;
  reload<R extends object>(row: R, options?: ReadOptions): Promise<R | null>;
  async reload(rows: unknown, options?: ReadOptions): Promise<unknown> {
    const checked = checkReadOptions<ReadOptions>("reload", options, READ_OPTION_KEYS);
    if (Array.isArray(rows)) return reload(this.#core, rows, checked, false);
    const [fresh] = await reload(this.#core, [rows], checked, false);
    return fresh;
  }

  preload(schema: unknown, rows: unknown, spec: unknown, ...rest: readonly unknown[]): Promise<never> {
    return this.#preload(schema, rows, spec, rest) as Promise<never>;
  }

  async #preload(schema: unknown, rows: unknown, spec: unknown, rest: readonly unknown[]): Promise<unknown> {
    const checked = checkSchema("preload", schema as AnySchema);
    const fn = typeof rest[0] === "function" ? rest[0] : undefined;
    const args = fn === undefined ? rest : rest.slice(1);
    const { nodes, names } = preloadNodesOf(checked, spec, fn);
    if (names.length > 0) {
      throw new QueryError(
        "query.preloadNamedParams",
        `repo.preload() runs its callback at once, so its query takes values, not named parameters (${names.map((name) => `"${name}"`).join(", ")}).`,
      );
    }
    const given = args[0];
    if (typeof given === "object" && given !== null && Object.hasOwn(given, "schema")) {
      throw new TypeError(
        "repo.preload() takes no schema option: each row's associations are read from where the row was read (or, for a schema class that declares a database schema, the repo's default).",
      );
    }
    const options = checkReadOptions<PreloadOptions>("preload", given, PRELOAD_OPTION_KEYS);
    if (args.length > 1) {
      throw new TypeError(
        `repo.preload(): it takes its options last, but it was given ${args.length} arguments after the spec.`,
      );
    }
    const force = own(options, "force");
    if (force !== undefined && typeof force !== "boolean") {
      throw new TypeError(`repo.preload(): force must be true or false, but it is ${typeof force}.`);
    }
    return preloadRows(this.#core, checked, rows, nodes, undefined, options);
  }

  reloadOrThrow<R extends object>(rows: readonly R[], options?: ReadOptions): Promise<R[]>;
  reloadOrThrow<R extends object>(row: R, options?: ReadOptions): Promise<R>;
  async reloadOrThrow(rows: unknown, options?: ReadOptions): Promise<unknown> {
    const checked = checkReadOptions<ReadOptions>("reloadOrThrow", options, READ_OPTION_KEYS);
    if (Array.isArray(rows)) return reload(this.#core, rows, checked, true);
    const [fresh] = await reload(this.#core, [rows], checked, true);
    return fresh;
  }

  toSql<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, SqlOptions>): SqlAndParams {
    const input = inputOf("toSql", queryable);
    const { named, options } = splitArgs<ReadOptions>("toSql", input.names, args, SQL_OPTION_KEYS);
    return toSql(this.#core, input, named, options);
  }

  explain<Q extends Queryable>(
    queryable: Q,
    ...args: ReadArgsWith<Q, ExplainReadOptions & { readonly format: "json" }>
  ): Promise<unknown>;
  explain<Q extends Queryable>(queryable: Q, ...args: ReadArgs<Q, ExplainReadOptions>): Promise<string>;
  async explain(queryable: Queryable, ...args: readonly unknown[]): Promise<unknown> {
    const input = inputOf("explain", queryable);
    const { named, options } = splitArgs<ExplainReadOptions>(
      "explain",
      input.names,
      args,
      EXPLAIN_OPTION_KEYS,
    );
    return explain(this.#core, input, named, options);
  }

  async raw<X extends Expr<unknown, SomeParams>>(statement: X, ...args: RawArgs<X>): Promise<RawRows> {
    if (!isFragment(statement)) {
      throw new QueryError(
        "query.rawArgument",
        `repo.raw() takes a fragment, and was given ${typeof statement === "string" ? "a string, which would put text into the SQL unchecked" : "something else"}.`,
      );
    }
    const names: string[] = [];
    for (const node of statement.named) if (!names.includes(node.name)) names.push(node.name);
    const { named, options } = splitArgs<ReadOptions>("raw", names, args, READ_OPTION_KEYS);
    return raw(this.#core, statement, named, options);
  }

  // --- writes ----------------------------------------------------------------------

  insert(changeset: unknown, options?: unknown): Promise<Result<never, never>> {
    return insert(this.#core, this, changeset, options) as Promise<Result<never, never>>;
  }

  async insertOrThrow(changeset: unknown, options?: unknown): Promise<never> {
    return orThrow(await insert(this.#core, this, changeset, options, "insertOrThrow"), "insert") as never;
  }

  update(changeset: unknown, options?: unknown): Promise<Result<never, never>> {
    return update(this.#core, this, changeset, options) as Promise<Result<never, never>>;
  }

  async updateOrThrow(changeset: unknown, options?: unknown): Promise<never> {
    return orThrow(await update(this.#core, this, changeset, options, "updateOrThrow"), "update") as never;
  }

  delete(target: unknown, options?: unknown): Promise<Result<never, never>> {
    return remove(this.#core, this, target, options) as Promise<Result<never, never>>;
  }

  async deleteOrThrow(target: unknown, options?: unknown): Promise<never> {
    return orThrow(await remove(this.#core, this, target, options), "delete") as never;
  }

  insertOrUpdate(changeset: unknown, options?: unknown): Promise<Result<never, never>> {
    return insertOrUpdate(this.#core, this, changeset, options) as Promise<Result<never, never>>;
  }

  async insertOrUpdateOrThrow(changeset: unknown, options?: unknown): Promise<never> {
    const result = await insertOrUpdate(this.#core, this, changeset, options);
    return orThrow(result, "insertOrUpdate") as never;
  }

  insertAll(schema: unknown, rows: unknown, options?: unknown): Promise<never> {
    return insertAll(this.#core, schema, rows, options) as Promise<never>;
  }

  updateAll(query: unknown, ...args: readonly unknown[]): Promise<never> {
    return modifyAll(this.#core, "updateAll", query, args) as Promise<never>;
  }

  deleteAll(queryable: unknown, ...args: readonly unknown[]): Promise<never> {
    return modifyAll(this.#core, "deleteAll", queryable, args) as Promise<never>;
  }

  // --- transactions ----------------------------------------------------------------

  get inTransaction(): boolean {
    return inTransaction(this.#bound);
  }

  transaction(input: unknown, options?: TransactionOptions): Promise<never> {
    return transaction(this.#bound, input, options, false) as Promise<never>;
  }

  transactionOrThrow(input: unknown, options?: TransactionOptions): Promise<never> {
    return transaction(this.#bound, input, options, true) as Promise<never>;
  }

  rollback(reason: unknown): never {
    return rollback(this.#bound, reason);
  }

  checkout(fn: unknown): Promise<never> {
    return checkout(this.#bound, this, fn) as Promise<never>;
  }

  on(event: "query", listener: (event: RepoQueryEvent) => void): () => void;
  on(event: "connect" | "disconnect" | "poolExhausted", listener: (event: PoolEvent) => void): () => void;
  on(event: string, listener: (event: never) => void): () => void {
    if (event === "query") return this.#core.hub.on(listener as (event: RepoQueryEvent) => void);
    if (POOL_EVENTS.includes(event)) {
      return this.#core.adapter.on(event as "connect", listener as (event: PoolEvent) => void);
    }
    throw new TypeError(
      `repo.on(${JSON.stringify(event)}): unknown event. The events are "query", "connect", "disconnect" and "poolExhausted".`,
    );
  }

  ping(): Promise<void> {
    return this.#core.adapter.ping();
  }

  poolStats(): PoolStats {
    return this.#core.adapter.poolStats();
  }

  planCacheStats(): PlanCacheStats {
    return this.#core.adapter.planCacheStats();
  }

  close(): Promise<void> {
    if (this.#scope instanceof Level) {
      return Promise.reject(
        new QueryError("query.closeNotRoot", "close() closes the whole repo and its pool."),
      );
    }
    this.#core.hub.close();
    return this.#core.adapter.close();
  }
}

function checkSchema(method: string, schema: unknown): AnySchema {
  if (!isSchema(schema)) {
    throw new TypeError(`repo.${method}() takes a schema class first: repo.${method}(User, id).`);
  }
  return schema;
}
