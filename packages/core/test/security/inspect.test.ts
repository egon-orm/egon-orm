// What a Node process prints about an error that holds the database's own text (F4 of
// the security review): `console.log` goes through the errors' custom inspect, which
// leaves the text out. Node's printer of an uncaught error does not: it inspects with
// `customInspect: false`, so it prints `detail` and the cause as they are. SECURITY.md
// documents that; this pins it, so that a change on either side shows.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SECRET = "tok-91c2e7";
const CORE = fileURLToPath(new URL("../..", import.meta.url));

/** Runs `body` in a new Node process that has a constraint error holding SECRET as `error`. */
function run(body: string): { stdout: string; stderr: string } {
  const source = `
import { ConstraintError } from "./src/errors.ts";
const cause = Object.assign(new Error("Key (token_hash)=(${SECRET}) already exists."), { code: "23505" });
const error = new ConstraintError({
  type: "unique",
  constraint: "accounts_token_hash_key",
  table: "accounts",
  column: undefined,
  detail: "Key (token_hash)=(${SECRET}) already exists.",
  cause,
});
${body}`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: CORE,
    encoding: "utf8",
    timeout: 20_000,
  });
  return { stdout: child.stdout, stderr: child.stderr };
}

describe("a Node process printing an error", () => {
  test("console.log and console.error leave the database's text out", () => {
    const { stdout, stderr } = run("console.log(error); console.error(error);");
    expect(stdout).toContain("[cause]: Error 23505 (hidden: read error.cause)");
    expect(stderr).toContain("detail: (hidden: read error.detail)");
    expect(`${stdout}${stderr}`).not.toContain(SECRET);
  });

  test.each([
    ["an uncaught exception", "throw error;"],
    ["an unhandled rejection", "Promise.reject(error);"],
  ])("Node's printer of %s skips the custom inspect and prints the text", (_, body) => {
    const { stderr } = run(body);
    expect(stderr).toContain("ConstraintError: constraint.violated");
    expect(stderr).toContain(SECRET);
  });
});
