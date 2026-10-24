/**
 * The row-level writes of the repo: `insert`, `update`, `delete` and `insertOrUpdate` of
 * one changeset, the options they take, and the `validateUniqueAsync` check.
 *
 * ## insert
 *
 * 1. An invalid changeset is returned as a failure; nothing is sent.
 * 2. The `prepareChanges` functions run, in order, on the changeset with its `action` and
 *    `repo` set.
 * 3. The values: each persisted field's change, else its default (a function default is
 *    called), else its generated value (the timestamps of `timestamps()` share one
 *    instant). A field left without a value is not written, so a database default
 *    applies; a field the database owns (`writable: "never"`) is never written.
 * 4. A non-nullable field that has no value, or `null`, and that the database does not
 *    generate, is reported as `can't be blank` (`validation: "required"`); nothing is sent.
 * 5. `INSERT … RETURNING` the primary key, the database-generated fields, the fields the
 *    database owns and the `returning` option's fields. The row is built from the values
 *    written and the values returned, its virtual fields from the changes.
 *
 * ## update
 *
 * An invalid changeset is a failure; the prepare functions run; with no change (and no
 * `force`) nothing is sent and the row is returned as it is; an optimistic lock's bump on
 * its own is not a change (an unchanged save leaves the version alone). Otherwise `UPDATE … SET`
 * the changed columns that may be updated, plus the fields generated on every write
 * (`updatedAt`), `WHERE` the primary key and the optimistic-lock filters. No row matched
 * is a stale entry.
 *
 * ## delete
 *
 * `DELETE … WHERE` the primary key and the filters; no row matched is a stale entry. The
 * row returned is the row given, in the `deleted` state.
 *
 * A database constraint violation is matched against the changeset's declarations
 * (`constraints.ts`).
 *
 * @module
 */

import { sqlDialectOf } from "../adapter/compiler.js";
import {
  Changeset,
  change,
  provideValidateUniqueAsync,
  rebuild,
  withAction,
  withErrors,
  withRepo,
} from "../changeset/changeset.js";
import { embedChanges, isNestedValue, missingEmbedded } from "../changeset/nested/embed.js";
import { bindParams, fieldOfRefusal } from "../compiler/bind.js";
import type {
  CompiledQuery,
  Connection,
  ExecuteOptions,
  Executor,
  OnConflict,
  RawResult,
} from "../contracts/adapter.js";
import type { Action, ChangesetError } from "../contracts/changeset.js";
import type { ExprNode } from "../contracts/query.js";
import { type Failure, failure, type Result, type Success, success } from "../contracts/result.js";
import {
  type AnySchema,
  type FieldMeta,
  type FieldNames,
  ROW,
  type RowMeta,
  type SchemaMeta,
} from "../contracts/schema.js";
import {
  CastError,
  ConstraintError,
  DatabaseError,
  InvalidChangesetError,
  isEgonError,
  QueryError,
  rewrap,
  StaleEntryError,
} from "../errors.js";
import { distinct } from "../internal/distinct.js";
import { own } from "../internal/own.js";
import { isPlainObject } from "../internal/plain-object.js";
import { collectParams } from "../query/ast.js";
import { from } from "../query/builder.js";
import type { Col, Expr, SomeParams } from "../query/expr.js";
import { and, not } from "../query/functions.js";
import { isRow } from "../schema/guards.js";
import { meta } from "../schema/schema.js";
import { handleViolation } from "./constraints.js";
import { decoderFor, WRITTEN } from "./hydrate.js";
import { writeNested } from "./nested.js";
import { checkReadOptions, READ_OPTION_KEYS, type ReadOptions, type RepoOperation } from "./options.js";
import { keepPreloads } from "./preload.js";
import { Call, isFragment, load, ReadCore } from "./read.js";
import { atomically } from "./transaction.js";

/** Added to a read-back decoding error of an upsert, which is undone with its read-back. */
const UNDONE = " The write was undone: an upsert and its read-back run as one unit.";

/** A changeset of any schema, as the repo handles it. */
export type AnyChangeset = Changeset<AnySchema, boolean>;

const NONE: readonly never[] = /* @__PURE__ */ Object.freeze([]);
const hasOwn = Object.hasOwn;
const now = (): number => performance.now();

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Which conflict an upsert handles: the unique index over these fields, a named
 * constraint, or a `fragment` (an index expression, with a predicate if needed).
 *
 * @example
 * ```ts
 * const byEmail: ConflictTargetOption<typeof User> = ["email"];
 * const byName: ConflictTargetOption<typeof User> = { constraint: "users_email_key" };
 * ```
 */
export type ConflictTargetOption<S extends AnySchema = AnySchema> =
  | readonly FieldNames<S>[]
  | { readonly constraint: string }
  | Expr<unknown, SomeParams>;

/**
 * Which columns an upsert updates on the row it collided with: every inserted column
 * (`"all"`), these fields, or every inserted column but these.
 *
 * @example
 * ```ts
 * const update: ConflictUpdateOption<typeof User> = { except: ["createdAt"] };
 * ```
 */
export type ConflictUpdateOption<S extends AnySchema = AnySchema> =
  | "all"
  | readonly FieldNames<S>[]
  | { readonly except: readonly FieldNames<S>[] };

/**
 * What an insert does when it collides with an existing row: nothing (`"nothing"`), or
 * update that row. Without the option, a conflict is an error. `target` may be left out
 * only on a database that cannot take one (MySQL); Postgres requires it.
 *
 * @example
 * ```ts
 * const upsert: OnConflictOption<typeof User> = { target: ["email"], update: ["name"] };
 * ```
 */
export type OnConflictOption<S extends AnySchema = AnySchema> =
  | "nothing"
  | { readonly target?: ConflictTargetOption<S>; readonly update: ConflictUpdateOption<S> };

/**
 * The options of `repo.insert`.
 *
 * - `returning`: the fields to read back besides the primary key and the fields the
 *   database generates; `true` for every field (for columns a trigger or a database
 *   default sets).
 * - `onConflict`: see {@link OnConflictOption}. With `"nothing"`, a conflict inserts
 *   nothing and the result's `data` is `null`.
 *
 * @example
 * ```ts
 * const options: InsertOptions<typeof User> = { returning: true, timeoutMs: 1_000 };
 * ```
 */
export interface InsertOptions<S extends AnySchema = AnySchema> extends ReadOptions {
  readonly returning?: true | readonly FieldNames<S>[] | undefined;
  readonly onConflict?: OnConflictOption<S> | undefined;
}

/**
 * How a stale update or delete is reported on the changeset instead of thrown: an error
 * on `field` (any error key), with `message` (default `is stale`).
 *
 * @example
 * ```ts
 * const staleError: StaleErrorOption = { field: "lockVersion", message: "was changed by someone else" };
 * ```
 */
export interface StaleErrorOption {
  readonly field: string;
  readonly message?: string | undefined;
}

/**
 * The options of `repo.update`.
 *
 * - `force`: run the update even when nothing changed (the fields generated on every
 *   write, such as `updatedAt`, are still set).
 * - `staleError`: report a stale row on the changeset (see {@link StaleErrorOption}).
 * - `allowStale`: treat a stale row as updated.
 * - `returning`: as for insert.
 *
 * @example
 * ```ts
 * const options: UpdateOptions<typeof User> = { staleError: { field: "lockVersion" } };
 * ```
 */
export interface UpdateOptions<S extends AnySchema = AnySchema> extends ReadOptions {
  readonly returning?: true | readonly FieldNames<S>[] | undefined;
  readonly force?: boolean | undefined;
  readonly staleError?: StaleErrorOption | undefined;
  readonly allowStale?: boolean | undefined;
}

/**
 * The options of `repo.delete`: `staleError` and `allowStale`, as for update.
 *
 * @example
 * ```ts
 * const options: DeleteOptions = { allowStale: true };
 * ```
 */
