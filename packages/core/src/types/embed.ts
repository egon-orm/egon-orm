/**
 * The type of an embed field: one embedded row, or a list of them, stored in one JSON
 * column of the parent (`jsonb` on Postgres).
 *
 * Each embedded field is written with its own type and then as JSON: a `Date` as an ISO
 * string, a `bigint` as a string of digits, bytes as base64. Reading builds the embedded
 * rows with the embedded schema's row factory (no constructor runs): keys that are not
 * fields are ignored, and a missing key takes the field's default (or `null` for a
 * nullable field). The JSON keys are the embedded fields' column names (their field
 * names unless the embedded schema says otherwise).
 *
 * @module
 */
import type { AnySchema, FieldMeta, OnReplace, RowMeta, SchemaMeta } from "../contracts/schema.js";
import type { AnyFieldType, CastResult, DbType, FieldType } from "../contracts/type.js";
import { IDENTITY } from "../contracts/type.js";
import { CastError } from "../errors.js";
import { deepEqual } from "../internal/deep-equal.js";
import { setOwn } from "../internal/own.js";
import { isPlainObject } from "../internal/plain-object.js";
import { meta } from "../schema/schema.js";
import { detached } from "./define.js";
import { INVALID } from "./scalars.js";

const hasOwn = Object.hasOwn;

/**
 * What an embed type knows: one row or a list of them, and the embedded schema class
 * (looked up when first needed, so that the class may be defined after its parent).
 */
export interface EmbedTypeInfo {
  readonly cardinality: "one" | "many";
  readonly schema: () => AnySchema;
  /** What a nested change does with an embedded row it replaces. */
  readonly onReplace: OnReplace;
}

const infos = /* @__PURE__ */ new WeakMap<AnyFieldType, EmbedTypeInfo>();

/**
 * What an embed type stores, or `undefined` for a type that is not an embed's.
 *
 * @example
 * ```ts
 * embedTypeInfo(embedType("one", () => Address))?.cardinality; // "one"
 * embedTypeInfo(jsonType()); // undefined
 * ```
 */
export function embedTypeInfo(type: AnyFieldType): EmbedTypeInfo | undefined {
  return infos.get(type);
}

// ---------------------------------------------------------------------------
// The conversions of one embedded schema, computed once
// ---------------------------------------------------------------------------

/** How one embedded field is written to JSON and read back. */
interface Slot {
  readonly field: FieldMeta;
  /** The JSON key. */
  readonly key: string;
  /** The type's own conversion to its driver value, or `IDENTITY`. */
  readonly toDb: (value: unknown) => unknown;
  /** The type's own conversion from its driver value, or `IDENTITY`. */
  readonly fromDb: (value: unknown) => unknown;
  /** Whether the field is an embed: its own `toDb`/`fromDb` take and give JSON already. */
  readonly embedded: boolean;
}

interface Codec {
  readonly meta: SchemaMeta;
  readonly slots: readonly Slot[];
}

const codecs = /* @__PURE__ */ new WeakMap<SchemaMeta, Codec>();

function codecOf(schemaMeta: SchemaMeta): Codec {
  let codec = codecs.get(schemaMeta);
  if (codec === undefined) {
    codec = {
      meta: schemaMeta,
      slots: schemaMeta.persisted.map((field) => ({
        field,
        key: field.column,
        toDb: detached(field.type, "toDb") as (value: unknown) => unknown,
        fromDb: detached(field.type, "fromDb") as (value: unknown) => unknown,
        embedded: infos.has(field.type),
      })),
    };
    codecs.set(schemaMeta, codec);
  }
  return codec;
}

// ---------------------------------------------------------------------------
// JSON forms of driver values
// ---------------------------------------------------------------------------

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_INDEX: ReadonlyMap<string, number> = /* @__PURE__ */ new Map(
  /* @__PURE__ */ Array.from(BASE64, (char, i) => [char, i]),
);

