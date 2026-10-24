# Contributing

Egon is built step by step from a written plan. **Read
[`docs/plan/README.md`](docs/plan/README.md) first**: it holds the goals, the settled
decisions, the testing, performance and documentation standards, and (§9) the worker
protocol and the pull request and review loop that every change follows.

## Prerequisites

- Node.js >= 22.12 (`.nvmrc` pins 22; CI also runs Node 24)
- pnpm 12.11.2, pinned in `package.json` `"packageManager"`. Corepack (`corepack enable`) and
  pnpm 9 or newer switch to the pinned version by themselves. An older global pnpm does
  not; `engines.pnpm` makes it stop with an "unsupported engine" error instead of running.
- Docker with Compose v2, for the test databases

## Everyday commands

| Command | What it does |
|---|---|
| `pnpm i` | Install dependencies |
| `pnpm check` | `lint` + `typecheck` + `test:unit` + `test:types` + `build`. Must pass before a PR. |
| `pnpm lint` / `pnpm format` | Biome: check / fix formatting, import order and lint rules |
| `pnpm typecheck` | `tsc -b` over every project, plus the design spikes (see below) |
| `pnpm test:unit` | Unit tests (`*.test.ts`) with coverage; fails under 95% lines or branches in `packages/core` or `packages/postgres` |
| `pnpm test:types` | Type tests (`*.test-d.ts`) |
| `pnpm test:integration` | Integration tests (`*.itest.ts`) against real databases |
| `pnpm test:soak` | Opt-in soak test: a mixed workload against Postgres with random backend kills through a pool of 5 (`EGON_SOAK_MINUTES`, default 2; the release gate is 30). Not run on pull requests; `.github/workflows/robustness.yml` runs it by hand and weekly. |
| `pnpm test:mutation [area...]` | Stryker over `packages/core` `changeset`, `query` and `compiler` (target 80% each), two test processes at a time; several hours. Reports in `reports/mutation/`. Not run on pull requests. Do not run it beside the soak test. |
| `pnpm test:watch` | Unit tests in watch mode |
| `pnpm build` | ESM + declarations for every package (`tsup`). There is no CommonJS build (decision D14). |
| `pnpm lint:packages` | `publint --strict` and `@arethetypeswrong/cli` on the built packages. attw runs with `--profile esm-only`: the packages have no CommonJS build, so its two CommonJS resolution modes (`node10`, `node16-cjs`) are reported but not failed. The ESM and bundler modes must be clean. |
| `pnpm api:report` / `pnpm api:check` | Build and rewrite / check the API report in `api-report/` (see [The API report](#the-api-report)) |
| `pnpm smoke` | Loads the built packages from an ES module and, with `require()`, from a CommonJS script; then runs the consumer matrix (`examples/smoke/consumer.mjs`): packs the packages, installs the tarballs with their peer dependencies in a project outside the workspace, runs both consumers there, and type-checks a consumer under `moduleResolution` `nodenext`, `node16` and `bundler` and a CommonJS `.cts` file, with `declaration: true` and `skipLibCheck: false`. Options go to `consumer.mjs`: `--node <path>` also runs the consumers on another Node of the same major (CI: 22.12.0), `--typescript <version>` type-checks with another TypeScript, `--peers lower\|upper` installs every peer at the bottom or the top of its range, `--drivers` runs each adapter against its database (`examples/smoke/drivers.mjs`). |
| `pnpm release:dry-run` | The release workflow end to end against a local registry (verdaccio), from a clean clone of `HEAD`: see [Releases](#releases). |
| `pnpm bench [filter]` | Builds, runs the benchmarks, writes `benchmarks/results/<git-sha>.json` |
| `pnpm docs:dev` / `pnpm docs:build` | VitePress site in `docs/site`; both generate the API reference first (`pnpm docs:api`) |
| `pnpm docs:check` | The documentation checks (part of `pnpm lint`): see [Documentation](#documentation) |
| `pnpm docs:exports` / `pnpm docs:dialects` | Regenerate `reference/exports.md` / `reference/dialect-support.md` |
| `pnpm db:up` / `db:down` / `db:reset` | Start / stop / recreate Postgres (`db:up:tier2` adds MySQL) |
| `pnpm changeset` | Add a release note for a change to a published package |

To run one Vitest project or file:

```sh
pnpm vitest run --project core:unit
pnpm vitest run --project core:integration packages/core/test/support/db.itest.ts
```

## Layout

```
packages/core        "egon-orm"            the library
packages/postgres    "@egon-orm/postgres"
packages/zod         "@egon-orm/zod"
packages/sqlite       "@egon-orm/sqlite"
packages/mysql        "@egon-orm/mysql"
packages/cli          "@egon-orm/cli"       the egon command
packages/core/test/support               shared test helpers, importable as "@egon-orm/test-support"
benchmarks/          micro/<area>.bench.ts, harness in src/
examples/smoke       an ESM consumer, a CommonJS consumer (require of the ES module), and a type-checked consumer
examples/blog        the tutorial's application, with its own test suite (blog:integration)
examples/react-form  the React form of the form-errors recipe, type-checked on its own
examples/runtime     the runtime matrix: one round trip from ESM, require() and esbuild bundles (Node, Bun)
examples/next-app    the same through a Next.js build (next build, next start)
docs/plan            the plan (frozen; workers add only status/NN.md)
docs/adr             architecture decision records
docs/site            VitePress site; docs/site/examples holds the type-checked example sources
```

Inside the workspace, `egon-orm` and `@egon-orm/*` imports resolve to package **sources**
(TypeScript `paths` in `tsconfig.base.json`, aliases in `vitest.config.ts`), so type-checking
and tests never need a build.

`examples/smoke` and the benchmarks are the exceptions: they load the built `dist/`, because
that is what users install. Benchmark processes are started with `benchmarks/tsconfig.run.json`,
which has no source `paths`; the runner and every benchmark file refuse to run unless
`egon-orm` resolves into the package's own `dist/` directory, and the report records the resolved file
(`egonEntry`). `pnpm bench` builds first. `scripts/check-bench-dist-guard.mjs` (run by CI
before the build) proves the refusal.

Code that is not public API cannot be imported from `egon-orm`. `packages/core` therefore has
a second build entry, `dist/internal.js` (the utilities of `src/internal`), which is not in
the package's `exports` and is left out of the published files; `benchmarks/micro/internal.bench.ts` shows how a benchmark loads
it from `dist/` while taking its types from the sources.

## Tests

Each package has three Vitest projects, named `<package>:unit`, `<package>:types` and
`<package>:integration`:

- **Unit**, `*.test.ts` beside the source: no database, no network.
- **Types**, `*.test-d.ts`: `expectTypeOf` and `// @ts-expect-error`. Include
  `expectTypeOf(x).not.toBeAny()` on inferred results.
- **Integration**, `*.itest.ts`: real databases. Files run in parallel, tests inside a file
  run serially. Never share a database between files: take one with `withDatabase` or
  `createTestDatabase` from `@egon-orm/test-support`, and reset it between tests with
  `truncateAll` (until the sandbox of step 16 exists).

Test databases are named `egon_<label>_<run id>_<creation time>_<random>` and are cleaned
up at three levels: `withDatabase` drops its database when the callback settles **and**
through Vitest's `onTestFinished`, so a test that times out does not leak it; after the run
`global-setup.ts` drops everything the run still owns; before the run it drops databases
older than 30 minutes (`EGON_TEST_STALE_MINUTES`) that a killed run left behind. Several
runs can share one server: a run never drops a younger database of another run, nor one
that has open connections (checked on Postgres and MySQL). A run that is interrupted
(Ctrl-C) or killed skips its own cleanup, so its databases stay until the start-up sweep
of a later run finds them stale, or until `pnpm db:reset`. With `createTestDatabase` you call `drop()`
yourself, in `afterAll`.

Connections are checked at two levels. A suite that makes adapters waits, after each test,
until every connection that test checked out is back in its pool (`expectAllReturned` from
`leaks.ts`, or the same check written inline in the adapter, read and transaction suites).
And the whole run fails if any test file ended with a connection checked out of any
adapter's pool, or a caller still waiting for one: `leak-check.ts`, a setup file of the
integration projects, records the pool of every adapter a file started, and the teardown in
`global-setup.ts` reads the records and names each file that leaked.

The proof that integration files really run concurrently without interfering is the pair
`parallel-a.pair.ts` / `parallel-b.pair.ts`, which only pass when they overlap in time.
`parallel.itest.ts` runs them in a nested Vitest process with exactly two workers, so
`pnpm test:integration` works with any worker count, including `--maxWorkers=1`.

Test support (`packages/core/test/support`):

| Module | Provides |
|---|---|
| `env.ts` | `connectionSettings(dialect)`, `connectionUrl`, `tier2Enabled` |
| `db.ts` | `withDatabase`, `createTestDatabase`, `loadFixture`, `uniqueDatabaseName`, `parseDatabaseName` |
| `sweep.ts`, `global-setup.ts` | `sweepTestDatabases`; the Vitest global setup that sweeps leaked databases and fails the run on a leaked connection |
| `leaks.ts`, `leak-check.ts` | `expectAllReturned(adapter)`; the setup file that records every adapter's pool for the leak check |
| `truncate.ts` | `truncateAll(db, { except })` |
| `sql.ts` | `expectSql(compiled).toMatchInlineSnapshot()`, `normalizeSql` |
| `fixtures/blog.sql` | The reference blog schema (PostgreSQL DDL) |

### Databases

`docker-compose.yml` starts Postgres 16 on **127.0.0.1:54329** (user `egon`, password
`egon`, database `egon_dev`) and, with the `tier2` profile, MySQL 8.4 on
**127.0.0.1:33069** (user `root`, password `egon`). Both ports are published on the
loopback interface only. Data lives on tmpfs and is discarded when the containers stop. To point the tests elsewhere, set `EGON_PG_HOST`,
`EGON_PG_PORT`, `EGON_PG_USER`, `EGON_PG_PASSWORD`, `EGON_PG_DATABASE` (and the
`EGON_MYSQL_*` equivalents). MySQL tests run only with `EGON_TEST_TIER2=1`.

## Code rules the tools enforce

- No default exports (config files excepted), no `any`, no `@ts-ignore`, no non-null
  assertions outside tests, sorted imports, no `console` under `packages/`. Biome warnings
  fail `pnpm lint` too (`--error-on-warnings`).
- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
  `verbatimModuleSyntax`. Relative imports carry the `.js` extension (`module: NodeNext`).
- `packages/core/src/index.ts` is the only public entry point of `egon-orm`.
- Hot-path rules (no `Proxy`, no per-row `defineProperty`, monomorphic shapes, …) are in
  plan README §7 and summarised in [`CLAUDE.md`](CLAUDE.md).

### Design spikes

`docs/plan/spikes/schema-typing.ts` is the regression test for decision D1 (schemas are
classes) and is type-checked by `pnpm typecheck` through `tsconfig.spikes.json`.
`docs/plan/spikes/rejected-const-thunks.ts` intentionally does **not** compile; it is
excluded from every tsconfig and from Biome, and `scripts/check-rejected-spike.mjs` asserts
that it still fails with TS7022 and TS2506.

`docs/plan/spikes/kysely-bridge/` is the evidence for ADR 0002 (Kysely as the SQL back
end), which ADR 0003 superseded; it is kept as a record and as a checklist of statements
for the emitter: five scripts that lower a hand-built query AST to Kysely nodes and run it against
the Compose Postgres. It is a private workspace package, type-checked by `pnpm typecheck`
but not run by CI. To run it: `pnpm db:up`, then
`pnpm --filter @egon-orm/spike-kysely-bridge run spike` (see its `README.md`).

### Dependency versions

pnpm refuses releases younger than its minimum release age. **Never add
`minimumReleaseAgeExclude` to `pnpm-workspace.yaml`**, and keep `minimumReleaseAgeStrict: true`:
without strict mode, `pnpm add pkg@<too-new exact version>` succeeds and pnpm writes the
exclusion into the file by itself, with one log line as the only notice. If a release is
too new, pin the newest one that passes and say so in your status note. `pnpm lint` runs
`scripts/check-workspace-policy.mjs`, which fails on an exclusion or on strict mode being
off. Read the diff of `pnpm-workspace.yaml` and `package.json` before committing a
dependency change.

Runtime support starts at Node 22.12 (decision D14) and every tool is on its current stable
release, with one exception: TypeScript is held at `6` because tsup's declaration bundler
does not work with TypeScript 7. `packages/core` has
no runtime dependency (ADR 0003); Kysely is a dependency of the step 02 spike only.

Users need TypeScript 5.8 or later (owner decision, 2026-10-22), whatever the workspace
builds with. CI's `types (typescript …)` jobs type-check the consumer project of
`examples/smoke/consumer.mjs` against the packed packages, every program the CommonJS one
included, with the newest 5.8.x and with the latest release, and, as information only, with
the `next` build (`scripts/typescript-version.mjs` picks the versions). A declaration that
needs a newer TypeScript fails the 5.8 job.

### The API report

`api-report/` holds the public API of every entry point, written by
[API Extractor](https://api-extractor.com/) from the built declarations. CI's build job runs
`pnpm api:check`, which fails when the declarations no longer match the committed report.
After a change to a public signature, run `pnpm api:report` (it builds first), read the diff
of `api-report/`, and commit it with the change: the reviewer reviews it as an API change. A
type that the API uses but no entry point exports is marked `ae-forgotten-export` in the
report; export it if a user has to name it.

## Documentation

The site is VitePress, in `docs/site`. Read plan README §8 before writing for it: pages are
written for people who know Drizzle, Sequelize or Prisma, and present the library on its
own terms.

### Code blocks come from checked files

A TypeScript block is never typed into a page. It is a region of a file under
`docs/site/examples/` (or of `examples/blog`), included by reference:

```md
<<< @/examples/changesets.ts#register
```

<!-- illustrative -->
```ts
// docs/site/examples/changesets.ts
// #region register
const result = await repo.insert(User.changeset(User, params));
// #endregion register
```

- Everything outside a region is scaffolding that makes the region compile (`declare
  const repo: Repo;` and the like). `pnpm typecheck` compiles every file there.
- A file whose first lines contain `// @run` also **runs**, against a fresh Postgres
  database, in `pnpm test:integration` (project `docs:integration`). Each statement that
  ends its line with `// => value` is checked: the statement's value (or, for
  `const x = …;`, the value of `x`) must deep-equal `value`, a JavaScript expression. Keep
  such a statement on one line. Every such check must run: one in a branch that is not
  taken fails the test. `// @run after: ./setup.ts` runs another file of the example first,
  as a reader would (a script that creates the tables). A runnable example creates its own tables, exports a `run`
  function if it needs one, and closes every adapter it opens. A `// =>` comment in a file
  without `// @run` is refused, since nothing would check it.
- Shell, SQL, text and configuration blocks may be written inline. TypeScript that is not
  meant to compile as it stands (deliberately invalid code, or a sketch of this tooling, as
  above) may be too, with `<!-- illustrative -->` on the line above the block. The checks
  below apply to the README and to this file as well.

### Checks

`pnpm docs:check` (part of `pnpm lint`) runs `scripts/check-docs.mjs`, the index check,
`scripts/check-page-order.mjs` and the spell checker:

- no hand-written TypeScript or JavaScript block; every included file and region exists;
- `// =>` only in `// @run` files;
- none of the positioning that plan README §8 rules out, in pages, examples, the README or
  package sources;
- every export of every public entry point is listed in `reference/exports.md` (generated
  by `pnpm docs:exports` from the TSDoc), and every exported value (function, class,
  constant) is also named on a written page or shown in an included example;
- every page is in the sidebar, and every sidebar link is a page;
- the README's example is the `example` region of `docs/site/examples/home.ts`;
- on the pages meant to be followed from the top (getting started, the tutorial, the
  "Coming from" pages, the recipes), the parts of each file, joined in page order, compile,
  and no name is used above the part that declares it (`scripts/check-page-order.mjs`);
- `cspell` with the project's word list, `docs/site/words.txt` (British spelling).

`pnpm docs:build` runs TypeDoc first: an export without a TSDoc summary or `@example`
fails the build. VitePress then fails on a link to a missing page, and
`scripts/check-anchors.mjs` on a link to a missing heading (`#anchor`).

### The page template

Feature pages (`guide/`) follow one shape, so readers know where to look:

1. **Overview**: what the feature is, in a paragraph, under the page title.
2. **Quick example**: the common case, as an included region, right after the overview.
3. **Reference sections**: one `##` section per part of the feature, with tables of
   options and their defaults.
4. **Recipes**: worked solutions to common tasks, on the page or linked from
   [`recipes/`](docs/site/recipes).
5. **Good to know**: a `::: tip Good to know` box with the behaviour that would surprise
   someone coming from another ORM (no lazy loading, explicit transactions, non-null by
   default, results instead of exceptions).
6. **See also**: links to the related pages.

Recipes are shorter: the problem, the solution as included regions, notes, Good to know,
See also. Use the words of the [glossary](docs/site/reference/glossary.md) (row, schema,
changeset, binding, queryable, preload, adapter) in one sense only.

### Deployment

CI builds the site on every pull request and keeps it as the `docs-site` artifact for a
week. `.github/workflows/docs.yml` builds `main` with `DOCS_BASE=/<repository>/` and
deploys it to GitHub Pages (the repository's Pages source must be "GitHub Actions").

## Pull requests

The full loop is in plan README §9. In short:

1. Work on `step/NN-short-name`; touch only the paths your step owns.
2. `pnpm check` (and `pnpm test:integration` where relevant) must pass locally.
3. Write `docs/plan/status/NN.md`, push, and open a PR against `main` titled
   `Step NN: <name>`. The PR template mirrors the required body.
4. Wait for CI. A **different** agent or person reviews; never review your own PR.
5. Address every comment with follow-up commits (no force-push during review).
6. Squash-merge after approval and green CI, then delete the branch.

### Branch protection for `main`

These settings are expected on the GitHub repository (they need admin rights and are not
stored in the repo):

- Require a pull request before merging, with **1 approving review**; dismiss stale
  approvals when new commits are pushed.
- Require status checks to pass, branch up to date: require the **`ci`** check, which is
  green only when every CI job (`lint`, `typecheck`, `unit+types` on Node 22 and 24,
  `integration`, `integration (tier 2)`, `build+publint+attw`, `peer bounds` (lower and upper),
  `types (typescript minimum)`, `types (typescript latest)`, `release dry run`, `edge worker`,
  `docs:build`) is green. `types (typescript next, informational)` is not part of it.
- Allow squash merging only; delete head branches automatically.
- No force pushes and no deletion of `main`.

## Architecture decisions

Changing a decision in plan README §2 or a frozen contract needs an ADR: copy
`docs/adr/0000-template.md` to `docs/adr/NNNN-title.md`, fill it in, and open a PR. The
affected work waits until the ADR is accepted.

## Releases

Versions and changelogs are managed with [Changesets](https://github.com/changesets/changesets)
(`.changeset/`). Every `egon-orm` and `@egon-orm/*` package is in one `fixed` group and
shares one version; private packages (examples, the docs site, benchmarks) are never
versioned. The versioning and support policy is in
[`reference/upgrading.md`](docs/site/reference/upgrading.md).

1. **A pull request that changes a published package adds a changeset**: `pnpm changeset`,
   with the bump the policy calls for (before 1.0: `minor` for a breaking change, `patch`
   for everything else). A breaking change also adds a section to `reference/upgrading.md`.
2. **The version pull request.** `.github/workflows/release.yml` runs on every push to
   `main`. While changesets are pending it opens or updates "Version packages", made by
   `pnpm version-packages`: every package's new version, its `CHANGELOG.md` entry, and the
   `VERSION` constants (`scripts/sync-version.mjs`). Before merging it, write the release's
   entry in the root [`CHANGELOG.md`](CHANGELOG.md) for people (what changed and why, with
   links), and replace "unreleased" with the date.
3. **Publish.** Merging the version pull request makes the publish plan non-empty
   (`changeset publish-plan`). The `pack` job, which holds no credential, builds, runs
   publint and attw, packs the packages (`changeset pack`), and then runs the consumer
   matrix, so that nothing it installs can touch what was packed. Then
   the `publish` job (after an approval, if the `npm` environment has required reviewers)
   publishes those tarballs with npm provenance (`changeset publish --from-pack-dir`). It
   runs no install script. It pushes a tag `<name>@<version>` per package and creates a
   GitHub release per tag from its `CHANGELOG.md` section.

The workflow does nothing until the repository variable `RELEASE` is `on`, and runs only
for `main`. Authentication
to npm is trusted publishing (OIDC) once each package has this repository and
`release.yml` as its trusted publisher on npmjs.com; the first publish of a package that
does not exist yet needs an `NPM_TOKEN` secret, which the job uses only when it is set.

`pnpm release:dry-run` (`scripts/release-dry-run.mjs`, also the `release dry run` CI job)
runs steps 2 and 3 against a local verdaccio registry from a clean clone of `HEAD`: it
versions, checks the publish plan, packs, publishes from the pack directory, checks the
published manifests (no `workspace:` ranges, the README) and that the plan is then empty,
the tags and the release notes, installs the packages from that registry with npm and loads
every entry point, then checks that a patch to one package versions all of them. It
publishes nothing anywhere else and needs no secret; provenance is off, since it needs a
GitHub Actions token. `--keep` leaves the temporary directory.