export interface DeleteOptions extends ReadOptions {
  readonly staleError?: StaleErrorOption | undefined;
  readonly allowStale?: boolean | undefined;
}

/**
 * The options of `repo.insertOrUpdate`: those of insert and of update; each path reads
 * its own.
 *
 * @example
 * ```ts
 * const options: InsertOrUpdateOptions<typeof User> = { returning: true, force: true };
 * ```
 */
export interface InsertOrUpdateOptions<S extends AnySchema = AnySchema>
  extends InsertOptions<S>,
    UpdateOptions<S> {
  readonly returning?: true | readonly FieldNames<S>[] | undefined;
}

export const INSERT_OPTION_KEYS: readonly string[] = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ READ_OPTION_KEYS.concat(["returning", "onConflict"]),
);
export const UPDATE_OPTION_KEYS: readonly string[] = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ READ_OPTION_KEYS.concat(["returning", "force", "staleError", "allowStale"]),
);
export const DELETE_OPTION_KEYS: readonly string[] = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ READ_OPTION_KEYS.concat(["staleError", "allowStale"]),
);
export const INSERT_OR_UPDATE_OPTION_KEYS: readonly string[] = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ READ_OPTION_KEYS.concat(["returning", "onConflict", "force", "staleError", "allowStale"]),
);

/** Everything a write reads from its options, checked. */
export interface WriteSettings {
  readonly options: ReadOptions | undefined;
  readonly returning: readonly FieldMeta[] | true | undefined;
  readonly onConflict: OnConflict | undefined;
  /** The values of a fragment conflict target's parameters. */
  readonly conflictParams: readonly unknown[];
  readonly force: boolean;
  readonly staleError: StaleErrorOption | undefined;
  readonly allowStale: boolean;
}

const NO_SETTINGS: WriteSettings = /* @__PURE__ */ Object.freeze({
  options: undefined,
  returning: undefined,
  onConflict: undefined,
  conflictParams: NONE,
  force: false,
  staleError: undefined,
  allowStale: false,
});

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `${typeof value} ${String(value)}`;
}

/**
 * The persisted field `name` of `schemaMeta`.
 *
 * @throws QueryError when there is none (or it is virtual).
 */
export function persistedField(schemaMeta: SchemaMeta, name: unknown, where: string): FieldMeta {
  const field = typeof name === "string" ? schemaMeta.fieldsByName.get(name) : undefined;
  if (field === undefined || field.virtual) {
    throw new QueryError(
      "query.writeOptionField",
      `${where}: ${typeof name === "string" ? `"${name}"` : describe(name)} is not ${field?.virtual === true ? "a stored field (it is virtual)" : "a field"} of ${schemaMeta.name}. Its fields are: ${schemaMeta.persisted.map((each) => each.name).join(", ")}.`,
    );
  }
  return field;
}

function fieldList(schemaMeta: SchemaMeta, names: unknown, where: string): readonly FieldMeta[] {
  if (!Array.isArray(names) || names.length === 0) {
    throw new QueryError("query.writeOptionFields", `${where} must be a non-empty list of field names.`);
  }
  // A name listed twice is one field (owner decision, 2026-10-24).
  return distinct(names.map((name) => persistedField(schemaMeta, name, where)));
}

/**
 * Checks `returning`: `true` or a list of persisted field names.
 *
 * @throws QueryError otherwise.
 */
export function returningOption(
  schemaMeta: SchemaMeta,
  returning: unknown,
  method: string,
): readonly FieldMeta[] | true | undefined {
  if (returning === undefined) return undefined;
  if (returning === true) return true;
  if (!Array.isArray(returning)) {
    throw new QueryError(
      "query.returningOption",
      `repo.${method}(): returning is true or a list of field names, but it is ${describe(returning)}.`,
    );
  }
  return fieldList(schemaMeta, returning, `repo.${method}(): returning`);
}

/**
 * Checks `onConflict` and turns it into the adapter's form, with the values of a fragment
 * target's parameters.
 *
 * @throws QueryError when it is malformed or names something that is not a field.
 */
export function conflictOption(
  schemaMeta: SchemaMeta,
  option: unknown,
  method: string,
): { readonly onConflict: OnConflict | undefined; readonly params: readonly unknown[] } {
  const where = `repo.${method}(): onConflict`;
  if (option === undefined) return { onConflict: undefined, params: NONE };
  if (option === "nothing") return { onConflict: "nothing", params: NONE };
  if (typeof option !== "object" || option === null || !isPlainObject(option)) {
    throw new QueryError(
      "query.onConflictOption",
      `${where} is "nothing" or { target, update }, but it is ${describe(option)}.`,
    );
  }
  const given = option as { readonly target?: unknown; readonly update?: unknown };
  for (const key of Object.keys(given)) {
    if (key !== "target" && key !== "update") {
      throw new QueryError(
        "query.onConflictKey",
        `${where} has the keys target and update; "${key}" is not one of them.`,
      );
    }
  }
  let target: OnConflict & object extends { target: infer T } ? T : never;
  let params: readonly unknown[] = NONE;
  const rawTarget = own(given, "target");
  if (rawTarget === undefined) {
    target = undefined;
  } else if (Array.isArray(rawTarget)) {
    target = fieldList(schemaMeta, rawTarget, `${where}'s target`);
  } else if (isFragment(rawTarget)) {
    target = rawTarget.node;
    const values: unknown[] = [];
    collectParams(rawTarget.node as ExprNode, values, []);
    params = values;
  } else if (
    typeof rawTarget === "object" &&
    rawTarget !== null &&
    isPlainObject(rawTarget) &&
    Object.keys(rawTarget).length === 1 &&
    typeof own(rawTarget as { constraint?: unknown }, "constraint") === "string" &&
    (rawTarget as { constraint: string }).constraint !== ""
  ) {
    target = { constraint: (rawTarget as { constraint: string }).constraint };
  } else {
    throw new QueryError(
      "query.onConflictTargetOption",
      `${where}'s target is a list of field names, { constraint: "name" } or a fragment, but it is ${describe(rawTarget)}.`,
    );
  }
  const rawUpdate = own(given, "update");
  let update: Exclude<OnConflict, "nothing">["update"];
  if (rawUpdate === "all") {
    update = "all";
  } else if (Array.isArray(rawUpdate)) {
    update = fieldList(schemaMeta, rawUpdate, `${where}'s update`);
  } else if (
    typeof rawUpdate === "object" &&
    rawUpdate !== null &&
    isPlainObject(rawUpdate) &&
    Object.keys(rawUpdate).length === 1 &&
    Array.isArray(own(rawUpdate as { except?: unknown }, "except"))
  ) {
    update = {
      except: fieldList(schemaMeta, (rawUpdate as { except: unknown }).except, `${where}'s except`),
    };
  } else {
    throw new QueryError(
      "query.onConflictUpdateOption",
      `${where}'s update is "all", a list of field names or { except: [...] }, but it is ${describe(rawUpdate)}.`,
    );
  }
  return { onConflict: { target, update }, params };
}

function checkBooleanOption(method: string, name: string, value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new TypeError(`repo.${method}(): ${name} must be true or false, but it is ${describe(value)}.`);
  }
  return value;
}

function staleErrorOption(method: string, value: unknown): StaleErrorOption | undefined {
  if (value === undefined) return undefined;
  const given = value as { readonly field?: unknown; readonly message?: unknown };
  const field = typeof value === "object" && value !== null ? own(given, "field") : undefined;
  const message = typeof value === "object" && value !== null ? own(given, "message") : undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    !isPlainObject(value) ||
    typeof field !== "string" ||
    field === "" ||
    field === "__proto__" ||
    (message !== undefined && typeof message !== "string") ||
    Object.keys(value).some((key) => key !== "field" && key !== "message")
  ) {
    throw new TypeError(
      `repo.${method}(): staleError is { field, message? }, with field the error key to report on, such as { field: "lockVersion" }.`,
    );
  }
  return given as StaleErrorOption;
}

