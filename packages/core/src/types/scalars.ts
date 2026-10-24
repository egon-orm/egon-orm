/**
 * The scalar built-in types: string, integer, bigint, float, decimal, boolean, uuid, binary.
 *
 * Each type is made with `defineType`, exactly as a custom type is. A type with no
 * options is one shared object; a type with options is one object per option set.
 *
 * @module
 */
import type { CastResult, FieldType } from "../contracts/type.js";
import { IDENTITY } from "../contracts/type.js";
import { CastError, SchemaDefinitionError } from "../errors.js";
import { own } from "../internal/own.js";
import { defineType, parameterized } from "./define.js";

/**
 * The failed cast with no message, shared by every built-in type so that rejecting a
 * value allocates nothing. The changeset reports it as `"is invalid"`.
 *
 * @example
 * ```ts
 * const cast = (input: unknown): CastResult<string> =>
 *   typeof input === "string" ? { success: true, data: input } : INVALID;
 * ```
 */
export const INVALID: CastResult<never> = /* @__PURE__ */ Object.freeze({ success: false });

/** Longer strings are rejected before any parsing: no integer or float needs this many characters. */
const MAX_NUMBER_TEXT = 400;
/** A 64-bit integer has at most 19 digits; the margin allows a sign and leading zeros. */
const MAX_INTEGER_TEXT = 40;
const INTEGER_TEXT = /^-?\d+$/;
const FLOAT_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const DECIMAL_TEXT = /^([+-]?)(\d*)(?:\.(\d*))?$/;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIN_SAFE = /* @__PURE__ */ BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = /* @__PURE__ */ BigInt(Number.MAX_SAFE_INTEGER);
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

// --- string ------------------------------------------------------------------

const STRING = /* @__PURE__ */ defineType<string>({
  name: "string",
  db: { kind: "text" },
  cast: (input) => (typeof input === "string" ? { success: true, data: input } : INVALID),
});

/**
 * Text. Accepts strings only: a number is not turned into a string.
 *
 * @example
 * ```ts
 * stringType().cast("Ada"); // { success: true, data: "Ada" }
 * stringType().cast(42); // { success: false }
 * ```
 */
export function stringType(): FieldType<string, string> {
  return STRING;
}

// --- integer -----------------------------------------------------------------

function castInteger(input: unknown): CastResult<number> {
  if (typeof input === "number") {
    // `+ 0` turns -0 into 0, so that a cast integer is never negative zero.
    return Number.isSafeInteger(input) ? { success: true, data: input + 0 } : INVALID;
  }
  if (typeof input === "string") {
    if (input.length > MAX_INTEGER_TEXT || !INTEGER_TEXT.test(input)) return INVALID;
    const parsed = Number(input);
    return Number.isSafeInteger(parsed) ? { success: true, data: parsed + 0 } : INVALID;
  }
  if (typeof input === "bigint") {
    return input >= MIN_SAFE && input <= MAX_SAFE ? { success: true, data: Number(input) } : INVALID;
  }
  return INVALID;
}

const INTEGER = /* @__PURE__ */ defineType<number>({
  name: "integer",
  db: { kind: "integer" },
  cast: castInteger,
});

/**
 * A whole number. Accepts a safe integer, a string of digits such as `"42"` or `"-7"`,
 * or a `bigint`, each within the safe integer range. Rejects `1.5`, `"1.0"`, `NaN` and
 * `Infinity`.
 *
 * @example
 * ```ts
 * integerType().cast("42"); // { success: true, data: 42 }
 * integerType().cast(1.5); // { success: false }
 * ```
 */
export function integerType(): FieldType<number, number> {
  return INTEGER;
}

// --- bigint ------------------------------------------------------------------

