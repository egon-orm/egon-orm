/**
 * Redaction-aware formatting for inspect output, logs and error messages.
 *
 * Nothing here depends on `node:util`, so it behaves the same in every runtime.
 *
 * @module
 */
import type { FieldMeta, SchemaMeta } from "../contracts/schema.js";
import { META, ROW } from "../contracts/schema.js";
import { setOwn } from "./own.js";

/**
 * What stands in for the value of a redacted field.
 *
 * @example
 * ```ts
 * redactFields({ email: "a@b.c", passwordHash: "x" }, new Set(["passwordHash"]));
 * // { email: "a@b.c", passwordHash: REDACTED }
 * ```
 */
export const REDACTED = "**redacted**";

/**
 * Copies the own enumerable string-keyed properties of `values`, replacing the value of
 * every key in `redacted` with {@link REDACTED}. Key order is kept. The copy is shallow:
 * nested values are the same objects.
 *
 * @example
 * ```ts
 * redactFields({ email: "a@b.c", passwordHash: "$2b$…" }, new Set(["passwordHash"]));
 * // { email: "a@b.c", passwordHash: "**redacted**" }
 * ```
 */
export function redactFields(values: object, redacted: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(values)) {
    setOwn(out, key, redacted.has(key) ? REDACTED : (values as Record<string, unknown>)[key]);
  }
  return out;
}

/** Strings longer than this are cut in {@link formatValue}. */
const MAX_STRING = 100;
/** Arrays and objects show at most this many entries in {@link formatValue}. */
const MAX_ENTRIES = 20;
/** Nesting deeper than this is abbreviated in {@link formatValue}. */
const MAX_DEPTH = 3;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NOTHING_REDACTED: ReadonlySet<string> = /* @__PURE__ */ new Set();

// Built-in accessors and methods, captured once, so that formatting a value never runs
// a method or getter that the value (or its class) defines in their place.
const dateTime = Date.prototype.getTime;
const dateIso = Date.prototype.toISOString;
const typedArrayPrototype = /* @__PURE__ */ Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLength = /* @__PURE__ */ Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")
  ?.get as (this: unknown) => number;
const symbolToString = Symbol.prototype.toString;

/** The value of an own data property; `undefined` for a missing property or an accessor. */
function ownData(target: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor === undefined || !("value" in descriptor) ? undefined : descriptor.value;
}

/** The constructor a value's prototype names, read without running a getter. */
function constructorOf(value: object): unknown {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype ? undefined : ownData(proto as object, "constructor");
}

/** A function's name, read without running a getter; `""` when it has none. */
function functionName(fn: unknown): string {
  if (typeof fn !== "function") return "";
  const name = ownData(fn, "name");
  return typeof name === "string" ? name : "";
}

/** Answers "is this key redacted?". A set of names, or {@link EVERYTHING_REDACTED}. */
interface Redaction {
  has(key: string): boolean;
}

/**
 * Used when an object claims to be a row (its class chain has `META`) but its metadata
 * cannot be read as plain data. Which fields are redacted is then unknown, so none of
 * its values is printed: redaction fails closed.
 */
const EVERYTHING_REDACTED: Redaction = { has: () => true };

/** The redaction per schema metadata object, computed once each. */
const redactionByMeta = /* @__PURE__ */ new WeakMap<object, Redaction>();

/** The redacted names listed by a `fields` array, or `undefined` if any entry is not plain data. */
function redactedNames(fields: unknown): Set<string> | undefined {
  if (!Array.isArray(fields)) return undefined;
  const names = new Set<string>();
  for (let i = 0; i < fields.length; i++) {
    const field = ownData(fields, i);
    if (typeof field !== "object" || field === null) return undefined;
    const name = ownData(field, "name" satisfies keyof FieldMeta);
    const redact = ownData(field, "redact" satisfies keyof FieldMeta);
    if (typeof name !== "string" || typeof redact !== "boolean") return undefined;
    if (redact) names.add(name);
  }
  return names;
}