/**
 * Checks a write's options.
 *
 * @throws TypeError for an unknown option or a wrong type; QueryError for a field that is not one.
 */
export function writeSettings(
  schemaMeta: SchemaMeta,
  method: string,
  options: unknown,
  keys: readonly string[],
): WriteSettings {
  const checked = checkReadOptions<ReadOptions>(method, options, keys);
  if (checked === undefined) return NO_SETTINGS;
  const given = checked as Readonly<Record<string, unknown>>;
  const conflict = conflictOption(schemaMeta, own(given, "onConflict"), method);
  return {
    options: checked,
    returning: returningOption(schemaMeta, own(given, "returning"), method),
    onConflict: conflict.onConflict,
    conflictParams: conflict.params,
    force: checkBooleanOption(method, "force", own(given, "force")),
    staleError: staleErrorOption(method, own(given, "staleError")),
    allowStale: checkBooleanOption(method, "allowStale", own(given, "allowStale")),
  };
}

// ---------------------------------------------------------------------------
// Running a statement
// ---------------------------------------------------------------------------

/** The execution options of a write, in one shape (the shape the reads use). */
interface CallOptions {
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number | undefined;
  readonly slots: CompiledQuery["slots"];
  readonly context: Call | undefined;
  readonly batchSize: undefined;
}

/**
 * A call's deadline (`performance.now()` based) when it runs several statements under one
 * `timeoutMs`; `undefined` without one.
 */
export function deadlineOf(options: ReadOptions | undefined): number | undefined {
  const timeoutMs = own(options, "timeoutMs");
  return typeof timeoutMs === "number" ? now() + timeoutMs : undefined;
}

/** What is left of a call's budget: its `timeoutMs` for a one-statement call, else what remains before the deadline. */
export function remaining(
  options: ReadOptions | undefined,
  deadline: number | undefined,
): number | undefined {
  return deadline === undefined ? own(options, "timeoutMs") : Math.max(0, deadline - now());
}

/**
 * Binds the values of a row-level write, whose first values are one per field of
 * `fields` (an insert's columns, an update's set fields). When one of them is a value of
 * an integer type that is not a whole number, the error names the field (`User.age`),
 * with the error naming the parameter as its cause (owner row 7, status 03). The values
 * after them (an update's key and lock, which come from a loaded row; an upsert's
 * conflict values) keep the error that names the parameter.
 */
function bindFields(
  plan: CompiledQuery,
  values: readonly unknown[],
  schemaMeta: SchemaMeta,
  fields: readonly FieldMeta[],
): unknown[] {
  try {
    return bindParams(plan.slots, values);
  } catch (error) {
    throw fieldOfRefusal(error, (index) => {
      const field = fields[index];
      return field === undefined ? undefined : `${schemaMeta.name}.${field.name}`;
    });
  }
}

/**
 * Runs one statement of a write on `executor`, reporting it to the repo's `query`
 * listeners as `operation` on `source`. `finish` turns the result into what the write
 * needs (the decoding is timed as `decodeMs`); it is a module-level function, handed
 * `extra`, so that no closure is made per call.
 */
export async function runWrite<T, E>(
  core: ReadCore,
  executor: Executor,
  operation: RepoOperation,
  source: string | undefined,
  plan: CompiledQuery,
  values: readonly unknown[],
  options: ReadOptions | undefined,
  deadline: number | undefined,
  finish: (result: RawResult, plan: CompiledQuery, core: ReadCore, extra: E) => T,
  extra: E,
): Promise<T> {
  const hub = core.hub;
  const call = hub.listening ? new Call(hub, operation, source, own(options, "context")) : undefined;
  const shaped: CallOptions = {
    signal: own(options, "signal"),
    timeoutMs: remaining(options, deadline),
    slots: plan.slots,
    context: call,
    batchSize: undefined,
  };
  let result: RawResult;
  try {
    result = await executor.execute(plan.sql, values, shaped as ExecuteOptions);
  } catch (error) {
    if (call !== undefined) hub.emit(call, 0, undefined);
    throw deadline === undefined ? error : overBudget(error, options);
  }
  if (call === undefined) return finish(result, plan, core, extra);
  const start = now();
  let value: T;
  try {
    value = finish(result, plan, core, extra);
  } catch (error) {
    hub.emit(call, now() - start, error);
    throw error;
  }
  hub.emit(call, now() - start, undefined);
  return value;
}

/**
 * A timeout of one statement of a call that runs several, said with the call's budget:
 * the statement was given only what was left of it. Other errors are returned unchanged.
 */
export function overBudget(error: unknown, options: ReadOptions | undefined): unknown {
  if (!(error instanceof DatabaseError) || error.code !== "timeout") return error;
  const timeoutMs = own(options, "timeoutMs");
  return new DatabaseError(
    "database.callTimeout",
    `The call ran longer than its timeoutMs (${timeoutMs} ms), which covers every statement it runs.`,
    { code: "timeout", ...(error.sql === undefined ? {} : { sql: error.sql }), cause: error },
  );
}

/**
 * A connection from the pool within the call's budget: the wait counts against
 * `timeoutMs`, and the call's signal stops it. A connection that arrives after the call
 * gave up is returned to the pool. `what` names the call in the messages.
 *
 * @throws DatabaseError with the code `"timeout"` or `"aborted"`.
 */
export async function acquireWithin(
  core: ReadCore,
  options: ReadOptions | undefined,
  deadline: number | undefined,
  what = "write",
): Promise<Connection> {
  const signal = own(options, "signal");
  if (signal?.aborted === true) {
    throw new DatabaseError("database.abortedBefore", `The ${what} was not run: its AbortSignal had fired.`, {
      code: "aborted",
    });
  }
  const pending = core.adapter.acquire();
  if (signal === undefined && deadline === undefined) return pending;
  return new Promise<Connection>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const giveUp = (error: DatabaseError): void => {
      if (settled) return;
      done();
      reject(error);
    };
    const onAbort = (): void =>
      giveUp(
        new DatabaseError(
          "database.abortedWaiting",
          `The ${what} was not run: its AbortSignal fired while it waited for a free connection.`,
          {
            code: "aborted",
          },
        ),
      );
    if (deadline !== undefined) {
      const timeoutMs = own(options, "timeoutMs");
      timer = setTimeout(
        () =>
          giveUp(
            new DatabaseError(
              "database.timeoutWaiting",
              `The ${what} was not run: it waited longer than its timeoutMs (${timeoutMs} ms) for a free connection.`,
              { code: "timeout" },
            ),
          ),
        Math.max(0, deadline - now()),
      );
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (connection) => {
        if (settled) {
          void connection.release();
          return;
        }
        done();
        resolve(connection);
      },
      (error: unknown) => {
        if (settled) return;
        done();
        reject(error);
      },
    );
  });
}

/** What a row-level write's statement returned. */
interface Written {
  readonly rowCount: number;
  /** The returned row, decoded to an object keyed by field name; `undefined` when none came back. */
  readonly returned: Readonly<Record<string, unknown>> | undefined;
  readonly insertId: bigint | number | undefined;
}

/**
 * Decodes the returned row of a row-level write. `schemaName` names its values in a
 * decoding error (`User.id`).
 */
function decodeWritten(result: RawResult, plan: CompiledQuery, core: ReadCore, schemaName: string): Written {
  const row = result.rows[0];
  const returned =
    row === undefined || plan.output === undefined
      ? undefined
      : (decoderFor(plan, core.adapter, core.codegen, schemaName)(row, NONE) as Readonly<
          Record<string, unknown>
        >);
  return { rowCount: result.rowCount, returned, insertId: result.insertId };
}

