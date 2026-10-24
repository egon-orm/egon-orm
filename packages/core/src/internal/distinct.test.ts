import { describe, expect, test } from "vitest";
import { distinct } from "./distinct.js";

describe("distinct", () => {
  test("a list without repeats is returned as it is, not copied", () => {
    const names = ["email", "name", "age"];
    expect(distinct(names)).toBe(names);
    const one = ["email"];
    expect(distinct(one)).toBe(one);
  });

  test("an empty list is returned as it is", () => {
    const none: string[] = [];
    expect(distinct(none)).toBe(none);
  });

  test("repeats are dropped and the first occurrences keep their order", () => {
    const names = ["name", "email", "name", "age", "email", "name"];
    expect(distinct(names)).toEqual(["name", "email", "age"]);
    expect(names).toEqual(["name", "email", "name", "age", "email", "name"]);
    expect(distinct(["a", "a"])).toEqual(["a"]);
  });

  test("objects are compared by reference", () => {
    const a = { name: "a" };
    const b = { name: "a" };
    expect(distinct([a, b, a])).toEqual([a, b]);
  });
});
