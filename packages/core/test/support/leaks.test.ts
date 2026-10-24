import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  assertNoLeaks,
  expectAllReturned,
  type FileRecord,
  leakReport,
  prepareLeakDirectory,
  readFileRecords,
  removeLeakDirectory,
  writeFileRecord,
} from "./leaks.js";

const clean: FileRecord = { file: "a.itest.ts", pools: [{ size: 3, idle: 3, waiting: 0 }] };
const checkedOut: FileRecord = { file: "b.itest.ts", pools: [{ size: 2, idle: 1, waiting: 0 }] };
const waiting: FileRecord = { file: "c.itest.ts", pools: [{ size: 4, idle: 4, waiting: 1 }] };

describe("leakReport", () => {
  test("is empty when every pool has all its connections back", () => {
    expect(leakReport([clean, { file: "d.itest.ts", pools: [] }])).toEqual([]);
  });

  test("names the file of a pool with a connection checked out or a caller waiting", () => {
    expect(leakReport([clean, checkedOut, waiting])).toEqual([
      "b.itest.ts: a pool still has 1 connection(s) checked out and 0 caller(s) waiting",
      "c.itest.ts: a pool still has 0 connection(s) checked out and 1 caller(s) waiting",
    ]);
  });
});

describe("assertNoLeaks", () => {
  test("passes without a leak", () => {
    expect(() => assertNoLeaks([clean])).not.toThrow();
  });

  test("throws, listing every leak", () => {
    expect(() => assertNoLeaks([checkedOut, waiting])).toThrow(
      /Connection leak: 2 pool\(s\)[\s\S]*b\.itest\.ts[\s\S]*c\.itest\.ts/,
    );
  });
});

describe("the record directory", () => {
  test("round-trips the records the workers write, and reads as empty once removed", () => {
    const runId = `test${randomBytes(4).toString("hex")}`;
    prepareLeakDirectory(runId);
    try {
      writeFileRecord(runId, clean, "1");
      writeFileRecord(runId, checkedOut, "2");
      expect(readFileRecords(runId)).toEqual([clean, checkedOut]);
    } finally {
      removeLeakDirectory(runId);
    }
    expect(readFileRecords(runId)).toEqual([]);
  });
});

describe("expectAllReturned", () => {
  test("resolves once the connections are back", async () => {
    let calls = 0;
    const adapter = {
      poolStats: () => (++calls < 3 ? { size: 1, idle: 0, waiting: 0 } : { size: 1, idle: 1, waiting: 0 }),
    };
    await expectAllReturned(adapter);
    expect(calls).toBe(3);
  });

  test("fails when a connection never comes back", async () => {
    const adapter = { poolStats: () => ({ size: 2, idle: 1, waiting: 0 }) };
    await expect(expectAllReturned(adapter, 30)).rejects.toThrow(
      "Connection leak: the test ended with 1 connection(s) checked out and 0 caller(s) waiting (pool size 2, idle 1).",
    );
  });
});
