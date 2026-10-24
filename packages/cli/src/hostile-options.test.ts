// Options read as own properties only (owner decision, 2026-10-24): a key planted on
// Object.prototype is never taken as an option. See also
// packages/core/test/security/hostile-params.test.ts.
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { run } from "./cli.js";
import { loadConfig } from "./config.js";

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

const CONFIG = "export default { adapter: { acquire() {}, execute() {}, close: async () => {} } };";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "egon-cli-own-"));
});
afterEach(async () => {
  for (const key of planted.splice(0)) Reflect.deleteProperty(Object.prototype, key);
  await rm(cwd, { recursive: true, force: true });
});

describe("a key planted on Object.prototype is no setting of the CLI", () => {
  test("a planted database is no database setting", async () => {
    await writeFile(join(cwd, "egon.config.mjs"), CONFIG);
    plant("database", { name: 1 });
    const loaded = await loadConfig(cwd, undefined);
    expect(loaded.config.database).toBeUndefined();
  });

  test("a planted adapter is no adapter, and an injected module's planted default is no config", async () => {
    await writeFile(join(cwd, "egon.config.mjs"), "export const nothing = 1;");
    plant("adapter", { acquire() {}, execute() {} });
    plant("config", { adapter: { acquire() {}, execute() {} } });
    await expect(loadConfig(cwd, undefined, async () => ({}))).rejects.toThrow(/an object with an adapter/);
  });

  test("an io whose methods are on its class's prototype works", async () => {
    class Io {
      out = "";
      readonly cwd = cwd;
      readonly env = {};
      stdout(text: string): void {
        this.out += text;
      }
      stderr(): void {}
      now(): Date {
        return new Date("2026-10-24T09:30:00Z");
      }
    }
    const io = new Io();
    expect(await run(["--version"], io)).toBe(0);
    expect(io.out).toMatch(/\d+\.\d+\.\d+/);
  });

  test("an error that is not Egon's is reported without a planted sql or cause", async () => {
    plant("sql", "select planted");
    let err = "";
    const io = {
      stdout: () => {},
      stderr: (text: string) => {
        err += text;
      },
      cwd,
      env: {},
      now: () => new Date("2026-10-24T09:30:00Z"),
    };
    expect(await run(["migrate"], io)).not.toBe(0);
    expect(err).toContain("error:");
    expect(err).not.toContain("select planted");
  });

  test("a planted migrations directory is not where migrate create writes", async () => {
    await writeFile(join(cwd, "egon.config.mjs"), CONFIG);
    plant("migrations", { directory: "planted" });
    let out = "";
    const io = {
      stdout: (text: string) => {
        out += text;
      },
      stderr: () => {},
      cwd,
      env: {},
      now: () => new Date("2026-10-24T09:30:00Z"),
    };
    expect(await run(["migrate", "create", "add_users"], io)).toBe(0);
    expect(out).toMatch(/^Created migrations\//);
    expect(await readdir(cwd)).not.toContain("planted");
  });
});
