// Run by `pnpm test:unit` (node --test).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  dedent,
  FORMER_NAME,
  findFormerName,
  findReadmeProblems,
  findReleaseProblems,
  findWorkflowProblems,
} from "./check-release-config.mjs";

const NAMES = ["egon-orm", "@egon-orm/postgres"];
const config = () => ({
  fixed: [[...NAMES]],
  access: "public",
  privatePackages: { version: false, tag: false },
});
const pkg = (dir, name, overrides = {}) => ({
  dir,
  files: ["LICENSE", "README.md", "package.json", "src"],
  manifest: {
    name,
    version: "0.1.0",
    type: "module",
    engines: { node: ">=22.12" },
    publishConfig: { access: "public" },
    repository: { type: "git", url: "git+https://github.com/egon-orm/egon-orm.git", directory: dir },
    ...overrides,
  },
});
const packages = () => [pkg("packages/core", "egon-orm"), pkg("packages/postgres", "@egon-orm/postgres")];

describe("findReleaseProblems", () => {
  test("accepts one fixed group of every published package", () => {
    assert.deepEqual(findReleaseProblems(config(), packages()), []);
  });

  test("ignores private packages", () => {
    const withPrivate = [...packages(), { ...pkg("packages/spike", "spike", { private: true }), files: [] }];
    assert.deepEqual(findReleaseProblems(config(), withPrivate), []);
  });

  test("rejects a published package missing from the fixed group, and a stray name", () => {
    const problems = findReleaseProblems(
      { ...config(), fixed: [["egon-orm", "@egon-orm/gone"]] },
      packages(),
    );
    assert.equal(problems.length, 2);
    assert.match(problems[0], /@egon-orm\/postgres is not in the fixed group/);
    assert.match(problems[1], /names @egon-orm\/gone/);
  });

  test("rejects two groups, restricted access and versioned private packages", () => {
    assert.equal(
      findReleaseProblems({ ...config(), fixed: [["egon-orm"], ["@egon-orm/postgres"]] }, packages()).length,
      1,
    );
    assert.match(findReleaseProblems({ ...config(), access: "restricted" }, packages())[0], /access/);
    const versioned = { ...config(), privatePackages: { version: true, tag: false } };
    assert.match(findReleaseProblems(versioned, packages())[0], /privatePackages/);
  });

  test("rejects a package without a README, at another version, or with the wrong metadata", () => {
    const [core, postgres] = packages();
    const problems = findReleaseProblems(config(), [
      core,
      {
        ...postgres,
        files: ["LICENSE"],
        manifest: {
          ...postgres.manifest,
          version: "0.2.0",
          type: "commonjs",
          engines: { node: ">=20" },
          publishConfig: undefined,
          repository: { url: "x", directory: "packages/postgres" },
        },
      },
    ]);
    for (const pattern of [
      /different versions/,
      /no README\.md/,
      /publishConfig/,
      /engines\.node/,
      /"type"/,
      /repository/,
    ])
      assert.ok(
        problems.some((problem) => pattern.test(problem)),
        `${pattern} in ${problems.join("\n")}`,
      );
  });
});

describe("findFormerName", () => {
  const former = ["Ec", "type"].join("");
  test("finds the former name in any case, in contents or in a path, outside docs/plan", () => {
    const files = {
      "README.md": `# ${former} ORM`,
      "docs/plan/README.md": `It was called ${former}.`,
      [`examples/${former.toLowerCase()}.ts`]: "",
      "packages/core/src/index.ts": "export {};",
    };
    const problems = findFormerName(Object.keys(files), (file) => files[file]);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /^README\.md:/);
    assert.match(problems[1], /^examples\//);
  });

  test("the pattern does not match the file that defines it", () => {
    assert.equal(FORMER_NAME.test("check-release-config.mjs"), false);
  });
});

