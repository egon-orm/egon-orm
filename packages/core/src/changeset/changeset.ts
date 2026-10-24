/**
 * The `Changeset`: a description of a change to one record, built from untrusted params
 * (`cast`) or trusted values (`change`), validated, and carrying the constraint
 * declarations the repo uses to turn a database violation into an error.
 *
 * Every method returns a new changeset that shares every member it did not change with
 * the one it was called on (copy-on-write). A validation that passes allocates the new
 * changeset and one entry of the validation list, nothing else. `valid` is stored, never
 * recomputed.
 *
 * @module
 */
import type { Action, ChangesetError, ChangesetLike, Constraint, Validator } from "../contracts/changeset.js";
import type { Failure, Result, Success } from "../contracts/result.js";
import type { AnyFieldBuilder, AnySchema, AssocMeta, FieldMeta, Row, RowMeta } from "../contracts/schema.js";
import { ROW } from "../contracts/schema.js";
import { InvalidChangesetError, QueryError } from "../errors.js";
import { deepEqual } from "../internal/deep-equal.js";
import { distinct } from "../internal/distinct.js";
import { formatStruct, formatValue, redactFields } from "../internal/inspect.js";
import { own } from "../internal/own.js";
import { meta } from "../schema/index.js";
import { fieldConverter, fieldValueJson, jsonValue, safeJsonValue } from "../schema/json.js";
import { booleanType } from "../types/index.js";
import { codepoints, graphemes, utf8Bytes } from "./measure.js";
import { castRelation, putRelation } from "./nested/change.js";
import { embedValue } from "./nested/embed.js";
import type {
  AssocTarget,
  CastNestedArgs,
  EmbedName,
  EmbedTarget,
  PutAssocValue,
  PutEmbedValue,
} from "./nested/types.js";
import type { Spec } from "./spec.js";
import { fieldOf, paramsOf, startOf } from "./spec.js";
import type {
  AppliedData,
  AssocName,
  CastOptions,
  Changes,
  ChangesetData,
  ChangesetModel,
  ChangesetSource,
  ChangeValidatorError,
  ChangeValidatorResult,
  CheckConstraintOptions,
  ConfirmationOptions,
  ConstraintOptions,
  ErrorFormatter,
  ErrorMessages,
  ErrorTree,
  ErrorTreeOf,
  FieldName,
  FieldOfType,
  FieldValues,
  LengthOptions,
  MessageOption,
  MessageOptions,
  NumberOptions,
  RequiredOptions,
  RowSchema,
  SchemalessTarget,
  UniqueAsyncOptions,
  ValidationEntry,
} from "./types.js";
import type { FieldValidator, ValidateOptions } from "./validators/types.js";
import {
  validateChangeset,
  validateChangesetAsync,
  validateFieldOf,
  validateFieldOfAsync,
} from "./validators/validate.js";

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** Changeset `C` with `K` added to the error keys it records. */
type WithErrorKey<C, K extends string> =
  C extends Changeset<infer S, infer N, infer E> ? Changeset<S, N, E | K> : C;

/** Proves that a constructor call comes from this module. */
const TOKEN: unique symbol = /* @__PURE__ */ Symbol("changeset");
/** Node's `util.inspect.custom`, looked up by name: no import of `node:util`. */
const INSPECT: unique symbol = /* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom");

type Errors = Readonly<Record<string, readonly ChangesetError[]>>;
type Values = Readonly<Record<string, unknown>>;

/**
 * One validation that ran, in a list linked backwards: appending one costs one object.
 * `cs.validations` turns the list into entries when it is first read.
 */
interface ValidationNode {
  /** One field, or the list `validateRequired` was given (one entry each). */
  readonly field: string | readonly string[];
  /** The validation's name; `undefined` when `options` is the whole descriptor. */
  readonly validation: string | undefined;
  readonly options: object | undefined;
  /** The validation's main argument (a pattern, a list of values), under `argumentKey` in the descriptor. */
  readonly argumentKey: string | undefined;
  readonly argument: unknown;
  readonly prev: ValidationNode | null;
}

/** A function `prepareChanges` registered: run by the repo just before the write. */
/**
 * A function `prepareChanges` registered: run by the repo just before the write, with
 * the changeset, returning the changeset to write. Stored without its type parameters;
 * the public member `prepare` gives them back.
 */
type PrepareFn = (changeset: never) => unknown;

const EMPTY: Values = /* @__PURE__ */ Object.freeze({});
const NO_ERRORS: Errors = /* @__PURE__ */ Object.freeze({});
const NO_CONSTRAINTS: readonly Constraint[] = /* @__PURE__ */ Object.freeze([]);
const NO_PREPARE: readonly PrepareFn[] = /* @__PURE__ */ Object.freeze([]);
const NO_ISSUES: readonly ChangesetError[] = /* @__PURE__ */ Object.freeze([]);
const DEFAULT_EMPTY_VALUES: readonly unknown[] = /* @__PURE__ */ Object.freeze([""]);
const ACTIONS: ReadonlySet<unknown> = /* @__PURE__ */ new Set<Action>([
  "insert",
  "update",
  "delete",
  "replace",
  "ignore",
]);

const BLANK = "can't be blank";
/** The error for a `null` given to a field that is not nullable. Shared: errors are plain values. */
const NOT_NULL: ChangesetError = /* @__PURE__ */ Object.freeze({
  message: BLANK,
  validation: "required",
  meta: /* @__PURE__ */ Object.freeze({}),
});

/**
 * A function given to `prepareChanges`: the repo calls it with the changeset just before
 * the write and writes the changeset it returns.
 *
 * @example
 * ```ts
 * const stamp: PrepareFunction<typeof Post, boolean> = (cs) => cs.putChange("slug", "launch");
 * ```
 */
export type PrepareFunction<S extends ChangesetSource, New extends boolean> = (
  changeset: Changeset<S, New>,
) => Changeset<S, New>;

/** The `data` member: `null` for a new record. */
type DataMember<S, New extends boolean> = New extends true ? null : ChangesetData<S>;

/**
 * `unknown` unless the changeset is certainly of a new record, in which case it requires
 * a member no changeset has: calling the method is then a compile error whose message
 * names the reason.
 */
type NotNewRecord<New extends boolean> = [New] extends [true]
  ? {
      readonly "a new record has no row: applyChanges() and applyAction() need a changeset of a loaded row": never;
    }
  : unknown;

// Functions with access to the private members, assigned by the class's static block.
let construct: (
  spec: Spec,
  data: object | null,
  params: Values | null,
  changes: Values,
  errors: Errors,
  valid: boolean,
  action: Action | null,
  node: ValidationNode | null,
  constraints: readonly Constraint[],
  filters: Values,
  prepare: readonly PrepareFn[],
  repo: unknown,
) => AnyChangeset;
let specOf: (changeset: AnyChangeset) => Spec;
let nodeOf: (changeset: AnyChangeset) => ValidationNode | null;

/** A changeset of any source, as internal code handles it. */
type AnyChangeset = Changeset<ChangesetSource, boolean>;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const hasOwn = Object.hasOwn;

/** The value a new record has for `field`: its default (a function default is called), `null` when nullable. */
function initialValue(field: FieldMeta): unknown {
  const fallback = field.default;
  if (fallback !== undefined) return fallback.kind === "value" ? fallback.value : fallback.fn();
  return field.nullable ? null : undefined;
}

/** The value `field` has before the changes: in the data, or the new record's initial value. */
function currentValue(spec: Spec, data: object | null, field: FieldMeta): unknown {
  if (data === null) return initialValue(field);
  if (spec.model === null && !hasOwn(data, field.name)) return initialValue(field);
  return (data as Values)[field.name];
}

/** Whether two values of `field` are the same value, by the field's type. */
function same(field: FieldMeta, a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return field.type.equal(a, b);
}

function isBlank(value: unknown, trim: boolean): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string") return false;
  return trim ? !/\S/.test(value) : value === "";
}

function messageOf(option: MessageOption | undefined, fallback: string, meta: Values): string {
  if (option === undefined) return fallback;
  if (typeof option === "string") return option;
  const message: unknown = option(meta);
  if (typeof message !== "string") {
    throw new QueryError(
      "query.messageFunctionResult",
      "A message function must return the message as a string.",
    );
  }
  return message;
}

function errorOf(message: string, validation: string | undefined, meta: Values): ChangesetError {
  return validation === undefined ? { message, meta } : { message, validation, meta };
}

function sameError(a: ChangesetError, b: ChangesetError): boolean {
  return (
    a === b ||
    (a.message === b.message &&
      a.validation === b.validation &&
      a.constraint === b.constraint &&
      deepEqual(a.meta, b.meta))
  );
}

/** Copies `object` without `key`. */
function without(object: Values, key: string): Values {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(object)) if (name !== key) out[name] = object[name];
  return out;
}

/** `errors` with `added` appended to `key`, leaving out errors equal to one already there. */
function appendErrors(
  errors: Errors,
  key: string,
  added: readonly ChangesetError[],
  dedupe: boolean,
): Errors {
  const existing = hasOwn(errors, key) ? (errors[key] as readonly ChangesetError[]) : undefined;
  const list = existing === undefined ? [] : [...existing];
  for (const error of added) {
    if (!dedupe || !list.some((other) => sameError(other, error))) list.push(error);
  }
  if (existing !== undefined && list.length === existing.length) return errors;
  return { ...errors, [key]: list };
}

/** A field name, or a list of them without repeats (a name listed twice is recorded once). */
function listed(names: string | readonly string[]): string | readonly string[] {
  return typeof names === "string" ? names : distinct(names);
}

function checkErrorKey(key: unknown, fn: string): string {
  if (typeof key !== "string" || key === "" || key === "__proto__") {
    throw new QueryError(
      "query.errorKey",
      `${fn}(): the error key must be a non-empty string other than "__proto__".`,
    );
  }
  return key;
}

function checkMessage(message: unknown, fn: string): void {
  if (message !== undefined && typeof message !== "string" && typeof message !== "function") {
    throw new QueryError(
      "query.messageOption",
      `${fn}(): message must be a string or a function that returns one.`,
    );
  }
}

// ---------------------------------------------------------------------------
// The class
// ---------------------------------------------------------------------------

/**
 * A change to one record: which values were accepted, what changed, what is wrong, and
 * which database constraints to watch for. Immutable and synchronous; it never touches
 * the database. Make one with {@link cast} or {@link change}: there is no public
 * constructor.
 *
 * `S` is the schema class (or, for a changeset without one, `{ data, types }`). `New` is
 * `true` for a new record, `false` for a changeset of a loaded row, and `boolean` when
 * either is possible (a changeset function that takes `User | typeof User`). `E` collects
 * the error keys that are not fields, as validations add them (`validateConfirmation`'s
 * `passwordConfirmation`, a key given to `addError`), so that `errorMessages()` is typed
 * with them.
 *
 * @example
 * ```ts
 * const cs = cast(User, params, ["email", "name", "age"])
 *   .validateRequired(["email"])
 *   .validateFormat("email", /^[^@\s]+@[^@\s]+$/)
 *   .validateLength("name", { min: 2, max: 80 })
 *   .validateNumber("age", { greaterThanOrEqualTo: 13 })
 *   .uniqueConstraint("email");
 *
 * cs.valid; // boolean
 * cs.changes; // { email?: string; name?: string | null; age?: number | null }
 * cs.errorMessages(); // { email: ["can't be blank"] }
 * ```
 */
export class Changeset<
  S extends ChangesetSource = AnySchema,
  New extends boolean = boolean,
  E extends string = never,
