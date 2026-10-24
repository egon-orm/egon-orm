// Unit tests of Batch: building (immutability, unique names, the listing), the check of
// changesets given as they are, and running the steps against a recording repo. How a
// batch runs inside a real transaction is in repo/transaction.test.ts and the transaction
// conformance suite.
import { Org, Post, Tag, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import { failure, success } from "../contracts/result.js";
import { QueryError } from "../errors.js";
import { cast, change, from } from "../index.js";
import type { Repo } from "../repo/repo.js";
import { Batch, createBatch, firstInvalid, isBatch, runSteps } from "./batch.js";

/** What `tx.rollback(reason)` throws in these tests. */
class Rolled {
  constructor(readonly reason: unknown) {}
}

interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** A repo that records each call and answers it from `answers`, by method name. */
function recorder(answers: Record<string, (...args: unknown[]) => unknown> = {}) {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    async (...args: unknown[]): Promise<unknown> => {
      calls.push({ method, args });
      const answer = answers[method];
      return answer === undefined ? success(`${method} result`) : answer(...args);
    };
  const repo = {
    insert: record("insert"),
    update: record("update"),
    delete: record("delete"),
    insertOrUpdate: record("insertOrUpdate"),
    insertAll: record("insertAll"),
    updateAll: record("updateAll"),
    deleteAll: record("deleteAll"),
    one: record("one"),
    all: record("all"),
    exists: record("exists"),
    rollback(reason: unknown): never {
      calls.push({ method: "rollback", args: [reason] });
      throw new Rolled(reason);
    },
  };
  return { repo: repo as unknown as Repo, calls };
}

async function rolledBack(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rolled) return error.reason;
    throw error;
  }
  throw new Error("expected a rollback");
}

describe("building a batch", () => {
  test("every method returns a new batch and leaves the original as it was", () => {
    const empty = createBatch();
    const one = empty.put("a", 1);
    const two = one.put("b", 2);
    expect(Batch.toList(empty)).toEqual([]);
    expect(Batch.toList(one).map((step) => step.name)).toEqual(["a"]);
    expect(Batch.toList(two).map((step) => step.name)).toEqual(["a", "b"]);
    expect(Object.isFrozen(Batch.toList(two))).toBe(true);
    expect(Object.isFrozen(Batch.toList(two)[0])).toBe(true);
    expect(createBatch()).toBe(empty);
  });

  test("toList lists each step's name, operation, input, schema and arguments", () => {
    const cs = change(Tag, { name: "t" });
    const query = from(Tag, "t");
    const later = () => change(Tag, { name: "later" });
    const inspector = () => undefined;
    const batch = createBatch()
      .insert("tag", cs, { returning: true })
      .update("later", later)
      .insertAll("many", Tag, [{ name: "a" }])
      .all("tags", query, { timeoutMs: 5 })
      .inspect(inspector)
      .inspect("look", inspector);
    expect(Batch.toList(batch)).toEqual([
      { name: "tag", operation: "insert", input: cs, schema: undefined, args: [{ returning: true }] },
      { name: "later", operation: "update", input: later, schema: undefined, args: [] },
      { name: "many", operation: "insertAll", input: [{ name: "a" }], schema: Tag, args: [] },
      { name: "tags", operation: "all", input: query, schema: undefined, args: [{ timeoutMs: 5 }] },
      { name: undefined, operation: "inspect", input: inspector, schema: undefined, args: [] },
      { name: "look", operation: "inspect", input: inspector, schema: undefined, args: [] },
    ]);
  });

  test("a step name that is already used is a QueryError when the batch is built", () => {
    const batch = createBatch().put("user", 1);
    expect(() => batch.put("user" as never, 2)).toThrow(QueryError);
    expect(() => batch.put("user" as never, 2)).toThrow('already has a step named "user"');
    expect(() => batch.inspect("user" as never, () => undefined)).toThrow(QueryError);
  });

  test("a step named __proto__ is a QueryError when the batch is built", () => {
    // Its result would replace the prototype of the results object.
    expect(() => createBatch().put("__proto__", { polluted: true })).toThrow(
      expect.objectContaining({ id: "query.batchStepName" }),
    );
    expect(() => createBatch().run("__proto__", () => success({}))).toThrow(QueryError);
    expect(() => createBatch().inspect("__proto__", () => undefined)).toThrow(QueryError);
    // Other names of Object.prototype's members are plain own keys of the results.
    expect(Batch.toList(createBatch().put("constructor", 1)).map((step) => step.name)).toEqual([
      "constructor",
    ]);
  });

  test("append and prepend join two batches, refusing a name that both have", () => {
    const first = createBatch().put("a", 1);
    const second = createBatch().put("b", 2);
    expect(Batch.toList(first.append(second)).map((step) => step.name)).toEqual(["a", "b"]);
    expect(Batch.toList(first.prepend(second)).map((step) => step.name)).toEqual(["b", "a"]);
    expect(() => first.append(createBatch().put("a", 3))).toThrow(QueryError);
    expect(() => first.prepend(createBatch().put("a", 3))).toThrow(QueryError);
    // The joined batch knows both sets of names.
    expect(() => first.append(second).put("b" as never, 4)).toThrow(QueryError);
  });

  test("wrong arguments are a TypeError", () => {
    const batch = createBatch();
    expect(() => batch.put("" as never, 1)).toThrow(TypeError);
    expect(() => batch.put(3 as never, 1)).toThrow(TypeError);
    expect(() => batch.insertAll("x", {} as never, [])).toThrow(TypeError);
    expect(() => batch.run("x", "not a function" as never)).toThrow(TypeError);
    expect(() => batch.inspect("x", "not a function" as never)).toThrow(TypeError);
    expect(() => batch.inspect(undefined as never)).toThrow(TypeError);
    expect(() => batch.merge("not a function" as never)).toThrow(TypeError);
    expect(() => batch.append({} as never)).toThrow(TypeError);
    expect(() => batch.prepend({} as never)).toThrow(TypeError);
    expect(() => Batch.toList({} as never)).toThrow(TypeError);
  });

  test("isBatch tells a batch from anything else", () => {
    expect(isBatch(createBatch())).toBe(true);
    expect(isBatch({})).toBe(false);
    expect(isBatch(() => undefined)).toBe(false);
  });
});

