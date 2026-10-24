/**
 * The date and time built-in types: date, time, timestamp, localTimestamp.
 *
 * Nothing here calls `Date.parse`: its results for anything but the full ISO form differ
 * between engines. Strings are matched against a grammar and the instant is computed
 * from the parts.
 *
 * @module
 */
import type { CastResult, FieldType } from "../contracts/type.js";
import { CastError, SchemaDefinitionError } from "../errors.js";
import { own } from "../internal/own.js";
import { defineType } from "./define.js";
import { INVALID, integerType } from "./scalars.js";

const TIME_TEXT = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/;
const TIMESTAMP_TEXT =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;
/** Longer strings are rejected before the grammar runs. */
const MAX_TIMESTAMP_TEXT = 64;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  if (month === 2 && day === 29) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= (DAYS_IN_MONTH[month - 1] as number);
}

/**
 * The instant of a UTC wall time whose date is a real calendar date. The day count is
 * computed with integer arithmetic (the "days from civil" algorithm): `Date.UTC` reads
 * the years 0 to 99 as 1900 to 1999, and costs several times as much per value.
 */
function utcMillis(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
): number {
  // Years run from March, so that the leap day is the last day of the year. `year` is at
  // least 1, so nothing here is negative and `| 0` truncates as `Math.floor` would, while
  // keeping the arithmetic in integers (about 6 ns of 26 per value in the benchmark).
  const y = month <= 2 ? year - 1 : year;
  const era = (y / 400) | 0;
  const yearOfEra = y - era * 400;
  const dayOfYear = (((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) | 0) + day - 1;
  const dayOfEra = yearOfEra * 365 + ((yearOfEra / 4) | 0) - ((yearOfEra / 100) | 0) + dayOfYear;
  const days = era * 146097 + dayOfEra - 719468;
  return days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1000 + millisecond;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

const getTime = Date.prototype.getTime;

const objectTag = Object.prototype.toString;

/**
 * The timestamp of a valid `Date`, or `NaN` for anything else. It never throws.
 *
 * `getTime` taken from `Date.prototype` reads the internal slot, so it gives the real
 * timestamp of a `Date` from another realm and of an instance of a subclass that overrides
 * `getTime`, and it throws (caught here) for an object that only inherits from
 * `Date.prototype` and for a proxy of a `Date`. The two checks before it only keep the
 * exception rare, since a caught exception is slow: `instanceof` settles a `Date` of this
 * realm in a few nanoseconds, and the tag finds one from another realm.
 */
function timeOf(input: unknown): number {
  try {
    return input instanceof Date || objectTag.call(input) === "[object Date]"
      ? getTime.call(input)
      : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

function datesEqual(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime();
}

// --- date --------------------------------------------------------------------

const DAY = 86_400_000;
const FIRST_DAY = /* @__PURE__ */ utcMillis(1, 1, 1, 0, 0, 0, 0);
const LAST_DAY = /* @__PURE__ */ utcMillis(9999, 12, 31, 0, 0, 0, 0);

/** The two-digit number at `at`, or a negative number when either character is not a digit. */
function twoDigits(text: string, at: number): number {
  const tens = text.charCodeAt(at) - 48;
  const ones = text.charCodeAt(at + 1) - 48;
  return tens >= 0 && tens <= 9 && ones >= 0 && ones <= 9 ? tens * 10 + ones : -1;
}

/**
 * Midnight UTC of a `"YYYY-MM-DD"` date, or `NaN` when the text is not a real date.
 *
 * It reads the text by character code and stays in integer arithmetic. This runs once per
 * value when a date column is read as a `Date`; matching a regular expression, converting
 * three substrings and calling `Date.UTC` cost about twice as much (128 ns against 57 ns
 * per value in benchmarks/micro/types.bench.ts, "load an array of 1,000 elements").
 */
function dateTextToMillis(text: string): number {
  if (text.length !== 10 || text.charCodeAt(4) !== 45 || text.charCodeAt(7) !== 45) return Number.NaN;
  const century = twoDigits(text, 0);
  const yearInCentury = twoDigits(text, 2);
  const month = twoDigits(text, 5);
  const day = twoDigits(text, 8);
  if (century < 0 || yearInCentury < 0 || month < 0 || day < 0) return Number.NaN;
  const year = century * 100 + yearInCentury;
  return isCalendarDate(year, month, day) ? utcMillis(year, month, day, 0, 0, 0, 0) : Number.NaN;
}

/** Reads `{ year, month, day }`, each a whole number or a string of digits (form input). */
function dateObjectToMillis(input: object): number {
  try {
    // Own properties only: a year, month or day planted on Object.prototype is not input.
    const parts = input as { year?: unknown; month?: unknown; day?: unknown };
    const year = own(parts, "year");
    const month = own(parts, "month");
    const day = own(parts, "day");
    if (year == null || month == null || day == null) return Number.NaN;
    const integer = integerType();
    const y = integer.cast(year);
    const m = integer.cast(month);
    const d = integer.cast(day);
    return y.success && m.success && d.success && isCalendarDate(y.data, m.data, d.data)
      ? utcMillis(y.data, m.data, d.data, 0, 0, 0, 0)
      : Number.NaN;
  } catch {
    // A getter or a proxy trap threw.
    return Number.NaN;
  }
}

/** Midnight UTC of the calendar date of any accepted input, or `NaN`. */
function dateInputToMillis(input: unknown): number {
  if (typeof input === "string") return dateTextToMillis(input);
  if (typeof input !== "object" || input === null) return Number.NaN;
  const time = timeOf(input);
  if (Number.isNaN(time)) return dateObjectToMillis(input);
  // A Date gives its UTC date, within the years 1 to 9999.
  const midnight = Math.floor(time / DAY) * DAY;
  return midnight >= FIRST_DAY && midnight <= LAST_DAY ? midnight : Number.NaN;
}

function formatUtcDate(value: Date): string {
  return `${String(value.getUTCFullYear()).padStart(4, "0")}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`;
}

const DATE = /* @__PURE__ */ defineType<string>({
  name: "date",
  db: { kind: "date" },
  cast: (input) => {
    const time = dateInputToMillis(input);
    if (Number.isNaN(time)) return INVALID;
    // A valid date string is already the value.
    return { success: true, data: typeof input === "string" ? input : formatUtcDate(new Date(time)) };
  },
});

function dateTextToDate(stored: string): Date {
  const time = dateTextToMillis(stored);
  if (Number.isNaN(time)) {
    throw new CastError(
      "cast.dateRead",
      'A date column read with { as: "date" } holds a value that is not a "YYYY-MM-DD" date (for example "infinity", or a date before year 1).',
    );
  }
  return new Date(time);
}

function dateToDateText(value: Date): string {
  const time = value.getTime();
  if (Number.isNaN(time)) {
    throw new CastError("cast.dateInvalidWrite", "An invalid Date cannot be written to a date column.");
  }
  // The same range that cast and fromDb accept: a date written here can be read back.
  if (time < FIRST_DAY || time >= LAST_DAY + DAY) {
    throw new CastError(
      "cast.dateRange",
      'A Date outside the years 1 to 9999 cannot be written to a date column read with { as: "date" }.',
    );
  }
  return formatUtcDate(value);
}

const DATE_AS_DATE = /* @__PURE__ */ defineType<Date, string>({
  name: "date(date)",
  db: { kind: "date" },
  cast: (input) => {
    const time = dateInputToMillis(input);
    return Number.isNaN(time) ? INVALID : { success: true, data: new Date(time) };
  },
  fromDb: dateTextToDate,
  toDb: dateToDateText,
  equal: datesEqual,
});

/**
 * Options of {@link dateType}.
 *
 * @example
 * ```ts
 * const options: DateOptions = { as: "date" };
 * ```
 */
export interface DateOptions {
  /** `"string"` (the default) gives `"YYYY-MM-DD"`; `"date"` gives a `Date` at midnight UTC. */
  readonly as?: "string" | "date";
}

/**
 * A calendar date with no time and no time zone. The value is a `"YYYY-MM-DD"` string by
 * default, because a string cannot shift to the day before in another time zone.
 *
 * Accepts a `"YYYY-MM-DD"` string, a `Date` (its UTC date is taken) or
 * `{ year, month, day }`. Rejects dates that do not exist, such as 30 February.
 *
 * With `{ as: "date" }` the value is a `Date` at midnight UTC. The driver's value is the
 * `"YYYY-MM-DD"` string in both modes.
 *
 * @example
 * ```ts
 * dateType().cast({ year: 2026, month: 10, day: 13 }); // { success: true, data: "2026-10-13" }
 * dateType().cast("2026-02-30"); // { success: false }
 * dateType({ as: "date" }).cast("2026-10-13"); // { success: true, data: new Date("2026-10-13T00:00:00Z") }
 * ```
 *
 * @throws CastError from `fromDb` and `toDb` in `"date"` mode, for a stored value that is
 * not a `"YYYY-MM-DD"` date and for an invalid `Date`.
 */
export function dateType(options?: { readonly as?: "string" }): FieldType<string, string>;
export function dateType(options: { readonly as: "date" }): FieldType<Date, string>;
export function dateType(options?: DateOptions): FieldType<string, string> | FieldType<Date, string> {
  const as = own(options, "as") ?? "string";
  if (as === "string") return DATE;
  if (as === "date") return DATE_AS_DATE;
  throw new SchemaDefinitionError(
    "schema.dateAsOption",
    `t.date: as must be "string" or "date", but got ${JSON.stringify(as)}.`,
  );
}

// --- time --------------------------------------------------------------------

function castTime(input: unknown): CastResult<string> {
  if (typeof input !== "string" || input.length > 15) return INVALID;
  const match = TIME_TEXT.exec(input);
  if (match === null) return INVALID;
  const second = match[3] ?? "00";
  if (Number(match[1]) > 23 || Number(match[2]) > 59 || Number(second) > 59) return INVALID;
  // The form the database returns: seconds always, fraction without trailing zeros.
  let fraction = match[4] ?? "";
  let end = fraction.length;
  while (end > 0 && fraction.charCodeAt(end - 1) === 48) end--;
  fraction = fraction.slice(0, end);
  return { success: true, data: `${match[1]}:${match[2]}:${second}${fraction === "" ? "" : `.${fraction}`}` };
}

const TIME = /* @__PURE__ */ defineType<string>({ name: "time", db: { kind: "time" }, cast: castTime });

/**
 * A time of day with no date and no time zone, as a string. Accepts `"HH:MM"`,
 * `"HH:MM:SS"` and `"HH:MM:SS.ffffff"`, and normalises to the form the database returns:
 * seconds always present, no trailing zeros in the fraction.
 *
 * @example
 * ```ts
 * timeType().cast("09:30"); // { success: true, data: "09:30:00" }
 * timeType().cast("25:00"); // { success: false }
 * ```
 */
export function timeType(): FieldType<string, string> {
  return TIME;
}

// --- timestamp and localTimestamp ------------------------------------------------

interface ParsedTimestamp {
  /** The instant, reading the wall time as UTC and then applying the offset if there is one. */
  readonly time: number;
  readonly hasOffset: boolean;
}

function parseTimestamp(text: string): ParsedTimestamp | undefined {
  if (text.length > MAX_TIMESTAMP_TEXT) return undefined;
  const match = TIMESTAMP_TEXT.exec(text);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");
  if (!isCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return undefined;
  // A Date holds milliseconds: further digits are dropped, not rounded.
  const millisecond = Number((match[7] ?? "").slice(0, 3).padEnd(3, "0"));
  const wallTime = utcMillis(year, month, day, hour, minute, second, millisecond);

  const zone = match[8];
  if (zone === undefined) return { time: wallTime, hasOffset: false };
  if (zone === "Z" || zone === "z") return { time: wallTime, hasOffset: true };
  const offsetHours = Number(zone.slice(1, 3));
  const offsetMinutes = Number(zone.slice(-2));
  if (offsetHours > 23 || (zone.length > 3 && offsetMinutes > 59)) return undefined;
  const offset = (offsetHours * 60 + (zone.length > 3 ? offsetMinutes : 0)) * 60_000;
  return { time: zone.charCodeAt(0) === 45 ? wallTime + offset : wallTime - offset, hasOffset: true };
}

/**
 * The precision of a timestamp field: `"s"`, `"ms"` (the default) or `"us"`.
 *
 * @example
 * ```ts
 * import { type TimestampPrecision, t } from "egon-orm";
 *
 * const precision: TimestampPrecision = "s";
 * const loggedAt = t.timestamp({ precision });
 * ```
 */
export type TimestampPrecision = "s" | "ms" | "us";

/**
 * Options of `t.timestamp()` and `t.localTimestamp()`.
 *
 * @example
 * ```ts
 * import { type TimestampOptions, t } from "egon-orm";
 *
 * const seconds: TimestampOptions = { precision: "s" };
 * const publishedAt = t.timestamp(seconds);
 * ```
 */
export interface TimestampOptions {
  /**
   * `"ms"` (the default) keeps what a JavaScript `Date` holds. `"s"` drops the
   * milliseconds of accepted input. `"us"` declares a microsecond column; the value is
   * still a `Date`, so it carries milliseconds.
   */
  readonly precision?: TimestampPrecision;
}

function timestampCast(
  withOffset: boolean,
  precision: TimestampPrecision,
): (input: unknown) => CastResult<Date> {
  const wholeSeconds = precision === "s";
  return (input) => {
    let time: number;
    if (typeof input === "string") {
      const parsed = parseTimestamp(input);
      if (parsed === undefined || parsed.hasOffset !== withOffset) return INVALID;
      time = parsed.time;
    } else if (typeof input === "object" && input !== null) {
      time = timeOf(input);
      if (Number.isNaN(time)) return INVALID;
      // A plain Date is returned as it is, unless its milliseconds have to go. An instance
      // of a subclass is copied: its methods may be overridden, and `equal` calls them.
      if ((!wholeSeconds || time % 1000 === 0) && Object.getPrototypeOf(input) === Date.prototype) {
        return { success: true, data: input as Date };
      }
    } else {
      return INVALID;
    }
    return { success: true, data: new Date(wholeSeconds ? Math.floor(time / 1000) * 1000 : time) };
  };
}

function timestampTypes(
  name: string,
  kind: "timestamp" | "timestamptz",
  withOffset: boolean,
): Readonly<Record<TimestampPrecision, FieldType<Date, Date>>> {
  const make = (precision: TimestampPrecision): FieldType<Date, Date> =>
    defineType<Date>({
      name: precision === "ms" ? name : `${name}(${precision})`,
      db: { kind },
      cast: timestampCast(withOffset, precision),
      equal: datesEqual,
    });
  return { s: make("s"), ms: make("ms"), us: make("us") };
}

function pickPrecision(
  builder: string,
  types: Readonly<Record<TimestampPrecision, FieldType<Date, Date>>>,
  options: TimestampOptions | undefined,
): FieldType<Date, Date> {
  const precision = own(options, "precision") ?? "ms";
  if (precision === "s" || precision === "ms" || precision === "us") return types[precision];
  throw new SchemaDefinitionError(
    "schema.precisionOption",
    `${builder}: precision must be "s", "ms" or "us", but got ${JSON.stringify(precision)}.`,
  );
}

const TIMESTAMP = /* @__PURE__ */ timestampTypes("timestamp", "timestamptz", true);
const LOCAL_TIMESTAMP = /* @__PURE__ */ timestampTypes("localTimestamp", "timestamp", false);

/**
 * A moment in time, stored with a time zone. The value is a `Date`.
 *
 * Accepts a valid `Date`, or an ISO-8601 string **with** an offset or `Z`, such as
 * `"2026-10-13T09:30:00Z"` or `"2026-10-13 11:30:00.250+02:00"`. A string without an
 * offset is rejected, because it does not say which moment it means.
 *
 * `precision` defaults to `"ms"`. With `"s"`, the milliseconds of accepted input are dropped.
 *
 * @example
 * ```ts
 * timestampType().cast("2026-10-13T11:30:00+02:00"); // { success: true, data: new Date("2026-10-13T09:30:00Z") }
 * timestampType().cast("2026-10-13T11:30:00"); // { success: false }
 * ```
 *
 * @throws SchemaDefinitionError when `precision` is not `"s"`, `"ms"` or `"us"`.
 */
export function timestampType(options?: TimestampOptions): FieldType<Date, Date> {
  return pickPrecision("t.timestamp", TIMESTAMP, options);
}

/**
 * A date and time with no time zone: a wall-clock reading. The value is a `Date` whose
 * **UTC** fields hold that reading, so `getUTCHours()` is the hour that was written.
 *
 * Accepts a valid `Date`, or an ISO-8601 string **without** an offset, such as
 * `"2026-10-13T09:30:00"`. A string with an offset or `Z` is rejected.
 *
 * @example
 * ```ts
 * localTimestampType().cast("2026-10-13T09:30:00"); // { success: true, data: new Date("2026-10-13T09:30:00Z") }
 * localTimestampType().cast("2026-10-13T09:30:00Z"); // { success: false }
 * ```
 *
 * @throws SchemaDefinitionError when `precision` is not `"s"`, `"ms"` or `"us"`.
 */
export function localTimestampType(options?: TimestampOptions): FieldType<Date, Date> {
  return pickPrecision("t.localTimestamp", LOCAL_TIMESTAMP, options);
}
