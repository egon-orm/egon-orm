/**
 * `Batch`: a transaction described as data, a list of named steps that
 * `repo.transaction(batch)` runs in order.
 *
 * The type of a batch accumulates as steps are added: `R` maps each step name to its
 * result, so that a step given as a function receives the results before it, typed, and
 * `F` is the union of the ways it can fail, one `{ step, error, completed }` per step
 * that can.
 *
 * @module
 */
import { Changeset } from "../changeset/changeset.js";
import type { RowSchema } from "../changeset/types.js";
import type { Result } from "../contracts/result.js";
import type { AnySchema, FieldNames, Row } from "../contracts/schema.js";
import { QueryError } from "../errors.js";
import type { Queryable, QueryLike, QueryParams } from "../query/builder.js";
import type { BulkResult, InsertAllOptions, InsertAllRow } from "../repo/bulk.js";
import type { ReadOptions } from "../repo/options.js";
import type { ReadArgs, Repo, ResultOf } from "../repo/repo.js";
import type {
  DeleteOptions,
  InsertOptions,
  InsertOrUpdateOptions,
  OnConflictOption,
  UpdateOptions,
} from "../repo/write.js";
import { isSchema } from "../schema/guards.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The results of no step. */
type Empty = Record<never, never>;

/** Flattens an intersection into one object type, for readable hovers. */
type Simplify<T> = { [K in keyof T]: T[K] };

/** `R` with the result `T` of step `N` added. */
type With<R, N extends string, T> = Simplify<R & { [K in N]: T }>;

/**
 * A step name, refused at compile time when the batch already has a step of that name
 * (the call then shows this property as the reason).
 */
type Unique<N extends string, R> = N &
  (N extends keyof R ? { readonly "this step name is already used in the batch": N } : unknown);

/** A step's input: given as it is, or computed from the results of the steps before it. */
type Input<R, T> = T | ((results: R) => T);

/**
 * The arguments after a query step's query: `[options?]`, or `[params, options?]` for a
 * query with named parameters, as the repo's reads take them. A query type whose
 * parameters are not known yet (`never`, while TypeScript has not yet inferred the query
 * a step function returns) counts as having none, so that the call is not refused before
 * the query is known.
 */
type StepArgs<Q> = [Q extends QueryLike ? QueryParams<Q> : never] extends [never]
  ? [options?: ReadOptions]
  : ReadArgs<Q, ReadOptions>;

/** An `onConflict` that inserts or updates a row, so that the write always returns one. */
type UpdatingConflict<S extends AnySchema> = Exclude<OnConflictOption<S>, "nothing"> | undefined;

/**
 * How a batch failed: the step that failed, what it failed with, and the results of the
 * steps that completed before it (everything was rolled back).
 *
 * `repo.transaction(batch)` fails with a union of these, one per step that can fail, so a
 * `switch` on `step` narrows `error` and `completed`.
 *
 * @example
 * ```ts
 * const result = await repo.transaction(signUp);
 * if (!result.success) {
 *   const failed: BatchFailure<string, unknown, object> = result.error;
 *   process.stderr.write(`sign-up failed at ${failed.step}\n`);
 * }
 * ```
 */
export interface BatchFailure<N extends string, E, C> {
  readonly step: N;
  readonly error: E;
  readonly completed: C;
}

/** The failures of a batch appended after steps with the results `R`: their `completed` includes `R`. */
type After<F, R> =
  F extends BatchFailure<infer N, infer E, infer C> ? BatchFailure<N, E, Simplify<R & C>> : never;

/**
 * The operations a batch step can be.
 *
 * @example
 * ```ts
 * const kinds: BatchOperation[] = Batch.toList(signUp).map((step) => step.operation);
 * ```
 */
export type BatchOperation =
  | "insert"
  | "update"
  | "delete"
  | "insertOrUpdate"
  | "insertAll"
  | "updateAll"
  | "deleteAll"
  | "one"
  | "all"
  | "exists"
  | "run"
  | "put"
  | "inspect"
  | "merge";

