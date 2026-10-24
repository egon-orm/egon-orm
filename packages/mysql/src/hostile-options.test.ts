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

describe("a key planted on Object.prototype is no option of mysql()", () => {
  test("a planted connection setting is not configured, with options or without", () => {
    plant("host", "elsewhere");
    plant("pool", { max: 1 });
    for (const options of [undefined, {}]) {
      const { config } = resolveOptions(options);
      expect(Object.hasOwn(config, "host")).toBe(false);
      expect(config.connectionLimit).toBe(10);
    }
  });
});