/**
 * Bytes as base64 text (with `=` padding).
 *
 * @example
 * ```ts
 * toBase64(new Uint8Array([1, 2, 3])); // "AQID"
 * ```
 */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0;
    const c = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64[(triple >> 18) & 63];
    out += BASE64[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64[(triple >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? BASE64[triple & 63] : "=";
  }
  return out;
}

/**
 * Base64 text (padded or not) as bytes, or `undefined` when it is not base64.
 *
 * @example
 * ```ts
 * fromBase64("AQID"); // Uint8Array [1, 2, 3]
 * ```
 */
export function fromBase64(text: string): Uint8Array | undefined {
  const trimmed = text.endsWith("==") ? text.slice(0, -2) : text.endsWith("=") ? text.slice(0, -1) : text;
  if (trimmed.length % 4 === 1) return undefined;
  const out = new Uint8Array(Math.floor((trimmed.length * 3) / 4));
  let bits = 0;
  let count = 0;
  let at = 0;
  for (const char of trimmed) {
    const value = BASE64_INDEX.get(char);
    if (value === undefined) return undefined;
    bits = (bits << 6) | value;
    count += 6;
    if (count >= 8) {
      count -= 8;
      out[at++] = (bits >> count) & 255;
    }
  }
  return out;
}

/** A driver value as JSON: dates as ISO strings, bigints as digits, bytes as base64, non-finite numbers as text. */
function jsonOf(value: unknown): unknown {
  switch (typeof value) {
    case "bigint":
      return value.toString();
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "object":
      break;
    default:
      return value;
  }
  if (value === null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime()))
      throw new CastError("cast.embedInvalidDate", "An embedded field holds an invalid Date.");
    return value.toISOString();
  }
  if (value instanceof Uint8Array) return toBase64(value);
  if (Array.isArray(value)) return value.map(jsonOf);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    // A `__proto__` key of JSON data stays a key: a plain assignment would set the prototype.
    for (const key of Object.keys(value)) setOwn(out, key, jsonOf((value as Record<string, unknown>)[key]));
    return out;
  }
  return value;
}

function unreadable(what: string, key: string, schemaMeta: SchemaMeta): CastError {
  return new CastError(
    "cast.embedStoredField",
    `The stored "${key}" of the embedded ${schemaMeta.name} is not ${what}.`,
  );
}

/** A JSON value as the driver value of a column of kind `db.kind`. */
function driverValueOf(json: unknown, db: DbType, key: string, schemaMeta: SchemaMeta): unknown {
  switch (db.kind) {
    case "timestamp":
    case "timestamptz": {
      if (typeof json !== "string" && typeof json !== "number")
        throw unreadable("a timestamp", key, schemaMeta);
      const date = new Date(json);
      if (Number.isNaN(date.getTime())) throw unreadable("a timestamp", key, schemaMeta);
      return date;
    }
    case "bigint":
      if (typeof json === "number" && Number.isSafeInteger(json)) return BigInt(json);
      if (typeof json === "string" && /^-?\d+$/.test(json)) return BigInt(json);
      throw unreadable("a whole number", key, schemaMeta);
    case "binary": {
      const bytes = typeof json === "string" ? fromBase64(json) : undefined;
      if (bytes === undefined) throw unreadable("base64 bytes", key, schemaMeta);
      return bytes;
    }
    case "float":
      if (typeof json === "number") return json;
      if (json === "NaN" || json === "Infinity" || json === "-Infinity") return Number(json);
      throw unreadable("a number", key, schemaMeta);
    case "array": {
      if (!Array.isArray(json)) throw unreadable("a list", key, schemaMeta);
      const of = db.of;
      return json.map((item: unknown) => (item === null ? null : driverValueOf(item, of, key, schemaMeta)));
    }
    default: {
      const expected = JSON_KINDS[db.kind];
      if (expected !== undefined && typeof json !== expected) {
        throw unreadable(expected === "number" ? "a number" : `a ${expected}`, key, schemaMeta);
      }
      return json;
    }
  }
}

/** The JSON type the stored value of a column kind must have; kinds not listed take any JSON value. */
const JSON_KINDS: Readonly<Record<string, "number" | "string" | "boolean">> = {
  integer: "number",
  text: "string",
  uuid: "string",
  date: "string",
  time: "string",
  decimal: "string",
  boolean: "boolean",
};

// ---------------------------------------------------------------------------
// Dumping and loading one embedded row
// ---------------------------------------------------------------------------

function missingKey(schemaMeta: SchemaMeta, slot: Slot, isNull: boolean): CastError {
  const what = `A stored ${schemaMeta.name} has ${isNull ? `null for "${slot.key}"` : `no "${slot.key}"`}`;
  if (slot.field.autogenerate !== undefined) {
    return new CastError(
      "cast.embedGeneratedMissing",
      `${what}, the generated value of ${slot.field.name}: it was written without one (not through a changeset or insertAll).`,
    );
  }
  return new CastError(
    "cast.embedFieldMissing",
    `${what}, and the field ${slot.field.name} has no default and is not nullable.`,
  );
}