/**
 * One step of a batch, as {@link Batch.toList} lists it.
 *
 * - `name`: the step's name; `undefined` for `merge` and for an `inspect` without one.
 * - `input`: what the step was given: a changeset, a row, a query, a value, or the
 *   function that computes it from the results before it (the callback of `run`,
 *   `inspect` and `merge`).
 * - `schema`: the schema class of an `insertAll`; `undefined` otherwise.
 * - `args`: the arguments after the input: the options, or a query's named parameters
 *   and options.
 *
 * @example
 * ```ts
 * expect(Batch.toList(signUp).map((step) => step.name)).toEqual(["user", "profile", "welcome"]);
 * ```
 */
export interface BatchStep {
  readonly name: string | undefined;
  readonly operation: BatchOperation;
  readonly input: unknown;
  readonly schema: AnySchema | undefined;
  readonly args: readonly unknown[];
}

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

let make: (steps: readonly BatchStep[], names: ReadonlySet<string>) => Batch<object, unknown>;
let stepsOf: (batch: Batch<object, unknown>) => readonly BatchStep[];
let namesOf: (batch: Batch<object, unknown>) => ReadonlySet<string>;

const NO_ARGS: readonly unknown[] = /* @__PURE__ */ Object.freeze([]);

function checkName(method: string, name: unknown): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError(`batch.${method}(name, …): the step name must be a non-empty string.`);
  }
  // Results are kept on plain objects under their step's name: a step named __proto__ would
  // replace the prototype of the results instead of holding a result.
  if (name === "__proto__") {
    throw new QueryError("query.batchStepName", `batch.${method}(): a step cannot be named "__proto__".`);
  }
  return name;
}

function duplicateName(name: string): QueryError {
  return new QueryError("query.batchStepTwice", `The batch already has a step named "${name}".`);
}

/**
 * A list of named steps that run in one transaction: `repo.transaction(batch)`. A batch is
 * an immutable value: every method returns a new batch, and the original is unchanged. It
 * is made with {@link createBatch}.
 *
 * A step is given either its input (a changeset, a query, a value) or a function that
 * computes it from the results of the steps before it, which it receives by name and
 * typed. A duplicate step name is a compile error where the types can see it and a
 * `QueryError` when the batch is built.
 *
 * @example
 * ```ts
 * const signUp = createBatch()
 *   .insert("user", User.changeset(User, input))
 *   .insert("profile", ({ user }) => change(Profile, { userId: user.id }))
 *   .run("welcome", async (tx, { user }) => success(await queueWelcomeEmail(tx, user)));
 *
 * const result = await repo.transaction(signUp);
 * if (result.success) result.data.profile; // Profile
 * ```
 */
export class Batch<R extends object = Empty, F = never> {
  /** Type-level only: the results by step name. */
  declare readonly "~results": R;
  /** Type-level only: the ways the batch can fail. */
  declare readonly "~failure": F;
  readonly #steps: readonly BatchStep[];
  readonly #names: ReadonlySet<string>;

  static {
    make = (steps, names) => new Batch(steps, names);
    stepsOf = (batch) => batch.#steps;
    namesOf = (batch) => batch.#names;
  }

  private constructor(steps: readonly BatchStep[], names: ReadonlySet<string>) {
    this.#steps = steps;
    this.#names = names;
  }

  /**
   * The steps of a batch as data, in order, for tests and debugging. A `merge` is one
   * step: the steps it adds are known only when it runs.
   *
   * @example
   * ```ts
   * expect(Batch.toList(signUp).map((step) => [step.name, step.operation])).toEqual([
   *   ["user", "insert"],
   *   ["profile", "insert"],
   * ]);
   * ```
   *
   * @throws TypeError when given something that is not a batch.
   */
  static toList(batch: Batch<object, unknown>): readonly BatchStep[] {
    if (!(batch instanceof Batch))
      throw new TypeError("Batch.toList(batch) takes a batch made with createBatch().");
    return batch.#steps;
  }

