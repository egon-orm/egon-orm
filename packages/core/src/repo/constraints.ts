/**
 * How a write turns a database constraint violation into a changeset error.
 *
 * When the adapter raises a `ConstraintError`, the changeset's declarations are searched in
 * the order they were made for one that matches it by **type** and by **name**:
 *
 * - type: a declared `foreignKey` or `noAssoc` constraint matches a `foreignKey`
 *   violation; `unique`, `check` and `exclusion` match their own; a `notNull` violation
 *   matches nothing (the insert's required-field check runs before any SQL);
 * - name: the declaration's `name` compared with the name the database reported, per its
 *   `match`: the whole name (`exact`), its end (`suffix`) or its start (`prefix`).
 *
 * A match becomes a failure: the declared message on the declared key, with `constraint`
 * (the declared type) and `constraintName` (the declared name) in its metadata. No match
 * rethrows the violation as a `ConstraintError` whose message names the declaration to
 * add.
 *
 * @module
 */
import { type Changeset, withAction, withErrors } from "../changeset/changeset.js";
import type { Action, ChangesetError, Constraint, ConstraintType } from "../contracts/changeset.js";
import type { AnySchema, SchemaMeta } from "../contracts/schema.js";
import { ConstraintError, type ConstraintViolationType } from "../errors.js";
import { frozenOptions } from "../internal/own.js";
import { meta } from "../schema/schema.js";

/** A changeset of any source, as the repo handles it. */
type AnyChangeset = Changeset<AnySchema, boolean>;

/** The declared types that a violation of each type can match. */
const MATCHING_TYPES: Readonly<Record<ConstraintViolationType, readonly ConstraintType[]>> =
  /* @__PURE__ */ frozenOptions({
    unique: ["unique"],
    foreignKey: ["foreignKey", "noAssoc"],
    check: ["check"],
    exclusion: ["exclusion"],
    notNull: [],
  });

/**
 * Whether a declared constraint name matches the name the database reported.
 *
 * @example
 * ```ts
 * nameMatches({ name: "_email_key", match: "suffix" } as Constraint, "users_2026_email_key"); // true
 * ```
 */
export function nameMatches(declared: Pick<Constraint, "name" | "match">, reported: string): boolean {
  switch (declared.match) {
    case "suffix":
      return reported.endsWith(declared.name);
    case "prefix":
      return reported.startsWith(declared.name);
    default:
      return reported === declared.name;
  }
}

// ---------------------------------------------------------------------------
// Names the database shortened
// ---------------------------------------------------------------------------

const encoder = /* @__PURE__ */ new TextEncoder();
const decoder = /* @__PURE__ */ new TextDecoder();

/** `text` cut to at most `bytes` bytes of UTF-8, never inside a character. */
export function clipBytes(text: string, bytes: number): string {
  const encoded = encoder.encode(text);
  if (encoded.length <= bytes) return text;
  let end = Math.max(0, bytes);
  while (end > 0 && ((encoded[end] as number) & 0xc0) === 0x80) end--;
  return decoder.decode(encoded.subarray(0, end));
}

/**
 * The name Postgres gives a constraint from a table name, a column part and a label
 * (`users`, `org_id_slug`, `key`) when the whole is longer than `maxBytes`: it shortens
 * whichever of the two parts is longer, a byte at a time, until `<table>_<columns>_<label>`
 * fits, then cuts each part at a character boundary.
 *
 * @example
 * ```ts
 * shortenedName("a".repeat(40), "b".repeat(40), "key", 63); // 29 a's, "_", 29 b's, "_key"
 * ```
 */
export function shortenedName(table: string, columns: string, label: string, maxBytes: number): string {
  let tableBytes = encoder.encode(table).length;
  let columnBytes = encoder.encode(columns).length;
  const available = maxBytes - (label.length + 1) - 1;
  while (tableBytes + columnBytes > available) {
    if (tableBytes > columnBytes) tableBytes--;
    else columnBytes--;
  }
  return `${clipBytes(table, tableBytes)}_${clipBytes(columns, columnBytes)}_${label}`;
}

