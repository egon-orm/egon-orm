// The type-health measurements of the step 21 audit, taken once and recorded in
// docs/plan/status/21-api.md. Not a CI gate (plan README §7): timings depend on the machine.
//
//   pnpm build && node scripts/type-health/measure.mjs [--typescript <typescript/lib>] [--schemas 200] [--topology chain|clusters|tree|hub] [--runs 5] [--completions-only] [--annotate-assocs] [--no-changeset]
//
// For two consumer projects that resolve `egon-orm` to the built declarations:
//
// - examples/blog: its application code (src/ and egon.config.ts; the tests import the
//   workspace's private test helpers, which are not part of the package);
// - the synthetic 200-schema project of scripts/type-health/generate.mjs;
//
// it prints `tsc --extendedDiagnostics` (check time, types, instantiations), the slowest
// statements from `tsc --generateTrace`, and, for the synthetic project, the time tsserver
// takes to answer a completion request inside a `where` callback (the budget: under 200 ms).
//
// The per-expression budget: no query expression over 50 ms of check time, not counting the
// first query expression a program checks (owner decision, 2026-10-24,
// docs/plan/21-release.md). That one also pays the one-time cost of resolving the library's
// types, which moves to whichever query is checked first, so it is reported on its own
// (`firstChecked`), and `slowest` and `budget` leave it out. In the synthetic project the
// queries are in the `queries-NN.ts` files (the `schemas-NN.ts` files only declare schemas);
// in examples/blog every file of `src/` has them.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generate, reachable } from "./generate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TEMP = join(ROOT, "temp", "type-health");
const option = (flag) => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
};
const TS_LIB = resolve(option("--typescript") ?? join(ROOT, "node_modules/typescript/lib"));
const SCHEMAS = Number(option("--schemas") ?? 200);
const RUNS = Number(option("--runs") ?? 5);
const TOPOLOGY = option("--topology") ?? "chain";
const TSC = join(TS_LIB, "tsc.js");
const TSSERVER = join(TS_LIB, "tsserver.js");

function blogProject() {
  const dir = join(TEMP, "blog");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const blog = join(ROOT, "examples/blog");
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        types: ["node"],
        typeRoots: [join(ROOT, "node_modules/@types")],
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: [join(blog, "src"), join(blog, "egon.config.ts")],
    }),
  );
  return dir;
}

function tsc(project, extra) {
  const run = spawnSync(process.execPath, [TSC, "-p", project, ...extra], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`tsc failed on ${project}:\n${run.stdout}${run.stderr}`);
  return run.stdout;
}

function diagnostics(project) {
  const out = tsc(project, ["--extendedDiagnostics"]);
  const pick = (label) => out.match(new RegExp(`^${label}:\\s+(.+)$`, "m"))?.[1]?.trim();
  return {
    files: pick("Files"),
    linesOfTypeScript: pick("Lines of TypeScript"),
    types: pick("Types"),
    instantiations: pick("Instantiations"),
    memory: pick("Memory used"),
    checkTime: pick("Check time"),
    totalTime: pick("Total time"),
  };
}

const texts = new Map();
/** The line of `pos` in `path` (trace paths are lower-cased on case-insensitive systems). */
function lineAt(path, pos) {
  if (!texts.has(path)) texts.set(path, readFileSync(path, "utf8"));
  return texts.get(path).slice(0, pos).split("\n").length;
}

/** The per-expression budget, in milliseconds (see the top of this file). */
const BUDGET_MS = 50;

/**
 * Check time per statement (`path:line`, the longest event on that line) in one traced run,
 * and the query statement checked first (the earliest event in a file `queries` matches).
 */