  #add(method: string, name: unknown, step: Omit<BatchStep, "name">): never {
    let names = this.#names;
    let stepName: string | undefined;
    if (name !== undefined || (method !== "merge" && method !== "inspect")) {
      stepName = checkName(method, name);
      if (names.has(stepName)) throw duplicateName(stepName);
      const more = new Set(names);
      more.add(stepName);
      names = more;
    }
    const full: BatchStep = Object.freeze({
      name: stepName,
      operation: step.operation,
      input: step.input,
      schema: step.schema,
      args: Object.freeze([...step.args]),
    });
    return make(Object.freeze([...this.#steps, full]), names) as never;
  }

  /**
   * Inserts a changeset of a new record; its result is the row.
   *
   * @example
   * ```ts
   * createBatch().insert("user", User.changeset(User, input));
   * ```
   */
  insert<const N extends string, S extends AnySchema, New extends boolean, E extends string = never>(
    name: Unique<N, R>,
    changeset: Input<R, Changeset<S, New, E>>,
    options: InsertOptions<S> & { readonly onConflict: "nothing" },
  ): Batch<With<R, N, Row<S> | null>, F | BatchFailure<N, Changeset<S, New, E>, R>>;
  insert<const N extends string, S extends AnySchema, New extends boolean, E extends string = never>(
    name: Unique<N, R>,
    changeset: Input<R, Changeset<S, New, E>>,
    options?: InsertOptions<S> & { readonly onConflict?: UpdatingConflict<S> },
  ): Batch<With<R, N, Row<S>>, F | BatchFailure<N, Changeset<S, New, E>, R>>;
  insert(name: string, changeset: unknown, options?: unknown): Batch<object, unknown> {
    return this.#add("insert", name, step("insert", changeset, options));
  }

  /**
   * Updates the row of a changeset of a loaded row; its result is the updated row.
   *
   * @example
   * ```ts
   * createBatch().update("renamed", cast(user, { name: "Ada" }, ["name"]));
   * ```
   */
  update<const N extends string, S extends AnySchema, New extends boolean, E extends string = never>(
    name: Unique<N, R>,
    changeset: Input<R, Changeset<S, New, E>>,
    options?: UpdateOptions<S>,
  ): Batch<With<R, N, Row<S>>, F | BatchFailure<N, Changeset<S, New, E>, R>>;
  update(name: string, changeset: unknown, options?: unknown): Batch<object, unknown> {
    return this.#add("update", name, step("update", changeset, options));
  }

  /**
   * Deletes a row (or the row of a changeset); its result is the deleted row.
   *
   * @example
   * ```ts
   * createBatch().delete("old", post);
   * ```
   */
  delete<const N extends string, S extends AnySchema, New extends boolean, E extends string = never>(
    name: Unique<N, R>,
    changeset: Input<R, Changeset<S, New, E>>,
    options?: DeleteOptions,
  ): Batch<With<R, N, Row<S>>, F | BatchFailure<N, Changeset<S, New, E>, R>>;
  delete<const N extends string, W extends object>(
    name: Unique<N, R>,
    row: Input<R, W>,
    options?: DeleteOptions,
  ): Batch<With<R, N, W>, F | BatchFailure<N, Changeset<RowSchema<W>, false>, R>>;
  delete(name: string, target: unknown, options?: unknown): Batch<object, unknown> {
    return this.#add("delete", name, step("delete", target, options));
  }

  /**
   * Inserts a changeset of a new record or updates one of a loaded row; its result is the row.
   *
   * @example
   * ```ts
   * createBatch().insertOrUpdate("saved", User.changeset(userOrClass, input));
   * ```
   */
  insertOrUpdate<const N extends string, S extends AnySchema, New extends boolean, E extends string = never>(
    name: Unique<N, R>,
    changeset: Input<R, Changeset<S, New, E>>,
    options: InsertOrUpdateOptions<S> & { readonly onConflict: "nothing" },
  ): Batch<With<R, N, Row<S> | null>, F | BatchFailure<N, Changeset<S, New, E>, R>>;
  insertOrUpdate<const N extends string, S extends AnySchema, New extends boolean, E extends string = never>(
    name: Unique<N, R>,
    changeset: Input<R, Changeset<S, New, E>>,
    options?: InsertOrUpdateOptions<S> & { readonly onConflict?: UpdatingConflict<S> },
  ): Batch<With<R, N, Row<S>>, F | BatchFailure<N, Changeset<S, New, E>, R>>;
  insertOrUpdate(name: string, changeset: unknown, options?: unknown): Batch<object, unknown> {
    return this.#add("insertOrUpdate", name, step("insertOrUpdate", changeset, options));
  }

  /**
   * Inserts many rows (`repo.insertAll`); its result is `{ count, rows }`.
   *
   * @example
   * ```ts
   * createBatch().insertAll("tags", Tag, [{ name: "news" }, { name: "sport" }]);
   * ```
   */
  insertAll<const N extends string, S extends AnySchema>(
    name: Unique<N, R>,
    schema: S,
    rows: Input<R, readonly InsertAllRow<S>[] | QueryLike>,
    options?: InsertAllOptions<S> & { readonly returning?: undefined },
  ): Batch<With<R, N, { readonly count: number; readonly rows: null }>, F>;
  insertAll<const N extends string, S extends AnySchema, const P extends FieldNames<S>>(
    name: Unique<N, R>,
    schema: S,
    rows: Input<R, readonly InsertAllRow<S>[] | QueryLike>,
    options: InsertAllOptions<S> & { readonly returning: readonly P[] },
  ): Batch<With<R, N, { readonly count: number; readonly rows: Pick<Row<S>, P & keyof Row<S>>[] }>, F>;
  insertAll<const N extends string, S extends AnySchema>(
    name: Unique<N, R>,
    schema: S,
    rows: Input<R, readonly InsertAllRow<S>[] | QueryLike>,
    options: InsertAllOptions<S> & { readonly returning: true },
  ): Batch<With<R, N, { readonly count: number; readonly rows: Row<S>[] }>, F>;
  insertAll(name: string, schema: unknown, rows: unknown, options?: unknown): Batch<object, unknown> {
    if (!isSchema(schema)) {
      throw new TypeError("batch.insertAll(name, schema, rows): the second argument must be a schema class.");
    }
    return this.#add("insertAll", name, {
      operation: "insertAll",
      input: rows,
      schema,
      args: argsOf(options),
    });
  }