/**
 * Which fields the rows of a class have redacted: a schema class holds its metadata
 * under `META`, and the metadata lists the fields. `undefined` when the class chain has
 * no `META` (it is not a schema class).
 *
 * The metadata is read as own data properties only, so that no code of the value runs
 * (the contract requires `META`, `fields`, `name` and `redact` to be such properties).
 * If `META` is there but is an accessor, or what it holds is not that plain shape, the
 * answer is {@link EVERYTHING_REDACTED}.
 */
function redactionOfClass(ctor: unknown): Redaction | undefined {
  // A class extends the base that `Schema()` returned, so the metadata is an own static
  // of an ancestor: walk the constructor chain.
  let descriptor: PropertyDescriptor | undefined;
  for (
    let c: unknown = ctor;
    typeof c === "function" && descriptor === undefined;
    c = Object.getPrototypeOf(c)
  ) {
    descriptor = Object.getOwnPropertyDescriptor(c, META);
  }
  if (descriptor === undefined) return undefined;
  const meta: unknown = "value" in descriptor ? descriptor.value : undefined;
  if (typeof meta !== "object" || meta === null) return EVERYTHING_REDACTED;
  const known = redactionByMeta.get(meta);
  if (known !== undefined) return known;
  const redaction: Redaction =
    redactedNames(ownData(meta, "fields" satisfies keyof SchemaMeta)) ?? EVERYTHING_REDACTED;
  redactionByMeta.set(meta, redaction);
  return redaction;
}

/**
 * Which fields of `value` are redacted. The schema class is looked for along the whole
 * prototype chain, not only on the immediate prototype: an object that is an instance of
 * a schema class is a row even when a prototype was put in between, or when the
 * `constructor` of its immediate prototype was deleted or replaced by an accessor
 * (accessors are skipped, never run). If no class with `META` is found but the object
 * carries the {@link ROW} marker, it claims to be a row whose schema cannot be
 * determined, so every value is redacted.
 */
function redactionOf(value: object): Redaction {
  for (
    let proto: unknown = Object.getPrototypeOf(value);
    typeof proto === "object" && proto !== null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    const found = redactionOfClass(ownData(proto, "constructor"));
    if (found !== undefined) return found;
  }
  return Object.getOwnPropertyDescriptor(value, ROW) === undefined ? NOTHING_REDACTED : EVERYTHING_REDACTED;
}

function formatPrimitive(value: string | number | bigint | boolean | symbol | undefined): string {
  switch (typeof value) {
    case "string":
      return value.length > MAX_STRING
        ? `${JSON.stringify(value.slice(0, MAX_STRING))}… (${value.length} characters)`
        : JSON.stringify(value);
    case "number":
      return Object.is(value, -0) ? "-0" : String(value);
    case "bigint":
      return `${value}n`;
    case "symbol":
      return symbolToString.call(value);
    default:
      return String(value);
  }
}

/** One `key: value` entry, without reading a redacted value or running an accessor. */
function formatEntry(
  target: object,
  key: string,
  redacted: Redaction,
  depth: number,
  seen: Set<object>,
): string {
  const label = IDENTIFIER.test(key) ? key : JSON.stringify(key);
  if (redacted.has(key)) return `${label}: ${REDACTED}`;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) return `${label}: undefined`;
  if (!("value" in descriptor)) return `${label}: [Getter]`;
  return `${label}: ${format(descriptor.value, depth, seen)}`;
}

