/**
 * Validation of a changeset by a Standard Schema (Zod, Valibot, ArkType, recent Yup) or
 * by a plain function: building the object the validator sees, running it, and turning
 * its issues into changeset errors.
 *
 * The `Changeset` methods `validate`, `validateAsync`, `validateField` and
 * `validateFieldAsync` delegate here.
 *
 * @module
 */
import type { Action, ChangesetError, ValidatorContext, ValidatorFn } from "../../contracts/changeset.js";
import type { FieldMeta } from "../../contracts/schema.js";
import type { StandardSchemaV1Props } from "../../contracts/standard-schema.js";
import { QueryError } from "../../errors.js";
import { own } from "../../internal/own.js";
import { addValidation, Changeset, fieldsOf, rebuild, valueBefore } from "../changeset.js";
import { nestedValid } from "../nested/change.js";
import { isNestedValue } from "../nested/embed.js";
import { leaves, type Relation, relationOf } from "../nested/relation.js";
import type { ChangesetSource } from "../types.js";
import { generatedBuilders } from "./generated.js";
import type { FieldValidatorFn, ValidateOptions } from "./types.js";
import { BASE } from "./types.js";

/** A changeset of any source, as internal code handles it. */
type AnyChangeset = Changeset<ChangesetSource, boolean>;
type Values = Readonly<Record<string, unknown>>;
type AnyValidatorFn = (value: never, ctx: never) => unknown;

const hasOwn = Object.hasOwn;
const NO_PATH: readonly PropertyKey[] = /* @__PURE__ */ Object.freeze([]);

// ---------------------------------------------------------------------------
// Field tables, computed once per field map
// ---------------------------------------------------------------------------

/**
 * Builds the object a validator sees: every field with the changes applied, in field
 * order, leaving out fields with no value. `base` holds the values before the changes:
 * the loaded row, or the object a {@link BeforeBuilder} made.
 */
type ValuesBuilder = (changes: Values, base: Values) => Values;

/**
 * Builds the values before the changes of a changeset that is not of a loaded row (a new
 * record, or one without a schema class): every field, `undefined` where there is none.
 * A default given as a function is called here, once per validation, and the result is
 * shared by the values and `ctx.data`.
 */
type BeforeBuilder = (changeset: AnyChangeset) => Record<string, unknown>;

/** What is derived once from a changeset's field table (one per schema class). */
interface Table {
  /** The fields in field order. */
  readonly list: readonly FieldMeta[];
  readonly build: ValuesBuilder;
  readonly before: BeforeBuilder;
}

const tables = /* @__PURE__ */ new WeakMap<ReadonlyMap<string, FieldMeta>, Table>();
// The table asked for last: a validation in a loop asks for the same one every time.
let lastFields: ReadonlyMap<string, FieldMeta> | undefined;
let lastTable: Table | undefined;

function tableOf(fields: ReadonlyMap<string, FieldMeta>): Table {
  if (fields === lastFields) return lastTable as Table;
  let table = tables.get(fields);
  if (table === undefined) {
    const list = Object.freeze([...fields.values()]);
    // Generated when the schema was defined, or now; loops where the runtime refuses.
    const builders = generatedBuilders(fields);
    table =
      builders === undefined
        ? { list, build: genericBuilder(list), before: genericBefore(list) }
        : { list, build: builders.build, before: builders.before<AnyChangeset>(valueBefore) };
    tables.set(fields, table);
  }
  lastFields = fields;
  lastTable = table;
  return table;
}

/** The value of a field: its change (an own property), else its value before the changes. */
function fieldValue(changes: Values, base: Values, name: string): unknown {
  return hasOwn(changes, name) ? changes[name] : base[name];
}

function genericBuilder(list: readonly FieldMeta[]): ValuesBuilder {
  return (changes, base) => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < list.length; i++) {
      const name = (list[i] as FieldMeta).name;
      const value = fieldValue(changes, base, name);
      if (value !== undefined) out[name] = value;
    }
    return out;
  };
}

