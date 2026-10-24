// Options read as own properties only (owner decision, 2026-10-24): a key planted on
// Object.prototype is never taken as an option. See also
// packages/core/test/security/hostile-params.test.ts.
import { afterEach, describe, expect, test } from "vitest";
import { resolveOptions } from "./options.js";

/** Removes what a test put on Object.prototype. */
const planted: string[] = [];
function plant(key: string, value: unknown): void {
  planted.push(key);
  Object.defineProperty(Object.prototype, key, {
    value,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}
afterEach(() => {
  for (const key of planted.splice(0)) Reflect.deleteProperty(Object.prototype, key);
});

describe("a key planted on Object.prototype is no option of sqlite()", () => {
  test("a planted filename, readonly or attach is not used", () => {
    plant("readonly", true);
    plant("attach", { audit: "audit.db" });
    expect(resolveOptions({ filename: ":memory:" })).toMatchObject({ readonly: false, attach: [] });
  });

  test("a planted filename does not stand in for a missing one", () => {
    plant("filename", "planted.db");
    expect(() => resolveOptions({} as never)).toThrow(/filename must be a non-empty string/);
  });
});