function tracedRun(project, run, queries) {
  const traceDir = join(TEMP, `trace-${project.split("/").pop()}-${run}`);
  rmSync(traceDir, { recursive: true, force: true });
  tsc(project, ["--generateTrace", traceDir]);
  const events = JSON.parse(readFileSync(join(traceDir, "trace.json"), "utf8"));
  const perLine = new Map();
  let first;
  for (const event of events) {
    if (event.ph !== "X" || event.cat !== "check") continue;
    if (!["checkExpression", "checkVariableDeclaration", "checkDeferredNode"].includes(event.name)) continue;
    const path = event.args?.path;
    if (path === undefined || path.includes("/node_modules/") || path.endsWith(".d.ts")) continue;
    // A statement's events nest (a declaration contains its expressions): keep the longest.
    const key = `${path}:${lineAt(path, event.args.pos)}`;
    perLine.set(key, Math.max(perLine.get(key) ?? 0, event.dur / 1000));
    if (queries.test(path) && (first === undefined || event.ts < first.ts)) first = { key, ts: event.ts };
  }
  return { perLine, first: first?.key };
}

const round = (ms) => Math.round(ms * 10) / 10;

function summary(times) {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    median: Math.round(sorted[Math.floor(sorted.length / 2)]),
    max: Math.round(sorted[sorted.length - 1]),
    runs: sorted.length,
  };
}

/**
 * The slowest statements of the project's own files, after the first query statement
 * checked (in a file that `queries` matches), which is reported on its own (see the top of
 * this file). A statement's time is its median over
 * `runs` traced compilations, so that one garbage-collection pause does not make it look
 * slow; its slowest single observation is reported as well.
 */
function slowest(project, count, runs, queries) {
  const all = Array.from({ length: runs }, (_, run) => tracedRun(project, run, queries));
  // The first query statement of each run; the one most runs agree on is left out of the
  // budget. A run that disagrees is reported (`firstCheckedByRun`) rather than hidden.
  const firsts = all.map((each) => each.first);
  const votes = new Map();
  for (const key of firsts) votes.set(key, (votes.get(key) ?? 0) + 1);
  const firstKey = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const agreed = firsts.every((key) => key === firstKey);
  const root = `${ROOT.toLowerCase()}/`;
  const rows = [];
  let firstChecked;
  for (const key of all[0].perLine.keys()) {
    const times = all.map(({ perLine }) => perLine.get(key) ?? 0).sort((a, b) => a - b);
    const at = key.toLowerCase().startsWith(root) ? key.slice(root.length) : key;
    const row = { at, medianMs: round(times[Math.floor(runs / 2)]), maxMs: round(times[runs - 1]) };
    if (key === firstKey) firstChecked = row;
    else rows.push(row);
  }
  rows.sort((a, b) => b.medianMs - a.medianMs);
  const slowestMs = rows[0]?.medianMs ?? 0;
  return {
    statements: rows.length + (firstChecked === undefined ? 0 : 1),
    runs,
    firstChecked,
    ...(agreed ? {} : { firstCheckedByRun: firsts.map((key) => key?.slice(root.length)) }),
    budget: { limitMs: BUDGET_MS, slowestAfterFirstMs: slowestMs, met: slowestMs <= BUDGET_MS },
    slowest: rows.slice(0, count),
  };
}