function format(value: unknown, depth: number, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "function") {
    const name = functionName(value);
    return name === "" ? "[Function]" : `[Function: ${name}]`;
  }
  if (typeof value !== "object") {
    return formatPrimitive(value as string | number | bigint | boolean | symbol | undefined);
  }
  if (value instanceof Date) {
    return Number.isNaN(dateTime.call(value)) ? "Invalid Date" : dateIso.call(value);
  }
  const ctor = constructorOf(value);
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return `<${functionName(ctor) || "TypedArray"} ${byteLength.call(value)} bytes>`;
  }
  if (seen.has(value)) return "[Circular]";
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return "[Array]";
    seen.add(value);
    const parts: string[] = [];
    for (let i = 0; i < value.length && i < MAX_ENTRIES; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, i);
      if (descriptor === undefined) parts.push("undefined");
      else if (!("value" in descriptor)) parts.push("[Getter]");
      else parts.push(format(descriptor.value, depth + 1, seen));
    }
    if (value.length > MAX_ENTRIES) parts.push(`… ${value.length - MAX_ENTRIES} more`);
    seen.delete(value);
    return `[${parts.join(", ")}]`;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  const name = proto === null || proto === Object.prototype ? "" : `${functionName(ctor) || "Object"} `;
  if (depth >= MAX_DEPTH) return name === "" ? "[Object]" : `[${name.trimEnd()}]`;
  // A nested row hides its own redacted fields, wherever it sits.
  const redacted = redactionOf(value);
  seen.add(value);
  const keys = Object.keys(value);
  const parts: string[] = [];
  for (let i = 0; i < keys.length && i < MAX_ENTRIES; i++) {
    parts.push(formatEntry(value, keys[i] as string, redacted, depth + 1, seen));
  }
  if (keys.length > MAX_ENTRIES) parts.push(`… ${keys.length - MAX_ENTRIES} more`);
  seen.delete(value);
  return parts.length === 0 ? `${name}{}` : `${name}{ ${parts.join(", ")} }`;
}

/**
 * Renders any value as one line of text for an error message or a log line: strings are
 * quoted and cut at 100 characters, dates are ISO strings, binary data is summarised,
 * arrays and objects show at most 20 entries and 3 levels, and cycles are marked.
 *
 * It runs no code of the value: no `toString`, `toJSON`, `valueOf` or inspect method, no
 * overridden `toISOString`, and no getter (an accessor property shows as `[Getter]`).
 * The one exception is a `Proxy`, whose traps necessarily run; if one throws, the result
 * is `[unprintable]`. It never throws.
 *
 * **Redaction.** A row of a schema, at any depth, has the values of its redacted fields
 * replaced by `**redacted**`: the row's class leads to the schema metadata, which names
 * them. If that metadata is not readable as plain data (an accessor where a data property
 * is required), every value of the row is replaced: redaction fails closed. A value that is not a row is printed as it is, so a *plain object* holding
 * field values (a changeset's `changes`, a params object) is NOT redacted by this
 * function: format it with {@link formatStruct} and the schema's redacted names, or
 * redact it first with {@link redactFields}.
 *
 * @example
 * ```ts
 * formatValue("ada"); // '"ada"'
 * formatValue(10n); // "10n"
 * formatValue(new Date(0)); // "1970-01-01T00:00:00.000Z"
 * formatValue({ id: 1, tags: ["a", "b"] }); // '{ id: 1, tags: ["a", "b"] }'
 * ```
 */
export function formatValue(value: unknown): string {
  try {
    return format(value, 0, new Set());
  } catch {
    // A Proxy trap threw. An error message must still be produced.
    return "[unprintable]";
  }
}

/**
 * Renders a named record of fields, such as a row or a changeset's changes, with the
 * values of the keys in `redacted` replaced by `**redacted**`. Those values are not
 * read at all. Nested values are formatted as by {@link formatValue}, so a row nested
 * inside (a preloaded association, a changeset's data) hides its own redacted fields.
 *
 * When `values` is itself a row of a schema, its redacted fields are hidden whether or
 * not `redacted` names them.
 *
 * @example
 * ```ts
 * formatStruct("User", { id: 1, email: "a@b.c", passwordHash: "$2b$…" }, new Set(["passwordHash"]));
 * // 'User { id: 1, email: "a@b.c", passwordHash: **redacted** }'
 * ```
 */
export function formatStruct(name: string, values: object, redacted: ReadonlySet<string>): string {
  const parts: string[] = [];
  try {
    const own = redactionOf(values);
    const seen = new Set<object>([values]);
    for (const key of Object.keys(values)) {
      // Hidden when either the caller or the row's own schema says so.
      parts.push(formatEntry(values, key, own.has(key) ? own : redacted, 1, seen));
    }
  } catch {
    return `${name} [unprintable]`;
  }
  return parts.length === 0 ? `${name} {}` : `${name} { ${parts.join(", ")} }`;
}