describe("findReadmeProblems", () => {
  const source =
    "export function f() {\n  // #region example\n  const a = 1;\n    a;\n  // #endregion example\n}\n";
  const read = (path) => (path === "docs/site/examples/x.ts" ? source : undefined);
  const fence = "```";
  const readme = (marker, body) =>
    `# x\n\n${marker}\n${fence}ts\n${body}\n${fence}\n\n${fence}sh\nnpm i x\n${fence}\n`;
  const marker = "<!-- example: docs/site/examples/x.ts#example -->";

  test("accepts a copy of the region, dedented, and leaves shell blocks alone", () => {
    assert.deepEqual(findReadmeProblems("R.md", readme(marker, "const a = 1;\n  a;"), read), []);
  });

  test("rejects a changed copy, a missing region, and a block without a marker", () => {
    assert.match(findReadmeProblems("R.md", readme(marker, "const a = 2;\n  a;"), read)[0], /copy it again/);
    assert.match(
      findReadmeProblems("R.md", readme("<!-- example: docs/site/examples/x.ts#other -->", "a"), read)[0],
      /has no region other/,
    );
    assert.match(findReadmeProblems("R.md", readme("Some prose.", "a"), read)[0], /hand-written `ts` block/);
  });

  test("checks every language check-docs checks, jsx included", () => {
    const jsx = `# x\n\nProse.\n${fence}jsx\n<App />\n${fence}\n`;
    assert.match(findReadmeProblems("R.md", jsx, read)[0], /hand-written `jsx` block/);
  });

  test("rejects a block that is never closed instead of dropping its last line", () => {
    const unclosed = `# x\n\n${marker}\n${fence}ts\nconst a = 1;\n  a;`;
    assert.match(findReadmeProblems("R.md", unclosed, read)[0], /never closed/);
  });

  test("dedent removes the shared indentation only", () => {
    assert.equal(dedent("  a\n\n    b"), "a\n\n  b");
  });
});

describe("findWorkflowProblems", () => {
  const workflow = (env = '          PNPM_CONFIG_PROVENANCE: "true"') =>
    [
      "  publish:",
      "    environment: npm",
      "    permissions:",
      "      contents: write",
      "      id-token: write # trusted publishing",
      "    steps:",
      "      - uses: changesets/action/publish@sha # v2.1.2",
      "        env:",
      env,
      "",
    ].join("\n");

  test("accepts pnpm 12 with PNPM_CONFIG_PROVENANCE, id-token: write and the npm environment", () => {
    assert.deepEqual(findWorkflowProblems(workflow(), "pnpm@12.11.2"), []);
  });

  test("rejects NPM_CONFIG_PROVENANCE, which pnpm ignores", () => {
    const problems = findWorkflowProblems(
      workflow('          NPM_CONFIG_PROVENANCE: "true"'),
      "pnpm@12.11.2",
    );
    assert.equal(problems.length, 2);
    assert.match(problems[0], /NPM_CONFIG_PROVENANCE is ignored/);
    assert.match(problems[1], /PNPM_CONFIG_PROVENANCE: "true"/);
  });

  test("rejects provenance turned off", () => {
    const problems = findWorkflowProblems(
      workflow('          PNPM_CONFIG_PROVENANCE: "false"'),
      "pnpm@12.11.2",
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /PNPM_CONFIG_PROVENANCE: "true"/);
  });

  test("does not take a comment that names NPM_CONFIG_PROVENANCE for a key", () => {
    const commented = workflow().replace(
      "        env:",
      "        # not NPM_CONFIG_PROVENANCE: pnpm ignores it\n        env:",
    );
    assert.deepEqual(findWorkflowProblems(commented, "pnpm@12.11.2"), []);
  });

  test("rejects a missing id-token permission or another environment", () => {
    const problems = findWorkflowProblems(
      workflow()
        .replace("      id-token: write # trusted publishing\n", "")
        .replace("environment: npm", "environment: release"),
      "pnpm@12.11.2",
    );
    assert.equal(problems.length, 2);
    assert.match(problems[0], /id-token: write/);
    assert.match(problems[1], /environment `npm`/);
  });

  test("rejects a pnpm older than 12, another package manager, or none", () => {
    for (const packageManager of ["pnpm@10.18.0", "npm@11.6.0", undefined])
      assert.match(findWorkflowProblems(workflow(), packageManager)[0] ?? "", /pnpm 12 or later/);
  });
});