> implements ChangesetLike<DataMember<S, New>>
{
  /**
   * Type-only; never set at runtime. Records `E`, the error keys validations added. Typed
   * as a method's parameter, which is compared both ways, so that a changeset with extra
   * keys still fits wherever a changeset of its schema is expected.
   */
  declare readonly "~errorKeys"?: { check(keys: E): void }["check"];
  /** The schema class; `null` for a changeset without one. */
  readonly model: ChangesetModel<S>;
  /** The loaded row (or, without a schema class, the data object); `null` for a new record. */
  readonly data: DataMember<S, New>;
  /**
   * The params given to `cast`, as given (merged when a changeset is cast again); `null`
   * for a changeset made with `change`. They may hold values of redacted fields, and are
   * never shown by inspect or `toJSON`.
   */
  readonly params: Readonly<Record<string, unknown>> | null;
  /** The changed fields and their new values. */
  readonly changes: Changes<S>;
  /** The errors, by field (or other key, such as `passwordConfirmation`). */
  readonly errors: Readonly<Record<string, readonly ChangesetError[]>>;
  /** Whether there are no errors. Stored, not recomputed. */
  readonly valid: boolean;
  /** What the changeset is used for; set by the repo or by {@link applyAction}. */
  readonly action: Action | null;
  /** The constraint declarations, in the order they were made. */
  readonly constraints: readonly Constraint[];
  /** Values the row must still have in the database for an update or delete to apply (`optimisticLock`). */
  readonly filters: Readonly<Record<string, unknown>>;
  /** The functions `prepareChanges` registered, in order. The repo runs them just before the write. */
  readonly prepare: readonly PrepareFunction<S, New>[];
  /** The repo running the write, while `prepare` functions run; `null` otherwise. */
  readonly repo: unknown;

  readonly #spec: Spec;
  readonly #node: ValidationNode | null;
  #entries: readonly ValidationEntry[] | undefined;

  private constructor(
    token: symbol,
    spec: Spec,
    data: object | null,
    params: Values | null,
    changes: Values,
    errors: Errors,
    valid: boolean,
    action: Action | null,
    node: ValidationNode | null,
    constraints: readonly Constraint[],
    filters: Values,
    prepare: readonly PrepareFn[],
    repo: unknown,
  ) {
    if (token !== TOKEN) {
      throw new QueryError("query.changesetConstructor", "Changeset has no public constructor.");
    }
    this.model = spec.model as ChangesetModel<S>;
    this.data = data as DataMember<S, New>;
    this.params = params;
    this.changes = changes as Changes<S>;
    this.errors = errors;
    this.valid = valid;
    this.action = action;
    this.constraints = constraints;
    this.filters = filters;
    this.prepare = prepare as readonly PrepareFunction<S, New>[];
    this.repo = repo;
    this.#spec = spec;
    this.#node = node;
    this.#entries = undefined;
  }

  static {
    construct = (
      spec,
      data,
      params,
      changes,
      errors,
      valid,
      action,
      node,
      constraints,
      filters,
      prepare,
      repo,
    ) =>
      new Changeset(
        TOKEN,
        spec,
        data,
        params,
        changes,
        errors,
        valid,
        action,
        node,
        constraints,
        filters,
        prepare,
        repo,
      );
    specOf = (changeset) => changeset.#spec;
    nodeOf = (changeset) => changeset.#node;
  }

  /** A copy with other changes, errors and validity; everything else shared. */
  #with(changes: Values, errors: Errors, valid: boolean): this {
    return new Changeset(
      TOKEN,
      this.#spec,
      this.data,
      this.params,
      changes,
      errors,
      valid,
      this.action,
      this.#node,
      this.constraints,
      this.filters,
      this.prepare,
      this.repo,
    ) as this;
  }

  /** A copy that records one more validation, with other changes, errors and validity. */
  #validated(
    field: string | readonly string[],
    validation: string,
    options: object | undefined,
    changes: Values,
    errors: Errors,
    valid: boolean,
    argumentKey?: string,
    argument?: unknown,
  ): this {
    return new Changeset(
      TOKEN,
      this.#spec,
      this.data,
      this.params,
      changes,
      errors,
      valid,
      this.action,
      { field, validation, options, argumentKey, argument, prev: this.#node },
      this.constraints,
      this.filters,
      this.prepare,
      this.repo,
    ) as this;
  }

  /**
   * Records a validation; adds `error` on `key` when there is one and `key` has no error
   * yet (one message per field: the first failure stands).
   */
  #check(
    field: string,
    validation: string,
    options: object | undefined,
    key: string,
    error: ChangesetError | undefined,
    argumentKey?: string,
    argument?: unknown,
  ): this {
    if (error === undefined || hasOwn(this.errors, key)) {
      return this.#validated(
        field,
        validation,
        options,
        this.changes,
        this.errors,
        this.valid,
        argumentKey,
        argument,
      );
    }
    return this.#validated(
      field,
      validation,
      options,
      this.changes,
      appendErrors(this.errors, key, [error], false),
      false,
      argumentKey,
      argument,
    );
  }

  /** The changed value of `field`, or `undefined` when it has no change (or a change to `null`). */
  #changed(field: string): unknown {
    const changes = this.changes as Values;
    return hasOwn(changes, field) ? changes[field] : undefined;
  }

  // -------------------------------------------------------------------------
  // Changes
  // -------------------------------------------------------------------------

  /**
   * Sets a change. A value equal to the current one is not a change, and putting the
   * current value back removes the change. `null` on a field that is not nullable adds
   * `can't be blank` instead.
   *
   * @example
   * ```ts
   * change(user).putChange("name", "Ada").changes; // { name: "Ada" }
   * ```
   *
   * @throws QueryError when `field` is not a field, or `value` is `undefined`.
   */
  putChange<K extends FieldName<S>>(field: K, value: FieldValues<S>[K]): this {
    return this.#put(fieldOf(this.#spec, field, "putChange"), value, false, "putChange");
  }

  /**
   * Sets a change even when the value equals the current one.
   *
   * @example
   * ```ts
   * change(user).forceChange("name", user.name).changes; // { name: … }
   * ```
   *
   * @throws QueryError when `field` is not a field, or `value` is `undefined`.
   */
  forceChange<K extends FieldName<S>>(field: K, value: FieldValues<S>[K]): this {
    return this.#put(fieldOf(this.#spec, field, "forceChange"), value, true, "forceChange");
  }

  #put(field: FieldMeta, value: unknown, force: boolean, fn: string): this {
    if (value === undefined) {
      throw new QueryError(
        "query.putChangeUndefined",
        `${fn}("${field.name}", undefined): undefined is not a value.`,
        { params: { name: field.name } },
      );
    }
    if (this.#spec.embeds.has(field.name)) {
      throw new QueryError("query.putChangeEmbed", `${fn}(): "${field.name}" is an embed.`);
    }
    if (value === null && !field.nullable) {
      return this.#with(this.changes, appendErrors(this.errors, field.name, [NOT_NULL], true), false);
    }
    const changes = this.changes as Values;
    const name = field.name;
    if (!force && same(field, currentValue(this.#spec, this.data, field), value)) {
      return hasOwn(changes, name) ? this.#with(without(changes, name), this.errors, this.valid) : this;
    }
    if (hasOwn(changes, name) && changes[name] === value) return this;
    return this.#with({ ...changes, [name]: value }, this.errors, this.valid);
  }

  /**
   * Removes the change of a field, if it has one.
   *
   * @example
   * ```ts
   * cs.deleteChange("name").changes.name; // undefined
   * ```
   *
   * @throws QueryError when `field` is not a field.
   */
  deleteChange(field: FieldName<S>): this {
    fieldOf(this.#spec, field, "deleteChange");
    const changes = this.changes as Values;
    return hasOwn(changes, field) ? this.#with(without(changes, field), this.errors, this.valid) : this;
  }

  /**
   * Replaces the change of a field with `fn(change)`. Does nothing when the field has no
   * change. The result is set as by {@link Changeset.putChange}.
   *
   * @example
   * ```ts
   * cast(User, params, ["email"]).updateChange("email", (email) => email.trim().toLowerCase());
   * ```
   *
   * @throws QueryError when `field` is not a field, or `fn` returns `undefined`.
   */
  updateChange<K extends FieldName<S>>(field: K, fn: (value: FieldValues<S>[K]) => FieldValues<S>[K]): this {
    const meta = fieldOf(this.#spec, field, "updateChange");
    const changes = this.changes as Values;
    if (!hasOwn(changes, field)) return this;
    return this.#put(meta, fn(changes[field] as FieldValues<S>[K]), false, "updateChange");
  }

  /**
   * Combines this changeset with another of the same record: the other's changes win,
   * errors, validations, constraints, filters and `prepare` functions are joined, and the
   * result is valid only if both are.
   *
   * @example
   * ```ts
   * const profile = cast(user, params, ["name"]);
   * const login = cast(user, params, ["email"]).validateRequired(["email"]);
   * profile.merge(login).changes; // { name: …, email: … }
   * ```
   *
   * @throws QueryError when the changesets are not of the same record, or have different actions.
   */
  merge(other: Changeset<S, New>): this {
    if (!(other instanceof Changeset)) {
      throw new QueryError("query.mergeArgument", "merge() takes another changeset.");
    }
    const otherSpec = specOf(other);
    if (otherSpec !== this.#spec || other.data !== this.data) {
      throw new QueryError("query.mergeOtherRecord", "merge(): the changesets are not of the same record.");
    }
    if (this.action !== null && other.action !== null && this.action !== other.action) {
      throw new QueryError(
        "query.mergeActions",
        `merge(): the changesets have different actions ("${this.action}" and "${other.action}").`,
      );
    }
    let errors = this.errors;
    for (const key of Object.keys(other.errors)) {
      errors = appendErrors(errors, key, other.errors[key] as readonly ChangesetError[], true);
    }
    let node = this.#node;
    const chain: ValidationNode[] = [];
    for (let at = nodeOf(other); at !== null; at = at.prev) chain.push(at);
    for (let i = chain.length - 1; i >= 0; i--) {
      const at = chain[i] as ValidationNode;
      node = { ...at, prev: node };
    }
    return construct(
      this.#spec,
      this.data,
      this.params === null && other.params === null ? null : { ...this.params, ...other.params },
      { ...(this.changes as Values), ...(other.changes as Values) },
      errors,
      this.valid && other.valid,
      this.action ?? other.action,
      node,
      other.constraints.length === 0 ? this.constraints : [...this.constraints, ...other.constraints],
      { ...this.filters, ...other.filters },
      other.prepare.length === 0 ? this.prepare : [...this.prepare, ...other.prepare],
      this.repo ?? other.repo,
    ) as this;
  }

  /**
   * Applies `fn` to this changeset and returns what it returns: for steps of your own
   * that you reuse between changeset functions.
   *
   * @example
   * ```ts
   * const normalizeEmail = (cs: Changeset<typeof User>) =>
   *   cs.updateChange("email", (email) => email.trim().toLowerCase());
   *
   * cast(User, params, ["email"]).pipe(normalizeEmail);
   * ```
   */
  pipe<R>(fn: (changeset: this) => R): R {
    return fn(this);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * The value of a field: its change if it has one, else its value in the data; for a
   * new record, its default. `fallback` is returned where that is `undefined`.
   *
   * @example
   * ```ts
   * cast(User, {}, ["role"]).getField("role"); // "member", the default
   * ```
   *
   * @throws QueryError when `field` is not a field.
   */
  getField<K extends FieldName<S>>(field: K): FieldValues<S>[K];
  getField<K extends FieldName<S>, D>(field: K, fallback: D): FieldValues<S>[K] | D;
  getField(field: string, fallback?: unknown): unknown {
    const meta = fieldOf(this.#spec, field, "getField");
    const changes = this.changes as Values;
    const value = hasOwn(changes, field)
      ? this.#spec.embeds.has(field)
        ? embedValue(changes[field], "built")
        : changes[field]
      : currentValue(this.#spec, this.data, meta);
    return value === undefined ? fallback : value;
  }

  /**
   * The change of a field, or `fallback` (default `undefined`) when it has none.
   *
   * @example
   * ```ts
   * cast(User, { name: "Ada" }, ["name"]).getChange("name"); // "Ada"
   * ```
   *
   * @throws QueryError when `field` is not a field.
   */
  getChange<K extends FieldName<S>>(field: K): Changes<S>[K] | undefined;
  getChange<K extends FieldName<S>, D>(field: K, fallback: D): Exclude<Changes<S>[K], undefined> | D;
  getChange(field: string, fallback?: unknown): unknown {
    fieldOf(this.#spec, field, "getChange");
    const changes = this.changes as Values;
    return hasOwn(changes, field) ? changes[field] : fallback;
  }

  /**
   * Where the value of a field comes from, and the value: `{ from: "changes" }` when it
   * has a change, `{ from: "data" }` otherwise (a new record's default counts as data).
   * `undefined` when the field has no value at all.
   *
   * @example
   * ```ts
   * change(user, { name: "Ada" }).fetchField("name"); // { from: "changes", value: "Ada" }
   * ```
   *
   * @throws QueryError when `field` is not a field.
   */
  fetchField<K extends FieldName<S>>(
    field: K,
  ): { readonly from: "changes" | "data"; readonly value: FieldValues<S>[K] } | undefined {
    const meta = fieldOf(this.#spec, field, "fetchField");
    const changes = this.changes as Values;
    if (hasOwn(changes, field)) {
      const change = this.#spec.embeds.has(field) ? embedValue(changes[field], "built") : changes[field];
      return { from: "changes", value: change as FieldValues<S>[K] };
    }
    const value = currentValue(this.#spec, this.data, meta);
    return value === undefined ? undefined : { from: "data", value: value as FieldValues<S>[K] };
  }

  /**
   * `{ value }` when the field has a change, else `undefined`.
   *
   * @example
   * ```ts
   * change(user, { name: null }).fetchChange("name"); // { value: null }
   * ```
   *
   * @throws QueryError when `field` is not a field.
   */
  fetchChange<K extends FieldName<S>>(
    field: K,
  ): { readonly value: Exclude<Changes<S>[K], undefined> } | undefined {
    fieldOf(this.#spec, field, "fetchChange");
    const changes = this.changes as Values;
    return hasOwn(changes, field)
      ? { value: changes[field] as Exclude<Changes<S>[K], undefined> }
      : undefined;
  }

  /**
   * Whether a field has a change; with `from` and `to`, whether it changes from that
   * value (in the data) and to that value. Values are compared by the field's type.
   *
   * @example
   * ```ts
   * cs.isChanged("role", { from: "member", to: "admin" });
   * ```
   *
   * @throws QueryError when `field` is not a field.
   */
  isChanged<K extends FieldName<S>>(
    field: K,
    options?: { readonly from?: FieldValues<S>[K]; readonly to?: FieldValues<S>[K] },
  ): boolean {
    const meta = fieldOf(this.#spec, field, "isChanged");
    const changes = this.changes as Values;
    if (!hasOwn(changes, field)) return false;
    if (options === undefined) return true;
    if (hasOwn(options, "to") && !same(meta, changes[field], options.to)) return false;
    return !hasOwn(options, "from") || same(meta, currentValue(this.#spec, this.data, meta), options.from);
  }

  /**
   * Whether a field has no value, in the changes or the data: `undefined`, `null`, or a
   * string of only whitespace.
   *
   * @example
   * ```ts
   * cast(User, { name: "  " }, ["name"]).fieldMissing("name"); // true
   * ```
   *
   * @throws QueryError when `field` is not a field.
   */
  fieldMissing(field: FieldName<S>): boolean {
    return isBlank(this.getField(field), true);
  }

  /**
   * The data with the changes applied, without validating: a new row of the same class
   * (or, without a schema class, a new plain object). Associations loaded on the row are
   * kept.
   *
   * Not available on a new record: a row the database never returned cannot exist. It is
   * a compile error there, and throws if reached anyway.
   *
   * @example
   * ```ts
   * change(user, { name: "Ada" }).applyChanges().name; // "Ada"
   * ```
   *
   * @throws QueryError on a changeset of a new record.
   */
  applyChanges(this: Changeset<S, New> & NotNewRecord<New>): AppliedData<S> {
    return applied(this) as AppliedData<S>;
  }

  // -------------------------------------------------------------------------
  // Validations
  // -------------------------------------------------------------------------

  /**
   * Adds `can't be blank` to each field that has no value in the changes **or** the data:
   * `undefined`, `null`, or a string of only whitespace (`trim: false` counts only `""`).
   * A field that already has an error is skipped, and the change of a field found missing
   * is removed. A name listed twice is checked once.
   *
   * With no list, it checks every stored field that is not nullable and has no default,
   * no generator and no database-generated value.
   *
   * @example
   * ```ts
   * cast(User, { email: " " }, ["email"]).validateRequired(["email"]).errors;
   * // { email: [{ message: "can't be blank", validation: "required", meta: {} }] }
   * ```
   *
   * @throws QueryError when a name is not a field.
   */
  validateRequired(fields?: FieldName<S> | readonly FieldName<S>[], options?: RequiredOptions): this {
    const spec = this.#spec;
    // A single name is not wrapped in an array, so that a passing check allocates nothing.
    const names: string | readonly string[] = fields === undefined ? spec.requiredByDefault : fields;
    if (typeof names !== "string" && !Array.isArray(names)) {
      throw new QueryError(
        "query.requiredFields",
        "validateRequired() takes a field name or a list of them.",
      );
    }
    const message = own(options, "message");
    checkMessage(message, "validateRequired");
    const trim = own(options, "trim") !== false;
    const changes = this.changes as Values;
    let missing: string[] | undefined;
    const count = typeof names === "string" ? 1 : names.length;
    for (let i = 0; i < count; i++) {
      const name = typeof names === "string" ? names : (names[i] as string);
      const field = fieldOf(spec, name, "validateRequired");
      const value = hasOwn(changes, name) ? changes[name] : currentValue(spec, this.data, field);
      // A name listed twice is checked once: one error (owner decision, 2026-10-24).
      if (isBlank(value, trim) && !hasOwn(this.errors, name)) {
        if (missing === undefined) missing = [name];
        else if (!missing.includes(name)) missing.push(name);
      }
    }
    if (missing === undefined) {
      return this.#validated(listed(names), "required", options, changes, this.errors, this.valid);
    }
    const error = errorOf(messageOf(message, BLANK, EMPTY), "required", EMPTY);
    let nextChanges = changes;
    let errors = this.errors;
    for (const name of missing) {
      if (hasOwn(nextChanges, name)) nextChanges = without(nextChanges, name);
      errors = appendErrors(errors, name, [error], false);
    }
    return this.#validated(listed(names), "required", options, nextChanges, errors, false);
  }

  /**
   * Adds `has invalid format` when the change of a string field does not match `pattern`.
   *
   * @example
   * ```ts
   * cs.validateFormat("email", /^[^@\s]+@[^@\s]+$/);
   * ```
   *
   * @throws QueryError when `field` is not a field or `pattern` is not a regular expression.
   */
  validateFormat(field: FieldOfType<S, string>, pattern: RegExp, options?: MessageOptions): this {
    fieldOf(this.#spec, field, "validateFormat");
    if (!(pattern instanceof RegExp)) {
      throw new QueryError("query.formatPattern", "validateFormat() takes a regular expression.");
    }
    const message = own(options, "message");
    checkMessage(message, "validateFormat");
    const value = this.#changed(field);
    let error: ChangesetError | undefined;
    if (value !== undefined && value !== null) {
      if (typeof value !== "string") throw notOfType("validateFormat", field, "a string");
      // `search` ignores and restores `lastIndex`, so a global or sticky pattern behaves.
      if (value.search(pattern) === -1) {
        error = errorOf(messageOf(message, "has invalid format", EMPTY), "format", EMPTY);
      }
    }
    return this.#check(field, "format", options, field, error, "pattern", pattern);
  }

  /**
   * Adds `is invalid` when the change of a field is not one of `values` (compared by the
   * field's type).
   *
   * @example
   * ```ts
   * cs.validateInclusion("role", ["admin", "member"]);
   * ```
   *
   * @throws QueryError when `field` is not a field or `values` is not an array.
   */
  validateInclusion<K extends FieldName<S>>(
    field: K,
    values: readonly NonNullable<FieldValues<S>[K]>[],
    options?: MessageOptions,
  ): this {
    return this.#membership(field, values, options, "inclusion", true, "is invalid");
  }

  /**
   * Adds `is reserved` when the change of a field is one of `values`.
   *
   * @example
   * ```ts
   * cs.validateExclusion("name", ["admin", "root"]);
   * ```
   *
   * @throws QueryError when `field` is not a field or `values` is not an array.
   */
  validateExclusion<K extends FieldName<S>>(
    field: K,
    values: readonly NonNullable<FieldValues<S>[K]>[],
    options?: MessageOptions,
  ): this {
    return this.#membership(field, values, options, "exclusion", false, "is reserved");
  }

  #membership(
    name: string,
    values: readonly unknown[],
    options: MessageOptions | undefined,
    validation: "inclusion" | "exclusion",
    wanted: boolean,
    fallback: string,
  ): this {
    const fn = validation === "inclusion" ? "validateInclusion" : "validateExclusion";
    const field = fieldOf(this.#spec, name, fn);
    if (!Array.isArray(values))
      throw new QueryError("query.inclusionValues", `${fn}() takes the values as an array.`, {
        params: { fn },
      });
    const message = own(options, "message");
    checkMessage(message, fn);
    const value = this.#changed(name);
    let error: ChangesetError | undefined;
    if (value !== undefined && value !== null && includes(field, values, value) !== wanted) {
      const meta = { enum: values };
      error = errorOf(messageOf(message, fallback, meta), validation, meta);
    }
    return this.#check(name, validation, options, name, error, "values", values);
  }

  /**
   * Adds `has an invalid entry` when the change of an array field has an element that is
   * not one of `values`.
   *
   * @example
   * ```ts
   * cs.validateSubset("tagList", ["news", "howto", "release"]);
   * ```
   *
   * @throws QueryError when `field` is not a field or `values` is not an array.
   */
  validateSubset<K extends FieldOfType<S, readonly unknown[]>>(
    field: K,
    values: readonly ElementOf<FieldValues<S>[K & FieldName<S>]>[],
    options?: MessageOptions,
  ): this {
    fieldOf(this.#spec, field, "validateSubset");
    if (!Array.isArray(values))
      throw new QueryError("query.subsetValues", "validateSubset() takes the values as an array.");
    const message = own(options, "message");
    checkMessage(message, "validateSubset");
    const value = this.#changed(field);
    let error: ChangesetError | undefined;
    if (value !== undefined && value !== null) {
      if (!Array.isArray(value)) throw notOfType("validateSubset", field, "an array");
      for (const element of value) {
        if (!values.some((allowed) => allowed === element || deepEqual(allowed, element))) {
          const meta = { enum: values };
          error = errorOf(messageOf(message, "has an invalid entry", meta), "subset", meta);
          break;
        }
      }
    }
    return this.#check(field, "subset", options, field, error, "values", values);
  }

  /**
   * Checks the length of the change of a string or array field. A string is counted in
   * grapheme clusters by default (`count: "codepoints"` or `"bytes"` for the others), an
   * array in items. `is` is checked first, then `min`, then `max`; one error at most.
   *
   * | | string | `count: "bytes"` | array |
   * |---|---|---|---|
   * | `is` | `should be {count} character(s)` | `should be {count} byte(s)` | `should have {count} item(s)` |
   * | `min` | `should be at least {count} character(s)` | `should be at least {count} byte(s)` | `should have at least {count} item(s)` |
   * | `max` | `should be at most {count} character(s)` | `should be at most {count} byte(s)` | `should have at most {count} item(s)` |
   *
   * @example
   * ```ts
   * cs.validateLength("name", { min: 2, max: 80 });
   * ```
   *
   * @throws QueryError when `field` is not a field, or no limit is given.
   */
  validateLength(field: FieldOfType<S, string | readonly unknown[]>, options: LengthOptions): this {
    fieldOf(this.#spec, field, "validateLength");
    if (typeof options !== "object" || options === null) {
      throw new QueryError("query.lengthOptions", "validateLength() takes its limits as an object.");
    }
    const is = own(options, "is");
    const min = own(options, "min");
    const max = own(options, "max");
    if (is === undefined && min === undefined && max === undefined) {
      throw new QueryError("query.lengthNoLimit", "validateLength() needs at least one of is, min and max.");
    }
    checkLimit(is);
    checkLimit(min);
    checkLimit(max);
    const count = own(options, "count") ?? "graphemes";
    if (count !== "graphemes" && count !== "codepoints" && count !== "bytes") {
      throw new QueryError(
        "query.lengthCount",
        'validateLength(): count must be "graphemes", "codepoints" or "bytes".',
      );
    }
    const message = own(options, "message");
    checkMessage(message, "validateLength");
    const value = this.#changed(field);
    let error: ChangesetError | undefined;
    if (value !== undefined && value !== null) {
      let length: number;
      let type: "string" | "binary" | "list";
      if (typeof value === "string") {
        type = count === "bytes" ? "binary" : "string";
        length =
          count === "bytes"
            ? utf8Bytes(value)
            : count === "codepoints"
              ? codepoints(value)
              : graphemes(value);
      } else if (Array.isArray(value)) {
        type = "list";
        length = value.length;
      } else {
        throw notOfType("validateLength", field, "a string or an array");
      }
      const kind =
        is !== undefined && length !== is
          ? "is"
          : min !== undefined && length < min
            ? "min"
            : max !== undefined && length > max
              ? "max"
              : undefined;
      if (kind !== undefined) {
        const limit = kind === "is" ? is : kind === "min" ? min : max;
        const meta = { count: limit, kind, type };
        error = errorOf(messageOf(message, LENGTH_MESSAGES[type][kind], meta), "length", meta);
      }
    }
    return this.#check(field, "length", options, field, error);
  }

  /**
   * Compares the change of a number field with limits, in the order the options are
   * given; the first that fails is reported (`must be greater than {number}`, …).
   *
   * @example
   * ```ts
   * cs.validateNumber("age", { greaterThanOrEqualTo: 13 });
   * ```
   *
   * @throws QueryError when `field` is not a field, no limit is given, or an option is
   * unknown or not a number.
   */
  validateNumber(field: FieldOfType<S, number | bigint>, options: NumberOptions): this {
    fieldOf(this.#spec, field, "validateNumber");
    if (typeof options !== "object" || options === null) {
      throw new QueryError("query.numberOptions", "validateNumber() takes its limits as an object.");
    }
    // Two passes with for…in, so that a passing check allocates nothing.
    let limits = 0;
    for (const key in options) {
      if (!hasOwn(options, key) || key === "message") continue;
      limits++;
      if (!hasOwn(NUMBER_CHECKS, key)) {
        throw new QueryError(
          "query.numberUnknownOption",
          `validateNumber(): unknown option "${key}". The options are ${Object.keys(NUMBER_CHECKS).join(", ")} and message.`,
        );
      }
      const limit: unknown = (options as Values)[key];
      if (typeof limit !== "bigint" && (typeof limit !== "number" || Number.isNaN(limit))) {
        throw new QueryError("query.numberLimit", `validateNumber(): ${key} must be a number.`);
      }
    }
    if (limits === 0) {
      throw new QueryError("query.numberNoLimit", "validateNumber() needs at least one limit.");
    }
    const message = own(options, "message");
    checkMessage(message, "validateNumber");
    const value = this.#changed(field);
    let error: ChangesetError | undefined;
    if (value !== undefined && value !== null) {
      if (typeof value !== "number" && typeof value !== "bigint") {
        throw notOfType("validateNumber", field, "a number");
      }
      for (const key in options) {
        if (!hasOwn(options, key) || key === "message") continue;
        const kind = key as keyof typeof NUMBER_CHECKS;
        const limit = options[kind] as number | bigint;
        const check = NUMBER_CHECKS[kind];
        if (Number.isNaN(value) || !check[0](value, limit)) {
          const meta = { kind, number: limit };
          error = errorOf(messageOf(message, check[1], meta), "number", meta);
          break;
        }
      }
    }
    return this.#check(field, "number", options, field, error);
  }

  /**
   * Checks that the params hold `<field>Confirmation` equal to the field's change
   * (`passwordConfirmation` for `password`). The confirmation is cast with the field's
   * type and compared with the change by that type, so the same input typed twice always
   * matches; a confirmation the type rejects does not. The error, `does not match confirmation`,
   * goes on the confirmation key. A missing confirmation is an error only with
   * `required: true` (`can't be blank`). Like the other validations it runs only when the
   * field has a change (not a change to `null`), and only on a changeset made by `cast`.
   *
   * @example
   * ```ts
   * cast(User, params, ["email", "password"]).validateConfirmation("password");
   * ```
   *
   * @throws QueryError when `field` is not a field.
   */
  validateConfirmation<const K extends FieldName<S>>(
    field: K,
    options?: ConfirmationOptions,
  ): WithErrorKey<this, `${K}Confirmation`> {
    const meta = fieldOf(this.#spec, field, "validateConfirmation");
    const message = own(options, "message");
    checkMessage(message, "validateConfirmation");
    const key = `${field}Confirmation`;
    const params = this.params;
    const value = this.#changed(field);
    let error: ChangesetError | undefined;
    if (params !== null && value !== undefined && value !== null) {
      // A key holding undefined counts as absent, as it does in cast.
      if (hasOwn(params, key) && params[key] !== undefined) {
        if (!confirms(meta, params[key], value)) {
          error = errorOf(messageOf(message, "does not match confirmation", EMPTY), "confirmation", EMPTY);
        }
      } else if (own(options, "required") === true) {
        error = errorOf(messageOf(message, BLANK, EMPTY), "required", EMPTY);
      }
    }
    return this.#check(field, "confirmation", options, key, error) as WithErrorKey<this, `${K}Confirmation`>;
  }

  /**
   * Adds `must be accepted` unless the params hold `true` (or `"true"`, `"1"`, `1`) under
   * `key`, such as a terms-of-service checkbox. The key need not be a field. Runs only on
   * a changeset made by `cast`.
   *
   * @example
   * ```ts
   * cast(User, params, ["email"]).validateAcceptance("termsOfService");
   * ```
   */
  validateAcceptance<const K extends string = never>(
    key: K | FieldName<S>,
    options?: MessageOptions,
  ): WithErrorKey<this, Exclude<K, FieldName<S>>> {
    checkErrorKey(key, "validateAcceptance");
    const message = own(options, "message");
    checkMessage(message, "validateAcceptance");
    const params = this.params;
    let error: ChangesetError | undefined;
    if (params !== null) {
      const accepted = hasOwn(params, key) ? ACCEPTANCE.cast(params[key]) : undefined;
      if (accepted === undefined || !accepted.success || accepted.data !== true) {
        error = errorOf(messageOf(message, "must be accepted", EMPTY), "acceptance", EMPTY);
      }
    }
    return this.#check(key, "acceptance", options, key, error) as WithErrorKey<
      this,
      Exclude<K, FieldName<S>>
    >;
  }

  /**
   * Runs `fn` on the change of a field (not on `null`, not when there is no change, and
   * not when the field already has an error). `fn` returns a message, an error, a list of
   * either, or nothing.
   *
   * @example
   * ```ts
   * cs.validateChange("email", (email) => (email.endsWith("@example.com") ? "is not allowed" : undefined));
   * ```
   *
   * @throws QueryError when `field` is not a field or `fn` returns something else.
   */
  validateChange<K extends FieldName<S>>(
    field: K,
    fn: (value: NonNullable<FieldValues<S>[K]>, field: K) => ChangeValidatorResult,
  ): this {
    fieldOf(this.#spec, field, "validateChange");
    if (typeof fn !== "function")
      throw new QueryError("query.validateChangeFunction", "validateChange() takes a function.");
    const value = this.#changed(field);
    if (value === undefined || value === null || hasOwn(this.errors, field)) {
      return this.#validated(field, "change", undefined, this.changes, this.errors, this.valid);
    }
    const result: unknown = fn(value as NonNullable<FieldValues<S>[K]>, field);
    const found = issuesOf(result);
    if (found.length === 0) {
      return this.#validated(field, "change", undefined, this.changes, this.errors, this.valid);
    }
    return this.#validated(
      field,
      "change",
      undefined,
      this.changes,
      appendErrors(this.errors, field, found, false),
      false,
    );
  }

  // -------------------------------------------------------------------------
  // Schema and function validators (step 06: ./validators/)
  // -------------------------------------------------------------------------

  /**
   * Validates the record with a Standard Schema (Zod, Valibot, ArkType, recent Yup) or a
   * function. The validator receives every field with the changes applied; each issue
   * becomes an error on the field its path starts with (`validation: "schema"`), or on
   * `$base` (exported as `BASE`) when the path is empty or does not start with a field.
   *
   * Every issue is kept by default, except on a field that already has an error (from
   * `cast` or an earlier validation): that field keeps its first message.
   * `{ scope: "changed" }` keeps only issues on changed fields. `{ apply: true }` writes
   * a schema's output back as changes when it finds no issue. `{ only: [...] }` narrows
   * the values and the issues to those fields.
   *
   * @example
   * ```ts
   * const UserInput = z.object({ email: z.string().email(), age: z.number().int().min(13).nullish() });
   * cast(User, params, ["email", "age"]).validate(UserInput);
   *
   * cs.validate((v, { isChanged }) =>
   *   isChanged("endsAt") && v.endsAt <= v.startsAt ? [{ path: "endsAt", message: "must be after start" }] : [],
   * );
   * ```
   *
   * @throws TypeError when `validator` is neither a Standard Schema nor a function, or a
   *   validator function returns something other than an array of issues or nothing
   *   (`undefined`), such as `null`, a single issue without its array or a string.
   * @throws QueryError when the validator answers with a promise (use `validateAsync`), or an option is wrong.
   */
  validate(validator: Validator<FieldValues<S>>, options?: ValidateOptions<S>): this {
    return validateChangeset(this, validator, options as ValidateOptions<ChangesetSource> | undefined);
  }

  /**
   * Like {@link Changeset.validate}, for validators that answer with a promise (a remote
   * check, a schema with async refinements). Also accepts synchronous validators.
   *
   * @example
   * ```ts
   * const checked = await cs.validateAsync(async (v) =>
   *   (await isDisposable(v.email)) ? [{ path: "email", message: "is not allowed" }] : [],
   * );
   * ```
   *
   * @throws TypeError (as a rejected promise) when `validator` is neither a Standard Schema nor a function,
   *   or a validator function's result resolves to something other than an array of issues or
   *   nothing (`undefined`), such as `null`, a single issue without its array or a string.
   */
  validateAsync(validator: Validator<FieldValues<S>>, options?: ValidateOptions<S>): Promise<this> {
    return validateChangesetAsync(this, validator, options as ValidateOptions<ChangesetSource> | undefined);
  }

  /**
   * Validates the change of one field with a Standard Schema or a function. It runs only
   * when the field has a change (not a change to `null`) and no error yet, and receives
   * that value alone; every issue goes on the field, its path in `meta.path`.
   *
   * @example
   * ```ts
   * cast(User, params, ["email"]).validateField("email", z.string().email());
   * ```
   *
   * @throws TypeError when `validator` is neither a Standard Schema nor a function, or a
   *   validator function returns something other than an array of issues or nothing
   *   (`undefined`), such as `null`, a single issue without its array or a string.
   * @throws QueryError when `field` is not a field, or the validator answers with a promise.
   */
  validateField<K extends FieldName<S>>(
    field: K,
    validator: FieldValidator<NonNullable<FieldValues<S>[K]>, FieldValues<S>>,
  ): this {
    return validateFieldOf(this, field, validator);
  }

  /**
   * Like {@link Changeset.validateField}, for validators that answer with a promise.
   *
   * @example
   * ```ts
   * const checked = await cs.validateFieldAsync("email", async (email) =>
   *   (await isDisposable(email)) ? [{ path: [], message: "is not allowed" }] : [],
   * );
   * ```
   *
   * @throws TypeError (as a rejected promise) when `validator` is neither a Standard Schema nor a function,
   *   or a validator function's result resolves to something other than an array of issues or
   *   nothing (`undefined`), such as `null`, a single issue without its array or a string.
   */
  validateFieldAsync<K extends FieldName<S>>(
    field: K,
    validator: FieldValidator<NonNullable<FieldValues<S>[K]>, FieldValues<S>>,
  ): Promise<this> {
    return validateFieldOfAsync(this, field, validator);
  }

  // -------------------------------------------------------------------------
  // Nested changes (step 15: ./nested/)
  // -------------------------------------------------------------------------

  /**
   * Casts an association from the params given to `cast`: each item becomes a child
   * changeset made by `with` (by default the target's static `changeset` function),
   * called as `with(existingRow, item, index)` for an item whose primary key matches a
   * child the parent has (an update), and `with(TargetClass, item, index)` otherwise (an
   * insert). Children the params leave out are handled by the association's `onReplace`.
   *
   * A to-one association takes an object or `null`, a to-many one an array of objects. On
   * a loaded parent the association must be preloaded as whole rows; a new parent has no
   * children. A key missing from the params changes nothing. The parent is invalid when a
   * child is; the children keep their own errors.
   *
   * @example
   * ```ts
   * cast(post, params, ["title"]).castAssoc("comments", { with: Comment.changeset });
   * ```
   *
   * @throws QueryError for an unknown or has-through association, wrong options, a
   * changeset made by `change`, or a left-out child when `onReplace` is `"error"`.
   * @throws NotLoadedError when the association of a loaded parent is not preloaded.
   */
  castAssoc<const K extends AssocName<S>>(name: K, ...options: CastNestedArgs<AssocTarget<S, K>>): this {
    return castRelation(this, name, (options as readonly unknown[])[0], false) as this;
  }

  /**
   * Casts an embed field from the params, as {@link Changeset.castAssoc} casts an
   * association. Items of an embedded list are matched by the embedded schema's primary
   * key; without one, the list is replaced as a whole.
   *
   * @example
   * ```ts
   * cast(user, params, ["email"]).castEmbed("address", { with: Address.changeset, required: true });
   * ```
   *
   * @throws QueryError for a field that is not an embed, wrong options, a changeset made
   * by `change`, or a left-out item when `onReplace` is `"error"`.
   */
  castEmbed<const K extends EmbedName<S>>(name: K, ...options: CastNestedArgs<EmbedTarget<S, K>>): this {
    return castRelation(this, name, (options as readonly unknown[])[0], true) as this;
  }

  /**
   * Sets an association from values you trust: rows (kept as they are), changesets (a
   * new record is inserted, one of a loaded row updated) or plain objects (a new record,
   * or an update of the existing child with that primary key). A list for `hasMany` and
   * `manyToMany`, one value or `null` for the others. Children left out follow
   * `onReplace`; putting the rows that are already there changes nothing.
   *
   * @example
   * ```ts
   * change(post).putAssoc("tags", [news, sport]);
   * change(comment).putAssoc("post", post);
   * ```
   *
   * @throws QueryError for an unknown or has-through association, a value of the wrong
   * kind, the same row twice, or a left-out child when `onReplace` is `"error"`.
   * @throws NotLoadedError when the association of a loaded parent is not preloaded.
   */
  putAssoc<const K extends AssocName<S>>(name: K, value: PutAssocValue<S, K>): this {
    return putRelation(this, name, value, false) as this;
  }

  /**
   * Sets an embed field from values you trust, as {@link Changeset.putAssoc} sets an
   * association: embedded rows, changesets of them, or plain objects of their fields.
   *
   * @example
   * ```ts
   * change(user).putEmbed("address", { street: "Storgata 1", city: "Oslo" });
   * ```
   *
   * @throws QueryError for a field that is not an embed, a value of the wrong kind, or a
   * left-out item when `onReplace` is `"error"`.
   */
  putEmbed<const K extends EmbedName<S>>(name: K, value: PutEmbedValue<S, K>): this {
    return putRelation(this, name, value, true) as this;
  }

  // -------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------

  /**
   * Adds an error by hand. The key may be a field or any other name (`$base` for the
   * changeset as a whole). `meta` fills the message's `{placeholders}`.
   *
   * @example
   * ```ts
   * cs.addError("email", "is not allowed", { domain: "example.com" });
   * ```
   *
   * @throws QueryError when the key is empty or `"__proto__"`.
   */
  addError<const K extends string = never>(
    key: K | FieldName<S>,
    message: string,
    meta?: Readonly<Record<string, unknown>>,
  ): WithErrorKey<this, Exclude<K, FieldName<S>>> {
    checkErrorKey(key, "addError");
    if (typeof message !== "string")
      throw new QueryError("query.addErrorMessage", "addError() takes the message as a string.");
    const error: ChangesetError = { message, meta: meta === undefined ? EMPTY : { ...meta } };
    return this.#with(this.changes, appendErrors(this.errors, key, [error], false), false) as WithErrorKey<
      this,
      Exclude<K, FieldName<S>>
    >;
  }

  /**
   * The errors as messages, with `{placeholders}` filled in from each error's metadata,
   * including those of nested changesets. The tree is typed by the schema: its fields,
   * associations and embeds (nested trees), the keys validations added
   * (`passwordConfirmation`, carried in the changeset's type), and `$base`.
   * Name its type with `ErrorMessages`: of the changeset's type, or of what the schema's
   * `changeset` function returns.
   *
   * @example
   * ```ts
   * cast(User, {}, ["email"]).validateRequired(["email"]).errorMessages(); // { email: ["can't be blank"] }
   *
   * // For a client: the errors of User.changeset, keys added by its validations included.
   * type SignUpErrors = ErrorMessages<ReturnType<typeof User.changeset>>;
   * ```
   */
  errorMessages<C extends ChangesetLike>(this: C): ErrorMessages<C> {
    return traverseErrors(this as ChangesetLike, interpolate) as ErrorMessages<C>;
  }

  // -------------------------------------------------------------------------
  // Constraints
  // -------------------------------------------------------------------------

  /**
   * Declares a unique constraint: if the database rejects the write because of it, the
   * repo reports `has already been taken` on the (first) field instead of throwing. The
   * default name is `<table>_<column(s)>_key`; a field listed twice is one column of it.
   *
   * @example
   * ```ts
   * cs.uniqueConstraint("email"); // users_email_key
   * cs.uniqueConstraint(["orgId", "slug"]); // projects_org_id_slug_key
   * ```
   *
   * @throws QueryError when a name is not a field, or the default name cannot be made.
   */
  uniqueConstraint(fields: FieldName<S> | readonly FieldName<S>[], options?: ConstraintOptions): this {
    const names: readonly string[] = typeof fields === "string" ? [fields] : fields;
    if (!Array.isArray(names) || names.length === 0) {
      throw new QueryError(
        "query.uniqueFields",
        "uniqueConstraint() takes a field name or a non-empty list of them.",
      );
    }
    const columns = distinct(names).map((name) => fieldOf(this.#spec, name, "uniqueConstraint").column);
    return this.#constraint(
      "unique",
      names[0] as string,
      () => `${this.#source("uniqueConstraint")}_${columns.join("_")}_key`,
      "has already been taken",
      options,
      "uniqueConstraint",
    );
  }

  /**
   * Declares a foreign-key constraint on a field of this record: a write that points at a
   * row that does not exist reports `does not exist`. The default name is
   * `<table>_<column>_fkey`.
   *
   * @example
   * ```ts
   * cast(Post, params, ["authorId"]).foreignKeyConstraint("authorId"); // posts_author_id_fkey
   * ```
   *
   * @throws QueryError when `field` is not a field, or the default name cannot be made.
   */
  foreignKeyConstraint(field: FieldName<S>, options?: ConstraintOptions): this {
    const column = fieldOf(this.#spec, field, "foreignKeyConstraint").column;
    return this.#constraint(
      "foreignKey",
      field,
      () => `${this.#source("foreignKeyConstraint")}_${column}_fkey`,
      "does not exist",
      options,
      "foreignKeyConstraint",
    );
  }

  /**
   * Declares the foreign-key constraint behind a `belongsTo` association: a write whose
   * parent does not exist reports `does not exist` on the association's name.
   *
   * @example
   * ```ts
   * cast(Post, params, ["authorId"]).assocConstraint("author"); // posts_author_id_fkey, error on "author"
   * ```
   *
   * @throws QueryError when `assoc` is not a `belongsTo` association.
   */
  assocConstraint(assoc: AssocName<S>, options?: ConstraintOptions): this {
    const found = this.#assoc(assoc, "assocConstraint");
    if (found.kind !== "belongsTo") {
      throw new QueryError(
        "query.assocConstraintKind",
        `assocConstraint(): "${assoc}" is a ${found.kind} association.`,
      );
    }
    const columns = found.ownerKey.map((name) => columnOf(found.owner, name));
    return this.#constraint(
      "foreignKey",
      assoc,
      () => `${this.#source("assocConstraint")}_${columns.join("_")}_fkey`,
      "does not exist",
      options,
      "assocConstraint",
    );
  }

  /**
   * Declares the foreign-key constraint of a `hasOne` or `hasMany` association, seen from
   * this side: deleting this record while rows still point at it reports `is still
   * associated with this entry` on the association's name. The default name is
   * `<child table>_<foreign key column>_fkey`.
   *
   * @example
   * ```ts
   * change(user).noAssocConstraint("posts"); // posts_author_id_fkey
   * ```
   *
   * @throws QueryError when `assoc` is not a `hasOne` or `hasMany` association.
   */
  noAssocConstraint(assoc: AssocName<S>, options?: ConstraintOptions): this {
    const found = this.#assoc(assoc, "noAssocConstraint");
    if ((found.kind !== "hasOne" && found.kind !== "hasMany") || found.through !== undefined) {
      throw new QueryError(
        "query.noAssocConstraintKind",
        `noAssocConstraint(): "${assoc}" is ${found.through !== undefined ? "a has-through" : `a ${found.kind}`} association.`,
      );
    }
    const target = found.target();
    const columns = found.relatedKey.map((name) => columnOf(target, name));
    return this.#constraint(
      "noAssoc",
      assoc,
      () => `${meta(target).source as string}_${columns.join("_")}_fkey`,
      "is still associated with this entry",
      options,
      "noAssocConstraint",
    );
  }

  /**
   * Declares a check constraint, reported as `is invalid` on `field`. Its name is
   * required.
   *
   * @example
   * ```ts
   * cs.checkConstraint("age", { name: "users_age_check", message: "must be positive" });
   * ```
   *
   * @throws QueryError when `field` is not a field or there is no name.
   */
  checkConstraint(field: FieldName<S>, options: CheckConstraintOptions): this {
    fieldOf(this.#spec, field, "checkConstraint");
    const name = own(options, "name");
    if (typeof name !== "string" || name === "") {
      throw new QueryError("query.checkConstraintName", "checkConstraint() needs the constraint's name.");
    }
    return this.#constraint("check", field, () => name, "is invalid", options, "checkConstraint");
  }

  /**
   * Declares an exclusion constraint, reported as `violates an exclusion constraint`. The
   * default name is `<table>_<column>_excl`.
   *
   * @example
   * ```ts
   * cs.exclusionConstraint("during"); // bookings_during_excl
   * ```
   *
   * @throws QueryError when `field` is not a field, or the default name cannot be made.
   */
  exclusionConstraint(field: FieldName<S>, options?: ConstraintOptions): this {
    const column = fieldOf(this.#spec, field, "exclusionConstraint").column;
    return this.#constraint(
      "exclusion",
      field,
      () => `${this.#source("exclusionConstraint")}_${column}_excl`,
      "violates an exclusion constraint",
      options,
      "exclusionConstraint",
    );
  }

  #source(fn: string): string {
    const source = this.#spec.meta?.source;
    if (source === null || source === undefined) {
      throw new QueryError(
        "query.constraintNoTable",
        `${fn}(): ${this.#spec.model === null ? "a changeset without a schema class" : `${this.#spec.name}`} has no table, so the constraint has no default name.`,
      );
    }
    return source;
  }

  #assoc(name: string, fn: string): AssocMeta {
    const found = this.#spec.meta?.assocs().get(name);
    if (found === undefined) {
      throw new QueryError(
        "query.constraintUnknownAssoc",
        `${fn}(): ${this.#spec.name} has no association "${String(name)}".`,
      );
    }
    return found;
  }

  #constraint(
    type: Constraint["type"],
    field: string,
    defaultName: () => string,
    message: string,
    options: ConstraintOptions | undefined,
    fn: string,
  ): this {
    if (options !== undefined && (typeof options !== "object" || options === null)) {
      throw new QueryError("query.constraintOptions", `${fn}(): the options must be an object.`);
    }
    const name = own(options, "name") ?? defaultName();
    if (typeof name !== "string" || name === "")
      throw new QueryError("query.constraintName", `${fn}(): name must be a non-empty string.`);
    const match = own(options, "match") ?? "exact";
    if (match !== "exact" && match !== "suffix" && match !== "prefix") {
      throw new QueryError("query.constraintMatch", `${fn}(): match must be "exact", "suffix" or "prefix".`);
    }
    const custom = own(options, "message");
    if (custom !== undefined && typeof custom !== "string") {
      throw new QueryError("query.constraintMessage", `${fn}(): message must be a string.`);
    }
    const errorKey = own(options, "errorKey");
    const constraint: Constraint = Object.freeze({
      type,
      name,
      match,
      field: errorKey === undefined ? field : checkErrorKey(errorKey, fn),
      message: custom ?? message,
    });
    return construct(
      this.#spec,
      this.data,
      this.params,
      this.changes as Values,
      this.errors,
      this.valid,
      this.action,
      this.#node,
      [...this.constraints, constraint],
      this.filters,
      this.prepare,
      this.repo,
    ) as this;
  }

  // -------------------------------------------------------------------------
  // Hooks for the repo
  // -------------------------------------------------------------------------

  /**
   * Makes an update or delete apply only if `field` still has the value it had when the
   * row was read, and has the update increment it (by default `n + 1`, wrapping to 1
   * after 2147483647). A write that finds the row changed fails as stale. The increment on
   * its own is not a change: an update with nothing else to write runs no query, so it is
   * not checked either; with `force` it runs, increments the field and checks it.
   *
   * @example
   * ```ts
   * repo.update(cast(user, params, ["name"]).optimisticLock("lockVersion"));
   * ```
   *
   * @throws QueryError when `field` is not a field or has no value.
   */
  optimisticLock<K extends FieldName<S>>(
    field: K,
    increment?: (current: NonNullable<FieldValues<S>[K]>) => NonNullable<FieldValues<S>[K]>,
  ): this {
    const meta = fieldOf(this.#spec, field, "optimisticLock");
    if (increment !== undefined && typeof increment !== "function") {
      throw new QueryError("query.lockIncrementer", "optimisticLock(): the incrementer must be a function.");
    }
    const current = currentValue(this.#spec, this.data, meta);
    if (current === null || current === undefined) {
      throw new QueryError("query.lockNoValue", `optimisticLock(): "${field}" has no value to compare.`);
    }
    if (increment === undefined && typeof current !== "number" && typeof current !== "bigint") {
      throw new QueryError(
        "query.lockNotNumber",
        `optimisticLock(): "${field}" is not a number, so it has no default increment.`,
      );
    }
    const next = (increment ?? incrementWithRollover)(current as never) as unknown;
    const bump: PrepareFunction<S, New> = (changeset) => changeset.forceChange(field, next as never);
    return construct(
      this.#spec,
      this.data,
      this.params,
      this.changes as Values,
      this.errors,
      this.valid,
      this.action,
      this.#node,
      this.constraints,
      { ...this.filters, [field]: current },
      [...this.prepare, bump],
      this.repo,
    ) as this;
  }

  /**
   * Registers a function the repo runs just before the write, inside its transaction,
   * with the changeset (its `repo` and `action` set). It returns the changeset to write.
   *
   * @example
   * ```ts
   * cs.prepareChanges((cs) => cs.putChange("slug", slugify(cs.getField("title"))));
   * ```
   *
   * @throws QueryError when `fn` is not a function.
   */
  prepareChanges(fn: PrepareFunction<S, New>): this {
    if (typeof fn !== "function")
      throw new QueryError("query.prepareFunction", "prepareChanges() takes a function.");
    return construct(
      this.#spec,
      this.data,
      this.params,
      this.changes as Values,
      this.errors,
      this.valid,
      this.action,
      this.#node,
      this.constraints,
      this.filters,
      [...this.prepare, fn],
      this.repo,
    ) as this;
  }

  /**
   * Asks the database whether another row already has these values, and adds `has
   * already been taken` if one does. It runs only when the fields have changes and no
   * errors, and the error key (`errorKey`, by default the first field) has none. Another
   * request can insert the same values between the check and the write, so it is for
   * early feedback only: always declare `uniqueConstraint` as well.
   *
   * @example
   * ```ts
   * const checked = await cs.validateUniqueAsync("email", repo);
   * ```
   *
   * @throws QueryError (as a rejected promise) when the repo does not provide the check.
   */
  validateUniqueAsync(
    fields: FieldName<S> | readonly FieldName<S>[],
    repo: unknown,
    options?: UniqueAsyncOptions,
  ): Promise<this> {
    const given: readonly string[] = typeof fields === "string" ? [fields] : fields;
    const names = Array.isArray(given) ? distinct(given) : given;
    try {
      for (const name of names) fieldOf(this.#spec, name, "validateUniqueAsync");
    } catch (error) {
      return Promise.reject(error);
    }
    if (uniqueAsync === undefined) {
      return Promise.reject(
        new QueryError(
          "query.uniqueAsyncUnavailable",
          "validateUniqueAsync() needs the repo's write support, which is not available in this build.",
        ),
      );
    }
    return uniqueAsync(this, names, repo, options) as Promise<this>;
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  /**
   * The validations that ran, oldest first: `[field, descriptor]`, where the descriptor
   * names the validation and holds its options. For tools that generate forms.
   *
   * @example
   * ```ts
   * cast(User, params, ["name"]).validateLength("name", { min: 2 }).validations;
   * // [["name", { validation: "length", min: 2 }]]
   * ```
   */
  get validations(): readonly ValidationEntry[] {
    if (this.#entries === undefined) this.#entries = entriesOf(this.#node);
    return this.#entries;
  }

  /**
   * A JSON-ready plain object of the action, the changes, the errors and `valid`: what
   * `JSON.stringify` writes. `changes` leaves out every field that is not in JSON (a
   * redacted field, a virtual one not declared `{ json: true }`), and maps the values as a
   * row's `toJSON` does (a `Date` to its ISO string, a `bigint` to a decimal string, bytes
   * to base64); nested changesets are written the same way.
   *
   * @example
   * ```ts
   * JSON.stringify(cs); // '{"action":null,"changes":{"email":"a@b.c"},"errors":{},"valid":true}'
   * ```
   */
  toJSON(): { action: Action | null; changes: Record<string, unknown>; errors: Errors; valid: boolean } {
    return {
      action: this.action,
      changes: changesJson(this.changes, this.#spec),
      errors: safeJsonValue(this.errors) as Errors,
      valid: this.valid,
    };
  }

  /** What `console.log(cs)` shows, with redacted fields hidden. */
  [INSPECT](): string {
    return describeChangeset(this);
  }
}

/**
 * The changes as JSON: a field that is not in JSON is left out, a field's value is mapped
 * as a row's `toJSON` maps it, and an association's nested changesets are written as JSON.
 */
function changesJson(changes: object, spec: Spec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const values = changes as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(changes)) {
    const field = spec.fields.get(key);
    if (field !== undefined && !field.json) continue;
    const value =
      field === undefined ? jsonValue(values[key]) : fieldValueJson(fieldConverter(field), values[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

type ElementOf<T> = T extends readonly (infer E)[] ? E : never;

const ACCEPTANCE = /* @__PURE__ */ booleanType();

const LENGTH_MESSAGES = {
  string: {
    is: "should be {count} character(s)",
    min: "should be at least {count} character(s)",
    max: "should be at most {count} character(s)",
  },
  binary: {
    is: "should be {count} byte(s)",
    min: "should be at least {count} byte(s)",
    max: "should be at most {count} byte(s)",
  },
  list: {
    is: "should have {count} item(s)",
    min: "should have at least {count} item(s)",
    max: "should have at most {count} item(s)",
  },
} as const;

type Compare = (value: number | bigint, limit: number | bigint) => boolean;

const NUMBER_CHECKS = /* @__PURE__ */ Object.freeze({
  lessThan: [(value, limit) => value < limit, "must be less than {number}"],
  greaterThan: [(value, limit) => value > limit, "must be greater than {number}"],
  lessThanOrEqualTo: [(value, limit) => value <= limit, "must be less than or equal to {number}"],
  greaterThanOrEqualTo: [(value, limit) => value >= limit, "must be greater than or equal to {number}"],
  equalTo: [(value, limit) => value >= limit && value <= limit, "must be equal to {number}"],
  notEqualTo: [(value, limit) => value < limit || value > limit, "must be not equal to {number}"],
} satisfies Record<string, readonly [Compare, string]>);

/** The column of a key field that association resolution has already checked. */
function columnOf(schema: AnySchema, field: string): string {
  return (meta(schema).fieldsByName.get(field) as FieldMeta).column;
}

function includes(field: FieldMeta, values: readonly unknown[], value: unknown): boolean {
  for (const candidate of values) if (same(field, candidate, value)) return true;
  return false;
}

/** Whether a confirmation param, cast with the field's type, equals the field's change. */
function confirms(field: FieldMeta, confirmation: unknown, change: unknown): boolean {
  if (confirmation === undefined || confirmation === null) return false;
  const result = field.type.cast(confirmation);
  return result.success && same(field, result.data, change);
}

function checkLimit(limit: unknown): void {
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0)) {
    throw new QueryError(
      "query.lengthWholeNumbers",
      "validateLength(): is, min and max must be whole numbers, 0 or more.",
    );
  }
}

function notOfType(fn: string, field: string, expected: string): QueryError {
  return new QueryError(
    "query.validatorValueType",
    `${fn}(): the change of "${field}" is not ${expected}, so it cannot be validated this way.`,
  );
}

/** The errors a `validateChange` function returned. */
function issuesOf(result: unknown): readonly ChangesetError[] {
  if (result === undefined || result === null) return NO_ISSUES;
  if (Array.isArray(result) && result.length === 0) return NO_ISSUES;
  const list: readonly unknown[] = Array.isArray(result) ? result : [result];
  return list.map((item) => {
    if (typeof item === "string") return { message: item, meta: EMPTY };
    // The error's own properties only: a key planted on Object.prototype is no part of it.
    const error = typeof item === "object" && item !== null ? (item as ChangeValidatorError) : undefined;
    const message = own(error, "message");
    if (typeof message === "string") {
      const meta = own(error, "meta");
      return errorOf(message, own(error, "validation"), meta === undefined ? EMPTY : meta);
    }
    throw new QueryError(
      "query.validateChangeResult",
      "A validateChange() function must return a message, an error ({ message, meta? }), a list of either, or nothing.",
    );
  });
}

function incrementWithRollover(current: number | bigint): number | bigint {
  if (typeof current === "bigint") return current + 1n;
  return current >= 2147483647 ? 1 : current + 1;
}

function entriesOf(node: ValidationNode | null): readonly ValidationEntry[] {
  const out: ValidationEntry[] = [];
  for (let at = node; at !== null; at = at.prev) {
    const descriptor: Record<string, unknown> =
      at.validation === undefined ? { ...at.options } : { validation: at.validation };
    if (at.argumentKey !== undefined) descriptor[at.argumentKey] = at.argument;
    if (at.validation !== undefined) Object.assign(descriptor, at.options);
    if (typeof at.field === "string") out.push([at.field, descriptor]);
    else for (let i = at.field.length - 1; i >= 0; i--) out.push([at.field[i] as string, descriptor]);
  }
  return Object.freeze(out.reverse());
}

// ---------------------------------------------------------------------------
// applyChanges, inspect
// ---------------------------------------------------------------------------

function applied(changeset: AnyChangeset): object {
  const spec = specOf(changeset);
  const data = changeset.data as object | null;
  const changes = changeset.changes as Values;
  if (data === null) {
    throw new QueryError(
      "query.applyChangesNewRecord",
      `applyChanges() and applyAction() need a changeset of a loaded row (or one without a schema class); this one is of a new ${spec.name}.`,
    );
  }
  if (spec.meta === null) {
    // Fields the data does not hold take their declared default, as getField reads them.
    let defaults: Record<string, unknown> | undefined;
    for (const field of spec.fields.values()) {
      if (hasOwn(data, field.name) || hasOwn(changes, field.name)) continue;
      const value = initialValue(field);
      if (value !== undefined) {
        defaults ??= {};
        defaults[field.name] = value;
      }
    }
    let embedded: Record<string, unknown> | undefined;
    for (const name of spec.embeds) {
      if (!hasOwn(changes, name)) continue;
      embedded ??= {};
      embedded[name] = embedValue(changes[name], "built");
    }
    return { ...data, ...defaults, ...changes, ...embedded };
  }
  const row = data as Values;
  const values: unknown[] = [];
  for (const field of spec.meta.persisted) {
    if (!hasOwn(changes, field.name)) values.push(row[field.name]);
    else
      values.push(
        spec.embeds.has(field.name) ? embedValue(changes[field.name], "built") : changes[field.name],
      );
  }
  const loaded: string[] = [];
  for (const key of Object.keys(row)) if (!spec.fields.has(key)) loaded.push(key);
  const rowMeta = (data as { readonly [ROW]: RowMeta })[ROW];
  const out = (
    loaded.length === 0
      ? spec.meta.create(values, rowMeta)
      : spec.meta.createWith(loaded)(
          values,
          loaded.map((key) => row[key]),
          rowMeta,
        )
  ) as Record<string, unknown>;
  for (const field of spec.meta.fields) {
    if (field.virtual) out[field.name] = hasOwn(changes, field.name) ? changes[field.name] : row[field.name];
  }
  return out;
}

/** A nested changeset as plain values for display: its own changes redacted. */
function displayValue(value: unknown): unknown {
  if (value instanceof Changeset) return displayChangeset(value);
  if (Array.isArray(value) && value.some((item) => item instanceof Changeset)) return value.map(displayValue);
  return value;
}

function displayChangeset(changeset: AnyChangeset): object {
  return {
    action: changeset.action,
    changes: displayChanges(changeset, true),
    errors: changeset.errors,
    valid: changeset.valid,
  };
}

function displayChanges(changeset: AnyChangeset, redact: boolean): Values {
  const changes = changeset.changes as Values;
  let display: Record<string, unknown> | undefined;
  for (const key of Object.keys(changes)) {
    const shown = displayValue(changes[key]);
    if (shown !== changes[key]) {
      display ??= { ...changes };
      display[key] = shown;
    }
  }
  const out = display ?? changes;
  return redact ? redactFields(out, specOf(changeset).redacted) : out;
}

function describeChangeset(changeset: AnyChangeset): string {
  const spec = specOf(changeset);
  const changes = formatStruct("changes:", displayChanges(changeset, false), spec.redacted);
  return `Changeset<${spec.name}> { action: ${formatValue(changeset.action)}, ${changes}, errors: ${formatValue(changeset.errors)}, valid: ${changeset.valid} }`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Fills `{key}` placeholders from the error's metadata; unknown keys are left as they are. */
function interpolate(error: ChangesetError): string {
  return error.message.replace(/\{(\w+)\}/g, (placeholder, key: string) =>
    hasOwn(error.meta, key) ? String(error.meta[key]) : placeholder,
  );
}

/**
 * Turns every error of a changeset, and of the changesets nested in its changes, into a
 * value with `fn`: to render messages, translate them or handle plurals. The result has
 * the errors' keys; a nested changeset contributes its own tree, a list of changesets a
 * list of trees (only when one of them has errors). A key that has errors of its own and
 * nested changesets with errors keeps both: its own under `$errors` (beside a child's
 * keys, or beside `$items`, the list of children's trees).
 *
 * @example
 * ```ts
 * traverseErrors(cs, (error) =>
 *   error.message.replace(/\{(\w+)\}/g, (_, key: string) => String(error.meta[key] ?? key)),
 * );
 * // { name: ["should be at least 2 character(s)"] }
 * ```
 */
export function traverseErrors<C extends ChangesetLike, T>(
  changeset: C,
  fn: ErrorFormatter<T>,
): ErrorTreeOf<C, T>;
export function traverseErrors<T>(changeset: ChangesetLike, fn: ErrorFormatter<T>): ErrorTree<T> {
  const out: Record<string, readonly T[] | ErrorTree<T> | readonly ErrorTree<T>[]> = {};
  for (const key of Object.keys(changeset.errors)) {
    out[key] = (changeset.errors[key] as readonly ChangesetError[]).map((error) => fn(error, key));
  }
  const changes = changeset.changes;
  for (const key of Object.keys(changes)) {
    const value = changes[key];
    let nested: ErrorTree<T> | readonly ErrorTree<T>[] | undefined;
    if (value instanceof Changeset) {
      const child = traverseErrors(value, fn);
      if (Object.keys(child).length > 0) nested = child;
    } else if (Array.isArray(value) && value.length > 0 && value.every((item) => item instanceof Changeset)) {
      const children = value.map((item: AnyChangeset) => traverseErrors(item, fn));
      if (children.some((child) => Object.keys(child).length > 0)) nested = children;
    }
    if (nested === undefined) continue;
    const own = out[key] as readonly T[] | undefined;
    // A key with errors of its own and children with errors: both are kept, the key's own
    // under "$errors" (and a list of children under "$items").
    if (own === undefined) out[key] = nested;
    else if (Array.isArray(nested)) out[key] = { $errors: own, $items: nested as readonly ErrorTree<T>[] };
    else out[key] = { ...(nested as ErrorTree<T>), $errors: own };
  }
  return out;
}

// ---------------------------------------------------------------------------
// cast and change
// ---------------------------------------------------------------------------

type IsClass<T> = T extends abstract new (...args: never[]) => unknown ? true : false;
/** A row given alone (not a class, not a union with one, not a changeset or `{ data, types }`). */
type RowOnly<R> =
  true extends IsClass<R>
    ? never
    : R extends Changeset<ChangesetSource, boolean> | { readonly types: unknown }
      ? never
      : R;
/** The schema class in a union of a class and its rows: `typeof User` in `User | typeof User`. */
type ClassOf<T> = Extract<T, AnySchema>;
/** `unknown` when `T` is a schema class together with rows of it; otherwise a type nothing matches. */
type ClassOrRow<T> = [ClassOf<T>] extends [never]
  ? never
  : [Exclude<T, AnySchema>] extends [Row<ClassOf<T>>]
    ? unknown
    : never;

/**
 * Starts a changeset from untrusted input, such as a request body: keeps the `permitted`
 * keys of `params`, converts each value to its field's type, and records the values that
 * differ from the current ones as changes.
 *
 * - `target` is a schema class (a new record), a loaded row (an update), a changeset
 *   (adds more input to it), or `{ data, types }` for a changeset without a schema class.
 * - Keys that are not permitted are ignored. `""` becomes `null` (`emptyValues`). A name
 *   permitted twice is cast once.
 * - A value the type rejects adds `is invalid`; `null` on a field that is not nullable
 *   adds `can't be blank`. Neither records a change.
 *
 * @example
 * ```ts
 * const cs = cast(User, { email: "ada@example.com", age: "36", role: "root" }, ["email", "age"]);
 * cs.changes; // { email: "ada@example.com", age: 36 }
 * ```
 *
 * @throws CastError when `params` is not a plain object, `null` or `undefined`.
 * @throws QueryError when a permitted name is not a field, or is an embed or association.
 */
export function cast<S extends AnySchema>(
  target: S,
  params: unknown,
  permitted: readonly FieldName<S>[],
  options?: CastOptions,
): Changeset<S, true>;
export function cast<const F extends Readonly<Record<string, AnyFieldBuilder>>, D extends object>(
  target: SchemalessTarget<F, D>,
  params: unknown,
  permitted: readonly (keyof F & string)[],
  options?: CastOptions,
): Changeset<SchemalessTarget<F, D>, false>;
export function cast<S extends ChangesetSource, New extends boolean>(
  target: Changeset<S, New>,
  params: unknown,
  permitted: readonly FieldName<S>[],
  options?: CastOptions,
): Changeset<S, New>;
export function cast<R extends object>(
  target: RowOnly<R>,
  params: unknown,
  permitted: readonly FieldName<RowSchema<R>>[],
  options?: CastOptions,
): Changeset<RowSchema<R>, false>;
export function cast<T extends object>(
  target: T & ClassOrRow<T>,
  params: unknown,
  permitted: readonly FieldName<ClassOf<T>>[],
  options?: CastOptions,
): Changeset<ClassOf<T>, boolean>;
export function cast(
  target: unknown,
  params: unknown,
  permitted: readonly string[],
  options?: CastOptions,
): AnyChangeset {
  const given = paramsOf(params);
  if (!Array.isArray(permitted)) {
    throw new QueryError("query.castPermitted", "cast() takes the permitted field names as an array.");
  }
  const emptyValues = own(options, "emptyValues") ?? DEFAULT_EMPTY_VALUES;
  if (!Array.isArray(emptyValues))
    throw new QueryError("query.castEmptyValues", "cast(): emptyValues must be an array.");
  const force = own(options, "forceChanges") === true;
  const base = target instanceof Changeset ? (target as AnyChangeset) : undefined;
  const { spec, data } =
    base === undefined ? startOf(target, "cast") : { spec: specOf(base), data: base.data as object | null };
  const baseChanges: Values = base === undefined ? EMPTY : (base.changes as Values);
  let changes: Record<string, unknown> | undefined;
  let errors: Errors = base === undefined ? NO_ERRORS : base.errors;
  let valid = base === undefined ? true : base.valid;

  // Errors are appended without repeats: over an earlier changeset an error it already has
  // is not added again, and a name permitted twice gives its error once (owner decision,
  // 2026-10-24). Casting a repeated name again records the same change, so it adds nothing.
  for (const name of permitted) {
    const field = fieldOf(spec, name, "cast");
    if (spec.embeds.has(name)) {
      throw new QueryError("query.castEmbed", `cast(): "${name}" is an embed.`, { params: { name } });
    }
    if (given === undefined || !hasOwn(given, name)) continue;
    let value: unknown = given[name];
    if (value === undefined) continue;
    if (emptyValues.includes(value)) value = null;
    if (value === null) {
      if (!field.nullable) {
        errors = appendErrors(errors, name, [NOT_NULL], true);
        valid = false;
        continue;
      }
    } else {
      const result = field.type.cast(value);
      if (!result.success) {
        // A failure such as the built-in INVALID has no message or meta of its own.
        const failureMeta = own(result, "meta");
        const meta =
          failureMeta === undefined ? { type: field.type.name } : { type: field.type.name, ...failureMeta };
        errors = appendErrors(
          errors,
          name,
          [errorOf(own(result, "message") ?? "is invalid", "cast", meta)],
          true,
        );
        valid = false;
        continue;
      }
      value = result.data;
    }
    if (!force) {
      if (hasOwn(baseChanges, name)) {
        if (same(field, baseChanges[name], value)) continue;
        if (same(field, currentValue(spec, data, field), value)) {
          // Back to the value the record already has: the earlier change goes.
          changes = without(changes ?? baseChanges, name) as Record<string, unknown>;
          continue;
        }
      } else if (same(field, currentValue(spec, data, field), value)) {
        continue;
      }
    }
    changes ??= { ...baseChanges };
    changes[name] = value;
  }

  const mergedParams: Values = given === undefined ? EMPTY : given;
  return construct(
    spec,
    data,
    base === undefined || base.params === null ? mergedParams : { ...base.params, ...mergedParams },
    changes ?? baseChanges,
    errors,
    valid,
    base === undefined ? null : base.action,
    base === undefined ? null : nodeOf(base),
    base === undefined ? NO_CONSTRAINTS : base.constraints,
    base === undefined ? EMPTY : base.filters,
    base === undefined ? NO_PREPARE : base.prepare,
    base === undefined ? null : base.repo,
  );
}

/**
 * Starts a changeset from trusted values, such as values your own code computed: no
 * permitted list and no conversion, but a value equal to the current one is still not a
 * change, and `null` on a field that is not nullable still adds `can't be blank`.
 *
 * @example
 * ```ts
 * const cs = change(User, { email: "ada@example.com" }); // a new record
 * const rename = change(user, { name: "Ada" }); // an update of a loaded row
 * ```
 *
 * @throws QueryError when a key is not a field, or is an embed or association.
 */
export function change<S extends AnySchema>(target: S, values?: Partial<FieldValues<S>>): Changeset<S, true>;
export function change<const F extends Readonly<Record<string, AnyFieldBuilder>>, D extends object>(
  target: SchemalessTarget<F, D>,
  values?: Partial<FieldValues<SchemalessTarget<F, D>>>,
): Changeset<SchemalessTarget<F, D>, false>;
export function change<S extends ChangesetSource, New extends boolean>(
  target: Changeset<S, New>,
  values?: Partial<FieldValues<S>>,
): Changeset<S, New>;
export function change<R extends object>(
  target: RowOnly<R>,
  values?: Partial<FieldValues<RowSchema<R>>>,
): Changeset<RowSchema<R>, false>;
export function change<T extends object>(
  target: T & ClassOrRow<T>,
  values?: Partial<FieldValues<ClassOf<T>>>,
): Changeset<ClassOf<T>, boolean>;
export function change(target: unknown, values?: Readonly<Record<string, unknown>>): AnyChangeset {
  let changeset: AnyChangeset;
  if (target instanceof Changeset) {
    changeset = target as AnyChangeset;
  } else {
    const { spec, data } = startOf(target, "change");
    changeset = construct(
      spec,
      data,
      null,
      EMPTY,
      NO_ERRORS,
      true,
      null,
      null,
      NO_CONSTRAINTS,
      EMPTY,
      NO_PREPARE,
      null,
    );
  }
  if (values === undefined) return changeset;
  if (typeof values !== "object" || values === null) {
    throw new QueryError("query.changeValues", "change() takes the values as an object.");
  }
  for (const key of Object.keys(values)) {
    const value = values[key];
    if (value === undefined) continue;
    const spec = specOf(changeset);
    fieldOf(spec, key, "change");
    if (spec.embeds.has(key)) {
      throw new QueryError("query.changeEmbed", `change(): "${key}" is an embed.`, { params: { key } });
    }
    changeset = changeset.putChange(key, value as never);
  }
  return changeset;
}

/**
 * Applies the changes if the changeset is valid, without the database: `{ success: true,
 * data }` with the updated row (or plain data object), or `{ success: false, error }`
 * with the changeset, its `action` set. Useful for forms that are validated but not
 * stored.
 *
 * Like `applyChanges()`, it needs a changeset of a loaded row or one without a schema
 * class: a compile error, and a `QueryError`, on a new record.
 *
 * @example
 * ```ts
 * const result = applyAction(cast({ data: {}, types: { q: t.string() } }, params, ["q"]), "insert");
 * if (result.success) search(result.data.q);
 * ```
 *
 * @throws QueryError when `action` is not an action, or the changeset is of a new record.
 */
export function applyAction<S extends ChangesetSource, New extends boolean>(
  changeset: Changeset<S, New> & NotNewRecord<New>,
  action: Action,
): Result<AppliedData<S>, Changeset<S, New>> {
  if (!ACTIONS.has(action)) {
    throw new QueryError("query.applyActionUnknown", `applyAction(): "${String(action)}" is not an action.`);
  }
  if (changeset.data === null) applied(changeset);
  if (changeset.valid)
    return { success: true, data: applied(changeset) as AppliedData<S> } satisfies Success<AppliedData<S>>;
  return { success: false, error: withAction(changeset, action) } satisfies Failure<Changeset<S, New>>;
}

/**
 * Applies the changes if the changeset is valid, without the database, as
 * {@link applyAction} does, and returns the updated row (or plain data object). An invalid
 * changeset throws `InvalidChangesetError`, which carries the changeset with its `action`
 * set; the error's message lists the errors by field, without their values.
 *
 * @example
 * ```ts
 * const filters = applyActionOrThrow(cast({ data: {}, types: { q: t.string() } }, params, ["q"]), "insert");
 * search(filters.q);
 * ```
 *
 * @throws InvalidChangesetError when the changeset is invalid.
 * @throws QueryError when `action` is not an action, or the changeset is of a new record.
 */
export function applyActionOrThrow<S extends ChangesetSource, New extends boolean>(
  changeset: Changeset<S, New> & NotNewRecord<New>,
  action: Action,
): AppliedData<S> {
  const result = applyAction(changeset, action);
  if (result.success) return result.data;
  throw new InvalidChangesetError({ action, changeset: result.error });
}

// ---------------------------------------------------------------------------
// For other modules of the package (steps 06, 13, 15)
// ---------------------------------------------------------------------------

/**
 * The changeset with `action` set. For the repo.
 *
 * @example
 * ```ts
 * const attempted = withAction(cs, "insert");
 * ```
 */
export function withAction<C extends AnyChangeset>(changeset: C, action: Action | null): C {
  return construct(
    specOf(changeset),
    changeset.data as object | null,
    changeset.params,
    changeset.changes as Values,
    changeset.errors,
    changeset.valid,
    action,
    nodeOf(changeset),
    changeset.constraints,
    changeset.filters,
    changeset.prepare,
    changeset.repo,
  ) as C;
}

/**
 * The changeset with `repo` set (or cleared with `null`). For the repo, before it runs
 * the `prepare` functions.
 *
 * @example
 * ```ts
 * const preparing = withRepo(cs, repo);
 * ```
 */
export function withRepo<C extends AnyChangeset>(changeset: C, repo: unknown): C {
  return construct(
    specOf(changeset),
    changeset.data as object | null,
    changeset.params,
    changeset.changes as Values,
    changeset.errors,
    changeset.valid,
    changeset.action,
    nodeOf(changeset),
    changeset.constraints,
    changeset.filters,
    changeset.prepare,
    repo,
  ) as C;
}

/**
 * The changeset with other changes, errors or validity; everything not given is kept.
 * For validators (step 06) and nested changesets (step 15), which put errors on keys
 * that are not fields and changesets into `changes`.
 *
 * @example
 * ```ts
 * const next = rebuild(cs, { errors: { $base: [{ message: "is invalid", meta: {} }] }, valid: false });
 * ```
 */
export function rebuild<C extends AnyChangeset>(
  changeset: C,
  parts: {
    readonly changes?: Readonly<Record<string, unknown>>;
    readonly errors?: Readonly<Record<string, readonly ChangesetError[]>>;
    readonly valid?: boolean;
  },
): C {
  return construct(
    specOf(changeset),
    changeset.data as object | null,
    changeset.params,
    own(parts, "changes") ?? (changeset.changes as Values),
    own(parts, "errors") ?? changeset.errors,
    own(parts, "valid") ?? changeset.valid,
    changeset.action,
    nodeOf(changeset),
    changeset.constraints,
    changeset.filters,
    changeset.prepare,
    changeset.repo,
  ) as C;
}

/**
 * The changeset with one more entry in `validations`, `descriptor` as given. For
 * validators (step 06): `["$schema", { validator, opts }]`.
 *
 * @example
 * ```ts
 * const next = addValidation(cs, "$schema", { validator, opts });
 * ```
 */
export function addValidation<C extends AnyChangeset>(
  changeset: C,
  field: string,
  descriptor: Readonly<Record<string, unknown>>,
): C {
  return construct(
    specOf(changeset),
    changeset.data as object | null,
    changeset.params,
    changeset.changes as Values,
    changeset.errors,
    changeset.valid,
    changeset.action,
    {
      field,
      validation: undefined,
      options: descriptor,
      argumentKey: undefined,
      argument: undefined,
      prev: nodeOf(changeset),
    },
    changeset.constraints,
    changeset.filters,
    changeset.prepare,
    changeset.repo,
  ) as C;
}

/**
 * Appends errors to a key, as validations do. For validators (step 06).
 *
 * @example
 * ```ts
 * const next = withErrors(cs, "email", [{ message: "is invalid", validation: "schema", meta: {} }]);
 * ```
 */
export function withErrors<C extends AnyChangeset>(
  changeset: C,
  key: string,
  errors: readonly ChangesetError[],
): C {
  if (errors.length === 0) return changeset;
  return rebuild(changeset, { errors: appendErrors(changeset.errors, key, errors, false), valid: false });
}

/**
 * The field table of a changeset: its fields' metadata, redacted names and model. For
 * validators (step 06), which build the values object in field order.
 *
 * @example
 * ```ts
 * for (const field of fieldsOf(cs).values()) field.name;
 * ```
 */
export function fieldsOf(changeset: AnyChangeset): ReadonlyMap<string, FieldMeta> {
  return specOf(changeset).fields;
}

/**
 * The value of a field before the changes: in the data, or a new record's default.
 * For validators (step 06), which hand the data to a validator.
 *
 * @example
 * ```ts
 * const before = valueBefore(cs, "email");
 * ```
 */
export function valueBefore(changeset: AnyChangeset, field: string): unknown {
  const spec = specOf(changeset);
  return currentValue(spec, changeset.data as object | null, fieldOf(spec, field, "valueBefore"));
}

/** What `validateUniqueAsync` delegates to; set by the repo (step 13). */
type UniqueAsync = (
  changeset: AnyChangeset,
  fields: readonly string[],
  repo: unknown,
  options: UniqueAsyncOptions | undefined,
) => Promise<AnyChangeset>;

let uniqueAsync: UniqueAsync | undefined;

/**
 * Provides the implementation of `validateUniqueAsync`. Called once by the repo module
 * (step 13), which can run the query; until then the method rejects.
 *
 * @example
 * ```ts
 * provideValidateUniqueAsync(async (cs, fields, repo, options) => cs);
 * ```
 */
export function provideValidateUniqueAsync(implementation: UniqueAsync | undefined): void {
  uniqueAsync = implementation;
}
