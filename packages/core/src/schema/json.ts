/**
 * What a row's `toJSON` returns, and the same mapping for a changeset's changes: the
 * JSON-ready shape that `Json<Row>` describes, so that `JSON.parse(JSON.stringify(row))`
 * deep-equals `row.toJSON()`.
 *
 * The conversion of each field is chosen once per schema, from its type
 * ({@link jsonTableOf}); a field whose value is already JSON (text, booleans, uuids,
 * decimals) has no conversion and is copied as it is.
 *
 * @module
 */
import type { FieldMeta } from "../contracts/schema.js";
import type { AnyFieldType } from "../contracts/type.js";
import { setOwn } from "../internal/own.js";
import { elementTypeOf } from "../types/composite.js";
import { toBase64 } from "../types/embed.js";
import { MODEL } from "./model.js";

/** Turns one non-`undefined` value into its JSON form. */
export type JsonConverter = (value: unknown) => unknown;

/**
 * The fields of a schema that are in JSON, in declaration order, with the conversion of
 * each (`undefined` where the value is already JSON). Built once per schema.
 */
export interface JsonTable {
  readonly names: readonly string[];
  readonly converters: readonly (JsonConverter | undefined)[];
  /** The names of all the schema's fields (in JSON or not): a row's other own properties are its associations. */
  readonly fields: ReadonlySet<string>;
}

/** What a row's `toJSON` reads from its schema's metadata (`Meta` in `schema.ts`). */
interface JsonModel {
  jsonTable(): JsonTable;
}

interface RowLike {
  readonly [MODEL]: JsonModel;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** A number as JSON: `NaN` and the infinities are `null`, `-0` is `0`. */
function jsonNumber(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return value === 0 ? 0 : value;
}

/**
 * `value` as `JSON.stringify` writes it, as a value: a `toJSON` method is called (a row's
 * gives its JSON), `undefined`, functions and symbols are `undefined` (left out of an
 * object, `null` in an array), numbers that JSON cannot hold are `null`. With `field`
 * set, the value of a field is being mapped, at any depth: a `bigint` becomes a decimal
 * string and bytes a base64 string, where `JSON.stringify` would throw or write an object.
 * Without it a `bigint` stays as it is, and `JSON.stringify` throws on it as it would
 * anyway.
 */
function jsonOf(value: unknown, key: string, field: boolean): unknown {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return jsonNumber(value);
    case "bigint":
      return field ? value.toString() : value;
    case "object":
      return value === null ? null : objectJson(value, key, field);
    default:
      return undefined;
  }
}

function objectJson(value: object, key: string, field: boolean): unknown {
  const toJSON: unknown = (value as { readonly toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    const result: unknown = toJSON.call(value, key);
    // A row's own toJSON already returns JSON; anything else is mapped as JSON.stringify would.
    return toJSON === rowToJSON ? result : jsonOf(result, key, field);
  }
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const item = jsonOf(value[i], String(i), field);
      out[i] = item === undefined ? null : item;
    }
    return out;
  }
  if (value instanceof Uint8Array && field) return toBase64(value);
  // Boxed primitives are written as the primitive.
  if (value instanceof Number) return jsonNumber(value.valueOf());
  if (value instanceof String || value instanceof Boolean) return value.valueOf();
  const out: Record<string, unknown> = {};
  const source = value as Readonly<Record<string, unknown>>;
  for (const name of Object.keys(value)) {
    const item = jsonOf(source[name], name, field);
    if (item !== undefined) setOwn(out, name, item);
  }
  return out;
}

/**
 * `value` as `JSON.stringify` writes it, as a value (`undefined` for one it leaves out).
 *
 * @example
 * ```ts
 * jsonValue({ at: new Date(0), skip: undefined }); // { at: "1970-01-01T00:00:00.000Z" }
 * ```
 */
export function jsonValue(value: unknown): unknown {
  return jsonOf(value, "", false);
}

/**
 * `value` as JSON, mapped as a field's value is: like {@link jsonValue}, except that a
 * `bigint` becomes a decimal string and bytes a base64 string, at any depth, so that
 * `JSON.stringify` of the result never throws. For values that come from the library
 * itself, such as the metadata of a changeset's errors (`validateNumber` with `bigint`
 * bounds).
 *
 * @example
 * ```ts
 * safeJsonValue({ number: 10n }); // { number: "10" }
 * ```
 */
export function safeJsonValue(value: unknown): unknown {
  return jsonOf(value, "", true);
}

// ---------------------------------------------------------------------------
// Field conversions, chosen once per field
// ---------------------------------------------------------------------------

function numberJson(value: unknown): unknown {
  return typeof value === "number" ? jsonNumber(value) : fieldJson(value);
}

function timestampJson(value: unknown): unknown {
  // An invalid Date is null, as Date.prototype.toJSON makes it.
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return fieldJson(value);
}

/** A calendar date read `{ as: "date" }` is midnight UTC: its JSON is the date alone. */
function dateJson(value: unknown): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  return fieldJson(value);
}

function bigintJson(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return numberJson(value);
}