  /**
   * Runs an `updateAll` of a query built with `.set(...)`; its result is `{ count, rows }`.
   *
   * @example
   * ```ts
   * createBatch().updateAll("published", from(Post, "p").where({ authorId: 1 }).set({ published: true }));
   * ```
   */
  updateAll<const N extends string, Q extends QueryLike>(
    name: Unique<N, R>,
    query: Input<R, Q>,
    ...args: StepArgs<Q>
  ): Batch<With<R, N, BulkResult<ResultOf<Q>>>, F>;
  updateAll(name: string, query: unknown, ...args: unknown[]): Batch<object, unknown> {
    return this.#add("updateAll", name, { operation: "updateAll", input: query, schema: undefined, args });
  }

  /**
   * Runs a `deleteAll`; its result is `{ count, rows }`.
   *
   * @example
   * ```ts
   * createBatch().deleteAll("drafts", from(Post, "p").where({ published: false }));
   * ```
   */
  deleteAll<const N extends string, Q extends Queryable>(
    name: Unique<N, R>,
    queryable: Input<R, Q>,
    ...args: StepArgs<Q>
  ): Batch<With<R, N, BulkResult<ResultOf<Q>>>, F>;
  deleteAll(name: string, queryable: unknown, ...args: unknown[]): Batch<object, unknown> {
    return this.#add("deleteAll", name, {
      operation: "deleteAll",
      input: queryable,
      schema: undefined,
      args,
    });
  }

  /**
   * Reads the only row of a query (`repo.one`); its result is the row or `null`.
   *
   * @example
   * ```ts
   * createBatch().one("org", from(Org, "o").where({ slug }));
   * ```
   */
  one<const N extends string, Q extends Queryable>(
    name: Unique<N, R>,
    queryable: Input<R, Q>,
    ...args: StepArgs<Q>
  ): Batch<With<R, N, ResultOf<Q> | null>, F>;
  one(name: string, queryable: unknown, ...args: unknown[]): Batch<object, unknown> {
    return this.#add("one", name, { operation: "one", input: queryable, schema: undefined, args });
  }

  /**
   * Reads every row of a query (`repo.all`); its result is the rows.
   *
   * @example
   * ```ts
   * createBatch().all("members", ({ org }) => from(User, "u").where({ orgId: org.id }));
   * ```
   */
  all<const N extends string, Q extends Queryable>(
    name: Unique<N, R>,
    queryable: Input<R, Q>,
    ...args: StepArgs<Q>
  ): Batch<With<R, N, ResultOf<Q>[]>, F>;
  all(name: string, queryable: unknown, ...args: unknown[]): Batch<object, unknown> {
    return this.#add("all", name, { operation: "all", input: queryable, schema: undefined, args });
  }

  /**
   * Whether a query returns any row (`repo.exists`); its result is a boolean.
   *
   * @example
   * ```ts
   * createBatch().exists("taken", from(User, "u").where({ email }));
   * ```
   */
  exists<const N extends string, Q extends Queryable>(
    name: Unique<N, R>,
    queryable: Input<R, Q>,
    ...args: StepArgs<Q>
  ): Batch<With<R, N, boolean>, F>;
  exists(name: string, queryable: unknown, ...args: unknown[]): Batch<object, unknown> {
    return this.#add("exists", name, { operation: "exists", input: queryable, schema: undefined, args });
  }

  /**
   * Runs a function with the transaction's repo and the results so far. It must return
   * `success(data)` (the step's result is `data`) or `failure(error)` (the batch fails at
   * this step with `error`). A throw is a throw: the transaction rolls back and the error
   * propagates.
   *
   * @example
   * ```ts
   * createBatch().run("welcome", async (tx, { user }) => success(await queueWelcomeEmail(tx, user)));
   * ```
   */
  run<const N extends string, T, E = never>(
    name: Unique<N, R>,
    fn: (tx: Repo, results: R) => Result<T, E> | PromiseLike<Result<T, E>>,
  ): Batch<With<R, N, T>, [E] extends [never] ? F : F | BatchFailure<N, E, R>>;
  run(name: string, fn: unknown): Batch<object, unknown> {
    if (typeof fn !== "function") throw new TypeError("batch.run(name, fn): fn must be a function.");
    return this.#add("run", name, { operation: "run", input: fn, schema: undefined, args: NO_ARGS });
  }

  /**
   * Adds a value to the results under `name`, as if a step had produced it.
   *
   * @example
   * ```ts
   * createBatch().put("source", "signup-form");
   * ```
   */
  put<const N extends string, T>(name: Unique<N, R>, value: T): Batch<With<R, N, T>, F> {
    return this.#add("put", name, { operation: "put", input: value, schema: undefined, args: NO_ARGS });
  }

  /**
   * Calls `fn` with the results so far, and adds nothing to them: for logging and
   * debugging. A name is optional; when given it is a step name like any other.
   *
   * @example
   * ```ts
   * createBatch().insert("user", cs).inspect((results) => log.debug(results));
   * ```
   */
  inspect(fn: (results: R) => void): Batch<R, F>;
  inspect<const N extends string>(name: Unique<N, R>, fn: (results: R) => void): Batch<R, F>;
  inspect(nameOrFn: unknown, fn?: unknown): Batch<object, unknown> {
    const named = typeof nameOrFn !== "function";
    const callback = named ? fn : nameOrFn;
    if (typeof callback !== "function")
      throw new TypeError("batch.inspect(name?, fn): fn must be a function.");
    return this.#add("inspect", named ? nameOrFn : undefined, {
      operation: "inspect",
      input: callback,
      schema: undefined,
      args: NO_ARGS,
    });
  }

  /**
   * Adds the steps of the batch `fn` builds from the results so far, at this point of the
   * sequence. `fn` runs when the batch reaches it, inside the transaction; a step name it
   * repeats is a `QueryError` then.
   *
   * @example
   * ```ts
   * createBatch()
   *   .insert("user", cs)
   *   .merge(({ user }) => createBatch().insert("audit", change(AuditLog, { userId: user.id, action: "signed_up" })));
   * ```
   */
  merge<R2 extends object, F2>(
    fn: (results: R) => Batch<R2, F2> | PromiseLike<Batch<R2, F2>>,
  ): Batch<Simplify<R & R2>, F | After<F2, R>> {
    if (typeof fn !== "function")
      throw new TypeError("batch.merge(fn): fn must be a function that returns a batch.");
    return this.#add("merge", undefined, { operation: "merge", input: fn, schema: undefined, args: NO_ARGS });
  }

  /**
   * This batch followed by the steps of `other`.
   *
   * @example
   * ```ts
   * const both = signUp.append(createBatch().put("source", "form"));
   * ```
   *
   * @throws QueryError when the two batches share a step name.
   */
  append<R2 extends object, F2>(other: Batch<R2, F2>): Batch<Simplify<R & R2>, F | After<F2, R>> {
    return join(this, other) as never;
  }

  /**
   * The steps of `other` followed by this batch.
   *
   * @example
   * ```ts
   * const both = signUp.prepend(createBatch().put("source", "form"));
   * ```
   *
   * @throws QueryError when the two batches share a step name.
   */
  prepend<R0 extends object, F0>(other: Batch<R0, F0>): Batch<Simplify<R0 & R>, F0 | After<F, R0>> {
    return join(other, this) as never;
  }
}

