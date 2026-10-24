import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig, type TestProjectConfiguration } from "vitest/config";

/** Every workspace package gets the same three Vitest projects: unit, types, integration. */
const PACKAGES = ["core", "postgres", "zod", "cli", "sqlite", "mysql"] as const;

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/** Tests run against package sources, so no build is needed before `pnpm test:*`. */
const alias = {
  // Before "egon-orm": an alias also matches the subpaths of its key, and the first match wins.
  "egon-orm/migration": fromRoot("./packages/core/src/migration/index.ts"),
  "egon-orm/messages": fromRoot("./packages/core/src/messages/index.ts"),
  "egon-orm/testing": fromRoot("./packages/core/src/testing.ts"),
  "egon-orm": fromRoot("./packages/core/src/index.ts"),
  "@egon-orm/postgres": fromRoot("./packages/postgres/src/index.ts"),
  "@egon-orm/sqlite": fromRoot("./packages/sqlite/src/index.ts"),
  "@egon-orm/mysql": fromRoot("./packages/mysql/src/index.ts"),
  "@egon-orm/zod": fromRoot("./packages/zod/src/index.ts"),
  "@egon-orm/cli": fromRoot("./packages/cli/src/index.ts"),
  // Shared test helpers (not a published package): packages/core/test/support.
  "@egon-orm/test-support": fromRoot("./packages/core/test/support/index.ts"),
};

function projectsFor(pkg: (typeof PACKAGES)[number]): TestProjectConfiguration[] {
  const root = fromRoot(`./packages/${pkg}`);
  return [
    {
      resolve: { alias },
      test: {
        name: `${pkg}:unit`,
        root,
        environment: "node",
        include: ["src/**/*.test.ts", "test/**/*.test.ts"],
        // Full error messages, so that tests can match their advice (ADR 0007).
        setupFiles: [fromRoot("./packages/core/test/support/full-messages.ts")],
      },
    },
    {
      resolve: { alias },
      test: {
        name: `${pkg}:types`,
        root,
        environment: "node",
        include: [],
        typecheck: {
          enabled: true,
          only: true,
          checker: "tsc",
          // `tsc --build`: a package whose tests import another package (through a project
          // reference) needs that package's declarations built first, as on a fresh checkout.
          build: true,
          tsconfig: "./tsconfig.json",
          include: ["src/**/*.test-d.ts", "test/**/*.test-d.ts"],
        },
      },
    },
    {
      resolve: { alias },
      test: {
        name: `${pkg}:integration`,
        root,
        environment: "node",
        include: ["src/**/*.itest.ts", "test/**/*.itest.ts"],
        // Gives the run an id and sweeps leaked test databases before and after it; after
        // it, also fails the run on a pool left with a connection checked out (leak-check.ts).
        globalSetup: [fromRoot("./packages/core/test/support/global-setup.ts")],
        setupFiles: [
          fromRoot("./packages/core/test/support/full-messages.ts"),
          fromRoot("./packages/core/test/support/leak-check.ts"),
        ],
        // Files run in parallel (each owns a database, see test/support/db.ts);
        // tests inside one file run serially.
        fileParallelism: true,
        sequence: { concurrent: false },
        testTimeout: 30_000,
        hookTimeout: 60_000,
      },
    },
  ];
}

/**
 * The two files that prove integration files can run concurrently (step 01 acceptance).
 * They only pass when they overlap in time, which needs two workers, so they are not part
 * of `core:integration`: `parallel.itest.ts` there starts this project in its own Vitest
 * process with exactly two workers. No globalSetup on purpose; the outer run owns the sweep.
 */
