# Step 21 (release fixes): the 0.1.0 fixes from the readiness report, status

Branch `step/21-release-fixes`, 2026-10-24, from `main` at `c2088d6` (#75). Input: the
readiness report (`status/21-audit.md` on PR #76, not merged when this started) and the
owner decisions of 2026-10-24 on it ("do the recommended").

## Summary

| # | Item | Result |
|---|---|---|
| 1 | Zod peer floor `^4.6.6` | **Done.** Peer `zod: ^4.6.6`; the four workspace pins 4.6.5 → 4.6.7 (12 days old, passes the release-age rule; no exclusion added). The peer-bounds lower job derives its version from the range, so it now installs 4.6.6. `pnpm audit --prod`: no known vulnerabilities. |
| 2 | Database floors in CI | **Done.** Compose profile `floors` (Postgres 14.24, MySQL 8.0.31, pinned by digest, ports 54314 / 33031), job `integration (database floors)` in the `ci` gate. Both pass locally with the full integration suite; no incompatibility found, no advertised minimum changed. CI result below. |
| 3 | `ErrorMessagesOf` → `ErrorMessages` | **Done.** No alias. Source, TSDoc, type tests, docs, examples, API report, CHANGELOG and the upgrade guide's table of renamed exports. |
| 4 | 50 ms budget without the first query checked | **Done** in `21-release.md` (dated owner-decision note, Work §1, Acceptance) and in `measure.mjs`, which now reports the first query statement on its own and checks the budget on the rest. Re-measured: see §4. |
| 5 | Global-teardown leak check (box 11.5) | **Done.** The run fails if any test file leaves a connection checked out of an adapter's pool; seen failing with a scratch leak. No leak in the existing suites. The write, preload and nested conformance suites got their per-test check. |
| 6 | Docs build with no warnings (box 20.5) | **Done, with option (a)** (owner decision, 2026-10-25; §6.1). The messages page chunk (600 kB) is fixed. The local search index (778 kB), one lazily loaded data module that Vite cannot split, is held to a 1,500 kB ceiling of its own by a build plugin, and every other chunk to 500 kB; a chunk over its limit fails the build. `pnpm docs:build` prints no warning. The DEP0040 warning: `actions/deploy-pages` is already at its newest release (v5.0.1). |
| 7 | 1.0 gate recorded | **Done.** New "1.0 gate" section in `21-release.md` with the report's §8 list, the two new items (completions under 200 ms; query and compiler survivors triaged one by one) marked as owner decisions. |

## 1. Zod peer floor

- `packages/zod/package.json`: peer `^4.3.0` → `^4.6.6`; dev pin 4.6.5 → 4.6.7. Pins also
  bumped in `examples/blog`, `benchmarks` and `docs/site` (they were what `pnpm audit
  --prod` flagged). 4.6.7 was published 2026-10-12, so it passes `minimumReleaseAgeStrict`;
  `pnpm i` resolved it with no change to `pnpm-workspace.yaml`.
- Stryker's `mutation-server-protocol` (`zod: ^4.1.12`) still resolved to 4.6.5 after the
  install; `pnpm dedupe` moved it to 4.6.7, so no 4.6.5 is left in the lockfile. The lockfile
  diff is only the zod lines.
- Peer bounds CI: `examples/smoke/consumer.mjs --peers lower` reads the floor from the
  declared range (`lowerBound`), so the job tests 4.6.6 with no workflow change.
- Docs: `docs/site/reference/upgrading.md` peer table (`^4.6.6`, "4.6.6 and the newest
  4.x"), `docs/site/guide/validation.md`, `packages/zod/README.md`, and one sentence in the
  `CHANGELOG.md` requirements with a link to the advisory.
- `pnpm audit --prod`: **No known vulnerabilities found.** `pnpm audit` (everything): 43
  (9 low, 24 moderate, 10 high), down from 44; the Zod entry is gone, the rest are the
  development-only advisories of the report's P8.

## 2. Database floors in CI

- `docker-compose.yml`: services `postgres-floor`
  (`postgres:14.24-alpine@sha256:50fce0c9…0c80`, the newest 14.x) and `mysql-floor`
  (`mysql:8.0.31@sha256:3d7ae561…f614`, the exact floor), profile `floors`, on
  127.0.0.1:54314 and 127.0.0.1:33031, with the same settings as the tier-1/tier-2 services.
  The digests are the multi-arch index digests (amd64 and arm64 for both).
- `package.json`: `db:up:floors` starts exactly those two; `db:down` also takes down the
  `floors` profile (I did not run it).
- `.github/workflows/ci.yml`: job `integration-floors` ("integration (database floors)"),
  built like `integration-tier2`: `pnpm db:up:floors`, print both server versions, then
  `pnpm test:integration` with `EGON_TEST_TIER2=1`, `EGON_PG_PORT=54314`,
  `EGON_MYSQL_PORT=33031`; compose logs on failure. Added to the `ci` job's `needs`.
- `upgrading.md`'s "Tested in CI" column now says 14 and 16, 8.0.31 and 8.4.
  `CONTRIBUTING.md` describes the profile. The guides' "Postgres 14 or later" (P3) is now
  true as tested, so I left it.
- **Local runs** (separate containers on free ports, the shared 54329/33069 untouched):
  - Postgres 14.24, `EGON_PG_PORT=54314 pnpm test:integration --maxWorkers=2`: 40 files
    passed, 11 skipped (MySQL), 1,257 tests passed, 1 expected fail, 600 skipped. Same as on 16.
  - MySQL 8.0.31, `EGON_TEST_TIER2=1 EGON_MYSQL_PORT=33031 … --maxWorkers=2` (Postgres
    16): 51 files, 1,801 passed, 2 expected fail, 55 skipped, the same counts as on 8.4, so
    no test is skipped for the older server.
  - The compose service `postgres-floor` was also started once through compose, answered
    `PostgreSQL 14.24`, and was stopped and removed. `mysql-floor` was not started through
    compose locally (same image digest as the `docker run` above), to spare the VM.
- **Incident:** while my MySQL 8.0.31 container ran, the shared `egon-mysql-1` was
  OOM-killed (exit 137) by the small VM. I restarted it with `pnpm db:up:tier2` (allowed by
  the worker rules) and stopped my container. Another worker running MySQL tests at that
  moment may have seen failures.
- CI: the `integration (database floors)` job passed (see Checks).

## 3. `ErrorMessagesOf` → `ErrorMessages`

A plain rename, no alias: `packages/core/src/changeset/types.ts` (the type),
`changeset.ts` (the `errorMessages()` return type and TSDoc), the two `index.ts` exports,
the type tests (`error-messages.test-d.ts`, `json-types.test-d.ts`), the docs
(`guide/changesets.md`, `recipes/error-responses.md`, `recipes/form-errors.md`,
`recipes/index.md`, the generated `reference/exports.md`), the checked examples
(`docs/site/examples/frameworks.ts`, `examples/recipes/error-responses.ts`,
`examples/react-form`), and the API report (`pnpm api:report`: `egon-orm.api.md` and
`egon-orm-testing.api.md`). `CHANGELOG.md` and `upgrading.md` did not mention the old name;
since both list the exports renamed before 0.1.0, I added it there. Historical status notes
(`status/21b.md`) keep the old name.

## 4. Type-health budget

- `docs/plan/21-release.md`: a dated "Owner decision, 2026-10-24" note at the top, and the
  budget reworded where it is defined (Work §1) and in Acceptance: no query expression over
  50 ms, not counting the first query expression a program checks, which is recorded on its
  own.
- `scripts/type-health/measure.mjs` did not apply a 50 ms check before, only listed the
  slowest statements. It now reports, per project, `firstChecked` (the earliest-checked
  statement in a query file, by trace timestamp, the one most runs agree on),
  `budget: { limitMs: 50, slowestAfterFirstMs, met }`, and `slowest` without the first one.
  "Query file": `queries-NN.ts` in the synthetic project (its `schemas-NN.ts` files only
  declare schemas, and one of them is checked first of all, at about 22 ms); in
  `examples/blog`, its four application files (`accounts`, `comments`, `posts`,
  `publishing`), not `db.ts` (which makes the repo) or `schemas.ts` (review round 1). Still a
  one-off measurement, not a CI gate.
- Numbers: §4.1.

### 4.1 Measurements

`node scripts/type-health/measure.mjs --topology <t>` (5 traced runs, medians; 20
completions after an edit), TypeScript 6.0.3, Node 22.23.1, this laptop (Apple silicon),
started with the 1-minute load average under 6. An earlier run under a load average of
about 100 (another build on the machine) gave times 3 to 4 times higher; it is discarded.

| Project | First query checked (median / max) | Slowest after it (median) | Budget (50 ms, after the first) | Completions after an edit (median / max) | Instantiations | Check time |
|---|---|---|---|---|---|---|
| `examples/blog` | `src/accounts.ts:16`: 33.1 / 35.5 ms | 20.7 ms (`src/posts.ts:50`) | met | — | 48,563 | 0.19 s |
| 200 schemas, tree | `queries-00.ts:4`: 53.0 / 54.4 ms | 21.8 ms (`schemas-10.ts:5`) | met | 240 / 381 ms | 401,512 | 2.41 s |
| 200 schemas, chain | `queries-00.ts:4`: 60.4 / 61.8 ms | 24.1 ms (`queries-00.ts:18`) | met | 244 / 373 ms | 413,957 | 4.19 s |
| 200 schemas, hub | `queries-00.ts:4`: 52.1 / 53.8 ms | 21.8 ms (`schemas-01.ts:4`) | met | 236 / 386 ms | 389,037 | 2.15 s |

(The blog row is from a chain run after review round 1, with the narrowed pattern; before
it, `src/db.ts:6`, the `createRepo` call, was taken as the first, at 9.1 ms, and
`accounts.ts:16` was the slowest after it, at 31.6 to 32.2 ms in three runs. The first
statement the application files check, `accounts.ts:16`, is the registration changeset
(`cast(...).validate(...)`), not a query builder statement.
The budget is met either way: no blog statement reaches 50 ms. The synthetic rows are from
the runs before the review; the chain re-run with the review's changes gave the same, 60.0 ms
first and 24.3 ms after it.)

- With the budget as now defined, **it is met** on `examples/blog` and on all three
  connected topologies of the 200-schema project. The first query checked costs 52 to 60
  ms, as the report measured (53 to 55 ms on tree).
- **Completions stay over 200 ms** (236 to 244 ms median) on the 200-schema project, as
  accepted for `0.1.0` (owner, 2026-10-22). That is now 1.0 gate item 2.
- In the first chain run the blog's first query statement was not the same in all five
  traces. I could not reproduce it: later runs over three topologies all agreed (on
  `src/db.ts:6` with the earlier pattern, on `src/accounts.ts:16` with the narrowed one). `measure.mjs` no longer throws on it. It leaves out the statement most runs
  agree on, and lists each run's first statement (`firstCheckedByRun`) when they differ.

## 5. The leak check (box 11.5)

The step 11 box: "after the whole integration suite, pool reports zero checked out
(asserted in a global teardown)". The report found that the teardown only dropped
databases, and that the write, preload and nested conformance suites had no leak assert.

- **Global teardown.** Pools live in the test workers and the teardown runs in the main
  process, so they meet in a directory (`$TMPDIR/egon-leaks/<run id>`):
  - `packages/core/test/support/leak-check.ts`, a new setup file of every integration
    project (the six package projects, `blog:integration`, `docs:integration`, and the
    nested pair runs `core:parallel-pair` and `core:sandbox-pair`, which inherit the outer
    run's id and so report to its teardown; added in review round 1), registers
    every adapter a test file starts. Every adapter of the three dialect packages comes from
    `createAdapter`, and an adapter starts its pool in one place, the private `open`, on
    first use; the setup file wraps that method on the adapter class, in the worker only, to
    record `this`. It changes nothing in the library. If the method is ever renamed, the
    setup file throws instead of checking nothing. After the file (`afterAll`, given 2 s for
    a release in flight) it writes the `poolStats()` of each.
  - `global-setup.ts` creates the directory before the run, and after the run (after the
    database sweep) reads the records and fails the run, naming each file, if any pool had
    a connection checked out (`size - idle > 0`) or a caller waiting.
  - `leaks.ts` holds the record format and the check; `leaks.test.ts` tests it (unit).
- **It fails when it should.** A scratch test that acquired a connection and never released
  it (`packages/postgres/test/zz-scratch-leak.itest.ts`, removed): the run exited 1 with
  "Connection leak: 1 pool(s) ended the integration run with a connection checked out.
  packages/postgres/test/zz-scratch-leak.itest.ts: a pool still has 1 connection(s) checked
  out and 0 caller(s) waiting". Vitest prints it as "error during close" after the summary,
  and the exit code is 1.
- **It sees the suites.** With the record directory kept for one full tier-2 run: 51 files
  recorded, 1,257 adapters tracked, **0 leaking**. No existing suite leaks, so no suite was
  changed for a leak.
- **Per-test asserts** in the write, preload and nested conformance suites:
  `expectAllReturned(adapter)` (in `leaks.ts`) in `afterEach`, before the adapter is closed,
  as the adapter, read and transaction suites already did inline. In the nested suite the
  close moved from `beforeEach` to `afterEach` so that the check runs at the end of each
  test. Each was seen failing with a scratch test that acquired a connection (removed).
- `CONTRIBUTING.md` describes both levels, and two limits of the run-wide check: a test
  that leaks and then closes its adapter fails with a timeout (`close()` waits for the
  connection) rather than the leak message, and a test file that never finishes writes no
  record.
- The pair runs were checked: a run of `parallel.itest.ts` and the Postgres transaction
  conformance (which start the two pair runs) left records for all four pair files, the
  sandbox pair's with their adapters' pools.
- An observation, not a leak: after `close()`, the MySQL adapter's `poolStats()` still
  reports the closed pool's connections as idle (398 closed MySQL pools reported `size > 0,
  idle = size`). mysql2's `pool.end()` closes the sockets (checked: the server's process
  list drops back) but leaves its `_allConnections` and `_freeConnections` arrays filled,
  which `packages/mysql/src/driver.ts` `stats()` reads. Checked-out counts are right, so the
  leak check is not affected. See Requests.

## 6. The docs-build warning (box 20.5)

`pnpm docs:build` printed Vite's "(!) Some chunks are larger than 500 kB after
minification" for two chunks:

1. **The API page of `messages` (`egon-orm/messages`), 600 kB: fixed.** TypeDoc expanded
   the catalog's 654 entries into a "Type Declaration" section, a duplicate of the error
   reference (`reference/errors/`, generated from the same catalog). `typedoc-plugin.mjs`
   now drops that declaration, shows the catalog's type as the equivalent
   `Record<ErrorId, string>`, and adds a sentence linking to the error reference; the page
   is a few kB. `ErrorId` is not a link on the page: the API reference renders declarations
   as plain code blocks (`useCodeBlocks`), which hold no links. The plugin throws if the
   catalog is no longer an object export, if an entry is not a string, or if `egon-orm` no
   longer exports `ErrorId`.
2. **The local search index, `@localSearchIndexroot`, 778 kB minified (190 kB gzip): not
   fixed.** It is one module, the serialized MiniSearch index of every non-API page (the
   API pages are already left out), loaded only when someone first opens the search box.
   Chunking cannot split one module. What I measured:
   - leaving code blocks out of the index: 692 kB;
   - leaving the 654 error entries (`reference/errors/`) out as well as the API: 518 kB,
     still over, and searching an error identifier would stop working;
   - the guide pages alone account for about 440 kB of the serialized index.

   So nothing short of removing most of the site from search gets under 500 kB. The
   options I see, for you to decide (I have not done any):
   - **(a)** keep Vite's 500 kB check for every chunk except the search index: set
     `chunkSizeWarningLimit` out of the way and add a small Vite plugin in the docs config
     that fails the build on any other chunk over 500 kB and on a search index over a
     ceiling (say 1.5 MB). This also makes the build fail on the warning, as the report's
     §8.10 proposes. My recommendation.
   - **(b)** raise `chunkSizeWarningLimit` to about 1,000 kB, with a comment saying why.
     Simplest, but it relaxes the check for every chunk.
   - **(c)** a hosted search (Algolia DocSearch) instead of the local index: no large
     chunk, but an external service.
- **DEP0040** (`punycode`) is printed by `actions/deploy-pages` in the Docs workflow's
  deploy job, not by our build. The workflow pins v5.0.1 (`368f825`), which is the newest
  release (2026-09-01), so there is no newer version to take.
- After the messages fix, `pnpm docs:build` printed only the search-index warning; after
  §6.1, none.

### 6.1 Option (a): the owner's decision, 2026-10-25

The owner chose (a): exempt only the local search index, and hold every other chunk to 500 kB.

- **The plugin**, `egon-docs-chunk-sizes`, is in `docs/site/.vitepress/config.ts` (`vite.plugins`).
  In `generateBundle` it measures every JS chunk (`Buffer.byteLength` of the minified code,
  in kB of 1,000 bytes, as Vite reports) and calls `this.error`, which fails the build, when
  a chunk is over its limit: `CHUNK_LIMIT_KB = 500` for every chunk, and
  `SEARCH_INDEX_LIMIT_KB = 1_500` for the search index. It runs in the client and the server
  build.
- **How the search-index chunk is identified:** by its facade module, not its file name.
  VitePress imports the index as `@localSearchIndex<locale>` and its `resolveId` hook
  returns `/${id}` (`vitepress/dist/node/chunk-*.js`, `LOCAL_SEARCH_INDEX_ID`), so the
  chunk's `facadeModuleId` is `/@localSearchIndexroot` for this site's one locale. The plugin
  matches `/^\/@localSearchIndex[^/]*$/`, which covers any later locale. The first failure
  run below shows the match working: the 778 kB chunk was checked against the
  search-index limit, not the 500 kB one.
- **The threshold:** the index was 778 kB on 2026-10-25 (778,301 bytes at this PR's head). 1,500 kB is about
  twice that, room for the docs to grow by about as much again. Past it, search needs another
  approach (the report's options (b) and (c)), not a higher number.
- **Both failure paths, proven locally** (each threshold lowered in a scratch copy of the
  config, then restored; `vitepress build` exited 1 both times):
  - search index, with the limit at 700 kB: `[plugin egon-docs-chunk-sizes]
    assets/chunks/@localSearchIndexroot.C79f33yJ.js is 778.3 kB after minification, over the
    700 kB limit for the local search index (docs/site/.vitepress/config.ts,
    egon-docs-chunk-sizes).`
  - any other chunk, with the limit at 250 kB: `[plugin egon-docs-chunk-sizes]
    assets/api_reference_egon-orm_classes_CastError.md.B6Pu2dbu.js is 268.3 kB after
    minification, over the 250 kB limit for a chunk (docs/site/.vitepress/config.ts,
    egon-docs-chunk-sizes).`
- After restoring, `pnpm docs:build` passes with no chunk warning. The largest other chunk
  is about 300 kB, an API page (`EgonError`).

### Checks changed

With the owner's approval (decision of 2026-10-25, "a"), this PR changes one check:

- **`build.chunkSizeWarningLimit` in the docs' Vite config is 1,500 kB**, the search index's
  ceiling, instead of Vite's default 500 kB. Vite has one limit for every chunk, so silencing
  its warning for the search index also raises it for every other chunk. **The plugin's
  500 kB check is what keeps the other chunks covered**, and it is stricter than Vite's own:
  it fails the build where Vite only warned.

## 7. The 1.0 gate

`docs/plan/21-release.md` had no place for it, so it has a new "1.0 gate" section
(owner-approved) with the report's §8 list, re-worded slightly where §8 referred to its own
sections. Items 1 to 3 are marked as owner decisions: F4 (2026-10-22), editor completions
under 200 ms and the query and compiler survivors triaged one by one (2026-10-24). The rest
is the report's proposal. The leak assertions of §8.10 are dropped from it, since this PR
adds them.

## Checks

All on the branch head, locally (Node 22.23.1, pnpm 12.11.2):

| Check | Result |
|---|---|
| `pnpm check` | passed: 6,645 unit tests (163 files), 608 type tests, build |
| `pnpm api:check` | API report up to date for 9 entry points |
| `pnpm lint:packages` | passed |
| `pnpm smoke` | passed ("every check passed") |
| `pnpm docs:build` | passed, no chunk warning (after §6.1) |
| `EGON_TEST_TIER2=1 pnpm test:integration --maxWorkers=2` | 51 files passed; 1,801 tests passed, 2 expected fail, 55 skipped; leak check passed |
| the same on Postgres 14.24 / MySQL 8.0.31 | see §2 |
| `pnpm audit --prod` | No known vulnerabilities found |

CI on PR #77 (run 40130483391): every job passed, including the new **integration
(database floors)**. That job printed `PostgreSQL 14.24` and `8.0.31`, then ran 51 files:
1,801 passed, 2 expected fail, 55 skipped. The exception is `types (typescript next,
informational)`, which fails as it does on `main` (P7 of the report) and is outside the
`ci` gate.

## Deviations and decisions

- "First expression a program checks" is implemented as the first **query** statement
  checked (§4). In the synthetic project a schema file is checked before any query; the
  one-time cost lands on the first query (`queries-00.ts:4`), as the report and
  `status/21-api.md` describe, so excluding the very first statement would have left the
  55 ms statement in. The plan text says "the first query expression".
- The leak check wraps a private method of the adapter class from a test setup file (§5).
  The alternative, a test hook in the library, would change published code.
- I touched files outside a single area (CI, compose, test support, docs, plan), as the
  owner's list required; each item is in its own commit.

## Needs the owner's decision

None open. The search-index warning (item 6) was decided on 2026-10-25: option (a), §6.1.

## Requests

- **MySQL adapter (`packages/mysql/src/driver.ts`):** `stats()` after `close()` reports the
  ended pool's connections as idle (mysql2 does not empty its arrays on `end()`); report
  zeros once the pool has ended. Low; nothing depends on it today.
- **To 21-audit's report (PR #76):** P1, P3/P4 (database floors), P10 (box 11.5), P14
  (`ErrorMessagesOf`), the 50 ms decision (P2) and P9 (box 20.5, with option (a)) are
  addressed here.

## Not verified

- MySQL 8.0.31 through the compose service locally (only the same image by digest through
  `docker run`); CI runs the compose service.

## Review round 1 (PR #77, approved)

The reviewer's four minor findings:

1. `typedoc-plugin.mjs`: the trimmed `messages` page showed `const messages: object`. It now
   shows `const messages: Record<ErrorId, string>`, which is what the object literal is (one
   `string` member per identifier, not `readonly`), and the added sentence no longer says
   "and this text".
2. `measure.mjs`: the blog's query files are now the four application files, so `db.ts:6`
   (`createRepo`) is no longer taken as the first query; blog re-measured (§4.1). The
   `startsWith` check now also applies to `firstCheckedByRun` (one `relative` helper).
3. Leak-check limits documented in `CONTRIBUTING.md`. Covering the pair runs was cheap (a
   setup file on the two pair projects), so they are covered instead of documented (§5).
4. No action (squash merge).

## Review round 2 (PR #77, approved)

1. `measure.mjs`'s `budget` also gives `slowestIncludingFirstMs` and `metIncludingFirst`,
   the slowest statement with the first query counted. A project that meets 50 ms without
   the exclusion shows it in the output. Re-measured (chain run): the blog gives `slowestIncludingFirstMs` 31.6 (`accounts.ts:16`), `metIncludingFirst: true`, and 20.3 ms after the first; the 200-schema chain gives 59.1 ms, `metIncludingFirst: false`, and 23.9 ms after the first, `met: true`.
2. §6 claimed `ErrorId` is linked on the generated `messages` page. It is not: the page
   shows the type in a plain code block, as every API page does. The claim is corrected.

The search-index warning (item 6) is left as it was; the owner is deciding between (a), (b)
and (c).

## Owner decisions of 2026-10-25

1. **Docs search index: option (a).** Built as §6.1 describes.
2. **No GitHub issues.** The project does not use GitHub issues. In `status/21-audit.md`
   (merged from `main` into this branch, #76) §10 is recast from issue drafts into the
   tracked list of open items, which is the record. Each entry keeps its rank (its P number)
   and owner (§7), and an item's owner plus its entry in the list fills the role of "an owner
   and issue". Only wording and labels changed, and no item was dropped or changed:
   - "Proposed issue" became "Entry", and "Body" became "Detail".
   - §7's columns "Issue" became "Item" and "Tracked in", and "proposed in §10" became
     "§10 list".
   - The §5 acceptance box says the list fills the issue's role. It stays unticked, as the
     audit left it.
   - One line was added to the report's owner decisions.
   - The review-round history at the end of the report was left as written.