// ---------------------------------------------------------------------------
// Per-schema write tables
// ---------------------------------------------------------------------------

/** What every write of one schema needs, computed once per schema. */
interface WriteTable {
  /** The fields an insert always reads back: the primary key, database-generated and database-owned fields. */
  readonly insertBack: readonly FieldMeta[];
  /** The fields an update always reads back: database-generated and database-owned fields that are not the key. */
  readonly updateBack: readonly FieldMeta[];
  /**
   * For each persisted field that is generated, the index (in `persisted`) of the first
   * field sharing its timestamp generator, so that `createdAt` and `updatedAt` get one
   * instant; its own index otherwise.
   */
  readonly shares: readonly number[];
  /** Whether a field is generated on update (`autogenerate` on insert and update). */
  readonly onUpdate: readonly boolean[];
  /** Each persisted field's index in `persisted`, looked up per key instead of searched. */
  readonly positions: ReadonlyMap<FieldMeta, number>;
}

const tables = /* @__PURE__ */ new WeakMap<SchemaMeta, WriteTable>();

const TIMESTAMP_KINDS: ReadonlySet<string> = /* @__PURE__ */ new Set(["timestamp", "timestamptz"]);

/**
 * The write table of a schema.
 *
 * @throws QueryError for an embedded schema, which has no table.
 */
export function writeTable(schemaMeta: SchemaMeta): WriteTable {
  let table = tables.get(schemaMeta);
  if (table !== undefined) return table;
  if (schemaMeta.source === null) {
    throw new QueryError(
      "query.writeEmbeddedSchema",
      `${schemaMeta.name} is an embedded schema: it is stored inside its parent's row and has no table to write to.`,
    );
  }
  const persisted = schemaMeta.persisted;
  const owned = (field: FieldMeta): boolean => field.dbGenerated || field.writable === "never";
  const shares: number[] = [];
  const onUpdate: boolean[] = [];
  for (let i = 0; i < persisted.length; i++) {
    const field = persisted[i] as FieldMeta;
    const generate = field.autogenerate;
    let share = i;
    if (generate !== undefined && TIMESTAMP_KINDS.has(field.type.db.kind)) {
      for (let j = 0; j < i; j++) {
        const other = persisted[j] as FieldMeta;
        if (other.autogenerate?.fn === generate.fn && TIMESTAMP_KINDS.has(other.type.db.kind)) {
          share = j;
          break;
        }
      }
    }
    shares.push(share);
    onUpdate.push(generate?.on === "insertAndUpdate");
  }
  table = {
    insertBack: persisted.filter((field) => field.primaryKey || owned(field)),
    updateBack: persisted.filter((field) => !field.primaryKey && owned(field)),
    shares,
    onUpdate,
    positions: new Map(persisted.map((field, i) => [field, i])),
  };
  tables.set(schemaMeta, table);
  return table;
}

/**
 * The value of a generated field, sharing the instant of an earlier timestamp field of
 * the same generator (`generated` holds what this write generated so far, by index).
 */
function generatedValue(table: WriteTable, field: FieldMeta, index: number, generated: unknown[]): unknown {
  const share = table.shares[index] as number;
  if (share !== index && generated[share] !== undefined) return generated[share];
  const value = (field.autogenerate as NonNullable<FieldMeta["autogenerate"]>).fn();
  generated[index] = value;
  return value;
}

/** `base` plus the fields of `option`, in the schema's field order. */
function returningFields(
  schemaMeta: SchemaMeta,
  base: readonly FieldMeta[],
  option: readonly FieldMeta[] | true | undefined,
): readonly FieldMeta[] {
  if (option === undefined) return base;
  if (option === true) return schemaMeta.persisted;
  return schemaMeta.persisted.filter((field) => base.includes(field) || option.includes(field));
}

// ---------------------------------------------------------------------------
// Checks shared by the writes
// ---------------------------------------------------------------------------

/**
 * The schema metadata of a changeset the repo can write.
 *
 * @throws TypeError when `changeset` is not a changeset; QueryError for one without a schema class.
 */
function changesetMeta(changeset: unknown, method: string): SchemaMeta {
  if (!(changeset instanceof Changeset)) {
    throw new TypeError(
      `repo.${method}() takes a changeset: repo.${method}(cast(User, params, ["email"])). It was given ${describe(changeset)}.`,
    );
  }
  const model = (changeset as AnyChangeset).model;
  if (model === null) {
    throw new QueryError(
      "query.writeSchemaless",
      `repo.${method}(): this changeset has no schema class (it was cast from { data, types }), so it has no table to write to.`,
    );
  }
  const schemaMeta = meta(model);
  writeTable(schemaMeta);
  return schemaMeta;
}

/**
 * Whether a changeset holds changes of associations (keys that are not fields): those are
 * written by the nested writes of `nested.ts`, in a transaction. Changes of embed fields
 * are written with the row.
 */
function hasAssocChanges(changeset: AnyChangeset, schemaMeta: SchemaMeta, method: string): boolean {
  const changes = changeset.changes as Readonly<Record<string, unknown>>;
  let nested = false;
  for (const key in changes) {
    if (!hasOwn(changes, key)) continue;
    const field = schemaMeta.fieldsByName.get(key);
    if (field === undefined) {
      if (!schemaMeta.assocs().has(key)) {
        throw new QueryError(
          "query.writeUnknownChange",
          `repo.${method}(): the changeset holds a change of "${key}", which is neither a field nor an association of ${schemaMeta.name}.`,
        );
      }
      nested = true;
    } else if (isNestedValue(changes[key]) && !schemaMeta.embeds.some((embed) => embed.name === key)) {
      throw new QueryError(
        "query.writeNestedNotEmbed",
        `repo.${method}(): the changeset of ${schemaMeta.name} holds a changeset as the change of "${key}", which is not an embed field.`,
      );
    }
  }
  return nested;
}

/** The loaded row of an update or delete, with a primary key that has values. */
export function loadedRow(
  changeset: AnyChangeset,
  schemaMeta: SchemaMeta,
  method: string,
): Record<string, unknown> {
  const data = changeset.data;
  if (data === null) {
    throw new QueryError(
      "query.writeNewRecord",
      `repo.${method}() needs a changeset of a loaded row; this one is of a new ${schemaMeta.name} (made from the class).`,
    );
  }
  if (!isRow(data) || data[ROW].state !== "loaded") {
    throw new QueryError(
      "query.writeNotLoaded",
      `repo.${method}() needs a row read from the database; ${isRow(data) ? `this ${schemaMeta.name} row is ${data[ROW].state}` : "the changeset's data is not a row"}.`,
    );
  }
  if (schemaMeta.primaryKey.length === 0) {
    throw new QueryError(
      "query.writeNoPrimaryKey",
      `repo.${method}(): ${schemaMeta.name} has no primary key, so a row of it cannot be found again to ${method === "delete" ? "delete" : "update"}.`,
      { params: { method: method === "delete" ? "deleteAll" : "updateAll" } },
    );
  }
  const row = data as unknown as Record<string, unknown>;
  for (const field of schemaMeta.primaryKey) {
    const value = row[field.name];
    if (value === null || value === undefined) {
      throw new QueryError(
        "query.writeNoKeyValue",
        `repo.${method}(): the ${schemaMeta.name} row has no value for its key field "${field.name}".`,
      );
    }
  }
  return row;
}

/**
 * Runs the changeset's `prepareChanges` functions in order, on the changeset with `action`
 * and `repo` set; the result has `action` set and `repo` cleared.
 *
 * @throws TypeError when a function does not return a changeset.
 */