function castBigint(input: unknown): CastResult<bigint> {
  let value: bigint;
  if (typeof input === "bigint") {
    value = input;
  } else if (typeof input === "number") {
    // An integer beyond the safe range has already lost digits; refuse it rather than store a neighbour.
    if (!Number.isSafeInteger(input)) return INVALID;
    value = BigInt(input);
  } else if (typeof input === "string") {
    if (input.length > MAX_INTEGER_TEXT || !INTEGER_TEXT.test(input)) return INVALID;
    value = BigInt(input);
  } else {
    return INVALID;
  }
  return value >= INT64_MIN && value <= INT64_MAX ? { success: true, data: value } : INVALID;
}

const BIGINT = /* @__PURE__ */ defineType<bigint>({
  name: "bigint",
  db: { kind: "bigint" },
  cast: castBigint,
});

/**
 * Reads the digits a driver sends for a 64-bit integer. Written as a loop over character
 * codes because it runs once per value: testing `INTEGER_TEXT` first and then calling
 * `Number()` costs almost twice as much (20 ns against 11 ns per value in
 * benchmarks/micro/types.bench.ts, "load an array of 1,000 elements"), and `Number()`
 * alone reads "", " 12 " and "0x10" as numbers.
 *
 * The sum is exact while it is a safe integer, and a sum that is not safe stays not safe
 * as digits are added, so the range check after the loop sees every overflow.
 */
function integerTextToNumber(text: string): number {
  const length = text.length;
  const negative = text.charCodeAt(0) === 45;
  let i = negative ? 1 : 0;
  if (i === length) return Number.NaN;
  let number = 0;
  for (; i < length; i++) {
    const digit = text.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return Number.NaN;
    number = number * 10 + digit;
  }
  return negative && number !== 0 ? -number : number;
}

function bigintColumnToNumber(value: number | bigint | string): number {
  let number: number;
  if (typeof value === "string") {
    number = integerTextToNumber(value);
    if (Number.isNaN(number)) {
      throw new CastError(
        "cast.bigintNumberString",
        'A bigint column read with { mode: "number" } received a string from the driver that is not a whole number.',
      );
    }
  } else {
    number = typeof value === "number" ? value : Number(value);
  }
  if (!Number.isSafeInteger(number)) {
    // The value itself is left out: the field may be redacted.
    throw new CastError(
      "cast.bigintNumberRange",
      'A bigint column read with { mode: "number" } holds a value outside the safe integer range of a JavaScript number (±9007199254740991).',
    );
  }
  return number;
}

const BIGINT_AS_NUMBER = /* @__PURE__ */ defineType<number, number | bigint | string>({
  name: "bigint(number)",
  db: { kind: "bigint" },
  cast: castInteger,
  fromDb: bigintColumnToNumber,
  toDb: IDENTITY,
});

/**
 * Options of {@link bigintType}.
 *
 * @example
 * ```ts
 * const options: BigintOptions = { mode: "number" };
 * ```
 */
export interface BigintOptions {
  /** `"bigint"` (the default) reads the column as a `bigint`; `"number"` reads it as a `number`. */
  readonly mode?: "bigint" | "number";
}

/**
 * A 64-bit integer. By default the value is a `bigint`; it accepts a `bigint`, a safe
 * integer `number`, or a string of digits, within the 64-bit range.
 *
 * With `{ mode: "number" }` the value is a `number` and input is accepted as for
 * {@link integerType}. Reading a stored value beyond the safe integer range then throws
 * `CastError`: the driver's value (a number, a bigint or digits) is checked on the way in.
 *
 * @example
 * ```ts
 * bigintType().cast("9007199254740993"); // { success: true, data: 9007199254740993n }
 * bigintType({ mode: "number" }).cast("42"); // { success: true, data: 42 }
 * ```
 *
 * @throws CastError from `fromDb` in `"number"` mode, when the stored value is not a safe integer.
 */
export function bigintType(options?: { readonly mode?: "bigint" }): FieldType<bigint, bigint>;
export function bigintType(options: { readonly mode: "number" }): FieldType<number, number | bigint | string>;
export function bigintType(
  options?: BigintOptions,
): FieldType<bigint, bigint> | FieldType<number, number | bigint | string> {
  const mode = own(options, "mode") ?? "bigint";
  if (mode === "bigint") return BIGINT;
  if (mode === "number") return BIGINT_AS_NUMBER;
  throw new SchemaDefinitionError(
    "schema.bigintMode",
    `t.bigint: mode must be "bigint" or "number", but got ${JSON.stringify(mode)}.`,
  );
}

