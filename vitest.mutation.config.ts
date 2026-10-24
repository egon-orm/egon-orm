import { fileURLToPath } from "node:url";
import { defineConfig, type TestProjectInlineConfiguration } from "vitest/config";
import workspace from "./vitest.config.js";

/**
 * Step 21: the Vitest configuration mutation testing runs (stryker.config.json,
 * `pnpm test:mutation`): the `core:unit` project of vitest.config.ts and nothing else,
 * without coverage, which Stryker measures itself. Its fast-check properties run from a
 * fixed seed (test/support/mutation-seed.ts), so that a mutation run can be repeated
 * exactly; the normal test runs stay unseeded.
 */
const coreUnit = (workspace.test?.projects ?? []).find(
  (project): project is TestProjectInlineConfiguration =>
    typeof project === "object" &&
    project !== null &&
    "test" in project &&
    project.test?.name === "core:unit",
);
if (coreUnit === undefined) throw new Error("vitest.config.ts has no core:unit project");

function toArray(files: string | string[] | undefined): string[] {
  if (files === undefined) return [];
  return typeof files === "string" ? [files] : files;
}

export default defineConfig({
  ...coreUnit,
  test: {
    ...coreUnit.test,
    name: "core:mutation",
    setupFiles: [
      ...toArray(coreUnit.test?.setupFiles),
      fileURLToPath(new URL("./packages/core/test/support/mutation-seed.ts", import.meta.url)),
    ],
  },
});