export function runPrepare(changeset: AnyChangeset, action: Action, repo: unknown): AnyChangeset {
  let current = withAction(changeset, action);
  const functions = current.prepare;
  if (functions.length === 0) return current;
  current = withRepo(current, repo);
  for (const fn of functions) {
    const next: unknown = fn(current);
    if (!(next instanceof Changeset)) {
      throw new TypeError(
        `A prepareChanges function must return the changeset to write (the one it was given, or one made from it); it returned ${describe(next)}.`,
      );
    }
    current = next as AnyChangeset;
  }
  return withRepo(current, null);
}

const BLANK: ChangesetError = /* @__PURE__ */ Object.freeze({
  message: "can't be blank",
  validation: "required",
  meta: /* @__PURE__ */ Object.freeze({}),
});

function blank(changeset: AnyChangeset, fields: readonly FieldMeta[]): AnyChangeset {
  let out = changeset;
  for (const field of fields) out = withErrors(out, field.name, [BLANK]);
  return out;
}

/** The database schema of a row-level write: the call's, else the row's (or for an insert the schema's), else the repo's default. */
function writeSchema(
  core: ReadCore,
  options: ReadOptions | undefined,
  fallback: string | undefined,
): string | undefined {
  return own(options, "schema") ?? fallback ?? core.schema;
}

/** `list` with `item` appended, made when it is the first. */
export function added<T>(list: T[] | undefined, item: T): T[] {
  const out = list ?? [];
  out.push(item);
  return out;
}

/** Builds a row: the values of the persisted fields, then the virtual fields and loaded associations of `row`, then the virtual changes. */
function buildRow(
  schemaMeta: SchemaMeta,
  values: readonly unknown[],
  rowMeta: RowMeta,
  previous: Readonly<Record<string, unknown>> | null,
  changes: Readonly<Record<string, unknown>>,
): object {
  let loaded: string[] | undefined;
  if (previous !== null) {
    for (const key of Object.keys(previous)) {
      if (!schemaMeta.fieldsByName.has(key)) loaded = added(loaded, key);
    }
  }
  const out = (
    loaded === undefined
      ? schemaMeta.create(values, rowMeta)
      : schemaMeta.createWith(loaded)(
          values,
          loaded.map((key) => (previous as Readonly<Record<string, unknown>>)[key]),
          rowMeta,
        )
  ) as Record<string, unknown>;
  for (const field of schemaMeta.fields) {
    if (!field.virtual) continue;
    if (hasOwn(changes, field.name)) out[field.name] = changes[field.name];
    else if (previous !== null) out[field.name] = previous[field.name];
  }
  // The kept associations come with how they were preloaded, for a later reload.
  if (previous !== null) keepPreloads(previous, out);
  return out;
}

/**
 * What a stale update or delete gives: `undefined` when it is allowed (`allowStale`: the
 * write counts as done), a failure with `staleError`, or else a thrown error.
 *
 * @throws StaleEntryError when neither option is given.
 */
function staleOutcome(
  changeset: AnyChangeset,
  schemaMeta: SchemaMeta,
  action: "update" | "delete",
  settings: WriteSettings,
): Failure<AnyChangeset> | undefined {
  if (settings.allowStale) return undefined;
  const stale = settings.staleError;
  if (stale !== undefined) {
    return failure(
      withErrors(changeset, stale.field, [
        { message: own(stale, "message") ?? "is stale", validation: "stale", meta: { stale: true } },
      ]),
    );
  }
  throw new StaleEntryError({ action, schema: schemaMeta.name });
}

/** The adapter's dialect's identifier limit in bytes, for matching shortened constraint names. */
function identifierLimit(core: ReadCore): number | undefined {
  return sqlDialectOf(core.adapter.dialect)?.identifierMaxBytes;
}

function isConstraintError(error: unknown): error is ConstraintError {
  return error instanceof ConstraintError || isEgonError(error, "constraint");
}

// ---------------------------------------------------------------------------
// insert
// ---------------------------------------------------------------------------

const ONE_ROW = /* @__PURE__ */ Object.freeze({ kind: "values" as const, rows: 1 });

/**
 * `repo.insert`: writes a new-record changeset.
 *
 * @throws TypeError, QueryError for misuse; ConstraintError for an undeclared violation;
 * DatabaseError when the database fails.
 */
export async function insert(
  core: ReadCore,
  repo: unknown,
  given: unknown,
  options: unknown,
  method = "insert",
  keys: readonly string[] = INSERT_OPTION_KEYS,
): Promise<Result<object | null, AnyChangeset>> {
  const schemaMeta = changesetMeta(given, method);
  const changeset = given as AnyChangeset;
  if (changeset.data !== null) {
    throw new QueryError(
      "query.insertLoadedRow",
      `repo.${method}() takes a changeset of a new record (made from the class, cast(${schemaMeta.name}, …)); this one is of a loaded row.`,
    );
  }
  // Refused before anything else, as an invalid changeset is.
  const nested = hasAssocChanges(changeset, schemaMeta, method);
  const settings = writeSettings(schemaMeta, method, options, keys);
  if (!changeset.valid) return failure(withAction(changeset, "insert"));
  if (nested) {
    return writeNested(core, repo, changeset, schemaMeta, settings, "insert", method, false);
  }
  const prepared = runPrepare(changeset, "insert", repo);
  if (!prepared.valid) return failure(prepared);
  if (hasAssocChanges(prepared, schemaMeta, method)) {
    return writeNested(core, repo, prepared, schemaMeta, settings, "insert", method, true);
  }
  return insertRow(core, schemaMeta, prepared, settings);
}

/**
 * The row of an insert, after the checks and the prepare functions: the values, the
 * required-field check, the statement and the row built from it. The nested writes call
 * it for a parent whose association changes they have taken out.
 *
 * @throws QueryError, ConstraintError, DatabaseError as {@link insert} does.
 */
export async function insertRow(
  core: ReadCore,
  schemaMeta: SchemaMeta,
  prepared: AnyChangeset,
  settings: WriteSettings,
): Promise<Result<object | null, AnyChangeset>> {
  const blankEmbeds = schemaMeta.embeds.length === 0 ? undefined : missingEmbedded(prepared);
  if (blankEmbeds !== undefined) return failure(blankEmbeds as AnyChangeset);
  const table = writeTable(schemaMeta);
  const persisted = schemaMeta.persisted;
  const changes =
    schemaMeta.embeds.length === 0
      ? (prepared.changes as Readonly<Record<string, unknown>>)
      : embedChanges(prepared, "loaded");
  const written: unknown[] = new Array(persisted.length);
  const columns: FieldMeta[] = [];
  const values: unknown[] = [];
  let generated: unknown[] | undefined;
  let missing: FieldMeta[] | undefined;
  for (let i = 0; i < persisted.length; i++) {
    const field = persisted[i] as FieldMeta;
    if (field.writable === "never") continue;
    let value = hasOwn(changes, field.name) ? changes[field.name] : undefined;
    if (value === undefined) {
      const fallback = field.default;
      if (fallback !== undefined) {
        value = fallback.kind === "value" ? fallback.value : fallback.fn();
      } else if (field.autogenerate !== undefined) {
        if (generated === undefined) generated = [];
        value = generatedValue(table, field, i, generated);
      }
    }
    if (value === undefined || (value === null && !field.nullable)) {
      // Left out: the database default applies. A database-generated field is never missing.
      if (!field.nullable && !field.dbGenerated) missing = added(missing, field);
      continue;
    }
    written[i] = value;
    columns.push(field);
    values.push(value);
  }
  if (missing !== undefined) return failure(blank(prepared, missing));

  const adapter = core.adapter;
  const capabilities = adapter.capabilities;
  // An upsert reads the whole row back: the row it updated may hold other values than these.
  const back = capabilities.returning
    ? returningFields(schemaMeta, table.insertBack, isUpsert(settings.onConflict) ? true : settings.returning)
    : NONE;
  const schema = writeSchema(core, settings.options, schemaMeta.schema);
  const plan = adapter.compileInsert(
    schemaMeta,
    columns,
    { source: ONE_ROW, returning: back, onConflict: settings.onConflict },
    schema,
  );
  for (const value of settings.conflictParams) values.push(value);
  const bound = bindFields(plan, values, schemaMeta, columns);

  let result: Written;
  let reread: Readonly<Record<string, unknown>> | undefined;
  try {
    if (capabilities.returning || !needsReread(schemaMeta, table, settings)) {
      result = await runWrite(
        core,
        core.executor,
        "insert",
        schemaMeta.source as string,
        plan,
        bound,
        settings.options,
        undefined,
        decodeWritten,
        schemaMeta.name,
      );
    } else {
      [result, reread] = await insertThenRead(
        core,
        prepared.model as AnySchema,
        schemaMeta,
        plan,
        bound,
        settings,
        written,
      );
    }
  } catch (error) {
    if (isConstraintError(error))
      return failure(handleViolation(prepared, error, "insert", identifierLimit(core)));
    throw error;
  }
  // An upsert read back has its row even when the database reports none written (MySQL
  // counts an existing row that the update left as it was as no row).
  if (result.rowCount === 0 && reread === undefined) {
    if (settings.onConflict === "nothing") return success(null);
    throw new QueryError("query.insertNoRow", `The insert into ${schemaMeta.name} reported no row written.`);
  }
  const returned = result.returned ?? reread ?? insertIdRow(schemaMeta, result.insertId);
  const rowValues: unknown[] = new Array(persisted.length);
  for (let i = 0; i < persisted.length; i++) {
    const field = persisted[i] as FieldMeta;
    if (returned !== undefined && hasOwn(returned, field.name)) rowValues[i] = returned[field.name];
    else if (written[i] !== undefined) rowValues[i] = written[i];
    else rowValues[i] = field.nullable ? null : undefined;
  }
  return success(buildRow(schemaMeta, rowValues, schemaMeta.rowMeta("loaded", plan.schema), null, changes));
}