// --- float -------------------------------------------------------------------

function castFloat(input: unknown): CastResult<number> {
  if (typeof input === "number") return Number.isFinite(input) ? { success: true, data: input } : INVALID;
  if (typeof input === "string") {
    if (input.length > MAX_NUMBER_TEXT || !FLOAT_TEXT.test(input)) return INVALID;
    const parsed = Number(input);
    return Number.isFinite(parsed) ? { success: true, data: parsed } : INVALID;
  }
  return INVALID;
}

const FLOAT = /* @__PURE__ */ defineType<number>({ name: "float", db: { kind: "float" }, cast: castFloat });

/**
 * A double-precision number. Accepts a finite number or a numeric string such as
 * `"1.5"`, `"-2"` or `"1e3"`. Rejects `NaN`, `Infinity` and strings that are not numbers.
 *
 * @example
 * ```ts
 * floatType().cast("1.5"); // { success: true, data: 1.5 }
 * floatType().cast(Number.NaN); // { success: false }
 * ```
 */
export function floatType(): FieldType<number, number> {
  return FLOAT;
}

// --- decimal -----------------------------------------------------------------

/** Writes a finite number in plain decimal notation: `1e-7` becomes `"0.0000001"`. */
function numberToDecimalText(value: number): string {
  const text = String(value);
  const e = text.indexOf("e");
  if (e === -1) return text;
  const exponent = Number(text.slice(e + 1));
  const negative = text.startsWith("-");
  const mantissa = text.slice(negative ? 1 : 0, e);
  const dot = mantissa.indexOf(".");
  const digits = dot === -1 ? mantissa : mantissa.slice(0, dot) + mantissa.slice(dot + 1);
  const pointAt = (dot === -1 ? mantissa.length : dot) + exponent;
  const body =
    pointAt <= 0 ? `0.${"0".repeat(-pointAt)}${digits}` : `${digits}${"0".repeat(pointAt - digits.length)}`;
  return negative ? `-${body}` : body;
}

function stripLeadingZeros(digits: string): string {
  let start = 0;
  while (start < digits.length - 1 && digits.charCodeAt(start) === 48) start++;
  return start === 0 ? digits : digits.slice(start);
}

function isAllZeros(digits: string): boolean {
  for (let i = 0; i < digits.length; i++) if (digits.charCodeAt(i) !== 48) return false;
  return true;
}

/** Adds one to a string of decimal digits: `"199"` becomes `"200"`, `"99"` becomes `"100"`. */
function incrementDigits(digits: string): string {
  let i = digits.length - 1;
  while (i >= 0 && digits.charCodeAt(i) === 57) i--;
  const zeros = "0".repeat(digits.length - 1 - i);
  if (i < 0) return `1${zeros}`;
  return `${digits.slice(0, i)}${String.fromCharCode(digits.charCodeAt(i) + 1)}${zeros}`;
}

/**
 * Parses decimal text into a normal form: no `+`, no leading zeros, no bare or trailing
 * point, no negative zero. The fraction digits are kept as written. With a `scale` the
 * fraction is rounded half away from zero (as the database rounds) and padded to it; with
 * a `precision` a number with too many integer digits is rejected.
 */