function binaryJson(value: unknown): unknown {
  return value instanceof Uint8Array ? toBase64(value) : fieldJson(value);
}

/** Any other field value: JSON documents, embeds, custom types. */
function fieldJson(value: unknown): unknown {
  return jsonOf(value, "", true);
}

function arrayJson(element: JsonConverter | undefined): JsonConverter {
  return (value) => {
    if (!Array.isArray(value)) return fieldJson(value);
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i];
      const json = item === null || item === undefined ? null : element === undefined ? item : element(item);
      out[i] = json === undefined ? null : json;
    }
    return out;
  };
}

/**
 * The conversion of a field's non-`null` value to JSON, or `undefined` when the value is
 * JSON already. Chosen by the type's storage kind, and each conversion checks the value it
 * is given, so that a custom type stored as one of those kinds is mapped by its value.
 *
 * @example
 * ```ts
 * converterOf(timestampType())?.(new Date(0)); // "1970-01-01T00:00:00.000Z"
 * converterOf(stringType()); // undefined
 * ```
 */
export function converterOf(type: AnyFieldType): JsonConverter | undefined {
  switch (type.db.kind) {
    case "text":
    case "uuid":
    case "decimal":
    case "time":
    case "boolean":
      return type.name === "string" ||
        type.name === "uuid" ||
        type.name === "enum" ||
        type.name === "time" ||
        type.name === "boolean" ||
        type.name.startsWith("decimal")
        ? undefined
        : fieldJson;
    case "integer":
    case "float":
      return numberJson;
    case "bigint":
      return bigintJson;
    case "binary":
      return binaryJson;
    case "date":
      return type.name === "date" ? undefined : dateJson;
    case "timestamp":
    case "timestamptz":
      return timestampJson;
    case "array": {
      const element = elementTypeOf(type);
      return arrayJson(element === undefined ? fieldJson : converterOf(element));
    }
    default:
      return fieldJson;
  }
}

/** The conversion of each field, once chosen; `null` for a field whose value is JSON already. */
const converters = /* @__PURE__ */ new WeakMap<FieldMeta, JsonConverter | null>();

/**
 * The conversion of `field`'s values ({@link converterOf} of its type), chosen once per field.
 *
 * @example
 * ```ts
 * const createdAt = meta(User).fieldsByName.get("createdAt");
 * if (createdAt !== undefined) fieldConverter(createdAt)?.(new Date(0)); // "1970-01-01T00:00:00.000Z"
 * ```
 */
export function fieldConverter(field: FieldMeta): JsonConverter | undefined {
  let convert = converters.get(field);
  if (convert === undefined) {
    convert = converterOf(field.type) ?? null;
    converters.set(field, convert);
  }
  return convert ?? undefined;
}

/**
 * The JSON table of a schema's fields.
 *
 * @example
 * ```ts
 * jsonTableOf(meta(User).fields).names; // ["id", "email", "createdAt"]: no passwordHash
 * ```
 */
export function jsonTableOf(fields: readonly FieldMeta[]): JsonTable {
  const names: string[] = [];
  const table: (JsonConverter | undefined)[] = [];
  for (const field of fields) {
    if (!field.json) continue;
    names.push(field.name);
    table.push(fieldConverter(field));
  }
  return Object.freeze({
    names: Object.freeze(names),
    converters: Object.freeze(table),
    fields: new Set(fields.map((field) => field.name)),
  });
}

/**
 * The value of a field as JSON (`undefined` when it is `undefined`), with the conversion
 * from {@link converterOf} (or none).
 *
 * @example
 * ```ts
 * fieldValueJson(converterOf(bigintType()), 5n); // "5"
 * ```
 */
export function fieldValueJson(convert: JsonConverter | undefined, value: unknown): unknown {
  if (value === undefined || value === null || convert === undefined) return value;
  return convert(value);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * Every row's `toJSON`, on the schema's prototype: the fields that are in JSON, in
 * declaration order, converted; then the preloaded associations, each as JSON. A field
 * whose value is `undefined` (a virtual field that was never set) is left out, as
 * `JSON.stringify` leaves it out.
 *
 * @example
 * ```ts
 * JSON.stringify(user); // '{"id":1,"email":"ada@example.com","createdAt":"2026-10-21T09:00:00.000Z"}'
 * ```
 */
export function rowToJSON(this: RowLike): Record<string, unknown> {
  const table = this[MODEL].jsonTable();
  const names = table.names;
  const converters = table.converters;
  const out: Record<string, unknown> = {};
  for (let i = 0; i < names.length; i++) {
    const name = names[i] as string;
    const value = fieldValueJson(converters[i], this[name]);
    if (value !== undefined) out[name] = value;
  }
  // A row's own properties are its fields, then its preloaded associations. A key is
  // skipped by name, not by position: Object.keys lists integer-like keys first.
  const fields = table.fields;
  const keys = Object.keys(this);
  if (keys.length > fields.size) {
    for (const key of keys) {
      if (fields.has(key)) continue;
      const value = jsonOf(this[key], key, false);
      if (value !== undefined) setOwn(out, key, value);
    }
  }
  return out;
}