const parallelPair: TestProjectConfiguration = {
  resolve: { alias },
  test: {
    name: "core:parallel-pair",
    root: fromRoot("./packages/core"),
    environment: "node",
    include: ["test/support/parallel-*.pair.ts"],
    fileParallelism: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
};

/**
 * Step 16: the two files that prove the sandbox isolates test files that run at the same
 * time over one database. Like the parallel pair, they need two workers and are started in
 * a Vitest process of their own, by the transaction conformance suite
 * (packages/core/test/conformance/transaction), which passes the database and the
 * dialect's profile in the environment.
 */
const sandboxPair: TestProjectConfiguration = {
  resolve: { alias },
  test: {
    name: "core:sandbox-pair",
    root: fromRoot("./packages/core"),
    environment: "node",
    include: ["test/conformance/transaction/sandbox-*.pair.ts"],
    fileParallelism: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
};

/**
 * Step 20: the tutorial's blog (examples/blog), an application with its own test suite and
 * the docs' end-to-end test. `test/test-database.ts` (this repository only) gives each test
 * file a database of its own and points `DATABASE_URL` at it; then `test/setup.ts`, the setup
 * file the tutorial shows, runs the migrations there.
 */
const blog: TestProjectConfiguration = {
  resolve: { alias },
  test: {
    name: "blog:integration",
    root: fromRoot("./examples/blog"),
    environment: "node",
    include: ["test/**/*.itest.ts"],
    // leak-check.ts first, so that its afterAll runs after those of the blog's own setup.
    setupFiles: [
      fromRoot("./packages/core/test/support/leak-check.ts"),
      "test/test-database.ts",
      "test/setup.ts",
    ],
    globalSetup: [fromRoot("./packages/core/test/support/global-setup.ts")],
    fileParallelism: true,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
};

/**
 * Step 20: docs examples marked `// @run` (first lines of a file under docs/site/examples)
 * run against a fresh Postgres database, and each `// =>` comment is checked. A statement
 * that ends a line with `// => value` becomes a deep-equality check of the statement's value
 * (or, for `const x = …;`, of `x`) against `value`, a JavaScript expression, and every such
 * check must run. The rewrite keeps every line where it was, so stack traces point at the
 * example's own lines.
 */
const RUN_MARKER = /^\/\/ @run\b/m;
const CHECK_LINE = /^(\s*)(.*?);\s*\/\/ => (.+?)\s*$/;
const DECLARATION = /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*.+$/;

const runExamples: Plugin = {
  name: "egon-docs-run-examples",
  enforce: "pre",
  transform(code, id) {
    if (!id.includes("/docs/site/examples/") || !RUN_MARKER.test(code.slice(0, 2000))) return null;
    const wheres: string[] = [];
    const lines = code.split("\n").map((line, index) => {
      const match = CHECK_LINE.exec(line);
      if (match === null) return line;
      const [, indent = "", statement = "", expected = ""] = match;
      wheres.push(`${id}:${index + 1}`);
      const where = JSON.stringify(`${id}:${index + 1}`);
      const declared = DECLARATION.exec(statement)?.[1];
      return declared === undefined
        ? `${indent}globalThis.__egonDocsCheck((${statement}), (${expected}), ${where});`
        : `${indent}${statement}; globalThis.__egonDocsCheck(${declared}, (${expected}), ${where});`;
    });
    // Announce every check of the file on its first line, so that the test can require each
    // one to have run: a check in a branch not taken, or after an early return, fails.
    lines[0] = `globalThis.__egonDocsExpect(${JSON.stringify(wheres)}); ${lines[0] ?? ""}`;
    return { code: lines.join("\n"), map: null };
  },
};

const docsExamples: TestProjectConfiguration = {
  resolve: { alias },
  plugins: [runExamples],
  test: {
    name: "docs:integration",
    root: fromRoot("./docs/site"),
    environment: "node",
    include: ["test/**/*.itest.ts"],
    globalSetup: [fromRoot("./packages/core/test/support/global-setup.ts")],
    setupFiles: [fromRoot("./packages/core/test/support/leak-check.ts")],
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
};

/**
 * Step 21: the soak test (packages/postgres/test/soak), a long mixed workload with random
 * backend kills. Opt-in: `pnpm test:soak` (EGON_SOAK_MINUTES sets the length); no other
 * project matches `*.soak.ts`, so neither CI nor `pnpm test:integration` runs it.
 */
const soak: TestProjectConfiguration = {
  resolve: { alias },
  test: {
    name: "postgres:soak",
    root: fromRoot("./packages/postgres"),
    environment: "node",
    include: ["test/soak/**/*.soak.ts"],
    globalSetup: [fromRoot("./packages/core/test/support/global-setup.ts")],
    hookTimeout: 60_000,
  },
};

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [...PACKAGES.flatMap(projectsFor), parallelPair, sandboxPair, blog, docsExamples, soak],
    coverage: {
      provider: "v8",
      // Resolved against each project root (packages/<name>), not the repository root.
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.test-d.ts", "**/*.itest.ts", "**/*.d.ts"],
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      thresholds: {
        // README §6: CI enforces 95% lines and branches per package.
        "packages/core/src/**": { lines: 95, branches: 95 },
        "packages/postgres/src/**": { lines: 95, branches: 95 },
        "packages/cli/src/**": { lines: 95, branches: 95 },
        "packages/sqlite/src/**": { lines: 95, branches: 95 },
        "packages/mysql/src/**": { lines: 95, branches: 95 },
      },
    },
  },
});