function argsOf(options: unknown): readonly unknown[] {
  return options === undefined ? NO_ARGS : [options];
}

function step(operation: BatchOperation, input: unknown, options: unknown): Omit<BatchStep, "name"> {
  return { operation, input, schema: undefined, args: argsOf(options) };
}

function join(first: Batch<object, unknown>, second: Batch<object, unknown>): Batch<object, unknown> {
  if (!(first instanceof Batch) || !(second instanceof Batch)) {
    throw new TypeError("batch.append(other) and batch.prepend(other) take a batch made with createBatch().");
  }
  const names = new Set(namesOf(first));
  for (const name of namesOf(second)) {
    if (names.has(name)) throw duplicateName(name);
    names.add(name);
  }
  return make(Object.freeze([...stepsOf(first), ...stepsOf(second)]), names);
}

const EMPTY_BATCH = /* @__PURE__ */ make(
  /* @__PURE__ */ Object.freeze([]),
  /* @__PURE__ */ new Set(),
) as Batch;

/**
 * Starts a batch with no steps.
 *
 * @example
 * ```ts
 * import { createBatch } from "egon-orm";
 *
 * const signUp = createBatch()
 *   .insert("user", User.changeset(User, input))
 *   .insert("profile", ({ user }) => change(Profile, { userId: user.id }));
 * ```
 */