describe("the check before the transaction opens", () => {
  test("finds the first write step given an invalid changeset as it is, with nothing completed", () => {
    const invalid = cast(User, {}, ["email"]).validateRequired(["email"]);
    const alsoInvalid = change(Tag, {}).addError("name", "no");
    const batch = createBatch()
      .put("a", 1)
      .insert("valid", change(Tag, { name: "ok" }))
      .insert("first", invalid)
      .update("second", alsoInvalid);
    expect(firstInvalid(batch)).toEqual({ step: "first", error: invalid, completed: {} });
  });

  test("ignores steps computed from earlier results, and steps that are not writes of a changeset", () => {
    const batch = createBatch()
      .insert("computed", () => change(Tag, {}).addError("name", "no"))
      .delete("row", { id: 1 } as never)
      .run("x", () => failure("not checked"));
    expect(firstInvalid(batch)).toBeUndefined();
  });
});

describe("running the steps", () => {
  test("each step calls its repo method with its input and arguments, and keeps the result under its name", async () => {
    const { repo, calls } = recorder({
      insertAll: () => ({ count: 2, rows: null }),
      updateAll: () => ({ count: 1, rows: null }),
      deleteAll: () => ({ count: 0, rows: null }),
      one: () => "one row",
      all: () => ["rows"],
      exists: () => true,
    });
    const cs = change(Tag, { name: "t" });
    const query = from(Tag, "t");
    const batch = createBatch()
      .insert("insert", cs, { returning: true })
      .update("update", cs as never)
      .delete("delete", cs as never)
      .insertOrUpdate("upsert", cs)
      .insertAll("insertAll", Tag, [{ name: "a" }, { name: "b" }])
      .updateAll("updateAll", query.set({ name: "u" }))
      .deleteAll("deleteAll", Tag)
      .one("one", query)
      .all("all", Post)
      .exists("exists", query, { timeoutMs: 9 })
      .put("put", () => "a function is kept as it is");
    const results = await runSteps(batch, repo);
    expect(results).toEqual({
      insert: "insert result",
      update: "update result",
      delete: "delete result",
      upsert: "insertOrUpdate result",
      insertAll: { count: 2, rows: null },
      updateAll: { count: 1, rows: null },
      deleteAll: { count: 0, rows: null },
      one: "one row",
      all: ["rows"],
      exists: true,
      put: expect.any(Function),
    });
    expect(calls.map((call) => call.method)).toEqual([
      "insert",
      "update",
      "delete",
      "insertOrUpdate",
      "insertAll",
      "updateAll",
      "deleteAll",
      "one",
      "all",
      "exists",
    ]);
    expect(calls[0]?.args).toEqual([cs, { returning: true }]);
    expect(calls[4]?.args).toEqual([Tag, [{ name: "a" }, { name: "b" }]]);
    // A schema class given as the queryable is passed as it is, not called.
    expect(calls[6]?.args).toEqual([Tag]);
    expect(calls[8]?.args).toEqual([Post]);
    expect(calls[9]?.args).toEqual([query, { timeoutMs: 9 }]);
  });

  test("a step given a function computes its input from a copy of the results so far", async () => {
    const { repo, calls } = recorder({ insert: (cs) => success({ inserted: cs }) });
    const seen: unknown[] = [];
    const batch = createBatch()
      .put("org", { id: "o1" })
      .insert("member", ({ org }) => {
        seen.push(org);
        return change(Org, { name: org.id });
      })
      .inspect((results) => {
        seen.push(Object.keys(results));
        (results as Record<string, unknown>).tampered = true;
      })
      .run("last", async (tx, results) => {
        expect(tx).toBe(repo);
        return success(Object.keys(results));
      });
    const results = await runSteps(batch, repo);
    expect(seen).toEqual([{ id: "o1" }, ["org", "member"]]);
    expect(results.last).toEqual(["org", "member"]);
    expect(results).not.toHaveProperty("tampered");
    expect(calls).toHaveLength(1);
  });

  test("a write step's failure rolls back with { step, error, completed }", async () => {
    const { repo } = recorder({ update: () => failure("the changeset") });
    const batch = createBatch()
      .put("first", 1)
      .update("second", change(Tag, { name: "x" }) as never)
      .put("third", 3);
    expect(await rolledBack(runSteps(batch, repo))).toEqual({
      step: "second",
      error: "the changeset",
      completed: { first: 1 },
    });
  });

  test("a run step's failure(error) rolls back; a run step that does not return a Result is a TypeError", async () => {
    const { repo } = recorder();
    expect(
      await rolledBack(
        runSteps(
          createBatch().run("r", () => failure(7)),
          repo,
        ),
      ),
    ).toEqual({
      step: "r",
      error: 7,
      completed: {},
    });
    for (const returned of [undefined, null, 5, { success: "yes" }]) {
      const batch = createBatch().run("r", () => returned as never);
      await expect(runSteps(batch, repo)).rejects.toThrow(TypeError);
    }
  });

  test("merge adds the steps of the batch it builds, at that point, with the results so far", async () => {
    const { repo } = recorder();
    const batch = createBatch()
      .put("a", 1)
      .merge(async ({ a }) => createBatch().put("b", a + 1))
      .put("c", 3)
      .merge(({ b }) => createBatch().put("d", b * 10));
    expect(await runSteps(batch, repo)).toEqual({ a: 1, b: 2, c: 3, d: 20 });
  });

  test("merge refuses a step name the batch already has, and anything but a batch", async () => {
    const { repo } = recorder();
    await expect(
      runSteps(
        createBatch()
          .put("a", 1)
          .merge(() => createBatch().put("a", 2)),
        repo,
      ),
    ).rejects.toThrow(QueryError);
    // Also a name that comes later in the batch.
    const later = createBatch()
      .merge(() => createBatch().put("z", 1))
      .put("z" as never, 2);
    await expect(runSteps(later, repo)).rejects.toThrow(QueryError);
    await expect(
      runSteps(
        createBatch().merge(() => ({}) as never),
        repo,
      ),
    ).rejects.toThrow(TypeError);
  });
});
