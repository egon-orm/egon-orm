// Options read as own properties only (owner decision, 2026-10-24): a key planted on
// Object.prototype is never taken as an option. See also
// packages/core/test/security/hostile-params.test.ts.
import { User } from "@egon-orm/test-support";
import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { toZod } from "./index.js";

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

describe("a key planted on Object.prototype is no option of toZod()", () => {
  test("a planted omit or mode is not used", () => {
    const keys = Object.keys(toZod(User, {}).shape).sort();
    plant("omit", ["email"]);
    plant("mode", "insert");
    expect(Object.keys(toZod(User, {}).shape).sort()).toEqual(keys);
  });

  test("a planted zod hint does not replace a field's schema", () => {
    plant("zod", z.any());
    expect(toZod(User, { pick: ["email"] as never }).safeParse({ email: 1 }).success).toBe(false);
  });
});