/** The suffix of each declared type's default name; a check constraint has none. */
const LABELS: Readonly<Record<ConstraintType, string | undefined>> = /* @__PURE__ */ frozenOptions({
  unique: "key",
  foreignKey: "fkey",
  noAssoc: "fkey",
  exclusion: "excl",
  check: undefined,
});

/**
 * Where names are shortened: the dialect's identifier limit in bytes (`undefined` when it
 * shortens none), and the tables a default name may start with (the changeset's own, and
 * the table the database reported, which is the child's for a `noAssoc` violation).
 */
export interface NameLimits {
  readonly maxBytes: number | undefined;
  readonly tables: readonly (string | null | undefined)[];
}

/**
 * The names a declaration with `match: "exact"` stands for: its own and, when that is
 * longer than the dialect keeps, the name cut to the limit and, for a default name
 * (`<table>_<columns>_<label>`), the name the database makes of it.
 */
function exactNames(declared: Constraint, limits: NameLimits | undefined): readonly string[] {
  const maxBytes = limits?.maxBytes;
  const name = declared.name;
  if (maxBytes === undefined || encoder.encode(name).length <= maxBytes) return [name];
  const names = [name, clipBytes(name, maxBytes)];
  const label = LABELS[declared.type];
  if (label === undefined) return names;
  for (const table of limits?.tables ?? []) {
    if (typeof table !== "string") continue;
    const head = `${table}_`;
    const tail = `_${label}`;
    if (name.startsWith(head) && name.endsWith(tail) && name.length > head.length + tail.length) {
      names.push(shortenedName(table, name.slice(head.length, name.length - tail.length), label, maxBytes));
    }
  }
  return names;
}

/**
 * The first declaration of `constraints` that matches the violation, or `undefined`.
 * With `limits`, a declaration whose (default) name is longer than the dialect keeps also
 * matches the shortened name the database reports.
 *
 * @example
 * ```ts
 * const declared = findConstraint(cs.constraints, violation);
 * ```
 */
export function findConstraint(
  constraints: readonly Constraint[],
  violation: ConstraintError,
  limits?: NameLimits,
): Constraint | undefined {
  const reported = violation.constraint;
  if (reported === undefined) return undefined;
  const types = MATCHING_TYPES[violation.type] ?? [];
  for (const declared of constraints) {
    if (!types.includes(declared.type)) continue;
    if (
      declared.match === "exact"
        ? exactNames(declared, limits).includes(reported)
        : nameMatches(declared, reported)
    ) {
      return declared;
    }
  }
  return undefined;
}

/**
 * The error a matched declaration puts on the changeset.
 *
 * @example
 * ```ts
 * constraintError(declared); // { message: "has already been taken", constraint: "unique", meta: { … } }
 * ```
 */
export function constraintError(declared: Constraint): ChangesetError {
  return {
    message: declared.message,
    constraint: declared.type,
    meta: { constraint: declared.type, constraintName: declared.name },
  };
}

/**
 * What a write does with a `ConstraintError`: the failed changeset (its action set) when a
 * declaration matches; otherwise it throws the violation again, with a message that says
 * which declaration to add.
 *
 * @example
 * ```ts
 * try { await execute(); } catch (error) {
 *   if (error instanceof ConstraintError) return failure(handleViolation(cs, error, "insert"));
 *   throw error;
 * }
 * ```
 *
 * @throws ConstraintError when no declaration matches.
 */
export function handleViolation<C extends AnyChangeset>(
  changeset: C,
  violation: ConstraintError,
  action: Action,
  maxBytes?: number,
): C {
  const table = changeset.model === null ? undefined : meta(changeset.model).source;
  const declared = findConstraint(changeset.constraints, violation, {
    maxBytes,
    tables: [table, violation.table],
  });
  if (declared === undefined) throw unhandledViolation(changeset, violation, action);
  return withErrors(withAction(changeset, action), declared.field, [constraintError(declared)]);
}