function genericBefore(list: readonly FieldMeta[]): BeforeBuilder {
  return (changeset) => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < list.length; i++) {
      const name = (list[i] as FieldMeta).name;
      out[name] = valueBefore(changeset, name);
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** What a validator turned out to be: a Standard Schema's properties, or a function. */
interface Dispatched {
  readonly standard: StandardSchemaV1Props<unknown, unknown> | undefined;
  readonly fn: AnyValidatorFn | undefined;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const type = typeof value;
  if (type === "object") return 'an object without a Standard Schema "~standard" property';
  return type === "undefined" ? "undefined" : `a ${type}`;
}

/**
 * A value with a `"~standard"` property is a Standard Schema, even when it is callable
 * (ArkType's schemas are functions); any other function is a validator function.
 *
 * @throws TypeError for anything else, or a Standard Schema of another version.
 */
function dispatch(validator: unknown, fn: string): Dispatched {
  if ((typeof validator === "object" && validator !== null) || typeof validator === "function") {
    // Read once: some libraries define it as a getter.
    const standard: unknown = (validator as { readonly "~standard"?: unknown })["~standard"];
    if (standard !== undefined) {
      const props = standard as Partial<StandardSchemaV1Props<unknown, unknown>> | null;
      if (
        typeof props !== "object" ||
        props === null ||
        props.version !== 1 ||
        typeof props.validate !== "function"
      ) {
        throw new TypeError(
          `${fn}() takes a Standard Schema of version 1 or a function, but got a "~standard" property of ${
            typeof props === "object" && props !== null && props.version !== 1
              ? `version ${String(props.version)}`
              : describe(props)
          }.`,
        );
      }
      return { standard: props as StandardSchemaV1Props<unknown, unknown>, fn: undefined };
    }
    if (typeof validator === "function") return { standard: undefined, fn: validator as AnyValidatorFn };
  }
  throw new TypeError(
    `${fn}() takes a Standard Schema (a Zod, Valibot, ArkType or Yup schema) or a function, but got ${describe(validator)}.`,
  );
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface Options {
  readonly changedOnly: boolean;
  readonly apply: boolean;
  readonly only: readonly string[] | undefined;
}

const DEFAULT_OPTIONS: Options = /* @__PURE__ */ Object.freeze({
  changedOnly: false,
  apply: false,
  only: undefined,
});

function optionsOf(
  options: ValidateOptions<ChangesetSource> | undefined,
  fields: ReadonlyMap<string, FieldMeta>,
  fn: string,
): Options {
  if (options === undefined) return DEFAULT_OPTIONS;
  if (typeof options !== "object" || options === null) {
    throw new QueryError("query.validateOptions", `${fn}(): the options must be an object.`);
  }
  const scope = own(options, "scope");
  const apply = own(options, "apply");
  const only = own(options, "only");
  if (scope !== undefined && scope !== "all" && scope !== "changed") {
    throw new QueryError("query.validateScope", `${fn}(): scope must be "all" or "changed".`);
  }
  if (apply !== undefined && typeof apply !== "boolean") {
    throw new QueryError("query.validateApply", `${fn}(): apply must be true or false.`);
  }
  if (only !== undefined) {
    if (!Array.isArray(only))
      throw new QueryError("query.validateOnly", `${fn}(): only must be a list of field names.`);
    for (const name of only) checkField(fields, name, fn);
  }
  return { changedOnly: scope === "changed", apply: apply === true, only };
}

function checkField(fields: ReadonlyMap<string, FieldMeta>, name: unknown, fn: string): FieldMeta {
  const field = typeof name === "string" ? fields.get(name) : undefined;
  if (field === undefined) {
    throw typeof name === "string"
      ? new QueryError(
          "query.validateUnknownField",
          `${fn}(): "${name}" is not a field. The fields are: ${[...fields.keys()].join(", ")}.`,
        )
      : new QueryError("query.fieldNameType", `${fn}() takes a field name as a string.`);
  }
  return field;
}

// ---------------------------------------------------------------------------
// What the validator sees
// ---------------------------------------------------------------------------

/**
 * Every field with the changes applied, in field order, as a plain object. A field with
 * no value (a new record's field without a default) is left out rather than set to
 * `undefined`, so that a schema's optional keys accept it.
 */
function valuesOf(changes: Values, table: Table, base: Values, only: readonly string[] | undefined): Values {
  if (only === undefined) return table.build(changes, base);
  const out: Record<string, unknown> = {};
  for (const field of table.list) {
    if (!only.includes(field.name)) continue;
    const value = fieldValue(changes, base, field.name);
    if (value !== undefined) out[field.name] = value;
  }
  return out;
}

/**
 * The values before the changes: the loaded row, or every field's value before the changes
 * (a new record's defaults; for a changeset without a schema class, its data and the
 * defaults of what the data lacks), computed once per validation.
 */
function baseOf(changeset: AnyChangeset, table: Table): Values {
  const data = changeset.data as Values | null;
  return data !== null && changeset.model !== null ? data : table.before(changeset);
}

/** `ctx.data`: the data, or for a new record the (frozen) values before the changes. */
function contextData(changeset: AnyChangeset, base: Values): Values {
  const data = changeset.data as Values | null;
  return data !== null ? data : Object.freeze(base);
}

/** The second argument of a validator function. One per call. */
class Context implements ValidatorContext<Record<string, unknown>> {
  readonly changes: Values;
  readonly action: Action | null;
  readonly isChanged: (field: string) => boolean;
  readonly #changeset: AnyChangeset;
  #data: Values | undefined;

  /** `data` may be left out, and is then built when first read (`validateField`). */
  constructor(changeset: AnyChangeset, data: Values | undefined) {
    const changes = changeset.changes as Values;
    this.changes = changes;
    this.action = changeset.action;
    // A closure, so that `({ isChanged }) => …` works.
    this.isChanged = (field) => hasOwn(changes, field);
    this.#changeset = changeset;
    this.#data = data;
  }

  /** The record before the changes: the row, or for a new record its field defaults. */
  get data(): Values {
    if (this.#data === undefined) {
      const changeset = this.#changeset;
      this.#data = contextData(changeset, baseOf(changeset, tableOf(fieldsOf(changeset))));
    }
    return this.#data;
  }
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}

/** A promise that is about to be refused: keep its rejection from going unhandled. */
function discard(value: PromiseLike<unknown>): void {
  value.then(undefined, () => undefined);
}

/** The issues of a Standard Schema result, or `undefined` when it succeeded. */
function standardIssues(result: unknown, fn: string): readonly unknown[] | undefined {
  if (typeof result !== "object" || result === null) {
    throw new TypeError(
      `${fn}(): the Standard Schema's validate() returned ${describe(result)}, not a result.`,
    );
  }
  const issues = (result as { readonly issues?: unknown }).issues;
  if (issues === undefined) return undefined;
  if (!Array.isArray(issues)) {
    throw new TypeError(`${fn}(): the Standard Schema's validate() returned issues that are not a list.`);
  }
  return issues;
}

/**
 * The issues a validator function returned, or `undefined` for none. An array (empty or
 * not) and nothing (`undefined`) are accepted.
 *
 * @throws TypeError for anything else: `null`, a single issue without its array, a
 *   string, a number, any other object. Such a result is a mistake in the function, and
 *   counting it as "no issues" would let an invalid changeset through.
 */
function functionIssues(result: unknown, fn: string, field: boolean): readonly unknown[] | undefined {
  if (Array.isArray(result)) return result.length > 0 ? result : undefined;
  if (result === undefined) return undefined;
  throw new TypeError(
    `${fn}(): a validator function must return an array of issues, such as ${
      field ? FIELD_ISSUE_EXAMPLE : ISSUE_EXAMPLE
    }, or nothing, but it returned ${describeResult(result)}.`,
  );
}

const ISSUE_EXAMPLE = '[{ path: "email", message: "is invalid" }]';
const FIELD_ISSUE_EXAMPLE = '[{ path: [], message: "is invalid" }]';
const SHOWN_LENGTH = 60;

/**
 * `text` cut to {@link SHOWN_LENGTH} code units with a `…` mark, one unit shorter when the
 * cut would split a surrogate pair (which would show as an escaped lone surrogate).
 */
function shorten(text: string): string {
  if (text.length <= SHOWN_LENGTH) return text;
  const last = text.charCodeAt(SHOWN_LENGTH - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? SHOWN_LENGTH - 1 : SHOWN_LENGTH;
  return `${text.slice(0, end)}…`;
}

/** What a validator function returned instead of an array, for the error message. */
function describeResult(result: unknown): string {
  switch (typeof result) {
    case "string":
      return `the string ${JSON.stringify(shorten(result))}`;
    case "number":
    case "bigint":
    case "boolean":
      return `the ${typeof result} ${String(result)}`;
    case "object":
      if (result === null) return "null";
      return typeof (result as { readonly message?: unknown }).message === "string"
        ? "a single issue, not an array. Put it in an array: return [issue]"
        : "an object that is not an array";
    default:
      return `a ${typeof result}`;
  }
}

function isKey(value: unknown): value is PropertyKey {
  return typeof value === "string" || typeof value === "number" || typeof value === "symbol";
}

/**
 * A path as a plain list of keys: `{ key }` segments unwrapped, a single key wrapped. The
 * list is the library's own only when it is a plain array of keys (some libraries hand
 * out array subclasses with extra properties, which would not serialise as a list).
 */
function pathOf(raw: unknown, fn: string): readonly PropertyKey[] {
  if (raw === undefined) return NO_PATH;
  if (!Array.isArray(raw)) {
    if (isKey(raw)) return [raw];
    throw new TypeError(
      `${fn}(): an issue's path must be a key or a list of keys, but got ${describe(raw)}.`,
    );
  }
  let out: PropertyKey[] | undefined = Object.getPrototypeOf(raw) === Array.prototype ? undefined : [];
  for (let i = 0; i < raw.length; i++) {
    const segment: unknown = raw[i];
    if (isKey(segment)) {
      if (out !== undefined) out.push(segment);
      continue;
    }
    const key: unknown =
      typeof segment === "object" && segment !== null
        ? (segment as { readonly key?: unknown }).key
        : undefined;
    if (!isKey(key)) {
      throw new TypeError(
        `${fn}(): an issue's path holds ${describe(segment)}, which is not a key or { key }.`,
      );
    }
    out ??= raw.slice(0, i) as PropertyKey[];
    out.push(key);
  }
  return out ?? (raw as readonly PropertyKey[]);
}

interface Issue {
  readonly message: string;
  readonly path: readonly PropertyKey[];
  readonly meta: Values | undefined;
}

function issueOf(raw: unknown, fn: string): Issue {
  if (typeof raw !== "object" || raw === null || typeof (raw as { message?: unknown }).message !== "string") {
    throw new TypeError(
      `${fn}(): a validator must return a list of issues ({ path, message, meta? }), but one of them is ${describe(raw)}.`,
    );
  }
  const { message, path, meta } = raw as {
    readonly message: string;
    readonly path?: unknown;
    readonly meta?: unknown;
  };
  if (meta !== undefined && (typeof meta !== "object" || meta === null)) {
    throw new TypeError(`${fn}(): an issue's meta must be an object.`);
  }
  return { message, path: pathOf(path, fn), meta: meta as Values | undefined };
}

function schemaError(
  message: string,
  path: readonly PropertyKey[],
  meta: Values | undefined,
): ChangesetError {
  return { message, validation: "schema", meta: meta === undefined ? { path } : { path, ...meta } };
}

/** Appends `error` to the list of `key`. */
function collect(added: Map<string, ChangesetError[]>, key: string, error: ChangesetError): void {
  const list = added.get(key);
  if (list === undefined) added.set(key, [error]);
  else list.push(error);
}

/** The changeset with the collected errors appended after its own, in issue order. */
function withAdded<C extends AnyChangeset>(changeset: C, added: Map<string, ChangesetError[]>): C {
  if (added.size === 0) return changeset;
  const errors: Record<string, readonly ChangesetError[]> = { ...changeset.errors };
  for (const [key, list] of added) {
    const existing = hasOwn(errors, key) ? errors[key] : undefined;
    errors[key] = existing === undefined ? list : [...existing, ...list];
  }
  return rebuild(changeset, { errors, valid: false });
}

/** Issues whose path leads into a nested changeset: by key, then by the child's position (-1 for a to-one child). */
type Routed = Map<string, Map<number, Issue[]>>;

/**
 * Routes whole-changeset issues by the first segment of their path: to a field, to a
 * nested changeset (an association or embed changed through `castAssoc`, `putAssoc`,
 * `castEmbed` or `putEmbed`, by position for a list), or to `BASE`. An issue on a field
 * that already has an error is dropped (in a nested changeset, on the child's field).
 */
function mapIssues(
  changeset: AnyChangeset,
  fields: ReadonlyMap<string, FieldMeta>,
  issues: readonly unknown[],
  options: Options,
  fn: string,
): { readonly added: Map<string, ChangesetError[]>; readonly routed: Routed | undefined } {
  const added = new Map<string, ChangesetError[]>();
  let routed: Routed | undefined;
  const changes = changeset.changes as Values;
  // The errors from before this validator ran: a field that has one already gets no more.
  const errors = changeset.errors;
  for (const raw of issues) {
    const issue = issueOf(raw, fn);
    const { message, path, meta } = issue;
    const head = path[0];
    const into = typeof head === "string" ? childOf(changeset, head, path) : undefined;
    if (into !== undefined && (options.only === undefined || options.only.includes(head as string))) {
      // An issue on the key itself (`["venue"]`), where the key already has an error, is
      // dropped like an issue on a field: the key keeps its first message.
      if (path.length === 1 && hasOwn(errors, head as string)) continue;
      routed ??= new Map();
      let byIndex = routed.get(head as string);
      if (byIndex === undefined) {
        byIndex = new Map();
        routed.set(head as string, byIndex);
      }
      const list = byIndex.get(into.index);
      const moved: Issue = { message, path: into.rest, meta };
      if (list === undefined) byIndex.set(into.index, [moved]);
      else list.push(moved);
      continue;
    }
    if (typeof head === "string" && fields.has(head)) {
      // One message per field: the first failure (cast, validateRequired, an earlier
      // validator) stands, and later issues on the field are dropped.
      if (hasOwn(errors, head)) continue;
      if (options.changedOnly && !hasOwn(changes, head)) continue;
      if (options.only !== undefined && !options.only.includes(head)) continue;
      collect(added, head, schemaError(message, path.length === 1 ? NO_PATH : path.slice(1), meta));
    } else {
      // The record as a whole, or a key that is not a field: kept with its whole path.
      collect(added, BASE, schemaError(message, path, meta));
    }
  }
  return { added, routed };
}

/**
 * The child changeset an issue's path leads into, and the rest of the path: `[key, …]`
 * for a to-one nested change, `[key, position, …]` for a list (positions count the
 * children that stay, as the validator saw them). `undefined` when the path leads into
 * no nested changeset.
 */
function childOf(
  changeset: AnyChangeset,
  head: string,
  path: readonly PropertyKey[],
): { readonly index: number; readonly rest: readonly PropertyKey[] } | undefined {
  const changes = changeset.changes as Values;
  if (!hasOwn(changes, head)) return undefined;
  const value = changes[head];
  if (value instanceof Changeset) return { index: -1, rest: path.slice(1) };
  if (!Array.isArray(value) || !isNestedValue(value)) return undefined;
  const at = path[1];
  const position = typeof at === "number" ? at : typeof at === "string" && /^\d+$/.test(at) ? Number(at) : -1;
  if (position < 0) return undefined;
  const stay = staying(changeset, head, value);
  const index = stay[position];
  return index === undefined ? undefined : { index, rest: path.slice(2) };
}

/** The positions in `list` of the children that stay in the relation (not deleted or unlinked). */
function staying(changeset: AnyChangeset, key: string, list: readonly unknown[]): number[] {
  const relation = nestedRelation(changeset, key);
  const out: number[] = [];
  list.forEach((item, i) => {
    if (!(item instanceof Changeset) || relation === undefined || !leaves(relation, item as AnyChangeset))
      out.push(i);
  });
  return out;
}

function nestedRelation(changeset: AnyChangeset, key: string): Relation | undefined {
  if (fieldsOf(changeset).has(key)) return relationOf(changeset, key, "validate", "embed");
  return changeset.model === null ? undefined : relationOf(changeset, key, "validate", "assoc");
}

/** The changeset with its own issues added and the routed ones given to its children. */
function applyIssues<C extends AnyChangeset>(
  changeset: C,
  issues: { readonly added: Map<string, ChangesetError[]>; readonly routed: Routed | undefined },
  options: Options,
  fn: string,
): C {
  let out = withAdded(changeset, issues.added);
  if (issues.routed === undefined) return out;
  const childOptions: Options = { changedOnly: options.changedOnly, apply: false, only: undefined };
  const changes: Record<string, unknown> = { ...(out.changes as Values) };
  for (const [key, byIndex] of issues.routed) {
    const value = changes[key];
    const list = Array.isArray(value) ? value.slice() : undefined;
    for (const [index, routed] of byIndex) {
      const child = (list === undefined ? value : list[index]) as AnyChangeset;
      const next = applyIssues(
        child,
        mapIssues(child, fieldsOf(child), routed, childOptions, fn),
        childOptions,
        fn,
      );
      if (list === undefined) changes[key] = next;
      else list[index] = next;
    }
    if (list !== undefined) changes[key] = list;
  }
  // Valid again only if nothing is wrong anywhere: a child may have dropped every issue
  // routed to it (scope "changed").
  let own = true;
  for (const key in out.errors) if (hasOwn(out.errors, key)) own = false;
  out = rebuild(out, { changes, valid: own && nestedValid(changes) });
  return out;
}

/**
 * The values a validator sees, with each nested change given as the values of its
 * children (in the form a validator sees a changeset's values; children that leave the
 * relation are left out of a list). An association appears only when it has a change.
 */
function withNested(changeset: AnyChangeset, values: Values, only: readonly string[] | undefined): Values {
  const changes = changeset.changes as Values;
  const fields = fieldsOf(changeset);
  let out: Record<string, unknown> | undefined;
  for (const key in changes) {
    if (!hasOwn(changes, key)) continue;
    const value = changes[key];
    if (fields.has(key)) {
      if (!isNestedValue(value) || (only !== undefined && !only.includes(key))) continue;
    } else if (only !== undefined) continue;
    let nested: unknown;
    if (value instanceof Changeset) nested = childValues(value as AnyChangeset);
    else if (Array.isArray(value)) {
      const stay = staying(changeset, key, value);
      nested = stay.map((i) => {
        const item: unknown = value[i];
        return item instanceof Changeset ? childValues(item as AnyChangeset) : item;
      });
    } else nested = value;
    out ??= { ...values };
    out[key] = nested;
  }
  return out ?? values;
}

function childValues(child: AnyChangeset): Values {
  const table = tableOf(fieldsOf(child));
  return withNested(
    child,
    valuesOf(child.changes as Values, table, baseOf(child, table), undefined),
    undefined,
  );
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

function same(field: FieldMeta, a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return field.type.equal(a, b);
}

/**
 * Records each field of `output` as a change when it differs from the field's current
 * value. Each value is first cast with the field's type, as `cast` would cast input: a
 * value the type rejects (a transform that turned a string into a number) becomes a
 * `cast` error on the field and is not written.
 */
function applyOutput<C extends AnyChangeset>(
  changeset: C,
  fields: ReadonlyMap<string, FieldMeta>,
  output: unknown,
): C {
  if (typeof output !== "object" || output === null) return changeset;
  let next = changeset;
  let rejected: Map<string, ChangesetError[]> | undefined;
  const out = output as Values;
  for (const key of Object.keys(out)) {
    const field = fields.get(key);
    const value = out[key];
    if (field === undefined || value === undefined) continue;
    let converted: unknown = value;
    if (value !== null) {
      const result = field.type.cast(value);
      if (!result.success) {
        // Not written either way; a field that already has an error gets no second one.
        if (hasOwn(changeset.errors, key)) continue;
        const failureMeta = own(result, "meta");
        const meta =
          failureMeta === undefined ? { type: field.type.name } : { type: field.type.name, ...failureMeta };
        rejected ??= new Map();
        collect(rejected, key, { message: own(result, "message") ?? "is invalid", validation: "cast", meta });
        continue;
      }
      converted = result.data;
    }
    const changes = next.changes as Values;
    const current = hasOwn(changes, key) ? changes[key] : valueBefore(next, key);
    if (same(field, current, converted)) continue;
    next = next.putChange(key, converted as never) as C;
  }
  return rejected === undefined ? next : withAdded(next, rejected);
}

// ---------------------------------------------------------------------------
// validate / validateAsync
// ---------------------------------------------------------------------------

interface Run {
  readonly dispatched: Dispatched;
  readonly options: Options;
  readonly fields: ReadonlyMap<string, FieldMeta>;
}

function start(
  changeset: AnyChangeset,
  validator: unknown,
  options: ValidateOptions<ChangesetSource> | undefined,
  fn: string,
): Run {
  const dispatched = dispatch(validator, fn);
  const fields = fieldsOf(changeset);
  const checked = optionsOf(options, fields, fn);
  if (checked.apply && dispatched.standard === undefined) {
    throw new QueryError(
      "query.validateApplyFunction",
      `${fn}(): apply needs a Standard Schema, whose output is written back.`,
    );
  }
  if (checked.apply && (checked.only !== undefined || checked.changedOnly)) {
    // A schema that reports any issue has no output. With these options the issues that
    // stopped it may be dropped, which would leave a valid changeset whose transform
    // silently did not happen.
    throw new QueryError(
      "query.validateApplyCombined",
      `${fn}(): apply cannot be combined with ${checked.only !== undefined ? "only" : 'scope: "changed"'}.`,
    );
  }
  return { dispatched, options: checked, fields };
}

function call(changeset: AnyChangeset, run: Run): unknown {
  const table = tableOf(run.fields);
  const base = baseOf(changeset, table);
  const values = withNested(
    changeset,
    valuesOf(changeset.changes as Values, table, base, run.options.only),
    run.options.only,
  );
  const { standard, fn } = run.dispatched;
  if (standard !== undefined) return standard.validate(values);
  return (fn as ValidatorFn<Values>)(values, new Context(changeset, contextData(changeset, base)));
}

function finish<C extends AnyChangeset>(
  changeset: C,
  run: Run,
  result: unknown,
  validator: unknown,
  options: unknown,
  fn: string,
): C {
  const recorded = addValidation(changeset, "$schema", { validator, opts: options });
  const standard = run.dispatched.standard !== undefined;
  const issues = standard ? standardIssues(result, fn) : functionIssues(result, fn, false);
  if (issues === undefined || issues.length === 0) {
    return standard && run.options.apply
      ? applyOutput(recorded, run.fields, (result as { readonly value?: unknown }).value)
      : recorded;
  }
  return applyIssues(recorded, mapIssues(changeset, run.fields, issues, run.options, fn), run.options, fn);
}

/**
 * Runs `validator` on the changeset's values and returns the changeset with its issues
 * as errors.
 *
 * @example
 * ```ts
 * const checked = validateChangeset(cs, UserInput, undefined);
 * ```
 *
 * @throws TypeError when `validator` is neither a Standard Schema nor a function, or when
 *   a validator function returns something other than an array of issues or nothing
 *   (`undefined`), such as `null`, a single issue without its array or a string.
 * @throws QueryError when the validator answers with a promise, or an option is wrong.
 */
export function validateChangeset<C extends AnyChangeset>(
  changeset: C,
  validator: unknown,
  options: ValidateOptions<ChangesetSource> | undefined,
): C {
  const run = start(changeset, validator, options, "validate");
  const result = call(changeset, run);
  if (isThenable(result)) {
    discard(result);
    throw new QueryError("query.validatorPromise", "The validator returned a Promise.");
  }
  return finish(changeset, run, result, validator, options, "validate");
}

/**
 * Like {@link validateChangeset}, for validators that may answer with a promise.
 *
 * @example
 * ```ts
 * const checked = await validateChangesetAsync(cs, async (v) => [], undefined);
 * ```
 *
 * @throws TypeError (as a rejected promise) in the cases {@link validateChangeset} throws
 *   it, including a function whose promise resolves to something other than an array of
 *   issues or nothing.
 */
export async function validateChangesetAsync<C extends AnyChangeset>(
  changeset: C,
  validator: unknown,
  options: ValidateOptions<ChangesetSource> | undefined,
): Promise<C> {
  const run = start(changeset, validator, options, "validateAsync");
  const result: unknown = await call(changeset, run);
  return finish(changeset, run, result, validator, options, "validateAsync");
}

// ---------------------------------------------------------------------------
// validateField / validateFieldAsync
// ---------------------------------------------------------------------------

/**
 * The field's change, or `undefined` when there is nothing to validate: no change, a
 * change to `null`, or an error on the field already (one message per field).
 */
function changeOf(changeset: AnyChangeset, field: string): unknown {
  const changes = changeset.changes as Values;
  return hasOwn(changes, field) && !hasOwn(changeset.errors, field) ? changes[field] : undefined;
}

function callField(changeset: AnyChangeset, dispatched: Dispatched, value: unknown): unknown {
  if (dispatched.standard !== undefined) return dispatched.standard.validate(value);
  return (dispatched.fn as FieldValidatorFn<unknown, Values>)(value, new Context(changeset, undefined));
}

function finishField<C extends AnyChangeset>(
  changeset: C,
  field: string,
  standard: boolean,
  result: unknown,
  validator: unknown,
  fn: string,
): C {
  const recorded = addValidation(changeset, field, { schema: validator });
  const issues = standard ? standardIssues(result, fn) : functionIssues(result, fn, true);
  if (issues === undefined || issues.length === 0) return recorded;
  const added = new Map<string, ChangesetError[]>();
  for (const raw of issues) {
    const { message, path, meta } = issueOf(raw, fn);
    collect(added, field, schemaError(message, path, meta));
  }
  return withAdded(recorded, added);
}

/**
 * Runs `validator` on the change of one field (skipped when the field has no change, a
 * change to `null`, or an error already); every issue goes on that field.
 *
 * @example
 * ```ts
 * const checked = validateFieldOf(cs, "email", z.string().email());
 * ```
 *
 * @throws TypeError when `validator` is neither a Standard Schema nor a function, or when
 *   a validator function returns something other than an array of issues or nothing
 *   (`undefined`), such as `null`, a single issue without its array or a string.
 * @throws QueryError when `field` is not a field, or the validator answers with a promise.
 */
export function validateFieldOf<C extends AnyChangeset>(changeset: C, field: string, validator: unknown): C {
  const dispatched = dispatch(validator, "validateField");
  checkField(fieldsOf(changeset), field, "validateField");
  const value = changeOf(changeset, field);
  if (value === undefined || value === null) return addValidation(changeset, field, { schema: validator });
  const result = callField(changeset, dispatched, value);
  if (isThenable(result)) {
    discard(result);
    throw new QueryError(
      "query.fieldValidatorPromise",
      `The field validator of "${field}" returned a Promise.`,
    );
  }
  return finishField(changeset, field, dispatched.standard !== undefined, result, validator, "validateField");
}

/**
 * Like {@link validateFieldOf}, for validators that may answer with a promise.
 *
 * @example
 * ```ts
 * const checked = await validateFieldOfAsync(cs, "email", async (email) => []);
 * ```
 *
 * @throws TypeError (as a rejected promise) in the cases {@link validateFieldOf} throws
 *   it, including a function whose promise resolves to something other than an array of
 *   issues or nothing.
 */
export async function validateFieldOfAsync<C extends AnyChangeset>(
  changeset: C,
  field: string,
  validator: unknown,
): Promise<C> {
  const dispatched = dispatch(validator, "validateFieldAsync");
  checkField(fieldsOf(changeset), field, "validateFieldAsync");
  const value = changeOf(changeset, field);
  if (value === undefined || value === null) return addValidation(changeset, field, { schema: validator });
  const result: unknown = await callField(changeset, dispatched, value);
  return finishField(
    changeset,
    field,
    dispatched.standard !== undefined,
    result,
    validator,
    "validateFieldAsync",
  );
}