/** The value a field takes when it is missing: its default, else `null` when nullable, else `undefined`. */
function missingValue(field: FieldMeta): unknown {
  const fallback = field.default;
  if (fallback !== undefined) return fallback.kind === "value" ? fallback.value : fallback.fn();
  return field.nullable ? null : undefined;
}

/**
 * An embedded row (or a plain object with its fields) as a JSON object: each stored
 * field under its key, written with its own type. A plain object's missing field takes
 * the field's default, and is left out when it has none.
 *
 * @example
 * ```ts
 * dumpEmbedded(meta(Address), { street: "Storgata 1", city: "Oslo", postCode: null });
 * // { street: "Storgata 1", city: "Oslo", postCode: null }
 * ```
 */
export function dumpEmbedded(schemaMeta: SchemaMeta, row: object): Record<string, unknown> {
  const { slots } = codecOf(schemaMeta);
  const source = row as Readonly<Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  for (const slot of slots) {
    let value = source[slot.field.name];
    if (value === undefined) value = missingValue(slot.field);
    if (value === undefined) continue;
    if (value === null) {
      out[slot.key] = null;
      continue;
    }
    const driver = slot.toDb === IDENTITY ? value : slot.toDb(value);
    out[slot.key] = slot.embedded ? driver : jsonOf(driver);
  }
  return out;
}

/**
 * Builds an embedded row from a stored JSON object: each field read from its key with
 * its own type, unknown keys ignored, a missing key taking the field's default (or
 * `null` when nullable).
 *
 * @example
 * ```ts
 * const address = loadEmbedded(meta(Address), { street: "Storgata 1", city: "Oslo" }, rowMeta);
 * address.postCode; // null
 * ```
 *
 * @throws CastError when the value is not an object, a value cannot be read with its
 * field's type, or a field that is neither nullable nor defaulted is missing.
 */
export function loadEmbedded(schemaMeta: SchemaMeta, json: unknown, rowMeta: RowMeta): object {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new CastError("cast.embedNotObject", `A stored ${schemaMeta.name} is not a JSON object.`);
  }
  const { slots } = codecOf(schemaMeta);
  const stored = json as Readonly<Record<string, unknown>>;
  const values = new Array<unknown>(slots.length);
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i] as Slot;
    const raw = hasOwn(stored, slot.key) ? stored[slot.key] : undefined;
    // A stored null on a field that is not nullable counts as missing.
    if (raw === undefined || (raw === null && !slot.field.nullable)) {
      const value = missingValue(slot.field);
      if (value === undefined) throw missingKey(schemaMeta, slot, raw === null);
      values[i] = value;
      continue;
    }
    if (raw === null) {
      values[i] = null;
      continue;
    }
    const driver = slot.embedded ? raw : driverValueOf(raw, slot.field.type.db, slot.key, schemaMeta);
    values[i] = slot.fromDb === IDENTITY ? driver : slot.fromDb(driver);
  }
  return schemaMeta.create(values, rowMeta);
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const hidden = /* @__PURE__ */ new WeakMap<AnyFieldType, boolean>();

/**
 * Whether a value of `type` must be redacted in logs because it is an embed whose schema
 * has a redacted field, at any depth (the column itself need not be redacted). Worked
 * out once per type, when first asked (the embedded class may be defined later).
 *
 * @example
 * ```ts
 * hidesValues(meta(User).fieldsByName.get("card").type); // true when Card has a .redact() field
 * ```
 */
export function hidesValues(type: AnyFieldType | undefined): boolean {
  if (type === undefined) return false;
  const known = hidden.get(type);
  if (known !== undefined) return known;
  const info = infos.get(type);
  if (info === undefined) return false;
  // Set first: an embed that contains itself stops here.
  hidden.set(type, false);
  const fields = meta(info.schema()).persisted;
  const answer = fields.some((field) => field.redact || hidesValues(field.type));
  hidden.set(type, answer);
  return answer;
}

// ---------------------------------------------------------------------------
// The type
// ---------------------------------------------------------------------------

/**
 * An embedded row from input: a row of the class as it is, or a plain object whose keys
 * are fields, each value cast with its field's type; a missing field takes its default or
 * its generated value (`.autogenerate()`). A string says what is wrong instead.
 */