// ---------------------------------------------------------------------------
// The message of an unhandled violation
// ---------------------------------------------------------------------------

const VIOLATION_WORDS: Readonly<Record<ConstraintViolationType, string>> = /* @__PURE__ */ frozenOptions({
  unique: "unique",
  foreignKey: "foreign-key",
  check: "check",
  exclusion: "exclusion",
  notNull: "not-null",
});

/** "insert into", "update of", "delete from". */
function actionPhrase(action: Action): string {
  switch (action) {
    case "insert":
      return "insert into";
    case "delete":
      return "delete from";
    default:
      return `${action} of`;
  }
}

/**
 * The fields whose columns, joined with `_`, are `joined`, in that order; `undefined`
 * when no sequence of the schema's columns spells it. A column may itself hold `_`, so
 * every way of splitting is tried.
 */
function fieldsSpelling(schemaMeta: SchemaMeta, joined: string): readonly string[] | undefined {
  const search = (position: number): string[] | undefined => {
    // Reached only after a trailing "_": an empty column name, so not a spelling.
    if (position === joined.length) return undefined;
    for (const field of schemaMeta.persisted) {
      const column = field.column;
      if (!joined.startsWith(column, position)) continue;
      const end = position + column.length;
      if (end === joined.length) return [field.name];
      if (joined[end] !== "_") continue;
      const rest = search(end + 1);
      if (rest !== undefined) return [field.name, ...rest];
    }
    return undefined;
  };
  return joined === "" ? undefined : search(0);
}

/**
 * The fields a default constraint name `<table>_<columns>_<suffix>` names, or `undefined`
 * when `name` is not such a name for this table.
 */
function fieldsOfDefaultName(
  schemaMeta: SchemaMeta,
  name: string,
  suffix: string,
): readonly string[] | undefined {
  const table = schemaMeta.source;
  if (table === null) return undefined;
  const head = `${table}_`;
  const tail = `_${suffix}`;
  if (!name.startsWith(head) || !name.endsWith(tail) || name.length <= head.length + tail.length) {
    return undefined;
  }
  return fieldsSpelling(schemaMeta, name.slice(head.length, name.length - tail.length));
}

/** `"email"` or `["orgId", "slug"]`, as the declaration's first argument is written. */
function argument(fields: readonly string[]): string {
  return fields.length === 1
    ? JSON.stringify(fields[0])
    : `[${fields.map((f) => JSON.stringify(f)).join(", ")}]`;
}

/**
 * The association of `schemaMeta` whose rows sit in `table` and point at this one through
 * the foreign key named `name` (`<table>_<columns>_fkey`), or failing that the only one
 * whose rows sit in `table`: what `noAssocConstraint` takes.
 */
function referencingAssoc(
  schemaMeta: SchemaMeta,
  table: string | undefined,
  name: string,
): { readonly assoc: string; readonly isDefault: boolean } | undefined {
  const candidates: string[] = [];
  for (const assoc of schemaMeta.assocs().values()) {
    if ((assoc.kind !== "hasOne" && assoc.kind !== "hasMany") || assoc.through !== undefined) continue;
    const target = meta(assoc.target());
    if (target.source === null || (table !== undefined && target.source !== table)) continue;
    const columns = assoc.relatedKey.map((key) => target.fieldsByName.get(key)?.column ?? key);
    if (name === `${target.source}_${columns.join("_")}_fkey`) return { assoc: assoc.name, isDefault: true };
    candidates.push(assoc.name);
  }
  return candidates.length === 1 ? { assoc: candidates[0] as string, isDefault: false } : undefined;
}

/**
 * The declaration that would have handled the violation: its default form when the
 * reported name is the default name of a declaration on this changeset's fields, and the
 * form with `{ name }` (always valid).
 */