export function createBatch(): Batch {
  return EMPTY_BATCH;
}

// ---------------------------------------------------------------------------
// Running a batch (repo.transaction calls these)
// ---------------------------------------------------------------------------

/** Whether `value` is a batch. */
export function isBatch(value: unknown): value is Batch<object, unknown> {
  return value instanceof Batch;
}

/** The write operations that return a `Result`, whose static changesets are checked before the transaction opens. */
const CHECKED: readonly BatchOperation[] = /* @__PURE__ */ Object.freeze([
  "insert",
  "update",
  "delete",
  "insertOrUpdate",
]);

/**
 * The failure of the first step given an invalid changeset as it is (not computed from
 * earlier results), or `undefined`. A batch with one fails without opening a transaction.
 */
export function firstInvalid(
  batch: Batch<object, unknown>,
): BatchFailure<string, unknown, object> | undefined {
  for (const each of stepsOf(batch)) {
    const input = each.input;
    if (CHECKED.includes(each.operation) && input instanceof Changeset && !input.valid) {
      return { step: each.name as string, error: input, completed: {} };
    }
  }
  return undefined;
}

/** A copy of the results so far: what a step's function, and a failure's `completed`, receive. */
function snapshot(results: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(results)) copy[key] = results[key];
  return copy;
}

