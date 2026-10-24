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

describe("a key planted on Object.prototype is no option of postgres()", () => {
  test("a planted connection setting is not configured", () => {
    plant("ssl", { rejectUnauthorized: false });
    plant("statementTimeoutMs", 1);
    const source = resolveOptions({ connectionString: "postgres://localhost/app" });
    if (!source.owned) throw new Error("expected an owned pool");
    expect(Object.hasOwn(source.config, "ssl")).toBe(false);
    expect(Object.hasOwn(source.config, "statement_timeout")).toBe(false);
  });

  test("a planted pool setting is not configured", () => {
    plant("max", 1);
    const source = resolveOptions({ pool: {} });
    if (!source.owned) throw new Error("expected an owned pool");
    expect(source.config.max).toBe(10);
  });

  test("a planted connection setting does not clash with an existing pool", () => {
    plant("host", "elsewhere");
    const pool = { connect() {}, end() {}, totalCount: 0 };
    expect(resolveOptions({ pool: pool as never }).owned).toBe(false);
  });
});