function suggestion(
  schemaMeta: SchemaMeta,
  violation: ConstraintError,
  action: Action,
  name: string,
): { readonly plain: string | undefined; readonly named: string } {
  const quoted = JSON.stringify(name);
  switch (violation.type) {
    case "unique": {
      const fields = fieldsOfDefaultName(schemaMeta, name, "key");
      const first = fields === undefined ? '"<field>"' : argument(fields);
      return {
        plain: fields === undefined ? undefined : `.uniqueConstraint(${first})`,
        named: `.uniqueConstraint(${first}, { name: ${quoted} })`,
      };
    }
    case "foreignKey": {
      if (action === "delete") {
        const found = referencingAssoc(schemaMeta, violation.table, name);
        const first = found === undefined ? '"<association>"' : JSON.stringify(found.assoc);
        return {
          plain: found?.isDefault === true ? `.noAssocConstraint(${first})` : undefined,
          named: `.noAssocConstraint(${first}, { name: ${quoted} })`,
        };
      }
      const fields = fieldsOfDefaultName(schemaMeta, name, "fkey");
      const single = fields !== undefined && fields.length === 1 ? JSON.stringify(fields[0]) : undefined;
      const first = single ?? '"<field>"';
      return {
        plain: single === undefined ? undefined : `.foreignKeyConstraint(${single})`,
        named: `.foreignKeyConstraint(${first}, { name: ${quoted} })`,
      };
    }
    case "check": {
      const fields = fieldsOfDefaultName(schemaMeta, name, "check");
      const first = fields !== undefined && fields.length === 1 ? JSON.stringify(fields[0]) : '"<field>"';
      return { plain: undefined, named: `.checkConstraint(${first}, { name: ${quoted} })` };
    }
    default: {
      const fields = fieldsOfDefaultName(schemaMeta, name, "excl");
      const single = fields !== undefined && fields.length === 1 ? JSON.stringify(fields[0]) : undefined;
      return {
        plain: single === undefined ? undefined : `.exclusionConstraint(${single})`,
        named: `.exclusionConstraint(${single ?? '"<field>"'}, { name: ${quoted} })`,
      };
    }
  }
}

/**
 * The violation to throw when no declaration matched: the same `ConstraintError` facts
 * (type, name, table, column, detail, SQL, and the driver's error as `cause`), with a
 * message that names the call to add. A not-null violation is rethrown as it is: it is
 * not something a declaration handles.
 *
 * @example
 * ```ts
 * unhandledViolation(cs, violation, "insert").message;
 * // constraint.undeclared: unique constraint "users_email_key" violated on insert into "users".
 * // The changeset has not defined this constraint. See …
 * // (with full messages: Add: .uniqueConstraint("email") (or .uniqueConstraint("email", { name: "users_email_key" })))
 * ```
 */
export function unhandledViolation(
  changeset: AnyChangeset,
  violation: ConstraintError,
  action: Action,
): ConstraintError {
  const name = violation.constraint;
  if (violation.type === "notNull" || name === undefined || changeset.model === null) return violation;
  const schemaMeta = meta(changeset.model);
  const { plain, named } = suggestion(schemaMeta, violation, action, name);
  const first = `${VIOLATION_WORDS[violation.type]} constraint ${JSON.stringify(name)} violated on ${actionPhrase(action)} ${JSON.stringify(schemaMeta.source)}.`;
  const add = plain === undefined ? named : `${plain}\n(or ${named})`;
  return new ConstraintError({
    type: violation.type,
    constraint: violation.constraint,
    table: violation.table,
    column: violation.column,
    detail: violation.detail,
    id: "constraint.undeclared",
    message: `${first} The changeset has not defined this constraint.`,
    params: { add },
    ...(violation.sql === undefined ? {} : { sql: violation.sql }),
    cause: violation.cause,
  });
}