/**
 * Whether an insert on a dialect without `RETURNING` must read the row back: when a field
 * the database fills, other than a single generated key, exists, or the call asked for
 * fields back.
 */
function needsReread(schemaMeta: SchemaMeta, table: WriteTable, settings: WriteSettings): boolean {
  if (settings.returning !== undefined || isUpsert(settings.onConflict)) return true;
  const key = schemaMeta.primaryKey;
  return table.insertBack.some((field) => !(key.length === 1 && field === key[0]));
}

function isUpsert(onConflict: OnConflict | undefined): boolean {
  return onConflict !== undefined && onConflict !== "nothing";
}

/** The key the database reported for the insert (`insertId`), as a returned row; `undefined` when there is none. */
function insertIdRow(
  schemaMeta: SchemaMeta,
  insertId: bigint | number | undefined,
): Readonly<Record<string, unknown>> | undefined {
  const key = schemaMeta.primaryKey;
  if (insertId === undefined || key.length !== 1) return undefined;
  const field = key[0] as FieldMeta;
  if (!field.dbGenerated) return undefined;
  const cast = field.type.cast(insertId);
  return { [field.name]: cast.success ? cast.data : insertId };
}

/**
 * On a dialect without `RETURNING`: runs the insert and reads the row back by its key on
 * the same connection (a generated key is reported for that connection only). An upsert
 * and its read-back are one unit (a transaction, or a savepoint inside one): when the
 * updated row cannot be read back by the key it was given, the update is undone before
 * the error is thrown.
 */
async function insertThenRead(
  core: ReadCore,
  model: AnySchema,
  schemaMeta: SchemaMeta,
  plan: CompiledQuery,
  bound: readonly unknown[],
  settings: WriteSettings,
  written: readonly unknown[],
): Promise<[Written, Readonly<Record<string, unknown>> | undefined]> {
  const deadline = deadlineOf(settings.options);
  const args = [model, schemaMeta, plan, bound, settings, written, deadline] as const;
  if (isUpsert(settings.onConflict)) {
    return atomically(core, settings.options, deadline, (executor) => writeThenRead(core, executor, ...args));
  }
  const connection = core.pooled ? await acquireWithin(core, settings.options, deadline) : undefined;
  try {
    return await writeThenRead(core, connection ?? core.executor, ...args);
  } finally {
    if (connection !== undefined) await connection.release();
  }
}