function normalizeDecimal(text: string, precision: number | undefined, scale: number): string | undefined {
  const match = DECIMAL_TEXT.exec(text);
  if (match === null) return undefined;
  let integer = match[2] as string;
  let fraction = match[3] ?? "";
  if (integer === "" && fraction === "") return undefined;
  if (integer === "") integer = "0";

  if (precision !== undefined) {
    if (fraction.length > scale) {
      const roundUp = fraction.charCodeAt(scale) >= 53;
      fraction = fraction.slice(0, scale);
      if (roundUp) {
        const rounded = incrementDigits(integer + fraction);
        integer = rounded.slice(0, rounded.length - scale);
        fraction = rounded.slice(rounded.length - scale);
      }
    } else if (fraction.length < scale) {
      fraction = fraction.padEnd(scale, "0");
    }
  }
  integer = stripLeadingZeros(integer);
  if (precision !== undefined && integer !== "0" && integer.length > precision - scale) return undefined;

  const negative = match[1] === "-" && !(isAllZeros(integer) && isAllZeros(fraction));
  return `${negative ? "-" : ""}${integer}${fraction === "" ? "" : `.${fraction}`}`;
}

/**
 * The form in which two decimals are equal exactly when they are the same number
 * (internal: also the key preloads group decimal keys by).
 *
 * @example
 * ```ts
 * canonicalDecimal("01.500"); // "1.5"
 * ```
 */
export function canonicalDecimal(text: string): string {
  const normal = normalizeDecimal(text, undefined, 0);
  // Not decimal text (the database's "NaN", say): compared as written.
  if (normal === undefined || !normal.includes(".")) return normal ?? text;
  let end = normal.length;
  while (normal.charCodeAt(end - 1) === 48) end--;
  if (normal.charCodeAt(end - 1) === 46) end--;
  return normal.slice(0, end);
}

function decimalEqual(a: string, b: string): boolean {
  return a === b || canonicalDecimal(a) === canonicalDecimal(b);
}

function decimalCast(precision: number | undefined, scale: number): (input: unknown) => CastResult<string> {
  return (input) => {
    let text: string;
    if (typeof input === "string") {
      text = input;
    } else if (typeof input === "number" && Number.isFinite(input)) {
      text = numberToDecimalText(input);
    } else {
      return INVALID;
    }
    const data = normalizeDecimal(text, precision, scale);
    return data === undefined ? INVALID : { success: true, data };
  };
}

const DECIMAL = /* @__PURE__ */ defineType<string>({
  name: "decimal",
  db: { kind: "decimal" },
  cast: /* @__PURE__ */ decimalCast(undefined, 0),
  equal: decimalEqual,
});

/**
 * Options of `t.decimal()`: the column's precision and scale.
 *
 * @example
 * ```ts
 * import { type DecimalOptions, t } from "egon-orm";
 *
 * const money: DecimalOptions = { precision: 10, scale: 2 };
 * const price = t.decimal(money);
 * ```
 */
export interface DecimalOptions {
  /** The total number of digits, 1 to 1000. */
  readonly precision: number;
  /** The number of digits after the point, 0 to `precision`. Defaults to 0. */
  readonly scale?: number;
}

const decimalWith = /* @__PURE__ */ parameterized(
  (options: { readonly precision: number; readonly scale: number }) =>
    defineType<string>({
      name: `decimal(${options.precision},${options.scale})`,
      db: { kind: "decimal" },
      cast: decimalCast(options.precision, options.scale),
      equal: decimalEqual,
    }),
);

/**
 * An exact decimal number, kept as a string so that no digit is lost. Accepts decimal
 * text such as `"19.99"`, `"-0.5"` or `".5"` (no exponent), or a finite number.
 *
 * With `{ precision, scale }` the value is rounded to `scale` digits after the point, half
 * away from zero as the database does, and a number with more than `precision - scale`
 * digits before the point is rejected.
 *
 * Two decimals are equal when they are the same number: `"1.50"` equals `"1.5"`.
 *
 * @example
 * ```ts
 * decimalType().cast("19.990"); // { success: true, data: "19.990" }
 * decimalType({ precision: 10, scale: 2 }).cast(0.1 + 0.2); // { success: true, data: "0.30" }
 * decimalType().equal("1.50", "1.5"); // true
 * ```
 *
 * @throws SchemaDefinitionError when `precision` or `scale` is out of range.
 */