/** A step's input: the value it was given, or what its function computes from the results so far. */
function inputOf(each: BatchStep, results: Readonly<Record<string, unknown>>): unknown {
  const input = each.input;
  return typeof input === "function" && !isSchema(input)
    ? (input as (r: unknown) => unknown)(snapshot(results))
    : input;
}

function isResult(value: unknown): value is Result<unknown, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { success?: unknown }).success === "boolean"
  );
}

/**
 * Runs a batch's steps in order on `tx` and returns the results by name. A step that
 * fails calls `tx.rollback({ step, error, completed })`, which ends the transaction with
 * that failure.
 */
export async function runSteps(batch: Batch<object, unknown>, tx: Repo): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  await runList(stepsOf(batch), tx, results, new Set(namesOf(batch)));
  return results;
}

/** What a write step's `Result` failure looks like to the batch. */
function failAt(
  tx: Repo,
  each: BatchStep,
  error: unknown,
  results: Readonly<Record<string, unknown>>,
): never {
  return tx.rollback({ step: each.name, error, completed: snapshot(results) });
}

async function runList(
  steps: readonly BatchStep[],
  tx: Repo,
  results: Record<string, unknown>,
  names: Set<string>,
): Promise<void> {
  for (const each of steps) {
    const key = each.name as string;
    const args = each.args;
    switch (each.operation) {
      case "insert":
      case "update":
      case "delete":
      case "insertOrUpdate": {
        const method = tx[each.operation] as (
          input: unknown,
          ...rest: unknown[]
        ) => Promise<Result<unknown, unknown>>;
        const outcome = await method.call(tx, inputOf(each, results), ...args);
        if (!outcome.success) failAt(tx, each, outcome.error, results);
        results[key] = outcome.data;
        break;
      }
      case "insertAll": {
        const method = tx.insertAll as (
          schema: unknown,
          rows: unknown,
          ...rest: unknown[]
        ) => Promise<unknown>;
        results[key] = await method.call(tx, each.schema, inputOf(each, results), ...args);
        break;
      }
      case "updateAll":
      case "deleteAll":
      case "one":
      case "all":
      case "exists": {
        const method = tx[each.operation] as (q: unknown, ...rest: unknown[]) => Promise<unknown>;
        results[key] = await method.call(tx, inputOf(each, results), ...args);
        break;
      }
      case "run": {
        const outcome = await (each.input as (tx: Repo, results: unknown) => unknown)(tx, snapshot(results));
        if (!isResult(outcome)) {
          throw new TypeError(
            `The batch step "${key}" (run) must return success(data) or failure(error), but it returned ${outcome === null ? "null" : typeof outcome}.`,
          );
        }
        if (!outcome.success) failAt(tx, each, outcome.error, results);
        results[key] = outcome.data;
        break;
      }
      case "put":
        results[key] = each.input;
        break;
      case "inspect":
        (each.input as (results: unknown) => void)(snapshot(results));
        break;
      default: {
        const produced = await (each.input as (results: unknown) => unknown)(snapshot(results));
        if (!isBatch(produced)) {
          throw new TypeError("batch.merge(fn): fn must return a batch made with createBatch().");
        }
        for (const name of namesOf(produced)) {
          if (names.has(name)) throw duplicateName(name);
          names.add(name);
        }
        await runList(stepsOf(produced), tx, results, names);
      }
    }
  }
}
