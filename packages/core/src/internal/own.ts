/**
 * Reading an option the caller gave. Options objects come from the caller, so they are
 * read as own properties only: a key planted on `Object.prototype` is never an option
 * (owner decision, 2026-10-24).
 *
 * @module
 */

const hasOwn = Object.hasOwn;

/**
 * The value of `options[key]` when `options` has it as an own property; `undefined`
 * otherwise, and when `options` is `undefined` or `null`. A key inherited from
 * `Object.prototype` (or any other prototype) reads as absent.
 *
 * @example
 * ```ts
 * own({ message: "is taken" }, "message"); // "is taken"
 * own(undefined, "message"); // undefined
 * own(Object.create({ message: "planted" }), "message"); // undefined
 * ```
 */
export function own<O extends object, K extends keyof O>(
  options: O | null | undefined,
  key: K,
): O[K] | undefined {
  return options !== undefined && options !== null && hasOwn(options, key) ? options[key] : undefined;
}

/**
 * A frozen object without a prototype, holding `values`: a default options object whose
 * absent keys read as `undefined` whatever `Object.prototype` holds.
 *
 * @example
 * ```ts
 * const NO_OPTIONS = frozenOptions({});
 * (NO_OPTIONS as { required?: boolean }).required; // undefined, even if Object.prototype.required is set
 * ```
 */
export function frozenOptions<T extends object>(values: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null) as T, values));
}

/**
 * Assigns `out[key] = value` as an own property, also for the key `"__proto__"` (which
 * `JSON.parse` produces as an ordinary own key): a plain assignment would replace the
 * object's prototype instead, dropping the key.
 *
 * @example
 * ```ts
 * const out: Record<string, unknown> = {};
 * setOwn(out, "__proto__", { admin: true });
 * Object.getPrototypeOf(out) === Object.prototype; // true
 * Object.hasOwn(out, "__proto__"); // true
 * ```
 */
export function setOwn(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    out[key] = value;
  }
}