export function decimalType(options?: DecimalOptions): FieldType<string, string> {
  if (options === undefined) return DECIMAL;
  const precision = own(options, "precision");
  const scale = own(options, "scale") ?? 0;
  if (precision === undefined || !Number.isInteger(precision) || precision < 1 || precision > 1000) {
    throw new SchemaDefinitionError(
      "schema.decimalPrecision",
      `t.decimal: precision must be a whole number from 1 to 1000, but got ${String(precision)}.`,
    );
  }
  if (!Number.isInteger(scale) || scale < 0 || scale > precision) {
    throw new SchemaDefinitionError(
      "schema.decimalScale",
      `t.decimal: scale must be a whole number from 0 to the precision (${precision}), but got ${String(scale)}.`,
    );
  }
  return decimalWith({ precision, scale });
}

// --- boolean -----------------------------------------------------------------

const TRUE: CastResult<boolean> = /* @__PURE__ */ Object.freeze({ success: true, data: true });
const FALSE: CastResult<boolean> = /* @__PURE__ */ Object.freeze({ success: true, data: false });

const BOOLEAN = /* @__PURE__ */ defineType<boolean>({
  name: "boolean",
  db: { kind: "boolean" },
  cast: (input) => {
    if (input === true || input === "true" || input === 1 || input === "1") return TRUE;
    if (input === false || input === "false" || input === 0 || input === "0") return FALSE;
    return INVALID;
  },
});

/**
 * A boolean. Accepts `true`, `false`, `"true"`, `"false"`, `1`, `0`, `"1"` and `"0"`,
 * which covers JSON and HTML form input.
 *
 * @example
 * ```ts
 * booleanType().cast("1"); // { success: true, data: true }
 * booleanType().cast("yes"); // { success: false }
 * ```
 */
export function booleanType(): FieldType<boolean, boolean> {
  return BOOLEAN;
}

// --- uuid --------------------------------------------------------------------

const UUID = /* @__PURE__ */ defineType<string>({
  name: "uuid",
  db: { kind: "uuid" },
  cast: (input) =>
    typeof input === "string" && input.length === 36 && UUID_TEXT.test(input)
      ? { success: true, data: input.toLowerCase() }
      : INVALID,
});

/**
 * A UUID as a string. Accepts the canonical 36-character form in any case and
 * normalises it to lower case.
 *
 * @example
 * ```ts
 * uuidType().cast("6F9619FF-8B86-D011-B42D-00C04FC964FF");
 * // { success: true, data: "6f9619ff-8b86-d011-b42d-00c04fc964ff" }
 * ```
 */
export function uuidType(): FieldType<string, string> {
  return UUID;
}

// --- binary ------------------------------------------------------------------

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  const length = a.length;
  if (length !== b.length) return false;
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The getter that names the kind of a typed array from its internal slot, and gives `undefined` for anything else. */
const typedArrayTag = /* @__PURE__ */ Object.getOwnPropertyDescriptor(
  /* @__PURE__ */ Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag,
)?.get as (this: unknown) => string | undefined;

const BINARY = /* @__PURE__ */ defineType<Uint8Array>({
  name: "binary",
  db: { kind: "binary" },
  // The getter reads the internal slot and runs no code of the value: it cannot throw, an
  // object that only inherits from Uint8Array.prototype does not pass, and a Uint8Array
  // from another realm does (`instanceof` fails all three).
  cast: (input) =>
    typedArrayTag.call(input) === "Uint8Array" ? { success: true, data: input as Uint8Array } : INVALID,
  equal: bytesEqual,
});

/**
 * Bytes. Accepts a `Uint8Array` (a Node.js `Buffer` is one). Two values are equal when
 * they hold the same bytes.
 *
 * @example
 * ```ts
 * binaryType().cast(new Uint8Array([1, 2, 3])); // { success: true, data: Uint8Array [1, 2, 3] }
 * binaryType().equal(new Uint8Array([1]), new Uint8Array([1])); // true
 * ```
 */
export function binaryType(): FieldType<Uint8Array, Uint8Array> {
  return BINARY;
}