/** The insert and the read-back of {@link insertThenRead}, on one executor. */
async function writeThenRead(
  core: ReadCore,
  executor: Executor,
  model: AnySchema,
  schemaMeta: SchemaMeta,
  plan: CompiledQuery,
  bound: readonly unknown[],
  settings: WriteSettings,
  written: readonly unknown[],
  deadline: number | undefined,
): Promise<[Written, Readonly<Record<string, unknown>> | undefined]> {
  const result = await runWrite(
    core,
    executor,
    "insert",
    schemaMeta.source as string,
    plan,
    bound,
    settings.options,
    deadline,
    decodeWritten,
    schemaMeta.name,
  );
  if (result.rowCount === 0 && !isUpsert(settings.onConflict)) return [result, undefined];
  const generated = insertIdRow(schemaMeta, result.insertId);
  const key: Record<string, unknown> = {};
  for (const field of schemaMeta.primaryKey) {
    key[field.name] =
      generated !== undefined && hasOwn(generated, field.name)
        ? generated[field.name]
        : written[writeTable(schemaMeta).positions.get(field) as number];
  }
  let query = from(model, "t").where(key as never);
  if (plan.schema !== undefined) query = query.schema(plan.schema);
  const reader = new ReadCore(core.adapter, executor, core.schema, core.codegen, core.hub);
  const options: ReadOptions = {
    schema: undefined,
    timeoutMs: remaining(settings.options, deadline),
    signal: own(settings.options, "signal"),
    context: own(settings.options, "context"),
  };
  let rows: readonly unknown[];
  try {
    rows = await load(reader, "insert", query.ast, undefined, options);
  } catch (error) {
    // The read plan is an ordinary read's, shared with other queries, so its decoder cannot
    // say that a write came first: the error is re-thrown here with that said. An upsert and
    // its read-back are one unit (see insertThenRead), which this error undoes; a plain
    // insert stays.
    if (error instanceof CastError) {
      throw rewrap(error, (short) => `${short}${isUpsert(settings.onConflict) ? UNDONE : WRITTEN}`);
    }
    throw error;
  }
  const row = rows[0] as Readonly<Record<string, unknown>> | undefined;
  if (row === undefined && isUpsert(settings.onConflict)) {
    // The update hit a row with another key (a conflict on another unique field), and a
    // database without RETURNING does not say which.
    throw new QueryError(
      "query.upsertUnreadable",
      `The upsert into ${schemaMeta.name} met a row that could not be read back by the key it was given: the conflict was on another unique field, and ${core.adapter.dialect} does not report which row it updated.`,
    );
  }
  return [result, row];
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

/**
 * `repo.update`: writes the changes of a changeset of a loaded row.
 *
 * @throws TypeError, QueryError for misuse; StaleEntryError when no row matched (unless
 * `allowStale` or `staleError`); ConstraintError for an undeclared violation.
 */
export async function update(
  core: ReadCore,
  repo: unknown,
  given: unknown,
  options: unknown,
  method = "update",
  keys: readonly string[] = UPDATE_OPTION_KEYS,
): Promise<Result<object, AnyChangeset>> {
  const schemaMeta = changesetMeta(given, method);
  const changeset = given as AnyChangeset;
  const row = loadedRow(changeset, schemaMeta, method);
  const nested = hasAssocChanges(changeset, schemaMeta, method);
  const settings = writeSettings(schemaMeta, method, options, keys);
  if (!changeset.valid) return failure(withAction(changeset, "update"));
  if (nested) {
    return writeNested(core, repo, changeset, schemaMeta, settings, "update", method, false) as Promise<
      Result<object, AnyChangeset>
    >;
  }
  const prepared = runPrepare(changeset, "update", repo);
  if (!prepared.valid) return failure(prepared);
  if (hasAssocChanges(prepared, schemaMeta, method)) {
    return writeNested(core, repo, prepared, schemaMeta, settings, "update", method, true) as Promise<
      Result<object, AnyChangeset>
    >;
  }
  const write = settings.force ? prepared : withoutLoneLockBump(prepared, schemaMeta);
  return updateRow(core, schemaMeta, row, write, settings, method);
}

/** Whether `values` has an own key, without making the array of them. */
function hasKeys(values: Readonly<Record<string, unknown>>): boolean {
  for (const name in values) if (hasOwn(values, name)) return true;
  return false;
}

/**
 * The changeset without its optimistic-lock bumps when they are all the update would
 * write: when every other change is to a virtual field or a field that may not be
 * updated, an unchanged save sends nothing and leaves the version (and `updatedAt`)
 * alone. The bumps are recognised by their fields, the keys of `filters`, after every
 * prepare function has run, so a change a prepare function makes still counts whichever
 * order it was registered in. `force` keeps the bump (the caller does not call this),
 * and so does a parent written with association changes, which the nested writes send
 * through {@link updateRow} directly.
 */
function withoutLoneLockBump(prepared: AnyChangeset, schemaMeta: SchemaMeta): AnyChangeset {
  const filters = prepared.filters;
  if (!hasKeys(filters)) return prepared;
  const changes = prepared.changes as Readonly<Record<string, unknown>>;
  const names = Object.keys(changes);
  let bumped = false;
  for (const name of names) {
    if (hasOwn(filters, name)) {
      bumped = true;
      continue;
    }
    const field = schemaMeta.fieldsByName.get(name);
    if (field === undefined || (!field.virtual && field.writable === "always")) return prepared;
  }
  if (!bumped) return prepared;
  const kept: Record<string, unknown> = {};
  for (const name of names) if (!hasOwn(filters, name)) kept[name] = changes[name];
  return rebuild(prepared, { changes: kept });
}

/**
 * The statement of an update, after the checks and the prepare functions; the nested
 * writes call it for a parent whose association changes they have taken out.
 *
 * @throws QueryError, StaleEntryError, ConstraintError, DatabaseError as {@link update} does.
 */
export async function updateRow(
  core: ReadCore,
  schemaMeta: SchemaMeta,
  row: Record<string, unknown>,
  prepared: AnyChangeset,
  settings: WriteSettings,
  method: string,
): Promise<Result<object, AnyChangeset>> {
  if (!settings.force && Object.keys(prepared.changes).length === 0) return success(row);
  const blankEmbeds = schemaMeta.embeds.length === 0 ? undefined : missingEmbedded(prepared);
  if (blankEmbeds !== undefined) return failure(blankEmbeds as AnyChangeset);
  const changes =
    schemaMeta.embeds.length === 0
      ? (prepared.changes as Readonly<Record<string, unknown>>)
      : embedChanges(prepared, "loaded");

  const table = writeTable(schemaMeta);
  const persisted = schemaMeta.persisted;
  const set: FieldMeta[] = [];
  const values: unknown[] = [];
  const written: unknown[] = new Array(persisted.length);
  const isSet: boolean[] = new Array(persisted.length).fill(false);
  // A change never holds null for a non-nullable field: the changeset reports that itself.
  for (let i = 0; i < persisted.length; i++) {
    const field = persisted[i] as FieldMeta;
    if (field.writable !== "always" || !hasOwn(changes, field.name)) continue;
    const value = changes[field.name];
    written[i] = value;
    isSet[i] = true;
    set.push(field);
    values.push(value);
  }
  if (set.length > 0 || settings.force) {
    const generated: unknown[] = [];
    for (let i = 0; i < persisted.length; i++) {
      const field = persisted[i] as FieldMeta;
      if (!table.onUpdate[i] || field.writable !== "always" || hasOwn(changes, field.name)) continue;
      written[i] = generatedValue(table, field, i, generated);
      isSet[i] = true;
      set.push(field);
      values.push(written[i]);
    }
  }
  const rowSchema = (row as unknown as { readonly [ROW]: RowMeta })[ROW].schema;
  const after: Updated = { schemaMeta, row, changes, written, isSet };
  // Nothing to write: only virtual fields, or fields that may not be updated, changed.
  if (set.length === 0) return success(updatedRow(after, undefined, rowSchema));

  const where: FieldMeta[] = [];
  for (const field of schemaMeta.primaryKey) {
    where.push(field);
    values.push(row[field.name]);
  }
  const filters = prepared.filters;
  for (const name of Object.keys(filters)) {
    where.push(persistedField(schemaMeta, name, `repo.${method}(): the optimistic lock`));
    values.push(filters[name]);
  }
  const adapter = core.adapter;
  const back = adapter.capabilities.returning
    ? returningFields(schemaMeta, table.updateBack, settings.returning)
    : NONE;
  const plan = adapter.compileUpdate(
    schemaMeta,
    set,
    where,
    back,
    writeSchema(core, settings.options, rowSchema),
  );
  let result: Written;
  try {
    result = await runWrite(
      core,
      core.executor,
      "update",
      schemaMeta.source as string,
      plan,
      bindFields(plan, values, schemaMeta, set),
      settings.options,
      undefined,
      decodeWritten,
      schemaMeta.name,
    );
  } catch (error) {
    if (isConstraintError(error))
      return failure(handleViolation(prepared, error, "update", identifierLimit(core)));
    throw error;
  }
  if (result.rowCount === 0) {
    const stale = staleOutcome(prepared, schemaMeta, "update", settings);
    if (stale !== undefined) return stale;
  }
  return success(updatedRow(after, result.returned, plan.schema));
}

/** What the row of an update is built from. */
interface Updated {
  readonly schemaMeta: SchemaMeta;
  readonly row: Readonly<Record<string, unknown>>;
  readonly changes: Readonly<Record<string, unknown>>;
  /** The values set, by index in `persisted`. */
  readonly written: readonly unknown[];
  readonly isSet: readonly boolean[];
}

/** The row after an update: the values returned, else the values set, else the row's own. */
function updatedRow(
  after: Updated,
  returned: Readonly<Record<string, unknown>> | undefined,
  schema: string | undefined,
): object {
  const { schemaMeta, row } = after;
  const persisted = schemaMeta.persisted;
  const rowValues: unknown[] = new Array(persisted.length);
  for (let i = 0; i < persisted.length; i++) {
    const field = persisted[i] as FieldMeta;
    if (returned !== undefined && hasOwn(returned, field.name)) rowValues[i] = returned[field.name];
    else if (after.isSet[i]) rowValues[i] = after.written[i];
    else rowValues[i] = row[field.name];
  }
  return buildRow(schemaMeta, rowValues, schemaMeta.rowMeta("loaded", schema), row, after.changes);
}

/** A copy of a row in the `deleted` state. */
function deletedRow(
  schemaMeta: SchemaMeta,
  row: Readonly<Record<string, unknown>>,
  schema: string | undefined,
): object {
  const rowValues: unknown[] = [];
  for (const field of schemaMeta.persisted) rowValues.push(row[field.name]);
  return buildRow(schemaMeta, rowValues, schemaMeta.rowMeta("deleted", schema), row, NO_CHANGES);
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

const NO_CHANGES: Readonly<Record<string, unknown>> = /* @__PURE__ */ Object.freeze({});

/**
 * `repo.delete`: deletes a loaded row, given as itself or as a changeset of it.
 *
 * @throws TypeError, QueryError for misuse; StaleEntryError when no row matched (unless
 * `allowStale` or `staleError`); ConstraintError for an undeclared violation.
 */
export async function remove(
  core: ReadCore,
  repo: unknown,
  given: unknown,
  options: unknown,
): Promise<Result<object, AnyChangeset>> {
  let target = given;
  if (!(given instanceof Changeset)) {
    if (!isRow(given)) {
      throw new TypeError(
        `repo.delete() takes a row read from the database, or a changeset of one; it was given ${describe(given)}.`,
      );
    }
    target = change(given as object);
  }
  const schemaMeta = changesetMeta(target, "delete");
  const changeset = target as AnyChangeset;
  const row = loadedRow(changeset, schemaMeta, "delete");
  const settings = writeSettings(schemaMeta, "delete", options, DELETE_OPTION_KEYS);
  if (!changeset.valid) return failure(withAction(changeset, "delete"));
  const prepared = runPrepare(changeset, "delete", repo);
  if (!prepared.valid) return failure(prepared);

  const where: FieldMeta[] = [];
  const values: unknown[] = [];
  for (const field of schemaMeta.primaryKey) {
    where.push(field);
    values.push(row[field.name]);
  }
  const filters = prepared.filters;
  for (const name of Object.keys(filters)) {
    where.push(persistedField(schemaMeta, name, "repo.delete(): the optimistic lock"));
    values.push(filters[name]);
  }
  const rowSchema = (row as unknown as { readonly [ROW]: RowMeta })[ROW].schema;
  const plan = core.adapter.compileDelete(
    schemaMeta,
    where,
    NONE,
    writeSchema(core, settings.options, rowSchema),
  );
  let result: Written;
  try {
    result = await runWrite(
      core,
      core.executor,
      "delete",
      schemaMeta.source as string,
      plan,
      bindParams(plan.slots, values),
      settings.options,
      undefined,
      decodeWritten,
      schemaMeta.name,
    );
  } catch (error) {
    if (isConstraintError(error))
      return failure(handleViolation(prepared, error, "delete", identifierLimit(core)));
    throw error;
  }
  if (result.rowCount === 0) {
    const stale = staleOutcome(prepared, schemaMeta, "delete", settings);
    if (stale !== undefined) return stale;
  }
  return success(deletedRow(schemaMeta, row, plan.schema));
}

// ---------------------------------------------------------------------------
// insertOrUpdate and the throwing twins
// ---------------------------------------------------------------------------

/**
 * `repo.insertOrUpdate`: inserts a changeset of a new record, updates one of a loaded row.
 * The database is not asked whether the row exists.
 *
 * @throws as {@link insert} and {@link update} do.
 */
export async function insertOrUpdate(
  core: ReadCore,
  repo: unknown,
  given: unknown,
  options: unknown,
): Promise<Result<object | null, AnyChangeset>> {
  if (!(given instanceof Changeset)) {
    throw new TypeError(
      `repo.insertOrUpdate() takes a changeset: of a new record to insert, of a loaded row to update. It was given ${describe(given)}.`,
    );
  }
  return (given as AnyChangeset).data === null
    ? insert(core, repo, given, options, "insertOrUpdate", INSERT_OR_UPDATE_OPTION_KEYS)
    : update(core, repo, given, options, "insertOrUpdate", INSERT_OR_UPDATE_OPTION_KEYS);
}

/**
 * The data of a successful result; for a failure, throws `InvalidChangesetError` with the
 * changeset.
 *
 * @throws InvalidChangesetError for a failure.
 */
export function orThrow<T>(result: Result<T, AnyChangeset>, action: string): T {
  if (result.success) return (result as Success<T>).data;
  const changeset = (result as Failure<AnyChangeset>).error;
  throw new InvalidChangesetError({ action: changeset.action ?? action, changeset });
}

// ---------------------------------------------------------------------------
// validateUniqueAsync
// ---------------------------------------------------------------------------

interface ExistsRepo {
  exists(query: unknown): Promise<boolean>;
}

function isRepo(value: unknown): value is ExistsRepo {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly exists?: unknown }).exists === "function" &&
    typeof (value as { readonly insert?: unknown }).insert === "function"
  );
}