/** Completion requests in a `where` callback, through a scripted tsserver session. */
async function completions(file, edits) {
  // `--tsserver-log <file>` writes tsserver's verbose log, with the time of each step.
  const log = option("--tsserver-log");
  const logArgs = log === undefined ? [] : ["--logVerbosity", "verbose", "--logFile", resolve(log)];
  const server = spawn(process.execPath, [TSSERVER, "--disableAutomaticTypingAcquisition", ...logArgs], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  let seq = 0;
  const pending = new Map();
  let buffer = "";
  server.stdout.setEncoding("utf8");
  server.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const header = buffer.match(/^Content-Length: (\d+)\r\n\r\n/);
      if (header === null) break;
      const start = header[0].length;
      const length = Number(header[1]);
      if (Buffer.byteLength(buffer.slice(start)) < length) break;
      const body = Buffer.from(buffer.slice(start)).subarray(0, length).toString("utf8");
      buffer = Buffer.from(buffer.slice(start)).subarray(length).toString("utf8");
      const message = JSON.parse(body);
      if (message.type === "response" && pending.has(message.request_seq)) {
        pending.get(message.request_seq)(message);
        pending.delete(message.request_seq);
      }
    }
  });
  const request = (command, args) =>
    new Promise((done) => {
      seq += 1;
      pending.set(seq, done);
      server.stdin.write(`${JSON.stringify({ seq, type: "request", command, arguments: args })}\n`);
    });
  const text = readFileSync(file, "utf8");
  const marker = text.indexOf("/*cursor*/");
  const before = text.slice(0, marker).split("\n");
  const line = before.length;
  const offset = before[before.length - 1].length + 1;
  const timed = async () => {
    const started = performance.now();
    const response = await request("completionInfo", { file, line, offset, triggerCharacter: "." });
    const ms = performance.now() - started;
    const names = (response.body?.entries ?? []).map((e) => e.name);
    return { ms, names };
  };
  await request("open", { file, fileContent: text });
  // The first request also builds the program: project load plus completion.
  const first = await timed();
  const after = [];
  for (let i = 0; i < edits; i++) {
    // An edit in the callback (typing and deleting a character) before each request, so
    // that every request runs against a changed file, as it does while typing.
    await request("change", { file, line, offset, endLine: line, endOffset: offset, insertString: "x" });
    await request("change", { file, line, offset, endLine: line, endOffset: offset + 1, insertString: "" });
    after.push((await timed()).ms);
  }
  // The same request again with no edit in between: the checker of the last program is
  // reused, so this is the cost of the completion itself, without re-checking.
  const again = [];
  for (let i = 0; i < edits; i++) again.push((await timed()).ms);
  // For comparison, a hover (quick info) on the binding after an edit.
  const hover = [];
  for (let i = 0; i < edits; i++) {
    await request("change", { file, line, offset, endLine: line, endOffset: offset, insertString: "x" });
    await request("change", { file, line, offset, endLine: line, endOffset: offset + 1, insertString: "" });
    const started = performance.now();
    await request("quickinfo", { file, line, offset: offset - 2 });
    hover.push(performance.now() - started);
  }
  server.kill();
  return {
    firstRequestMs: Math.round(first.ms),
    afterEditMs: summary(after),
    withoutEditMs: summary(again),
    hoverAfterEditMs: summary(hover),
    offersFields: ["name", "email", "age", "parentId", "createdAt"].every((f) => first.names.includes(f)),
  };
}

const typescriptVersion = JSON.parse(readFileSync(join(TS_LIB, "../package.json"), "utf8")).version;
const results = { typescript: typescriptVersion, node: process.version, projects: {} };
// `--completions-only` skips the blog, the diagnostics and the traces (for a sweep).
const completionsOnly = process.argv.includes("--completions-only");
if (!completionsOnly) {
  const blog = blogProject();
  results.projects["examples/blog"] = { ...diagnostics(blog), ...slowest(blog, 5, RUNS, /\/src\//) };
}
const synthetic = join(TEMP, "synthetic");
const ANNOTATE = process.argv.includes("--annotate-assocs");
const NO_CHANGESET = process.argv.includes("--no-changeset");
const editorFile = generate(synthetic, SCHEMAS, TOPOLOGY, { annotate: ANNOTATE, noChangeset: NO_CHANGESET });
results.projects[
  `synthetic (${SCHEMAS} schemas, ${TOPOLOGY}${ANNOTATE ? ", annotated" : ""}${NO_CHANGESET ? ", no changeset methods" : ""})`
] = {
  // The schemas the edited query's schema (S001) reaches through associations, itself included.
  reachableFromEditedSchema: reachable(1, SCHEMAS, TOPOLOGY),
  ...(completionsOnly
    ? {}
    : { ...diagnostics(synthetic), ...slowest(synthetic, 10, RUNS, /\/queries-\d+\.ts$/) }),
  completionsInWhere: await completions(editorFile, 20),
};
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