function rowFrom(schema: AnySchema, schemaMeta: SchemaMeta, input: unknown): object | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "it is not an object";
  if (Object.getPrototypeOf(input) === schema.prototype) return input;
  if (!isPlainObject(input)) return "it is not a plain object";
  const given = input as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(given)) {
    if (!schemaMeta.fieldsByName.has(key)) return `"${key}" is not a field`;
  }
  const values: unknown[] = [];
  for (const field of schemaMeta.persisted) {
    let value = given[field.name];
    if (value === undefined) {
      value = missingValue(field);
      if (value === undefined && field.autogenerate !== undefined) value = field.autogenerate.fn();
    } else if (value !== null) {
      const result = field.type.cast(value);
      if (!result.success) return `"${field.name}" is invalid`;
      value = result.data;
    }
    if (value === undefined || (value === null && !field.nullable)) return `"${field.name}" has no value`;
    values.push(value);
  }
  return schemaMeta.create(values, schemaMeta.rowMeta("built", undefined));
}

/**
 * The type of an embed field: `t.embedOne(() => Address)` and `t.embedMany(() => Phone)`
 * use it. Its driver value is the JSON document (an object, or an array of them).
 *
 * - `cast` accepts rows of the embedded schema, and plain objects whose keys are its
 *   fields, each value cast with its field's type, missing ones taking their defaults and
 *   generated values (a list of them for `"many"`).
 * - `toDb` writes each row as a JSON object ({@link dumpEmbedded}), a plain object made a
 *   row as `cast` makes it first (`CastError` when it cannot be); `fromDb` builds rows
 *   from one ({@link loadEmbedded}). A driver that hands JSON over as text is parsed.
 * - Two values are equal when their stored forms are.
 *
 * @example
 * ```ts
 * const type = embedType("one", () => Address);
 * type.toDb(address); // { street: "Storgata 1", city: "Oslo", postCode: null }
 * ```
 */
export function embedType(
  cardinality: "one" | "many",
  schema: () => AnySchema,
  onReplace: OnReplace = "error",
): FieldType<unknown, unknown> {
  const schemaMeta = (): SchemaMeta => meta(schema());
  const loaded = (): RowMeta => schemaMeta().rowMeta("loaded", undefined);
  const parse = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);
  // A plain object is made a row first (defaults, generated values, cast fields), so that
  // what is written can be read back; one that cannot be is refused.
  const dumpOne = (value: unknown, target: SchemaMeta): Record<string, unknown> => {
    const row = rowFrom(schema(), target, value);
    if (typeof row === "string")
      throw new CastError("cast.embedWrite", `A ${target.name} cannot be written: ${row}.`);
    return dumpEmbedded(target, row);
  };
  const dump = (value: unknown): unknown => {
    const target = schemaMeta();
    if (cardinality === "one") return dumpOne(value, target);
    if (!Array.isArray(value))
      throw new CastError("cast.embedListNotArray", `A list of ${target.name} must be an array.`);
    return value.map((row) => dumpOne(row, target));
  };
  const type: FieldType<unknown, unknown> = Object.freeze({
    name: cardinality === "one" ? "embedOne" : "embedMany",
    db: Object.freeze({ kind: "jsonb" }) as DbType,
    cast(input: unknown): CastResult<unknown> {
      try {
        const target = schemaMeta();
        const model = schema();
        if (cardinality === "one") {
          const row = rowFrom(model, target, input);
          return typeof row === "string" ? INVALID : { success: true, data: row };
        }
        if (!Array.isArray(input)) return INVALID;
        const rows: object[] = [];
        for (const item of input) {
          const row = rowFrom(model, target, item);
          if (typeof row === "string") return INVALID;
          rows.push(row);
        }
        return { success: true, data: rows };
      } catch {
        // A getter or a proxy trap threw.
        return INVALID;
      }
    },
    fromDb(value: unknown): unknown {
      const json = parse(value);
      const target = schemaMeta();
      if (cardinality === "one") return loadEmbedded(target, json, loaded());
      if (!Array.isArray(json))
        throw new CastError(
          "cast.embedStoredListNotArray",
          `A stored list of ${target.name} is not a JSON array.`,
        );
      const rowMeta = loaded();
      return json.map((item: unknown) => loadEmbedded(target, item, rowMeta));
    },
    toDb: dump,
    equal(a: unknown, b: unknown): boolean {
      if (a === b) return true;
      try {
        return deepEqual(dump(a), dump(b));
      } catch {
        return false;
      }
    },
  });
  infos.set(type, Object.freeze({ cardinality, schema, onReplace }));
  return type;
}