/** A binding of the query `validateUniqueAsync` runs: its columns by field name. */
type Columns = Readonly<Record<string, Col<unknown>>>;

type Condition = Expr<boolean, SomeParams>;

function allOf(conditions: readonly Condition[]): Condition {
  return conditions.length === 1
    ? (conditions[0] as Condition)
    : (and(...(conditions as [Condition, ...Condition[]])) as Condition);
}

/**
 * The implementation of `cs.validateUniqueAsync(fields, repo, options)`: when one of the
 * fields changed, all have a value and neither they nor `errorKey` has an error, asks the
 * database whether another row (not the changeset's own) has these values, and adds `has
 * already been taken` (`validation: "uniqueAsync"`) when one does.
 *
 * @throws TypeError (as a rejection) when `repo` is not a repo.
 */
export async function validateUnique(
  changeset: AnyChangeset,
  fields: readonly string[],
  repo: unknown,
  options: { readonly message?: unknown; readonly errorKey?: string } | undefined,
): Promise<AnyChangeset> {
  if (!isRepo(repo)) {
    throw new TypeError(
      "validateUniqueAsync(fields, repo): repo must be the repo to query, as createRepo() returns it (or a transaction's repo).",
    );
  }
  const model = changeset.model;
  if (model === null) {
    throw new QueryError(
      "query.uniqueAsyncSchemaless",
      "validateUniqueAsync(): this changeset has no schema class, so there is no table to look in.",
    );
  }
  if (fields.length === 0) {
    throw new QueryError(
      "query.uniqueAsyncFields",
      "validateUniqueAsync() takes a field name or a non-empty list of them.",
    );
  }
  const changes = changeset.changes as Readonly<Record<string, unknown>>;
  if (!fields.some((field) => hasOwn(changes, field))) return changeset;
  if (fields.some((field) => hasOwn(changeset.errors, field))) return changeset;
  // One message per key: an error already on errorKey stands, so the database is not asked.
  const key = own(options, "errorKey") ?? (fields[0] as string);
  if (hasOwn(changeset.errors, key)) return changeset;
  const values = fields.map((field) => changeset.getField(field));
  if (values.some((value) => value === null || value === undefined)) return changeset;
  const schemaMeta = meta(model);
  const data = changeset.data as Readonly<Record<string, unknown>> | null;
  const where = (bindings: { readonly t: Columns }): Condition => {
    const t = bindings.t;
    const same: Condition[] = fields.map((field, i) => (t[field] as Col<unknown>).eq(values[i] as never));
    if (data !== null && schemaMeta.primaryKey.length > 0) {
      const itself = schemaMeta.primaryKey.map((field) =>
        (t[field.name] as Col<unknown>).eq(data[field.name] as never),
      );
      same.push(not(allOf(itself)) as Condition);
    }
    return allOf(same);
  };
  let query = from(model, "t").where(where as never);
  // A loaded row is looked for where it was read, as its update would be written.
  const rowSchema = data !== null && isRow(data) ? data[ROW].schema : undefined;
  if (rowSchema !== undefined) query = query.schema(rowSchema);
  if (!(await repo.exists(query))) return changeset;
  const errorMeta = { fields: [...fields] };
  const message = own(options, "message");
  const text =
    typeof message === "function"
      ? String((message as (meta: Readonly<Record<string, unknown>>) => unknown)(errorMeta))
      : typeof message === "string"
        ? message
        : "has already been taken";
  return withErrors(changeset, key, [{ message: text, validation: "uniqueAsync", meta: errorMeta }]);
}

/** Registers {@link validateUnique} as the implementation of `validateUniqueAsync`. Idempotent. */
export function provideUniqueCheck(): void {
  provideValidateUniqueAsync(validateUnique as never);
}
