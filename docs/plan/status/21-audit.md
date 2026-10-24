# Step 21 (audit): readiness report for 0.1.0, status

Branch `step/21-audit`, 2026-10-24, from `main` at `c2088d6` ([#75](https://github.com/egon-orm/egon-orm/pull/75)). Spec:
`docs/plan/21-release.md` §5 and Acceptance. This part writes the report and changes nothing
else: findings are reported here, ranked, and not fixed.

Everything below was checked at `c2088d6`, on the owner's laptop (macOS, Apple silicon),
Node 22.23.1 (and 22.12.0 where stated), pnpm 12.11.2, TypeScript 6.0.3, against the shared
Compose Postgres 16 and MySQL 8.4. "I ran" means it was run for this report; anything taken
from a status note or a CI log says so.

## 1. Summary and recommendation

**Recommendation: publish `0.1.0` after O1–O6 and the follow-up PR** (see "Owner
decisions, 2026-10-24" below; at the time of the audit the list was O1–O6, the 50 ms
decision P2, the acceptance of the sampled survivors P6, and the Zod peer floor P1). No code
blocker was found. Nothing found is data loss, an injection path or a security hole in
Egon's own code.

The library is in good shape for a first public `0.x` release:

- `pnpm check` passes (6,638 unit tests, coverage 99.19% statements and 98.29% branches,
  608 type tests); the integration suite passes on Postgres, SQLite and MySQL (51 files,
  1,801 tests; the 55 skips are all capability skips); `api:check`, `lint:packages`,
  `smoke` (also on Node 22.12.0 exactly) and `docs:build` pass. CI on `main` at `c2088d6` is
  green except the informational TypeScript `next` job.
- The release dry run passes end to end from a fresh `git clone` of `origin`
  (verdaccio; six packages at `0.1.0`, tags, release notes, install from the registry,
  `require()` and `import` of all nine entry points, `egon --version`).
- Security review complete: F1, F2, F3, F5 and F11 fixed; F4 documented (a 1.0 gate, owner
  decision); no injection finding. Robustness: 30-minute soak, fault injection and the
  runtime matrix pass with zero leaked connections; a 2-minute soak I ran also passed.
  Mutation scores: compiler 93.04%, query 83.46%, changeset 88.14% (all over 80%).

What must happen before the first publish (§9, §10):

1. **Owner settings** (O1 to O6). None is done today, verified read-only through the GitHub
   API: `RELEASE` is not set, there is no `npm` environment, no `NPM_TOKEN` secret, `main` has
   no effective protection (the one ruleset targets no branch), private vulnerability
   reporting is off, and GitHub Actions may not create pull requests (the release
   workflow's version job needs that). Releases are off, so nothing publishes by accident.
2. **P1 (Medium): the Zod peer range admits a version with a memory-exhaustion advisory.**
   `@egon-orm/zod` declares `zod: ^4.3.0`; GHSA-mrhx-c7xc-m3w5 (high, published
   2026-10-01) affects Zod up to 4.6.5, and `toZod` emits `z.array(...)` without a length
   cap for embedded lists (`packages/zod/src/to-zod.ts:226`). The repository's own Zod pins
   are 4.6.5. Fix: peer floor `^4.6.6`, pins to 4.6.7 (both releases are 12 or more days
   old). This is a public peer-range change, so it is listed for the owner's decision.
3. **P2 (Medium): the 50 ms per-expression budget is not met, and only the completions miss
   was accepted.** The first expression checked in the 200-schema project takes 53–55 ms
   (55.2 ms, median of 3, in my run; 53.2 ms in one reviewer run); every other one is
   at most about 29 ms. Type health stays a `0.1.0` gate (owner, 2026-10-22), so the owner
   must decide: accept the miss for `0.1.0`, or define the budget so that it excludes the
   one-time cost of the first expression a program checks (§4.2, §10 item 3).
4. **P6: accept the sampled query and compiler survivors.** Owner decision 4 (2026-10-23)
   made only the changeset survivors a gate; the query and compiler survivors were sampled,
   not triaged one by one, and `0.1.0` ships that way (about 106 and 35 untested behaviours
   estimated). The owner accepts that explicitly before publishing (§4.3, §10 item 4).

Should be done before `0.1.0`, not blocking: say "tested on 16" next to "Postgres 14 or later"
everywhere it is claimed, or add a Postgres 14 job (P3); update the "under construction,
nothing is published" wording at release (P11).

Not met and accepted by the owner: the 200 ms completions budget on large connected models
(§4.2). Not met and **not** accepted yet: the 50 ms budget for the first expression (item 3). Still to be accepted: the sampled query
and compiler survivors (item 4). Not run: step 19 and every box deferred to it; **the published benchmark has not
run.**

## Owner decisions, 2026-10-24

The owner answered §10 with "do the recommended". The rest of this report is left as it was
at the time of the audit; these decisions supersede it where they differ.

- **§10 item 1 (O1–O6):** the owner does them. Still open until they are done.
- **Unscoped `egon-orm` name:** yes, the owner publishes a placeholder.
- **P1:** the Zod peer floor goes to `^4.6.6` before `0.1.0`, in a follow-up PR.
- **P2:** the 50 ms budget is redefined to exclude the one-time cost of the first expression
  a program checks. Type health therefore moves to "ready with caveats", with the
  completions miss still accepted. This takes effect when the follow-up PR updates
  `21-release.md`.
- **P6:** accepted. `0.1.0` ships with the query and compiler survivors sampled; triaging
  them one by one is a 1.0 gate.
- **Database floors (P3):** CI jobs for Postgres 14 and MySQL 8.0.31 before `0.1.0`, in the
  follow-up PR. This follows the coordinator's recommendation, which the owner answered, and
  is stricter than this report's (a Postgres 14 job before 1.0, "tested on 16" for `0.1.0`).
- **1.0 gate:** completions under 200 ms and the query and compiler triage are added
  (§8 items 2 and 3).
- **`ErrorMessagesOf`** is renamed to `ErrorMessages` before `0.1.0`, in the follow-up PR.
- **Boxes 11.5 and 20.5** (the leak check and the docs chunk-size warning) are fixed in the
  follow-up PR.

## 2. What I ran

| Command | Result | Log (scratch) |
|---|---|---|
| `pnpm i --frozen-lockfile` | ok | |
| `pnpm check` | **pass**, 66 s: Biome 658 files clean, policy checks, `docs:check` (cspell 72 files, 0 issues); typecheck; unit: 162 files, 6,638 tests, coverage 99.19% stmts / 98.29% branches / 99.23% funcs / 99.43% lines (thresholds 95%); benchmark-harness tests (4) and `node --test scripts/*.test.mjs` (77) pass; types: 35 files, 608 tests, no type errors; build | `check.log` |
| `pnpm api:check` | **pass**: "API report up to date for 9 entry points." | `apicheck.log` |
| `pnpm lint:packages` | **pass**: publint `--strict` "All good!" for all six packages; attw `esm-only` green for `node16 (from ESM)` and `bundler` on every entry point (the `node16 (from CJS)` warning is ignored by the profile, as documented) | `lintpkg.log` |
| `pnpm smoke` | **pass**: ESM, `require()` of the ES modules, and the consumer matrix from packed packages (nodenext, node16, bundler, CommonJS `.cts`, `json-return`) on TypeScript 6.0.3 | `smoke.log` |
| `node require-esm.cjs`, `node esm.mjs` in `examples/smoke` with **Node 22.12.0** | **pass** (rc 0). Node 22.12.0 prints `ExperimentalWarning: … loading ES Module … using require()`; see P12 | |
| `pnpm docs:build` | **pass**, 35 s, with Vite's "(!) Some chunks are larger than 500 kB" warning (P9) | `docsbuild.log` |
| `EGON_TEST_TIER2=1 pnpm test:integration --maxWorkers=2` | **pass**: 51 files; 1,801 passed, 2 expected failures (`test.fails` in `core/test/support/db.itest.ts:82` and `mysql.itest.ts:29`, which check the timeout guard), 55 skipped (38 SQLite, 16 MySQL, 1 Postgres), every skip a capability or profile skip (`[capability cancel is false]` 9, `[capability multipleConnections is false]` 9, `arrays` 4, `nonFiniteFloats` 4, …; the Postgres one is "the database begins a transaction with one statement") | `itest.log`, `itest-verbose.log` |
| `pnpm test:soak` (2 minutes, the documented default) | see §4.4 | `soak.log` |
| `pnpm audit --prod`, `pnpm audit`, `pnpm audit --json` | see §4.7 | `audit-*.log` |
| Fresh `git clone https://github.com/egon-orm/egon-orm.git`, `pnpm install --frozen-lockfile`, `EGON_VERDACCIO_PORT=4899 pnpm release:dry-run` | **pass** (§4.8) | `dryrun.log` |
| `node scripts/type-health/measure.mjs` (tree, 3 runs, with check times; and `--completions-only` for chain, hub, clusters, tree at 150) | see §4.2 | `th-*.log` |
| `npm view egon-orm`, `npm view @egon-orm/postgres`, the registry's org endpoint | see §4.6 | |
| `gh api` (read-only, `env -u GH_TOKEN`): repo, environments, variables, secrets, branch protection, rulesets, private vulnerability reporting, Actions workflow permissions, CI runs and job logs | see §4.9 | |

The per-step acceptance boxes (§6) were re-verified by reading code, tests, CI configuration
and CI logs, with a few single-file test runs; that work was split over five reviewers
working read-only from the same checkout, and I read every table and spot-checked the
findings that change a verdict (the ruleset, the docs-build warning, the Postgres versions,
the leak teardown).

Not run, by the rules of this part: a full Stryker area run, any benchmark, the
100,000-run injection property test, the 30-minute soak.

## 3. Area verdicts

| Area | Verdict | Evidence (details in §4 and §6) |
|---|---|---|
| Types, schema (steps 03, 04) | **Ready** | §6 steps 03–04: all boxes verified (two with caveats about test form); `pnpm check` |
| Changesets and validators (05, 06, 15) | **Ready** | §6; changeset mutation survivors triaged one by one ([#74](https://github.com/egon-orm/egon-orm/pull/74)), score 88.14%; duplicate names and own-key reads fixed ([#75](https://github.com/egon-orm/egon-orm/pull/75)) |
| Query builder and expressions (07–09) | **Ready with caveats** (P6 accepted 2026-10-24) | §6; mutation 83.46%; survivors sampled, not triaged one by one (owner decision 4, 2026-10-23): about 106 (42–237) untested estimated (§4.3) |
| SQL compiler (10) | **Ready with caveats** (P6 accepted 2026-10-24) | §6; injection property on all three dialects (10,000 runs in CI, 100,000 once in 21-security); mutation 93.04%; survivors sampled, not triaged (owner decision 4): about 35 (14–78) estimated gaps |
| Adapter, repo reads and writes (11–13) | **Ready with caveats** | §6; my integration run; Postgres 14 claimed but untested (P3); the "global teardown" leak box is false as worded (P10), covered in practice by fault injection and the soak |
| Associations, transactions, Batch (14, 16) | **Ready** | §6; seams tests (`packages/postgres/test/seams.itest.ts`) in my integration run |
| Dialects: SQLite, MySQL (17) | **Ready with caveats** | §6; tier-2 integration passes; "CI jobs required" is false (no branch protection, P0) |
| Migrations and CLI (18) | **Ready** | §6; CLI built-binary tests pass in my integration run |
| Documentation (20) | **Ready with caveats** | §6; the build has a chunk-size warning, so "zero warnings" is false (P9); the fresh-eyes box rests on the status note (unverified) |
| Edge readiness, JSON responses (21a, 21b) | **Ready** | §6: every box verified, six with low caveats |
| Security (21 §2) | **Ready with caveats** | F4 open by owner decision (1.0 gate); P1 (Zod peer) |
| Robustness (21 §3) | **Ready** | §4.4 |
| Type health (21 §1) | **Not ready** until the owner decides P2 | completions budget not met at about 140–170 connected schemas, accepted by the owner; 50 ms budget missed by the first expression (53–55 ms), not accepted (§4.2) |
| API surface (21 §1) | **Ready** | API report committed, `api:check` in CI's `build+publint+attw` job; owner items 1–9 built ([#72](https://github.com/egon-orm/egon-orm/pull/72)) |
| Packaging and release mechanics (21 §4) | **Ready** | publint, attw, smoke, peer bounds jobs, dry run from a clean clone |
| Release settings and repository governance | **Not ready** (owner) | §4.9: none of O1–O6 done; owner: the project owner; proposed issue in §10 |
| Supply chain | **Ready with caveats** | no runtime dependency in any published package; P1; dev-only advisories (§4.7) |
| Performance (19) | **Not run** | deferred by owner decision; does not count against readiness |

## 4. The known facts, with their evidence

### 4.1 Security: F4 open (1.0 gate), F5 fixed

- **F4 (Medium), open by owner decision (2026-10-22): a 1.0 gate.** `ConstraintError.detail`
  and `error.cause` hold the database's own text, which can quote a redacted value, and
  `util.inspect(error)` prints both. Pinned by a test that expects the leak, so a fix will
  show: `packages/postgres/test/secrets.itest.ts:210-211`
  (`expect(inspect(violation)).toContain(SECRET)`, and the same for the failed statement's
  query event). Documented in `SECURITY.md:40` ("Log errors by `message` or `toJSON()`, not
  by inspecting the object"). `packages/core/src/errors.ts` has no custom inspect today
  (grep for `inspect.custom` finds nothing). Before 1.0: a custom inspect on the constraint
  and driver errors that hides `detail` and the cause.
- **F5 (Low): fixed** in [#72](https://github.com/egon-orm/egon-orm/pull/72): schemaless changesets never generate code
  (`changeset/spec.ts`, `refuseGeneration`), test in
  `packages/core/test/security/codegen.test.ts` (zero `Function` constructions). The F5 row of
  `status/21-security.md` still says "Owner's decision"; `status/21-decisions.md` supersedes it.
- The other findings: F1, F2, F3, F11 fixed with tests; F6–F9 informational and documented in
  `SECURITY.md`; F10 (dev advisories) is §4.7. No injection finding.

### 4.2 Type health

Recorded in `status/21-api.md` §3 (median of 20 completions after an edit, in a `where`
callback of the 200-schema project):

| Topology | Reachable schemas | 21-api (sweep) | 21-api (table run) | I measured (2026-10-24) |
|---|---|---|---|---|
| chain | 200 | 244 ms | 246 / max 452 ms | **239 ms** |
| tree | 200 | 244 ms | 314 / max 449 ms | **239 ms** (max 387); 238 ms in a second run |
| hub | 200 | 255 ms | 242 / max 397 ms | **230 ms** |
| tree | 150 | — | — | **189 ms** |
| clusters | 10 | 55 ms | 47 / max 97 ms | **44 ms** |

- **The completions budget (< 200 ms) is not met** on large connected models: about 40 ms
  plus 1.1–1.2 ms per reachable schema, so it is crossed at roughly 140–170 connected
  schemas on this machine (my 150-schema tree: 189 ms, just under). **The owner accepted
  this for `0.1.0`** (2026-10-22); it is on the roadmap as "Faster editor completions in
  large models" (`docs/site/reference/roadmap.md:27`, PR [#70](https://github.com/egon-orm/egon-orm/pull/70)). The workaround (declare the
  return type of `changeset` methods, about 114 ms at 200 schemas in 21-api's measurement)
  is in the FAQ, "Why are editor completions slow in a large model?"
  (`docs/site/guide/faq.md:279-298`), with a checked example
  (`docs/site/examples/faq-completions.ts`). I did not re-measure the workaround.
- **50 ms per query expression: not met, and not accepted.** Every expression is under
  50 ms except the first one a program checks, a one-time cost of resolving the library's
  types: I measured 55.2 ms (max 56.4) at `queries-00.ts:4` in the 200-schema tree (21-api
  recorded 54–63 ms; one reviewer run of this report measured 53.2 ms); the next slowest is
  21.8 ms. The owner kept type health as a `0.1.0` gate and accepted only the completions
  miss, so this is an **unmet `0.1.0` gate** that needs the owner's decision (P2, §10).
  `examples/blog`: slowest 31.4 ms (`src/accounts.ts:16`).
- **Instantiation counts** (I measured; identical to 21-api's): `examples/blog` 48,563
  instantiations, 14,730 types, check 0.19 s; 200-schema tree 401,512 instantiations, 59,175
  types, check 2.39 s. 21-api also records chain (413,957) and hub (389,037).
- These are one-off audit measurements, not CI gates (plan README §7).

### 4.3 Mutation scores

Stryker, `ignoreStatic: false`, from the status notes (I did not run Stryker: a full area run
is not allowed here):

| Area | Score | Source | Survivors |
|---|---|---|---|
| compiler | **93.04%** | `status/21-robustness.md` §4 | 264 logic survivors; sample of 30: 4 real gaps (now tested), estimate **about 35 untested (14–78)** |
| query | **83.46%** | `status/21-robustness.md` §4 | 798 logic survivors; sample of 30: 4 real gaps, estimate **about 106 untested (42–237)** |
| changeset | **88.14%** (from 83.14%) | `status/21-changeset-gaps.md` (run on `01b6cf0`) | all 530 logic survivors looked at one by one: 202 now tested (203 gaps closed), 123 equivalent, 205 low value; no production bug |

All three are over the 80% target. **The query and compiler survivors were sampled, not
triaged one by one** (30 per area). That is by owner decision 4 of 2026-10-23
(`status/21-robustness.md`, "Owner decisions"): only the changeset survivors were made a
`0.1.0` gate, because their sampled gap rate (about 37%, 50% in the two largest files) was far
above the query and compiler rates (13%), which were not raised to a gate. The query and
compiler estimates are still open; their explicit acceptance for `0.1.0` is asked for in §10
item 6. **Proposal:** triage the query and compiler logic survivors one by one, as was
done for the changeset area, as 1.0 work and a 1.0 gate (§8): the query estimate (42–237
untested behaviours) is too wide to call the area fully tested, and the method is proven.
Note: the robustness note's summary table still says changeset 83.14%; [#74](https://github.com/egon-orm/egon-orm/pull/74) brought it to
88.14% (the robustness note's §4 explains the history).

### 4.4 Robustness

From `status/21-robustness.md`: the 30-minute soak (pool of 5, random
`pg_terminate_backend`) passed on the final code: 166,467 operations, 1,007 kills, 0
unexpected failures, 0 unhandled rejections, 0 connections left checked out, 0 backends after
`close()`, heap +0.49 MB. Fault injection: 22 scenarios, 105 await points, 210 faulted runs,
no connection left checked out (`packages/core/test/fault/fault-injection.test.ts`, part of
the unit run I did). Runtime matrix: Node 22.12.0, 22.23.1, 24.14.1 (ESM, `require()`,
esbuild ESM and CJS bundles, a Next.js 16.4.2 build); Bun best effort (Postgres passes,
SQLite cannot load `better-sqlite3`). **Zero connection leaks.** Three bugs were found and
fixed, each with a test: a Postgres stream whose session ended held its connection forever
(High); a session terminated right after `close()` crashed the process (Medium);
`@egon-orm/sqlite` failed when bundled to CommonJS (Medium).

CI: `runtime (node 22)` and `runtime (node 24)` are in the `ci` gate and passed on
`c2088d6` (run [40123401475](https://github.com/egon-orm/egon-orm/actions/runs/40123401475)); the Bun workflow passed (run [40123401470](https://github.com/egon-orm/egon-orm/actions/runs/40123401470)). The weekly soak
workflow (`.github/workflows/robustness.yml`) **has not run on GitHub yet** (no runs listed);
the 30-minute result is local only.

My 2-minute soak (`pnpm test:soak`, default settings, 121 s): **passed**. 11,095 operations, 66 kills, 7 expected `DatabaseError` `connection` failures, 0 unexpected, 0 unhandled rejections, 0 uncaught exceptions, 0 stuck workers, at most 5 backends, final pool 4 open / 4 idle / 0 waiting, `close()` clean, 0 backends after close, accounts total 10,000, heap growth +0.47 MB. Short, so it says nothing about the 9-minute hang class that only the 30-minute run could find.

### 4.5 Hardening (PR [#75](https://github.com/egon-orm/egon-orm/pull/75))

Done as the owner decided on 2026-10-24: a field listed twice is processed once
(`packages/core/src/internal/distinct.ts`); every read of an options object, and of the
library's frozen defaults, is an own-property read (`own()`), with tests that plant a key on
`Object.prototype` in every package (`packages/{postgres,mysql,sqlite,zod,cli}/src/hostile-options.test.ts`
and the core tests the hardening note lists); a Batch step named `__proto__` is a
`QueryError` when the batch is built (`packages/core/src/batch/batch.test.ts:104`). Mutation
runs seed fast-check in `packages/core/test/support/mutation-seed.ts` only.

The remaining driver-side gap is documented in `SECURITY.md:38` by owner decision: `pg`,
`pg-pool` and `mysql2` read keys of the configuration Egon builds that Egon does not set, so
under a polluted `Object.prototype` they may take an inherited `ssl`, `stream`, `typeCast`
and others. `better-sqlite3` gets a prototype-free options object. The hardening note says
the own-read audit was done by reading, with no lint to enforce it (a gap it states).

### 4.6 Support policy, TypeScript, npm

- **TypeScript minimum 5.8 for everyone** (decision D14, `docs/plan/README.md`; owner
  2026-10-22), stated in `docs/site/reference/upgrading.md:83`. CI checks the packed packages
  with the newest 5.8.x (5.8.3) and the latest release (7.0.2) in the `ci` gate
  (`types (typescript minimum)`, `types (typescript latest)`, both green on `c2088d6`).
  **The build stays on TypeScript 6** (6.0.3; owner decision, tsup's declaration bundler,
  TypeDoc and API Extractor need the TypeScript JS API); TS 7 is supported for users.
- **`types (typescript next, informational)` fails, on `main` too** (run [40123401475](https://github.com/egon-orm/egon-orm/actions/runs/40123401475), and
  every `main` run since [#69](https://github.com/egon-orm/egon-orm/pull/69), e.g. [39906052551](https://github.com/egon-orm/egon-orm/actions/runs/39906052551)), on 7.1.0-dev.20261023.1, with two errors:
  - `TS5115` in Zod 4.6.5's own declarations (`zod/v4/classic/schemas.d.cts(804,5)`:
    "Instantiations … appear infinitely circular"). Zod's, not ours.
  - `TS5088` at `examples/smoke/types/consumer.ts:174`,
    `export const errors = newUser.errorMessages();` ("The inferred type of 'errors'
    references a type with a cyclic structure which cannot be trivially serialized").
    **This one is ours**: under a future TypeScript, a consumer with `declaration: true` that
    exports the inferred result of `errorMessages()` would need a type annotation.
  - **Does it matter?** Not for `0.1.0`: the job is `continue-on-error: true` and outside
    the `ci` gate by design, 7.1 is an unreleased nightly, and 5.8.3, 6.0.3 and 7.0.2 all
    pass. It matters before TypeScript 7.1 ships: re-check at 7.1 beta and fix
    `ErrorTreeOf` / `errorMessages()` if it persists (P7).
- **Support policy** (owner, 2026-10-22): no backports before 1.0; after 1.0 the previous
  major gets security fixes for six months; databases supported until at least their end of
  life. Not provisional: `docs/site/reference/upgrading.md` and `SECURITY.md` "Supported
  versions" (I grepped: no "provisional" left in either).
- **npm.** `npm view egon-orm` → **E404** (the unscoped name is unpublished);
  `npm view @egon-orm/postgres` → E404. The scope exists: the registry's
  `/-/org/egon-orm/package` returns `200 {}` (no packages), where an unknown scope returns
  `404 {"error":"Scope not found"}`. That the owner holds it is the owner's statement of
  2026-10-22; I could not check membership (`npm whoami` has no valid token here).
  **Recommendation: publish a placeholder for the unscoped `egon-orm` now**, or publish
  `0.1.0` soon: the core package's name is unscoped, so anyone can take it until it exists.

### 4.7 Advisories

`pnpm audit --prod`: **1 advisory**, Zod GHSA-mrhx-c7xc-m3w5 (high), through
`examples/blog`, `benchmarks` and `docs/site`, all private workspace packages. It changed
since 21-security's "no known vulnerabilities".

`pnpm audit` (everything): **44 advisories** (11 high, 24 moderate, 9 low), up from 27 at the
security review and 28 at packaging. Grouped by package (paths to the first two levels):

| Package | Severity | Reached through | Ships in a package? |
|---|---|---|---|
| zod < 4.6.6 | high | `packages/zod` (devDependency pin 4.6.5), `examples/blog`, `benchmarks`, `docs/site`, Stryker | No; but the **peer range** `^4.3.0` admits it (P1) |
| vite ≤ 6.4.3 | high/moderate/low | `docs/site > vitepress` | No |
| undici < 7.30.1 | high/moderate/low | `examples/edge-worker > miniflare, wrangler` | No |
| sharp < 0.35.5 | high | `examples/edge-worker > miniflare` | No |
| body-parser | high | `verdaccio` (release dry run), `docs/site > express` | No |
| esbuild | moderate/low | `tsup`, `vite`, `vitest`, `vitepress` | No |
| qs | moderate | Stryker | No |
| fast-uri | moderate/low | `tsup`, Stryker, API Extractor, verdaccio, `docs/site > fastify` | No |

`braces` (via `verdaccio`), listed at packaging, no longer appears. **No published package
has a runtime dependency**: I read every `packages/*/package.json`: none of the six has a
`dependencies` field at all; `egon-orm` has no `peerDependencies` either (ADR 0003); the others declare only
peers (`pg`, optional `pg-cursor` and `@types/pg`; `mysql2`; `better-sqlite3`; `zod`;
`egon-orm`). So no advisory reaches a published package's runtime dependencies. The only one
that reaches a user's install is Zod, through the peer range of `@egon-orm/zod`.

### 4.8 Release dry run

From a fresh clone of `origin` (`c2088d6544bc`), `pnpm install --frozen-lockfile`, then
`EGON_VERDACCIO_PORT=4899 pnpm release:dry-run` (`scripts/release-dry-run.mjs`; port 4899
so as not to meet another worker's registry). Output, abridged:

```text
ok: clean clone at c2088d6544bce89b6b415a251b126c43587fb8b5
ok: installed with the frozen lockfile and built
ok: 6 published packages in one fixed group; pending changesets: first-release.md
ok: every published package is at 0.1.0, with a CHANGELOG entry and VERSION; no private package changed; committed
ok: publish plan (select-mode "publish"): egon-orm@0.1.0, @egon-orm/cli@0.1.0, @egon-orm/mysql@0.1.0, @egon-orm/postgres@0.1.0, @egon-orm/sqlite@0.1.0, @egon-orm/zod@0.1.0
ok: 6 packages at 0.1.0 in the registry, no workspace: ranges, READMEs shown, git tags @egon-orm/cli@0.1.0 @egon-orm/mysql@0.1.0 @egon-orm/postgres@0.1.0 @egon-orm/sqlite@0.1.0 @egon-orm/zod@0.1.0 egon-orm@0.1.0
ok: after publishing, the publish plan is empty (select-mode "none")
ok: 6 release notes written
ok: npm installed 9 entry points from the registry; egon --version is 0.1.0
ok: a patch to @egon-orm/zod alone moves all 6 packages to 0.1.1 (not published)
release dry run: passed (c2088d6, 0.1.0)
```

**Passed.** CI's `release dry run` job also passed on `c2088d6`. Not exercised (as the
packaging note says): provenance and trusted publishing, and the release workflow's jobs on
GitHub (they are off).

### 4.9 Owner actions before the first publish

Checked read-only on 2026-10-24 with `env -u GH_TOKEN gh api`:

| # | Action | State | Evidence |
|---|---|---|---|
| O1 | Repository variable `RELEASE=on` | **Not done** | `actions/variables`: `total_count: 0`. Every job of `release.yml` is skipped (run [40123401614](https://github.com/egon-orm/egon-orm/actions/runs/40123401614) "skipped") |
| O2 | `npm` environment, deployment branches restricted to `main` (required reviewers recommended) | **Not done** | `environments`: only `github-pages` |
| O3 | `NPM_TOKEN` (first publish) or trusted publishing | **Not done** (token) / not checkable (trusted publishing is set on npmjs.com, and the packages do not exist yet) | `actions/secrets`: `total_count: 0`; no environment to hold one |
| O4 | Branch protection on `main`: one approval, the `ci` check, squash only | **Not done** | `branches/main/protection`: 404 "Branch not protected"; `branches/main`: `protected: false`. The one ruleset, `main-protection` (id 25116048, active), has `conditions.ref_name.include: []`, so it applies to no branch, and its rules are only `deletion` and `non_fast_forward`. Merge methods: squash, merge commit and rebase all allowed. (An earlier version of this report said [#72](https://github.com/egon-orm/egon-orm/pull/72) merged with tier 2 red. That was wrong: see Review round 1.) |
| O5 | Private vulnerability reporting | **Not done** | `private-vulnerability-reporting`: `{"enabled": false}`; `SECURITY.md` points reporters to it |
| O6 | "Allow GitHub Actions to create and approve pull requests" (the release workflow's version job opens the version PR) | **Not done** | `actions/permissions/workflow`: `can_approve_pull_request_reviews: false`, `default_workflow_permissions: read` |

Also from the packaging note: the version PR opened with `GITHUB_TOKEN` gets no CI run (pass a
GitHub App or fine-grained token, or close and reopen it); set the date of "0.1.0
(unreleased)" in `CHANGELOG.md` in the version PR. Repository security features (Dependabot
security updates, secret scanning, push protection) are all disabled (`security_and_analysis`);
the owner may want them on.

### 4.10 Carried over (21-release.md)

| Item | State | Evidence |
|---|---|---|
| CommonJS consumer on Node 22.12 exactly | **Done** | I ran `examples/smoke/require-esm.cjs` and `esm.mjs` with `~/.nvm/versions/node/v22.12.0/bin/node`: both rc 0 (`cjs: require("egon-orm") loaded the ES module 0.0.0 on Node v22.12.0`). CI downloads 22.12.0 (SHA-256 pinned, `.github/workflows/ci.yml:101-122`) and runs `pnpm smoke --node …22.12.0` in `build+publint+attw`, green. The release dry run's install check ran on 22.23.1 |
| Package READMEs | **Done** | `packages/{cli,core,mysql,postgres,sqlite,zod}/README.md` exist (41–67 lines); the dry run confirms each is the package's readme on the registry; their code blocks copy checked example regions (`scripts/check-release-config.mjs`) |
| Move to TypeScript 7 | **Decided**: the build stays on TypeScript 6; TS 7 supported for users (owner, 2026-10-22) | `status/21-packaging.md` "Needs the owner's decision" 1; CI `types (typescript latest)` checks 7.0.2 |
| Branch protection on `main` | **Not done** | O4 |

### 4.11 API report

Committed: `api-report/*.api.md`, nine entry points. Enforced: `pnpm api:check` runs in CI's
`build+publint+attw` job (green on `c2088d6`) and fails on any difference (21-api verified by
editing a line; I ran it: up to date). The caveat is O4: a red `ci` does not block a merge
today, so "enforced" holds only as far as reviewers honour a red check.

## 5. Step 21's own Acceptance

The PRs behind it: [#57](https://github.com/egon-orm/egon-orm/pull/57) (21a), [#60](https://github.com/egon-orm/egon-orm/pull/60) (21b), [#61](https://github.com/egon-orm/egon-orm/pull/61), [#62](https://github.com/egon-orm/egon-orm/pull/62), [#65](https://github.com/egon-orm/egon-orm/pull/65) (packaging), [#68](https://github.com/egon-orm/egon-orm/pull/68) (security), [#69](https://github.com/egon-orm/egon-orm/pull/69)
(21-api), [#70](https://github.com/egon-orm/egon-orm/pull/70), [#71](https://github.com/egon-orm/egon-orm/pull/71), [#72](https://github.com/egon-orm/egon-orm/pull/72) (decisions), [#73](https://github.com/egon-orm/egon-orm/pull/73) (robustness), [#74](https://github.com/egon-orm/egon-orm/pull/74) (changeset gaps), [#75](https://github.com/egon-orm/egon-orm/pull/75)
(hardening); all merged (`gh pr list`). [#59](https://github.com/egon-orm/egon-orm/pull/59) and [#63](https://github.com/egon-orm/egon-orm/pull/63), [#64](https://github.com/egon-orm/egon-orm/pull/64), [#66](https://github.com/egon-orm/egon-orm/pull/66), [#67](https://github.com/egon-orm/egon-orm/pull/67) are plan and roadmap PRs.

- [ ] **Audit report written with evidence for each verdict; no "not ready" item without an
  owner and issue.** The report is this note. Every "not ready" item has an owner (the
  project owner, §3 and §10), but **none has a GitHub issue**: the repository has no issues at
  all (`gh issue list --state all`: empty), and creating them is not this part's job. Each
  has a proposed title and body in §10. Ticked once the owner opens them.
- [x] **Security review complete; all findings fixed or documented with severity.** F1–F11
  in `status/21-security.md`, each with a severity; F1, F2, F3, F5, F11 fixed (F5 in [#72](https://github.com/egon-orm/egon-orm/pull/72));
  F4 documented (`SECURITY.md:40`, pinned by `secrets.itest.ts:210`); F6–F10 documented.
  New since: the Zod advisory (P1), which is a dependency finding, recorded here with its
  severity.
- [x] **Soak, fault-injection and runtime-matrix results recorded; zero connection
  leaks.** `status/21-robustness.md` §1–§3; my 2-minute soak passed with 0 backends after
  close and 0 checked out (§4.4); the fault-injection test passed in my `pnpm check`; the
  runtime jobs passed in CI. The 30-minute run is local only (the weekly workflow has not run
  on GitHub yet).
- [x] **Mutation score target met for the three core areas.** 93.04%, 83.46%, 88.14% (§4.3),
  taken from the notes, not re-run (a full run is not allowed in this part).
- [ ] **Type-health budgets met.** Not met: completions over 200 ms at about 140–170
  connected schemas (I measured 230–239 ms at 200, 189 ms at 150), and the first expression a
  program checks takes 53–55 ms, over the 50 ms budget. Instantiation counts are recorded. The
  owner accepted the completions gate as not met for `0.1.0` (2026-10-22), with the fix on the
  roadmap; the 50 ms miss is not accepted yet (P2, §10 item 3).
- [x] **Release dry run succeeds end to end from a clean clone.** I ran it from a fresh
  `git clone` of `origin` at `c2088d6` (§4.8): passed. CI's `release dry run` job passed too.
- [x] **API report committed and enforced in CI.** `api-report/`, nine entry points;
  `pnpm api:check` in `build+publint+attw` (§4.11). Caveat: without branch protection (O4) a
  red `ci` does not stop a merge.

## 6. Re-verified acceptance boxes, steps 01–20, 21a, 21b

Each box was checked against the code, tests, docs or CI at `c2088d6`; the status notes were
used only to find things. Boxes that join a budget or benchmark to something checkable are
split into (a) and (b), and only the benchmark half is "not run (step 19)". Step 19's boxes
and every box deferred to it are **not run** and do not count against readiness. My own runs
in §2 (`pnpm check`, the full integration suite on both tiers, `lint:packages`, `smoke`,
`docs:build`, `api:check`) back every box below that says "conformance green" or "CI".
CI references: run [40123401475](https://github.com/egon-orm/egon-orm/actions/runs/40123401475) (CI, `c2088d6`, success; only the informational
TypeScript-next job failed), [40086470578](https://github.com/egon-orm/egon-orm/actions/runs/40086470578) (CI, `5b48199`), [40123401469](https://github.com/egon-orm/egon-orm/actions/runs/40123401469) (Docs, `c2088d6`).

Verdicts:

| Step | verified | verified with caveat | false | unverified | not run (step 19) |
|---|---|---|---|---|---|
| 01 | 3 | 3 | 0 | 0 | 0 |
| 02 | 5 | 1 | 0 | 0 | 1 |
| 03 | 4 | 1 | 0 | 0 | 0 |
| 04 | 3 | 2 | 0 | 0 | 1 |
| 05 | 2 | 2 | 0 | 0 | 1 |
| 06 | 2 | 2 | 0 | 0 | 1 |
| 07 | 4 | 0 | 0 | 0 | 0 |
| 08 | 2 | 2 | 0 | 0 | 1 |
| 09 | 3 | 1 | 0 | 0 | 0 |
| 10 | 1 | 3 | 0 | 0 | 1 |
| 11 | 2 | 0 | 1 | 1 | 1 |
| 12 | 3 | 0 | 0 | 0 | 1 |
| 13 | 1 | 2 | 0 | 0 | 1 |
| 14 | 1 | 2 | 0 | 0 | 1 |
| 15 | 3 | 1 | 0 | 0 | 0 |
| 16 | 3 | 1 | 0 | 0 | 0 |
| 17 | 2 | 1 | 1 | 0 | 0 |
| 18 | 3 | 1 | 0 | 0 | 0 |
| 19 | 0 | 0 | 0 | 0 | 4 |
| 20 | 2 | 1 | 1 | 1 | 0 |
| 21a | 5 | 4 | 0 | 0 | 1 |
| 21b | 5 | 2 | 0 | 0 | 1 |
| **total** | **59** | **32** | **3** | **2** | **16** |

The three **false** boxes:

- **11.5** "No leaked connections … asserted in a global teardown": the global teardown
  (`packages/core/test/support/global-setup.ts:43-51`) only sweeps test databases. Leaks are
  checked per test (`afterEach`, `checkedOut(poolStats()) === 0`) in the adapter, read and
  transaction conformance suites and `postgres.itest.ts`, but not in the write, preload and
  nested suites. Fault injection and the soak cover the behaviour (§4.4), so this is a test
  gap (P10), not a known leak.
- **17.3** "CI jobs added and required": added, but nothing is required (O4).
- **20.5** "Site builds with zero warnings and deploys from `main`": it deploys, but the build
  prints Vite's chunk-size warning (my `docs:build` and Docs run [40123401469](https://github.com/egon-orm/egon-orm/actions/runs/40123401469)), and the deploy
  job prints a `punycode` DEP0040 deprecation warning (P9).

The two **unverified** boxes: **11.2** Postgres 14 (no CI job, compose or script runs it; the
status note's run was local) (P3); **20.4** the fresh-eyes test (no transcript in the
repository; it cannot be re-run within this part).

### Step 01: Foundation
| # | Box (short) | Verdict | How checked | Evidence |
|---|---|---|---|---|
| 1 | Fresh clone: `pnpm i && db:up && check && test:integration` passes | verified with caveat | CI is a fresh checkout. Its jobs run each part of `pnpm check` (as separate jobs) plus the integration suite. `pnpm check` passed in my run (§2). | `.github/workflows/ci.yml` jobs `lint`, `typecheck`, `unit+types (node 22/24)`, `build+publint+attw`, `integration` (runs `pnpm db:up`, then `pnpm test:integration`). Run [40086470578](https://github.com/egon-orm/egon-orm/actions/runs/40086470578) on 5b48199 is all green. `package.json` `check` script is lint && typecheck && test:unit && test:types && build. |
| 2 | Failing type test, unit test, lint error and coverage drop each fail CI (demonstrate once) | verified with caveat | Read the gating config. Re-checked the coverage gate live. The original demonstration was local, not by pushing failing commits to CI (step 01's removed status note, `git show 4a2a237:docs/plan/status/01.md`, "Failure demonstrations"). | `biome.json` rules `noDefaultExport`, `noNonNullAssertion`, `noExplicitAny`, `noTsIgnore` and `noConsole` (packages) are set to `error`. `pnpm lint` = `biome ci --error-on-warnings`. `vitest.config.ts` thresholds are 95% lines and branches for `packages/{core,postgres,cli,sqlite,mysql}/src/**`. My run of `src/internal/hash.test.ts` with coverage printed `ERROR: Coverage for lines (0.16%) does not meet "packages/core/src/**" threshold (95%)`. The `unit+types` job runs `test:unit` (with `--coverage`) and `test:types`. |
| 3 | `import { VERSION } from "egon-orm"` works from an ESM script and from a CommonJS `require()` script in `examples/smoke/` | verified | Read the scripts and CI. | `examples/smoke/esm.mjs:12,17` and `examples/smoke/require-esm.cjs:14,18`. `smoke` = `node esm.mjs && node require-esm.cjs && node consumer.mjs`. ci.yml `build+publint+attw` runs `pnpm smoke --node <22.12.0>`, and the job is green in run [40086470578](https://github.com/egon-orm/egon-orm/actions/runs/40086470578). |
| 4 | `docs/plan/spikes/schema-typing.ts` type-checked in CI | verified | Read the config. | `tsconfig.spikes.json` `files: ["docs/plan/spikes/schema-typing.ts"]`. `package.json` `typecheck` = `tsc -b && pnpm typecheck:spikes`, which also runs `scripts/check-rejected-spike.mjs`. ci.yml job `typecheck` (`pnpm typecheck`, comment at lines 339-341). |
| 5 | Two integration files run in parallel without interfering | verified | Read the test and the config. Not run by the reviewer; my integration run (§2) passed it. | `packages/core/test/support/parallel.itest.ts:90` "two integration test files run in parallel without interfering" starts project `core:parallel-pair` with `--maxWorkers=2` (line 67). `parallel-a.pair.ts` / `parallel-b.pair.ts` meet through `pg_stat_activity` (`parallel.ts:44`). `vitest.config.ts` integration project sets `fileParallelism: true`, and each file gets its own database (`test/support/db.ts`). |
| 6 | `pnpm bench` runs the example benchmark and writes a results file | verified with caveat | The box is about the harness, not results or budgets, so it is classified from CI. Read the CI job and the runner. | `.github/workflows/ci.yml:123-125`: `build+publint+attw` runs `pnpm bench` ("keeps the benchmark harness working"), green in run [40123401475](https://github.com/egon-orm/egon-orm/actions/runs/40123401475). `benchmarks/micro/_example.bench.ts`; `benchmarks/src/run.ts:109-112` writes `benchmarks/results/<sha>.json`. Caveat: CI does not assert the results file exists; that half rests on reading the runner. I did not run it (no benchmarks in this part). |

Findings
- low: Box 2 was shown locally once, at step 01, never by a failing CI run. The gates in today's config are real (biome rule levels, coverage thresholds that fire, separate `test:types` step), so the claim holds in substance.

### Step 02: Core contracts
| # | Box (short) | Verdict | How checked | Evidence |
|---|---|---|---|---|
| 1 | Contract files compile, are exported from an internal barrel, and have TSDoc | verified | A one-off script checked that every `export` declaration in the 7 contract files is preceded by a `/** */` block: 156 checked, 1 flagged. That one is a false positive: `changeset.ts:196` `ValidatorResult` has its TSDoc at :180, then a `biome-ignore` line. Compilation is covered by green `typecheck` CI. | `packages/core/src/contracts/index.ts` is the barrel and is marked internal. Files: adapter, changeset, query, result, schema, standard-schema, type `.ts`. |
| 2 | No Kysely type in `contracts/` | verified | grep, plus a test that enforces it. | `grep -ri kysely packages/core/src/contracts` hits only `contracts/contracts.test.ts:39` `expect(code).not.toMatch(/kysely/i)`. |
| 3 | ADR 0002 with benchmark numbers and a clear verdict; D12 updated if needed | verified | Read the ADR and plan README §2. | `docs/adr/0002-kysely-backend.md:3`: verdict "accept with raw-node escapes", now marked superseded by 0003. Numbers at :130-131 (e.g. lowering 2.31 µs, compile + slot recovery 3.32 µs). `docs/plan/README.md:65` D12 is rewritten to "own SQL emitter" and cites ADR 0003. |
| 4 | Spike code answers all five questions with runnable scripts | verified with caveat | I ran 4 of the 5 scripts against the Compose Postgres. All passed. | `docs/plan/spikes/kysely-bridge/01..05-*.ts`. Output: "Question 1: every statement lowered, compiled to the expected SQL, and ran.", "Question 2: parameter order is recovered exactly…", "Question 3: cached plans, transactions and savepoints all run through the driver API alone.", "Question 5: every feature tried is expressible…". `04-cost.ts` (benchmark, about 3 min) was not run; its committed results are `results/04-cost.json`. |
| 5 | Error classes have unit tests for `code`, message and `cause` | verified | Read the tests. | `packages/core/src/errors.test.ts`: `every error class > %o has its own stable name, code and identifier` (:107), `codes are unique…` (:114), `has no cause unless one is given` (:162), `keeps the cause it is given, by identity` (:169), `a cause chain survives several levels` (:195), and per-class message tests (e.g. `NoResultsError > says what was expected` :346). |
| 6a | `internal/` utilities at 100% coverage | verified | Ran the `src/internal` unit tests with coverage scoped to `src/internal/**`. | 8 files and 219 tests passed. Statements 310/310, branches 224/224, functions 40/40, lines 257/257 (100%). "9 files fully covered, 1 empty file skipped" (`own.ts`, type-only). |
| 6b | …with benchmarks recorded | not run (step 19) | Benchmark item. | `benchmarks/micro/internal.bench.ts` exists. |

Findings
- low: The spike still depends on `kysely`/`pg` as a private workspace package (`pnpm-workspace.yaml`, `tsconfig.json:21` reference), although ADR 0003 removed Kysely from the product. It is kept on purpose as evidence (spike README "Superseded"). Nothing in `packages/` imports it.

### Step 03: Types
| # | Box (short) | Verdict | How checked | Evidence |
|---|---|---|---|---|
| 1 | Every Public API type implemented and reachable through `t`; no public `types` export | verified | Read `t` and the public index/API report. | `packages/core/src/schema/field.ts:440-471`: string, integer, bigint (+ `mode: "number"`), float, decimal, boolean, uuid, binary, date (+ `as: "date"`), time, timestamp, localTimestamp, json, array, enum (list and mapping), type. `src/index.ts:342` exports only `defineType, parameterized`. `api-report/egon-orm.api.md` has no `types` export. |
| 2 | Cast table behaviour covered by tests exactly as specified | verified | Compared the accept/reject tables row by row with the spec. | `types/scalars.test.ts`: `integer` table (:110) rejects `1.5`, `"1.0"`, NaN, ±Infinity, beyond-safe values and bigint; `boolean` (:582) accepts true/false/"true"/"false"/"1"/"0"/1/0 only; `uuid` (:626) lower-cases. `types/temporal.test.ts`: `date` (:135) takes `{year,month,day}` and a Date's UTC part; `timestamp` (:350) rejects strings without an offset and keeps ms; `localTimestamp` (:471) rejects strings with an offset. `types/composite.test.ts`: `array > fails with the index of the first element that fails` (:239); `enum from a mapping > accepts a key or its stored value` (:498). Hostile inputs (null-prototype, `toString`, 1 MB strings, -0) in `OBJECTS`/`HUGE` (scalars.test.ts:19-74) and `all-types.test.ts` `HOSTILE`. |
| 3 | Property tests pass with at least 1,000 runs each | verified with caveat | Read `numRuns`. | `types/all-types.test.ts:27` `RUNS = { numRuns: 1000 }` applies to round-trip, cast-accepts-valid, idempotence, never-throws and reflexive equal, for every built-in (list checked at :393-417). Others use 5000 (`scalars.test.ts:378`, `temporal.test.ts:540,558,592`). Exception: `types/embed.test.ts:184` (fast-check default, 100) and `:299` (200). These are embed types from step 15, outside this step's builtins. |
| 4 | No `fromDb`/`toDb` wrapper where `IDENTITY` is correct (tests) | verified | Read the tests. | `all-types.test.ts:381` "fromDb and toDb are the IDENTITY function exactly when nothing is converted", per subject. Expectations at :132-177: string/integer/bigint/float/decimal/boolean/uuid/json/timestamp/arrays are identity; `bigint(number)` and mapped enums convert. Also `codec.test.ts:18` and `define.test.ts:11`. |
| 5 | Custom and parameterized types use the same public interface as builtins | verified | Read the implementation and tests. | Builtins `decimal`/`array`/`enum` are built with the public `parameterized` (`types/scalars.ts:387`, `types/composite.ts:154,273`). `t.type(defineType(...))` is tested in `schema/field.test.ts:80`. Money and `fixedString` subjects (custom and parameterized) run through the same property suite (`all-types.test.ts:175-177`). |

Findings
- low: Embed property tests in `src/types/embed.test.ts` run fewer than 1,000 times. They belong to step 15, but they sit in this step's directory.

### Step 04: Schema
| # | Box (short) | Verdict | How checked | Evidence |
|---|---|---|---|---|
| 1 | Public API implemented; blog schemas compile with no annotations on associations | verified | Read the exports and `blog.ts`. | `src/index.ts` exports Schema, EmbeddedSchema, t, timestamps, hasMany, hasOne, belongsTo, manyToMany, meta, isSchema, isRow, stateOf, primaryKeyOf, fieldNames, plus types Row/InsertShape/Loaded. `packages/core/test/support/blog.ts`: every `static x = hasOne/hasMany/belongsTo/manyToMany(...)` has no type annotation. Covered: has-through, manyToMany by table and by join schema, composite key, uuid key, enum, virtual, redact, embed. |
| 2 | `spikes/schema-typing.ts` assertions all reproduced as type tests on the real implementation | verified with caveat | Compared each spike assertion with the tests. | Schema half: `src/schema/schema.test-d.ts:117` `describe("assertions ported from spikes/schema-typing.ts")` covers Loaded fields/getters/assocs, `u.nope`, `Loaded<…,"name">` rejected, both-direction cycle and Target. `new User({...})` is inverted on purpose: now a compile error (decision D2). Query half (wrong value type, unknown binding, unknown assoc, assoc not a column, joinAssoc/select inference): `src/query/builder.test-d.ts:29-200` (`bindings > an unknown binding or field does not compile`, `:177 an unknown association… does not compile`). |
| 3 | Definition errors thrown with actionable messages (snapshot-tested) | verified with caveat | Counted inline snapshots, then cross-checked each `schema.*` identifier in source against the tests (one-off script). | `schema/schema.test.ts` (30), `assoc.test.ts` (40) and `field.test.ts` (18) inline snapshots, e.g. `schema.test.ts:514` `schema.memberShadowsField`. 24 of 101 `schema.*` identifiers have no snapshot, and they are tested by message regex instead. Most are type-definition errors (`types/composite.test.ts:572` "enum definitions that are rejected"; decimal/bigint/date options). Others: `assoc.test.ts:666` `joinThroughEmpty` and `:782` `joinWhereFieldMissing`. |
| 4a | Row factory meets the hydration budget | not run (step 19) | Budget item. | `benchmarks/micro/schema.bench.ts` exists. |
| 4b | Both codegen and fallback paths covered | verified | Read the tests and code. | `schema/schema.ts:331` `loopConstructor`; codegen at :320-329 through `internal/codegen.ts` (an EvalError means fall back). Tests: `schema.test.ts:508` loops `codegen` over `[true, false]`; :595-602 Generated vs Looped rows compared; :638 "where code cannot be generated, schemas fall back to the loop". `schema/monomorphism.test.ts` uses `%HaveSameMap` and also covers `codegen: false` (:69). |
| 5 | No per-row closures, `defineProperty`, or `Proxy` | verified | grep plus reading the factory. | `grep Proxy|defineProperty|delete` in `src/schema/*.ts` (not tests) finds only `schema.ts:512,636` `Object.defineProperty(…, META, …)`, which runs once per class, not per row. `meta.create` (`schema.ts:440`) is `new Plain(values, NOTHING_LOADED, row)`, with no allocation per row besides the row itself. |

Findings
- low: The snapshot claim is partial. About a quarter of the definition-error identifiers (mostly type options, which are step 03 errors raised through `t`) are tested by message regex, not by snapshot. The messages are still asserted, so nothing is untested.

### Step 05: Changeset
| # | Box (short) | Verdict | How checked | Evidence |
|---|---|---|---|---|
| 1 | Every Public API function implemented, with the reference default messages, `{count}` placeholders and camelCase meta keys | verified | Checked each listed method in `changeset.ts` and read the message tables. | Methods: putChange :541, forceChange :555, updateChange :609, fetchField :745, fetchChange :768, isChanged :789, validateInclusion :935, validateExclusion :953, validateSubset :997, validateConfirmation :1174, validateChange :1241, optimisticLock :1749, and the rest (grep). Exports cast/change/applyAction/traverseErrors at :2220/:2354/:2426/:2147 and `src/index.ts:59-64`. Messages: `changeset.ts:1925-1949` (`should be at least {count} character(s)`, `should have {count} item(s)`, `must be not equal to {number}`); constraint messages at :1527-1657. Meta asserted in `validations.test.ts:299,404,423` (`{ count, kind: "min", type: "string" }`, `{ kind: "lessThan", number }`). |
| 2 | Reference test cases pass (sections listed in status note) | verified with caveat | Read the test files. Did not run them (part of `pnpm check`). | The owner's rule forbids copied tests, so the cases are written in our own words, one describe per method: `cast.test.ts`, `change.test.ts`, `validations.test.ts`, `constraints.test.ts`, `errors.test.ts` (use cases), `property.test.ts`. `docs/plan/status/05.md:36-51` lists the areas, not "ported sections". The box wording is out of date, not the work. |
| 3 | Structural sharing verified (`cs2.changes === cs1.changes`) | verified | Read the tests. | `changeset/sharing.test.ts:26` `structural sharing > a passing validation shares changes, errors, data, params and every list`: 8 validations, `expect(cs2.changes).toBe(cs1.changes)` and the same for errors/data/params/constraints/filters/prepare. Also `:79` valid is stored, `:85` same own keys. |
| 4 | Budget met | not run (step 19) | Budget item. | `benchmarks/micro/changeset.bench.ts` exists. |
| 5 | No database or adapter import in this module | verified with caveat | grep over all non-test `.ts` under `src/changeset/**` (recursive), plus the test. | No import matches adapter/repo/compiler/query/batch, the package index, or any bare specifier (all imports are contracts/, schema/, types/, internal/, errors). `sharing.test.ts:101` "nothing in the changeset module imports the database, the adapter or the repo" scans only the top-level directory (`readdirSync`, not recursive), so `nested/` and `validators/` are not policed by the test. They are clean today by my grep. |

Findings
- low: The module-boundary test (`src/changeset/sharing.test.ts:101-111`) does not recurse into `nested/` (step 15) or `validators/` (step 06). A future import there would not be caught.
- low: The box 2 wording ("ported … test cases") conflicts with the owner's rule against copied tests. The status note lists behaviour areas instead, which is the right outcome.

### Step 06: changeset validators

| # | Box (short) | Verdict | How checked | Evidence |
|---|---|---|---|---|
| 1 | Verbatim examples compile and pass as tests | verified with caveat | Read the test file, compared it with the spec's examples, and ran it | `packages/zod/test/examples.test.ts` > "the step's examples": Zod, cross-field Zod, plain function, async and toZod are verbatim and pass. The Yup example `cs.validate(yup.object(...))` throws `query.validatorPromise`, because Yup's Standard Schema is async. The test asserts that throw and then runs the same schema with `validateAsync`. |
| 2 | Core has no runtime or type dependency on Zod | verified | Read the guard test; grepped core sources; read core's `package.json` | `packages/core/src/changeset/validators/no-dependency.test.ts`: two tests (no import of zod/valibot/arktype/yup/@standard-schema in any core source file; no such package in any dependency field). Core `package.json` has only `devDependencies` (pg, mysql2, better-sqlite3 and their types). `StandardSchemaV1` is vendored. |
| 3 | Compatibility matrix green for 4 libraries (or a Yup adapter documented) | verified | Read the scenarios and the per-library files; ran them | `packages/zod/test/compat/scenarios.ts` `runScenarios` has 6 scenarios, called from `zod`, `valibot`, `arktype` and `yup.test.ts` (Yup with `asyncOnly`, plus "Yup: the synchronous function adapter"). The adapter is documented in `docs/site/guide/validation.md:164-175`. All pass. |
| 4 | `toZod` types equal schema-derived types in all three modes | verified with caveat | Read the type tests | `packages/zod/src/index.test-d.ts`: "toZod: row mode" checks against `FieldValues<S>`, which is `Omit<Row<S>,"~fields">` (getters left out), not `Row<S>` itself. "insert mode" checks against `InsertShape<S>` for Account, User and Post. "update mode" checks against `Partial<FieldValues<S>>`. There are also pick/omit and the `StandardSchemaV1` assignability test that the spec asked for. |
| 5 | Overhead targets met | not run (step 19) | — | Benchmarks deferred (CLAUDE.md). |

Findings
- (low) Row mode is typed against `FieldValues<S>`, not literally `Row<S>`. It differs only in leaving out getters and methods, which is the correct shape for a validator. Evidence: `packages/zod/src/index.test-d.ts:46-60`.
- (low) The spec's Yup example cannot run with sync `validate`. The spec allows for this ("otherwise the documented adapter"), and the guide explains it.
- (low, cosmetic) The validator's promise error has the id `query.validatorPromise`, although it is a changeset error. Evidence: `packages/zod/test/compat/scenarios.ts:167`.

### Step 07: query expressions

| # | Box (short) | Verdict | How checked | Evidence |
|---|---|---|---|---|
| 1 | Full operator table implemented and typed; rejected cases fail to compile | verified | Grepped every method of the spec's table and every free function for a definition and a type-test use | All of eq…isDistinctFrom, and/or/not, like…upper, add…neg, contains…remove, path/pathText, cast/as, asc/desc/nullsFirst/nullsLast are defined in `packages/core/src/query/expr.ts` (e.g. `neq` :643, `between` :729, `remove` :1201). filter/over are on `Aggregate` in `functions.ts:234,250`. All free functions are exported from `functions.ts` and `index.ts`. `expr.test-d.ts` has 91 `@ts-expect-error` lines. |
| 2 | Every value ends up in param/list nodes; nothing concatenates a user value into SQL text | verified | Read every string field of the AST node interfaces and the constructors that fill them, then ran the property test | String fields hold only schema metadata, table-checked names, fragment `strings` and `ident` names. A fragment's `strings` are accepted only from a frozen template array with a matching `raw` (`functions.ts:988-994`). `identNode` checks names against `IDENTIFIER` (`ast.ts:394`). `lit` takes only null, a boolean or a finite number (`ast.ts:274-288`). JSON path keys are `ExprNode[]`, so they are bound. `query/property.test.ts` > "no value supplied by the caller reaches a string of the tree (decision D9)" and "the generators reach the values they claim to" both pass. |
| 3 | Shape hash property test passes with 5,000 runs | verified | Read the test and ran it | `packages/core/src/query/property.test.ts:518` `RUNS = 5_000`: "the shape is invariant under changing bound values", "the shape changes with any structural change", "cached params, lists and shape agree with walking the node". All pass. No global fast-check override outside mutation runs (`test/support/mutation-seed.ts` only sets a seed). |
| 4 | AST node set documented in `ast.ts`, stable for 08–10 | verified | Read the module doc and the `ExprNode` union | `query/ast.ts:11-38` has a table of all 21 expression node kinds plus order and window, with the SQL each stands for. The `ExprNode` union in `contracts/query.ts:540-561` matches the spec's list. Each constructor has a TSDoc line giving its SQL. |

Findings: none.

### Step 08: query builder

| # | Box (short) | Verdict | How checked | Evidence |
|---|---|---|---|---|
| 1 | All listed methods implemented and typed; type tests cover each | verified | For each method, grepped its definition in `builder.ts` and its use in `builder.test-d.ts` | All 23 chain methods plus `from` (`builder.ts:2987`) and `hasNamedBinding` (:3070) are defined, and each is used in `builder.test-d.ts` (e.g. joinAssoc 18 uses, crossJoin 2, pipe 3, reverseOrder 1, schema 1). `QueryWith` composition is tested at `builder.test-d.ts:351`, and "hasNamedBinding narrows" at :385. |
| 2a | Build budget met | not run (step 19) | — | Deferred. |
| 2b | Binding objects provably cached (identity test) | verified | Read the tests | `builder.test.ts` > "bindings" > "are built once per schema and alias" (`toBe` across two queries and against `bindingOf`). There is also "the bindings object is shared by the callbacks of a query and of the queries built from it". |
| 3 | No mutation of Query/AST after construction (deep-frozen ASTs) | verified with caveat | Read the `deepFreeze`/`frozen` helpers and the immutability tests | `builder.test.ts` > "immutability" > "every method leaves the query it is called on unchanged…": it deep-freezes the AST (skipping meta/type), freezes the Query, runs 19 derivations, then compares a JSON snapshot and checks structural sharing. There is no library "dev mode": the freeze lives only in the tests. Not every method is in the frozen set: rightJoin, fullJoin, crossJoin, selectMerge, pipe, distinct-on, lock(fragment), and the step 09 methods (set, returning, set operations, windows, withCte) are missing. |
| 4 | Every error message names the clause and the offending binding/field | verified with caveat | Read every `new QueryError` in `builder.ts`/`select.ts` | Errors raised by the builder start with `${clause}()` and name the alias or key where one applies (e.g. `builder.ts:1474,1480,1582,3136`). Expression errors raised inside a callback are re-raised with the clause in front, but the expression layer's text names the operator, not the field: `expr.ts:1592` gives `eq() was given null.`. The step's status note lists this under Known gaps. |

Findings
- (low) The immutability test does not cover every builder method (list in row 3). A mutation in those methods would not be caught by the frozen test. Evidence: `packages/core/src/query/builder.test.ts:1167-1210`.
- (low) Expression errors inside clauses do not name the field (`expr.ts:1590-1594`), so box 4 does not hold literally for them.

### Step 09: query advanced

| # | Box (short) | Verdict | How checked | Evidence |
|---|---|---|---|---|
| 1 | Each feature has type tests, SQL snapshots, one integration test and a docs section | verified | Mapped the 8 built features (lateral, VALUES and similar sources are deferred by the owner) to describes, snapshot names, itests and guide headings | Type tests: `query/advanced/advanced.test-d.ts` describes for subquery/cte sources, set operations, windows, set and returning, dynamic, and "prepare, tuple, selectedAs". Snapshots: 34 Postgres entries in `compiler/advanced/advanced-cases.ts`, checked by `advanced.sql.test.ts` > "step 09 statements on $name". Itests: `advanced.itest.ts` runs every matrix statement, plus top-N with window, recursive tree, keyset, not exists, bulk publish with returning, set operations, scalar subquery, prepared query, dynamic filters. Docs: `docs/site/guide/queries-advanced.md` has a section per feature, "Other tools" for selectedAs/tuple, and Recipes. |
| 2 | Inner-query params and named params merge correctly (params on both sides, plan reuse across values) | verified | Read the itest and the snapshot | `advanced.itest.ts:312` "named parameters on both sides of a subquery bind, and the plan is reused for other values": two value sets, then asserts exactly 1 miss and at least 1 hit. Snapshot "named parameters inside and outside a subquery" has params `[1, 100]`. `advanced.sql.test.ts` > "the builder keeps every built query's derived properties canonical" and "the whole matrix compiled twice … never collides". |
| 3 | No feature bypasses parameter binding | verified | Read the snapshots (every value is `$n`, including `ntile($1)` and `lead(…, $2)`); checked the injection and identifier properties that cover CTE names, window names and selected names | `compiler/property.test.ts` > "identifiers on $name: a name from the AST is always quoted", "names that are looked up in a table are refused…" (window names, `fragment.ident`), "injection on $name…" (passed in my run). A window frame is a `fragment`, whose static text is the documented raw-SQL path. |
| 4 | Every gap-list construct this step owns is emitted natively, named windows as a real WINDOW clause, each with a snapshot | verified with caveat | Compared `docs/plan/spikes/kysely-bridge/05-gaps.ts` features with the Postgres snapshots | Snapshots exist for: named window (`… window "byAuthor" as (partition by …)`, "a named window, an inline window and a frame"), OVER/PARTITION BY, frame (`rows between …`), PARTITION BY an expression, tuple comparison (`("p"."created_at","p"."id") < ($1,$2)`), EXISTS/IN/scalar subquery, NOT MATERIALIZED, WITH RECURSIVE, EXCEPT with order/limit, UPDATE … FROM, DELETE … USING … RETURNING. The recursive CTE has no `name(columns)` list, unlike the gap case; the columns come from select aliases, which is equivalent. Lateral, VALUES and TABLESAMPLE are deferred by the owner. |

Findings
- (low) The spec says `prepare` pins the plan and skips the cache lookup. In the code, only `repo.updateAll`/`deleteAll` use the pinned plan (`repo/bulk.ts:762-765`). The read paths call `adapter.compile`, which is an L1 identity lookup (`repo/read.ts:543,1099,1222,1270`). The guide says the same ("skipping that lookup as well is planned", `queries-advanced.md` "Prepared queries"), so the docs are accurate. This was recorded as a sign-off decision in the status note. It is not an acceptance box.
- (low) The recursive CTE is emitted without a column list (see row 4).

### Step 10: SQL compiler

| # | Box (short) | Verdict | How checked | Evidence |
|---|---|---|---|---|
| 1 | Every step 07 AST node kind is emitted, with a snapshot and an execution test | verified with caveat | Grepped `sql-cases.ts` for each of the 21 expression kinds plus order and window (each appears); read `sql.itest.ts` | `compiler/sql.itest.ts:49-51` runs every case of `ALL_CASES` on Postgres in a rolled-back transaction. `registry.test.ts` > "the list above names every kind of the contract" checks the kind list against the contract type. No test asserts mechanically that every kind has a case: coverage is by construction of the matrices, which I spot-checked by grep (ident 6, star/count() 7, tuple 4, selectedAs 3, jsonPath 3, exists 7). |
| 2 | Budgets: L1 hit < 0.3 µs, cold < 40 µs | not run (step 19) | — | Deferred; `benchmarks/micro/compiler.bench.ts` not delivered. |
| 3 | Zero collisions across the test suite; forced-collision test passes | verified with caveat | Read the cache tests and grepped the collision assertions | `compiler/cache.test.ts` > "hash collisions" > "a forced collision is caught by the structural check and never serves a wrong plan" (collisions 1, then 2, correct plans). There are 30 assertions of `collisions` = 0 (shared-compiler matrices, `sql.itest.ts:115`, `advanced.sql.test.ts`). There is no suite-wide hook, so "whole suite" means every place where a cache is shared, not every compiler ever created. |
| 4 | Injection property test passes with 10,000 runs | verified | Read the test and ran it | `compiler/property.test.ts:128-148` "arbitrary strings in every value position are bound, never written (10,000 runs by default)", for each dialect, 18 value positions. `EGON_PROPERTY_RUNS` replaces the count, so it could also lower it (`runs()` :113-115 returns the override); it is not set in `.github/workflows/ci.yml` or `package.json`, so CI runs the default 10,000. Passed in my run. |
| 5 | Core has no runtime dependency; ADR 0003 rules hold; a test asserts no AST string reaches `sql` except via quote or table lookup | verified with caveat | Read `package.json` and the non-relative imports of core sources; read the identifier and lookup properties | Core has no `dependencies`/`peerDependencies`/`optionalDependencies`. The non-relative runtime imports in `src` are Node built-ins only: `node:async_hooks`, obtained through `process.getBuiltinModule` (`repo/transaction.ts:793`), and `node:fs/promises`, `node:path` and `node:url`, imported dynamically when a migrations directory is loaded (`migration/loader.ts:195-199`). No third-party package. Tests: `property.test.ts` > "identifiers on $name: a name from the AST is always quoted" (table, alias, schema, column, CTE, values columns, source keys, selected name, update target, write schema) and "names that are looked up in a table are refused when they are not in it" (operators, unary/nary, fn, aggregate, lock clause, join type, direction, nulls, set op, ident, window name). This works by listing positions; it is not a mechanical walk of every string field, so a new string field would need a new position. |

Findings
- (low) The "every AST string field" guarantee (box 5) and the "every node kind has a case" guarantee (box 1) rest on hand-maintained lists of positions and cases, not on a check derived from the contract types. They hold today, but a new node field could slip past.
- (low) "Zero collisions across the whole test suite" is asserted per shared compiler, not globally (box 3). The status note says so honestly.

No status-note claim checked here turned out false. Counts only grew: the status note for 07 says 73 `@ts-expect-error` lines, and `expr.test-d.ts` now has 91.

### Step 11: Adapter and the Postgres package
| # | Box (short) | Verdict | How checked | Evidence |
|---|---|---|---|---|
| 1 | Adapter contract implemented; no driver type in core's public signatures; core has no runtime dep | verified | package.json, api-report, implementation | `packages/core/package.json` has no `dependencies`/`peerDependencies`; `api-report/egon-orm.api.md` has no `import` lines (no `pg`); `SharedAdapter implements DatabaseAdapter` at `packages/core/src/adapter/adapter.ts:553`; the `compile*` methods now go to the step-10 compiler (`adapter/compiler.ts:38-47`, `adapter.ts:600-638`). `pg` types show up only in `api-report/egon-orm-postgres.api.md:8,23,26` |
| 2 | Conformance suite passes on Postgres 14 and 16 | unverified | CI config, compose, grep | 16: CI `integration` job, `docker-compose.yml:15` `postgres:16-alpine`. 14: no workflow, compose service or script runs it. The only evidence is the status note (`status/11.md:79-86`, which says "locally only"). Docs still say "Postgres 14 and later are supported" (`docs/site/guide/adapters.md:35`, `getting-started.md:51`) |
| 3 | Execution overhead target met; numbers in status note | not run (step 19) | — | deferred (CLAUDE.md, plan README §7) |
| 4 | Every normalised error keeps `cause` and carries constraint/table | verified | code + tests | `packages/postgres/src/errors.ts:128-198`: every branch passes `cause: error`, and `ConstraintError` gets constraint/table/column/detail; conformance `adapter conformance > error normalisation > a %s violation is a ConstraintError naming the constraint, keeping the driver error` (`test/conformance/adapter/index.ts:229-252`) checks constraint, table, column, sql and a non-Egon `cause` for each of the 5 kinds |
| 5 | No leaked connections after the whole integration suite (global teardown) | false (as worded) | vitest config, global setup, suites | `packages/core/test/support/global-setup.ts` teardown only drops test databases; it never looks at pools. The check is per test instead (`afterEach` with `checkedOut(poolStats()) === 0`): adapter conformance `index.ts:77-83`, read `read/index.ts:314-319`, transaction `transaction/index.ts:157-162`, `postgres.itest.ts:38-43`. Write, preload and nested conformance only `close()` (`write/index.ts:179-182`, `preload/index.ts:166-168`) |

Findings
- (medium) Postgres 14 is advertised as supported in the guides (`adapters.md:35`, `getting-started.md:51`, `tutorial.md:62`, `CHANGELOG.md:17`), but CI never runs it. The status note's own Requests ask for a PG14 CI run (`status/11.md:352`), and that has not been done.
- (low) Box 5 is done with a different mechanism from the one the box names (per-test, documented as a deviation in `status/11.md`), and only some suites have it. In the write/preload/nested suites a leak would only show up if `close()` waits on a checked-out connection and the test then times out; no assertion catches it.
- (low) `DriverWrapper`/`DriverConnection` are not exported by name, but they reach the public `.d.ts` through `AdapterDefinition.driver` (api-extractor reports `ae-forgotten-export` at `api-report/egon-orm.api.md:42`). These are driver-neutral types of our own, so the box still holds.

### Step 12: Repo reads and hydration
| # | Box (short) | Verdict | How checked | Evidence |
|---|---|---|---|---|
| 1 | All methods implemented and typed; conformance green on Postgres | verified | Repo interface, type tests, suite contents | `packages/core/src/repo/repo.ts:265-999` declares all, one, oneOrThrow, first, firstOrThrow, get(OrThrow), getBy(OrThrow), exists, count, aggregate, stream, reload(OrThrow), toSql, explain, raw, on, ping, poolStats, close; types in `repo/repo.test-d.ts`; `test/conformance/read/index.ts` has describes for each (all, select shapes, joins, one/first 0/1/many, get/getBy, exists/count/aggregate, stream, reload, database schemas, telemetry, cancellation, toSql/explain/raw, concurrency, codegen off), run by `packages/postgres/test/read-conformance.itest.ts` in CI `integration` |
| 2 | Hydration and end-to-end budgets met | not run (step 19) | — | deferred |
| 3 | Codegen and fallback both at full coverage and proven equivalent | verified | ran coverage + read tests | My run: `hydrate.ts` 100% lines/branches/functions; `hydrate.test.ts > generated and interpreted decoders are equivalent > on random plans and rows` (fast-check, line 757) plus per-shape `test.for(["generated","interpreted"])`; integration `read conformance > codegen off > rows are the same without generated decoders` (`read/index.ts:1626`) |
| 4 | `repo.raw` cannot take a plain string (compile error and runtime guard) | verified | code + type + unit tests | Signature `raw<X extends Expr<…>>` (`repo.ts:601`); runtime `isFragment` guard throws `QueryError` (`repo.ts:1297-1302`); `repo.test-d.ts:223-228` `raw > takes a fragment, never a string` (`@ts-expect-error`); `repo.test.ts:1125` `raw refuses anything but a fragment` (string, a non-fragment expression, null; no statement sent) |

Findings
- (low) The CI-wide threshold is 95% per package (`vitest.config.ts:220-227`), not 100%, so nothing in CI enforces "full coverage" of `hydrate.ts`. It is 100% today by my run only.

### Step 13: Repo writes
| # | Box (short) | Verdict | How checked | Evidence |
|---|---|---|---|---|
| 1 | All functions implemented; conformance green on Postgres | verified | Repo interface, suite | insert/update/delete/insertOrUpdate (+ OrThrow), insertAll/updateAll/deleteAll at `repo.ts:624-843`; `validateUniqueAsync` at `changeset/changeset.ts:1829`; `placeholders` in `repo/bulk.ts:110`; the "nested changes are not supported yet" stub is gone. `test/conformance/write/index.ts` describes insert, update, delete, insertOrUpdate, telemetry, constraints, onConflict, insertAll, updateAll, deleteAll, validateUniqueAsync, run by `packages/postgres/test/write-conformance.itest.ts` |
| 2 | Invalid changesets and no-op updates issue zero queries (asserted via telemetry) | verified with caveat | code + tests | `write.ts:1286` returns before prepare/SQL for an invalid changeset; `write.ts:1299` `withoutLoneLockBump` (the lock no-op follow-up). Telemetry: conformance `write > insert > an invalid changeset and a missing required field send nothing` (`events` empty, `:232`), `update > with no change it sends nothing and returns the row` (`:344`), `an unchanged save with an optimistic lock sends nothing and keeps the version` (`:423`); unit `write.test.ts:190,564` assert `events` and `statements`. An invalid update/delete is asserted with the fake driver's `statements` (`write.test.ts:864,1320`), not with telemetry |
| 3 | Unhandled constraint errors give the actionable message (snapshot) | verified with caveat | tests + code | Exact full-text expectations instead of a snapshot file: conformance `constraints > an undeclared unique constraint throws with the call to add` (`write/index.ts:605-619`) matches the spec's three lines word for word (message prefixed with code `constraint.undeclared:`); likewise foreignKey `:692`, noAssoc `:713`, check `:732`, exclusion `:753`; unit `constraints.test.ts > the message of an unhandled violation` |
| 4 | Budgets met | not run (step 19) | — | deferred |

Findings
- (low) The follow-up `status/13-followup-lock-noop.md` checks out: `update()` calls `withoutLoneLockBump` unless `force` (`write.ts:1299`), and `force` keeps the bump; the tests it lists exist (`write.test.ts:659,672,683,722`; conformance `:423,:442`).

### Step 14: Associations and preload
| # | Box (short) | Verdict | How checked | Evidence |
|---|---|---|---|---|
| 1 | All API forms work and are typed; conformance green on Postgres | verified with caveat | suite, type tests, exports | Conformance `test/conformance/preload/index.ts`: each kind (183-425), composite keys, nesting/siblings/maxConcurrency, callbacks (filter, per-parent limit/offset, missing order error, select with and without the key), join preloads incl. nested, repo.preload (force, null/empty, callback), assoc/isLoaded, transactions, chunking (`:1027`); types `repo/preload.test-d.ts` (depth 3, callback/selected shape, cumulative, isLoaded, assoc, belongsTo nullability); `assoc`/`isLoaded` exported at `index.ts:231`. Caveat: form 4 is `repo.preload(User, users, "posts")` (class first), not the spec's `repo.preload(users, "posts")`; owner accepted this as decision 6 (`status/14.md:203`) |
| 2 | Query counts prove 1 + levels in every case | verified with caveat | per-test scan for event-count assertions | `watched()` records `query` events, "the N+1 guard of every case" (`preload/index.ts:150-161`); my scan finds count/`events` assertions in every loading test except `a repo without generated code loads the same rows` (:779), `assoc() is a query…` (:909), `isLoaded…` (:939), `reload loads a level that was loaded empty…` (:1115), `a row an update returned reloads…` (:1132). The rest without counts are refusal tests (`events` empty, or a build-time throw) |
| 3 | Row shapes monomorphic per (schema, preload set) | verified | test read and run | `repo/preload.test.ts > row shapes > one hidden class per schema and set of preloads, however the rows were loaded` (`:1157`): V8 `%HaveSameMap` over query preloads in two orders, repo.preload, mixed and reload, codegen on and off; another preload set is a different map; same pattern as `schema/monomorphism.test.ts`. Passed in my run |
| 4 | Budget met | not run (step 19) | — | deferred |

Findings
- (low) Five loading cases in the preload conformance suite have no query-count assertion (listed above), so "every case" is not literally true. The main cases (each kind, nesting, siblings, callbacks, join preloads, chunking) do have one.

### Step 15: Nested changesets and embeds
| # | Box (short) | Verdict | How checked | Evidence |
|---|---|---|---|---|
| 1 | All matching/replacement combinations behave as the reference documents; table-driven tests | verified with caveat | read tests, ran them | Table at `changeset/nested/nested.test.ts:192-264` (`castAssoc on a to-many association > … (onReplace …)`): id match→update, id cast by key type, no id→insert, unknown id→insert, left out→delete (delete/deleteIfExists), setNull→update with fk null. Error, invalid, duplicate id, new parent and to-one each have separate tests (`:272,:277,:284,:342,:404-465`). Behaviour matches the reference's documented rules where I checked. Caveat: the table is sparse. It is not the full id present/absent/unknown/duplicate × existing/none × every `onReplace` product the step's Tests section asks for |
| 2 | Failed nested writes are atomic (verified against the DB) | verified | read conformance | `nested conformance > atomicity > a child that fails a declared constraint rolls everything back…` counts `orders`/`line_items` = 0 (`nested/index.ts:566-589`); `an undeclared violation is thrown and nothing is left behind` (:591); `inside a transaction a failed nested write undoes only itself` (:600); `review round 1 > a child failing two levels down rolls everything back` (:703) |
| 3 | Nested validator issue routing completed (closes step 06 item 4) | verified | read tests, ran them | `nested.test.ts > nested errors and validators > issues of a validator whose path leads into a child land on that child` (:701; index and string-index paths, out-of-range goes to `$base`), `routing … reaches embeds and nested embeds` (:737), plus the dropped-issue cases (:775,:801) |
| 4 | Embed round-trip property test passes; embedded rows are instances of their class | verified | ran test | `types/embed.test.ts > a round trip through JSON gives back equal rows, nested embeds and dates included` (:256, fast-check 200 runs, `toBeInstanceOf(Sample)`/`Pin`) passed; conformance `embeds > … read back as instances of their classes` (`nested/index.ts:772`) |

Findings
- (low) The embed property test pins several fields to constants (`day`, `dayAsDate: null`, `stamps: null`, `amount` set), so those types are not explored at random.
- (low) Box 1's table-driven coverage is partial (see row). The other combinations are covered, but by hand-written tests rather than the table.

### Step 16: Transactions, Batch, sandbox

| # | Box (short) | Verdict | How checked | Evidence |
|---|---|---|---|---|
| 1 | Statement sequences for all paths; no connection leak | verified | Read the unit tests. A scripted fake pool logs every statement and counts acquired/released/destroyed. Each outcome asserts the exact log and the pool counters. | `packages/core/src/repo/transaction.test.ts`: `statement sequences` (l.185), `when a transaction statement fails` (l.292: BEGIN/COMMIT/ROLLBACK/SAVEPOINT/RELEASE/ROLLBACK TO failures), `nested transactions`, `timeoutMs on a transaction`, `retries`, `checkout`, `the sandbox`, `running a batch`. Example: l.196 `expect([pool.acquired, pool.released, pool.destroyed]).toEqual([1, 1, 0])`. The integration side checks pool stats in `core/test/conformance/transaction/index.ts`. |
| 2 | Batch result/error types fully inferred, no annotations | verified | Read the type tests. Results, function-step arguments and the failure union are all inferred and checked with `expectTypeOf`. The only declared values are inputs (`declare const userChangeset`, `repo`), not result annotations. | `packages/core/src/batch/batch.test-d.ts`: `results accumulate > five different steps…` (l.20), `failures > are a union over the steps that can fail, narrowed by step` (l.107), `what does not compile > a step name already used` (l.162). |
| 3 | Sandbox adopted by core integration suites; before/after timings in status note | verified with caveat | Grepped the conformance suites for `createSandbox` / `truncateAll`. Read the status note's timing section. | The write suite uses the sandbox: `core/test/conformance/write/index.ts:43,136-141`. The nested suite still truncates before each test: `core/test/conformance/nested/index.ts:261-263`. Read/preload seed once and do not need it. The transaction suite truncates by design. Timings are in `docs/plan/status/16.md:382-388`: 2.55-2.62 s before, 3.00-3.50 s after, so the sandbox made the suite slower. |
| 4 | Conformance suite green on Postgres | verified | CI log of run [40123401475](https://github.com/egon-orm/egon-orm/actions/runs/40123401475), job `integration (tier 2)`. | `postgres:integration test/transaction-conformance.itest.ts (48 tests)`, 0 skipped. |

Findings
- (low) "Adopted by the core integration suites" holds for one suite only, the write suite. The nested-changeset conformance suite (step 15) still empties tables with `truncateAll` before each test (`core/test/conformance/nested/index.ts:263`). The spec's goal of a speed-up was not met (the status note says so honestly).

### Step 17: Dialects (SQLite, MySQL)

| # | Box (short) | Verdict | How checked | Evidence |
|---|---|---|---|---|
| 1 | Conformance green on SQLite and MySQL 8; skips equal documented gaps | verified with caveat | CI tier-2 log for pass/skip counts. Grepped every `skip(` in `core/test/conformance/*/index.ts`. | CI [40123401475](https://github.com/egon-orm/egon-orm/actions/runs/40123401475) `integration (tier 2)`: all sqlite:/mysql: conformance files pass. SQLite skips: adapter 16, read 6, write 5, migration 1, transaction 10. MySQL skips: adapter 4, read 5, write 4, migration 2, transaction 1. Most skips are gated on `capabilities.X` or on migration-table features, which `docs/site/reference/dialect-support.md` lists. A few are profile-gated rather than capability-gated (`read/index.ts:1349` "no microsecond timestamps", `:1377` "no binary column", `transaction/index.ts:575` "no safe way to make a COMMIT wait"). |
| 2 | Unsupported feature: compile-time `QueryError` naming feature and dialect | verified | Read the test. Every boolean capability is either in `COMPILE_TIME` with a probe or in `BEHAVIOUR`, and a test enforces that partition. For each dialect where a flag is false, the probe must throw `QueryError` matching `\b<dialect>\b`. `run()` rethrows non-QueryError errors. | `packages/core/src/compiler/capabilities.test.ts:113` (`every capability is in exactly one list`), `:125` (`$name > <flag>: a statement that needs it is refused, naming the dialect`). `unsupported()` is at `compiler/dialect.ts:793`. |
| 3 | Support matrix generated and published; CI jobs added and required | **false** | Read `package.json` lint and `ci.yml`. Queried the GitHub branch protection and ruleset APIs. | Matrix: generated by `scripts/dialect-support.ts`, staleness checked by `--check` in `pnpm lint`, published in `docs/site/reference/dialect-support.md`. Jobs: `integration` (SQLite) and `integration (tier 2)` (MySQL), both under the aggregate `ci` job (`ci.yml:271-280`). **Not required**: `gh api …/branches/main/protection` returns 404 "Branch not protected". The only ruleset, `main-protection` (id 25116048), has `ref_name.include: []`, so it targets no branch, and its only rules are `deletion` and `non_fast_forward`. `gh api …/rules/branches/main` returns `[]`. No status check is required. |
| 4 | No dialect-name conditionals outside adapter/, compiler/, dialect packages | verified | Ran the check. Grepped `core/src`, `cli/src` and `zod/src` for `.dialect` and quoted dialect names. Other dialect differences there are table-driven (`ctx.dialect.features.*`). | `scripts/check-dialect-conditionals.mjs` runs in `pnpm lint` and has a unit test (`check-dialect-conditionals.test.mjs`). It prints "ok: no dialect-name conditionals…". It also covers `core/test/conformance`. |

Findings
- (medium) The status note claim "Both are required through `ci`" (`docs/plan/status/17.md:101-102`) is false on GitHub. The `ci` aggregate job exists, but no branch protection or effective ruleset requires it on `main`. The ruleset `main-protection` has an empty include list, so it applies to no branch (`gh api repos/egon-orm/egon-orm/rules/branches/main` returns `[]`). A PR can merge with a red tier-2 job. ([#72](https://github.com/egon-orm/egon-orm/pull/72) itself merged after a fully green re-run of its head, run [39985031082](https://github.com/egon-orm/egon-orm/actions/runs/39985031082) attempt 2; the red tier 2 of `main`'s post-merge run [39986225471](https://github.com/egon-orm/egon-orm/actions/runs/39986225471) on `8b1aeea` was the close race fixed in [#73](https://github.com/egon-orm/egon-orm/pull/73).)
- (low) A few conformance skips are gated on a profile's fixture shape, not a capability: the microsecond, binary-column and COMMIT-wait skips. The owner accepted the microsecond one (status 17 "Needs the owner's decision", approved 2026-10-20). The status note left box 1 unticked for this reason. `dialect-support.md` does not list these skips. On Postgres the adapter suite also shows 1 skipped (CI log), which I did not trace.
- (low) The check's regex only catches `===`/`!==`/`case` forms. `["mysql"].includes(x)` or a lookup keyed by dialect name would pass it. My grep found no such use today.

### Step 18: Migrations and CLI

| # | Box (short) | Verdict | How checked | Evidence |
|---|---|---|---|---|
| 1 | up → down → up of the blog schema on all supported dialects | verified | Read the conformance test. Confirmed there is a profile per dialect, and checked the CI log. | `core/test/conformance/migration/index.ts:91` (`the blog schema goes up, down to an empty database, and up again`), run by `postgres/`, `sqlite/` and `mysql/test/migration-conformance.itest.ts`. All three pass in CI run [40123401475](https://github.com/egon-orm/egon-orm/actions/runs/40123401475) (tier 2). |
| 2 | Concurrent-runner test passes 50 consecutive times | verified with caveat | Read the test. It is one test with a loop: two runners race 50 times, each iteration on a fresh tracking table. It is not 50 separate runs of the test. All three dialect tables have `locks: true`, so it runs everywhere. | `migration/index.ts:229` (`two runners at once apply each version once, 50 times in a row`); `core/src/migration/dialect.ts:234,359,430` (`locks: true`). |
| 3 | Migration constraint names work with changeset defaults (tested) | verified | Read the unit and end-to-end tests. | `core/src/migration/names.test.ts:16` (`migration names pair with changeset defaults`). `migration/index.ts:140` covers unique, FK and check end to end. `:187` covers a long name shortened to still match. |
| 4 | CLI tested via the built binary; `--help` snapshot | verified | Read the itest. It spawns `packages/cli/dist/bin.js` in a temp project for each command. The help text is an inline snapshot, and the binary's output is compared with it. | `packages/cli/test/cli.itest.ts:24,136-147` (`egon, the built binary > --help prints the help and exits 0`), plus migrate create/migrate/migrations/rollback, `--dry-run`, `--json`, the failing migration, the loader and `db create/reset/drop` with the production guard (l.358). Snapshot: `packages/cli/src/cli.test.ts:72`. CI: `cli:integration test/cli.itest.ts (7 tests)` passed. |

Findings
- (low) The status note's box 1 tick (`docs/plan/status/18.md:86-89`) was not true when written: it admits only Postgres existed then. It is true now, through step 17's profiles.
- (info) The spec's `egon gen migration --from-schema` was removed at the owner's request (`status/18.md:470-485`). The CLI has `migrate create` instead. No acceptance box depends on it.

### Step 19: Performance

| # | Box (short) | Verdict | How checked | Evidence |
|---|---|---|---|---|
| 1 | Every README §7 budget has a benchmark, reported in the published run | not run (step 19) | n/a | n/a |
| 2 | Comparative suite + edge measurements reproducible; `reference/benchmarks.md` | not run (step 19) | n/a | n/a |
| 3 | Optimisation PRs carry before/after; `internals/performance-notes.md` | not run (step 19) | n/a | n/a |
| 4 | Memory, leak and bundle-size targets measured | not run (step 19) | n/a | n/a |

### Step 20: Documentation

| # | Box (short) | Verdict | How checked | Evidence |
|---|---|---|---|---|
| 1 | No hand-written code block (lint) | verified | Read and ran both checks. `check-docs.mjs` check 1 covers the site pages, root README and CONTRIBUTING, for ts/js/tsx/mjs/cjs/mts/cts blocks. Package READMEs are checked by `check-release-config.mjs`: each block must copy a region of `docs/site/examples/readme/*.ts` or `egon.config.ts`. Both checks pass, and both run in `pnpm lint` (CI job `lint`). No page uses `<!-- illustrative -->`. | `scripts/check-docs.mjs:29-41,208-226`; `scripts/check-release-config.mjs:87-112`; for example `packages/cli/README.md:19` has `<!-- example: docs/site/examples/egon.config.ts#config -->`. |
| 2 | 100% of public exports in API reference and referenced from a guide | verified with caveat | Read `typedoc.json` and `typedoc-plugin.mjs`: `notDocumented` + `treatWarningsAsErrors`, and the plugin errors on a missing `@example`. Read check 5 of `check-docs.mjs`. A one-off script, reusing that script's helpers, counted coverage by page section. | 381 exports from 8 entry points. Every export appears on some written page (guide, recipes, reference or internals). Only 124 appear in `guide/` or `recipes/`. 257 do not, mostly types, plus 10 values (`createAdapter`, `createDatabase`, `dropDatabase`, `parseMigrationFileName`, six `VERSION`s), which appear only on reference pages. Types count as covered by the generated `reference/exports.md` (Deviation 3, owner-accepted per `status/20.md:187-190`). `egon-orm/messages` is a public export (`packages/core/package.json` exports) and a TypeDoc entry point, but it is missing from `ENTRY_POINTS` in `scripts/check-docs.mjs:44-53`, so check 5 does not cover it. Its two exports are in fact listed in `exports.md` and named on `guide/edge.md` / `reference/errors.md`. |
| 3 | Coming from Drizzle/Sequelize/Prisma complete; no positioning against the design reference (CI grep) | verified | Read `coming-from-prisma.md` in full. Counted tasks and sections on all three pages. Ran `git grep -i -w` for the name outside `docs/plan`. Check 4 runs in `pnpm lint`. | Each page has 22 `###` tasks, a "Not supported, and what to do instead" table and a "What works differently" section. The Egon side is `docs/site/examples/coming-from.ts`, marked `// @run` and executed by `docs:integration` in CI. Name hits outside docs/plan: only CLAUDE.md (instructions), `docs/adr/0002-kysely-backend.md:205,206,270` (an internal ADR, not in the site or check scope) and the check's own test. |
| 4 | Fresh-eyes test passes with no unresolved findings; transcript summarised | unverified | Read the status note only. The repo holds no transcript, and the test cannot be re-run within this audit's rules. My own read of Getting started found no gap that would block a reader. | `docs/plan/status/20.md:366-…` summarises three runs (21, 16, 11 findings) and the round-5 reviewer's reruns. This rests on the note alone. |
| 5 | Site builds with zero warnings and deploys from `main` | **false** | Pulled the `build` job log of Docs run [40123401469](https://github.com/egon-orm/egon-orm/actions/runs/40123401469) (main, c2088d6). Queried the Pages API. | Deploys: Pages `build_type: workflow`, `html_url https://egon-orm.github.io/egon-orm/`, and the `deploy` job succeeded. Warnings: the log has Vite's `(!) Some chunks are larger than 500 kB after minification` during `vitepress build`, and the `deploy` job prints `(node:1956) [DEP0040] DeprecationWarning: The punycode module is deprecated` (from `actions/deploy-pages`, not from the site build; my local `docs:build` does not print it). Nothing in `docs/site/package.json` `build` or the workflow fails on warnings. |

Docs-quality reading. I read these pages in full: `guide/coming-from-prisma.md`, `guide/transactions.md`, `guide/getting-started.md`, `guide/batch.md`, and the first 60 lines of `guide/testing.md`. I spot-read the section and task lists of `coming-from-drizzle.md` and `coming-from-sequelize.md`. Judgement: the pages are task-oriented and accurate against the code I verified above. For example, transactions.md's savepoint naming, the refusal of `isolation`/`readOnly`/`retries` on nested calls, the queueing and use-after-completion rules, and `warnOnRootUseInTransaction` all match the tests in `transaction.test.ts`. testing.md states the sandbox limits the spec asks for. The explicit-`tx` rule has its own section with a wrong/right example. Every TypeScript block is a snippet include. The pages do not follow the Part A page template headings literally: there is no "Overview" or "Quick example" heading, and the pages open with an example and a "Good to know" tip. I found no stale "CLI not out yet" wording (grep).

Findings
- (medium) The site build is not warning-free on `main`. Vite's chunk-size warning appears in Docs run [40123401469](https://github.com/egon-orm/egon-orm/actions/runs/40123401469). The status note claims "the build has no warnings" (`status/20.md`, Part A, edit links bullet). Nothing would catch a new warning either.
- (low) `egon-orm/messages` is missing from `check-docs.mjs` `ENTRY_POINTS` (l.44-53), though `scripts/api-index.ts:24` and `typedoc.json` include it. A new export there would not be flagged by check 5.
- (low) "Referenced from a guide" is met only in the owner-accepted reading. 257 of 381 exports (247 types, 10 values) appear on no `guide/` or `recipes/` page. The 10 values appear only on reference pages, and the types only in the generated index.
- (low) The fresh-eyes result cannot be re-checked: no transcript or log is kept in the repo.

### Step 21a: Edge readiness

| # | Box (short) | Verdict | How checked | Evidence |
|---|---|---|---|---|
| 1 | Reference app runs in workerd against Postgres for three requests, in CI, codegen refused at request time | verified | Read the example, its runner and the CI job; read the job log | `examples/edge-worker/src/worker.ts` (repo per request, `ctx.waitUntil(repo.close())` :80, `codegenRefused()` :28); `examples/edge-worker/run.mjs` runs Miniflare against Postgres: insert, select, second select. CI job `edge worker` (`.github/workflows/ci.yml:205-221`) runs `pnpm db:up`, build, `pnpm --filter @egon-orm/example-edge-worker run check`. In the log, all 10 `ok:` lines pass, including "workerd refuses code generation while it handles a request" and "the second request's new repo reuses the plan the first compiled". |
| 2 | Every generated path has a tested fallback; no module-load-only check | verified | Grepped for `new Function` in published sources; read the tests | The only `new Function` is `packages/core/src/internal/codegen.ts:37` (asks on each call, remembers only an `EvalError`). Its 4 callers are `schema/schema.ts:324`, `changeset/validators/generated.ts:83,89` and `repo/hydrate.ts:361`. Tests: `internal/codegen.test.ts` > "a runtime that refuses code generation at request time" > "every generated path falls back to its loop and returns the same results" (row factory, `createWith`, schema and schemaless validators, decoder); `schema/schema.test.ts` > "where code cannot be generated, schemas fall back to the loop"; `changeset/validators/codegen-late.test.ts` (refusal after 0 to 8 generated functions); `repo/hydrate.test.ts:395`. No probe runs at module load. |
| 3 | Per-request repo reuses plans of an earlier request (test) | verified | Read the cache code and tests | `adapter/compiler.ts:195-199`: a module-level `SHARED` map keyed by dialect, capabilities, codecs and size. `adapter/adapter.test.ts:285` "adapters with the same configuration share their plans, so a per-request adapter reuses them" (`toBe(plan)`), plus :299 (no sharing across configs) and :313 (bound holds over 40 adapters). The dialect packages pass module constants (`postgres/src/index.ts:58,61`). Also covered by the Worker check in box 1. |
| 4 | `EgonError` alone from the packed tarball < 1 KB; size report (min+gzip) in status note | verified with caveat | Read `scripts/size-report.mjs` and the CI step; ran esbuild on the **source** (not the tarball) | The script packs `egon-orm` and `@egon-orm/postgres`, then bundles 6 cases, including "EgonError only". CI runs it into the job summary (`ci.yml:219`). I bundled `export { EgonError }` from `packages/core/src/index.ts` with esbuild 0.28.2 (minify, esm, neutral): **842 bytes**. Setup is consistent with the claim: `bundle: false` in every `packages/*/tsup.config.ts`, `sideEffects: false` in every package.json. The table is in `docs/plan/status/21a.md` ("Size report"; EgonError 0.7 KB / 0.5 KB). Caveat: no local `dist`, so I did not reproduce the number from the tarball, and the CI job summary cannot be read from the CLI. |
| 5 | No bare `net`/`tls`/built-in specifier in any dist | verified | Read the configs, the checker and the CI step; grepped sources | `removeNodeProtocol: false` in all 6 tsup configs. `scripts/check-node-specifiers.mjs` scans `packages/*/dist/**/*.js` against `builtinModules`. CI job `build+publint+attw` runs it (`ci.yml:99`), green on c2088d6. `postgres/src/cancel.ts:43` loads lazily with `import("node:net")` / `import("node:tls")`. No bare built-in import in any `packages/*/src`. |
| 6 | Every thrown message has an id and docs entry (checked); default has no fix text; opt-in restores it (Node + Worker) | verified with caveat | Read `scripts/error-docs.ts` and `errors.test.ts`; scanned all 659 short messages on the generated pages | The `--check` mode runs inside `pnpm docs:check`, which `pnpm lint` calls. It fails when an id has no catalog entry, an entry is thrown nowhere, an entry has empty advice, a `{{param}}` is missing, or a page is stale (`scripts/error-docs.ts:274-330`). Constructors require a typed `ErrorId` (`errors.ts:240,565,588,734`). No short message contains an imperative such as Use/Add/Pass/Call/Declare/Set/Try. Node: `errors.test.ts` > "every error class" > "...message is its identifier, a short sentence and the docs link", plus `messages/index.test.ts`. Worker: `run.mjs` checks the short message, `explain` and `useFullErrorMessages` (all `ok`). Caveats in Findings 1 and 2. |
| 7 | Error-code ADR accepted by the owner before part 4's mechanism is built | verified with caveat | Read the ADR; listed PR [#57](https://github.com/egon-orm/egon-orm/pull/57)'s commit order | `docs/adr/0007-error-identifiers-and-full-messages.md`: "Status: accepted (by the owner on 2026-10-21...)". PR [#57](https://github.com/egon-orm/egon-orm/pull/57) commits: `07c24de` ADR 19:04, `36cf941` "ADR 0007 accepted by the owner" 19:14, `ccbcc95` amendment 19:26, then the first mechanism commit `0f42148` at 19:44. Caveat: acceptance is recorded by the worker's commit, not by an owner-authored artifact. |
| 8 | `JSON.stringify(error)` is `{ name, code, id }` for every error class (tested) | verified | Read `toJSON` and the test table; listed every exported error class | `errors.ts:257` returns `{ name, code, id }`. `errors.test.ts:60-103` `EVERY_ERROR` covers all 12 `EgonError` subclasses exported from `errors.ts`. `test.each` "JSON.stringify(%o) gives only its name, code and identifier" asserts `toStrictEqual` and key order. "JSON leaves out the message, the cause and the SQL" covers the rest. |
| 9 | `pnpm check`, integration (both tiers), lint:packages, smoke, docs:build pass; no check weakened | verified with caveat | Read CI job conclusions on c2088d6; sampled the gates | Every required job passed on c2088d6: `lint`, `typecheck`, `unit+types` (node 22, 24), `integration`, `integration (tier 2)`, `build+publint+attw` (build, node-specifier check, `lint:packages`, `pnpm smoke`), `docs:build`, `edge worker`. Coverage thresholds are still 95% (`vitest.config.ts:220-224`). Caveat: `pnpm check` passed in my run (§2); "no check weakened" was sampled, not audited diff by diff. See Finding 3. |
| 10 | Benchmark and budget items | not run (step 19) | n/a | Deferred by owner decision of 2026-10-14. |

**Findings (21a)**

1. (low) "Every thrown message has an identifier" holds for `EgonError` and its subclasses only, which is the scope the spec sets in part 4. About 150 `throw new TypeError/Error/RangeError` in published sources have no identifier and full text in the default bundle: argument and option checks in `repo/options.ts`, `repo/transaction.ts`, `migration/builder.ts` (34), `changeset/validators/validate.ts`, `adapter/adapter.ts`, and the adapters' `options.ts`. `packages/cli/src/config.ts:98` `CliError extends Error`, not `EgonError`. Not a false claim, but the Goal's "thrown errors carry an identifier" is narrower in practice.
2. (low) "Default messages contain no how-to-fix text" has no mechanical check; it rests on review. My grep of the 659 short messages on `docs/site/reference/errors/*.md` found no imperatives. Many short messages do state the rule that was broken ("must be an array", "must be a string"), which I judged acceptable.
3. (low) Unit and integration tests run with full messages switched on globally (`vitest.config.ts:37,68` setup file `packages/core/test/support/full-messages.ts`). Only `errors.test.ts` and `messages/index.test.ts` exercise the default short form. This keeps the advice-matching assertions working, but most tests never see the shipped default message.
4. (info) Status-note claims checked against code and CI held. I did not reproduce the size numbers in the table (CI summary only).

### Step 21b: JSON responses

| # | Box (short) | Verdict | How checked | Evidence |
|---|---|---|---|---|
| 1 | `JSON.stringify` never throws on a row or changeset of any built-in type | verified | Compared the fixture against the `t` builder list; read the tests | The `Every` fixture (`schema/json.test.ts:75-100`) covers every builder in `t` (`schema/field.ts:439`): string, integer, bigint (both modes), float, decimal, boolean, uuid, binary, date (both), time, timestamp, localTimestamp, json, array, enum, type, embedOne/Many. Tests: "a row with every type through JSON.stringify" > "never throws, and reads back as toJSON() returns"; "a changeset's JSON" > "maps the changes as a row's toJSON does, and never throws"; "errors whose metadata holds a bigint...". |
| 2 | No virtual (without json:true) or redacted field in row/changeset JSON at any depth, incl. a write's row | verified | Read the tests | `json.test.ts`: "redacted and virtual fields are left out; a virtual { json: true } one only when set"; "preloaded associations" > "to-one, to-many and null, recursively" (nested `passwordHash` absent, `not.toContain("$hash")`); "an integer-like association name neither hides an association nor leaks a redacted field"; "signing up" > "the row the insert returns keeps the password, but its JSON does not" (`fakeRepo().insertOrThrow`) and "the changeset's JSON has no password"; "nested changesets of embeds and associations are written as JSON, without hidden fields". Runtime flag: `field.ts` `redact()` sets `json: false`; `virtual({json:true})` keeps the existing flag, so redaction wins. |
| 3 | `JSON.parse(JSON.stringify(row))` deep-equals `row.toJSON()` for every type | verified | Read the tests | `roundTrip(value)` `toStrictEqual(toJSON(value))` on the every-type row, the nullable variant, nested preloads and changesets (`json.test.ts:222-231`, 258-279, 531-565). The value table is pinned per field type at `json.test.ts:145-163`. |
| 4 | `Json<User>`, `Json<loaded>`, `JsonReturn<fn>` match runtime output for every part-3 case (type tests) | verified with caveat | Read `json-types.test-d.ts` against the part 3 list | Every part 3 case has a test: field mapping, getters and methods dropped, own `toJSON`, string/array/nested/`true` preload specs, more preloads assignable where fewer are expected, a getter returning a row, `LoadedAs` select, other values, plain bigint `never`, and `JsonReturn` of a row, an array, `\| null`, `Result`, an object of rows and `errorMessages()` (`packages/core/src/json-types.test-d.ts:106-345`). Plus a cold program, `json-return-cold.test-d.ts`. Caveats: (a) the type tests and the runtime tests use separate fixtures, so "matches the runtime" is checked by inspection; (b) owner-approved deviation: `row.toJSON()` is not typed as `Json` of the row; (c) see Finding 2. |
| 5 | `errorMessages()` keys typed, with nested trees and extra keys | verified | Read `error-messages.test-d.ts` | `packages/core/src/error-messages.test-d.ts`: "is keyed by field, association and $base" (typo is a `@ts-expect-error`, :69); "nested trees: an object for a to-one association or embed, a list for a to-many one"; "collects the keys validations add"; extra keys through a write and a batch failure; `traverseErrors`. The exact form is shipped, not the fallback. |
| 6 | No runtime cost outside `toJSON`: query/hydration paths unchanged | verified | Read the non-test source diff of squash commit `869b60a` ([#60](https://github.com/egon-orm/egon-orm/pull/60)) | `repo/repo.ts` and `batch/batch.ts` changes are type-only (generic `E`, preload marker). The runtime changes are `schema/field.ts` (`virtual()`/`redact()` set `json` at definition time), `schema/schema.ts` (lazy cached `jsonTable()`, new `rowToJSON` import) and the new `schema/json.ts`. `hydrate.ts` and the compiler are untouched. `FieldMeta.json` is per schema, not per row. |
| 7 | `pnpm check`, integration both tiers, lint:packages, smoke, docs:build pass; no check weakened | verified with caveat | Same CI evidence as 21a box 9 | All required jobs green on c2088d6, including `types (typescript minimum/latest)` and the smoke `JsonReturn` program (`examples/smoke/types/json-return.ts`). My local runs (§2) passed; "no check weakened" was sampled. |
| 8 | Benchmark and budget items | not run (step 19) | n/a | Deferred by owner decision of 2026-10-14. |

**Findings (21b)**

1. (low) Spec naming: the spec asks for `ErrorMessages<…>`. The export is `ErrorMessagesOf` (`index.ts:40`), chosen because 21a had taken `ErrorMessages`. PR [#62](https://github.com/egon-orm/egon-orm/pull/62) later renamed 21a's type to `ErrorCatalog`, so the spec name is free again but unused. Cosmetic; the owner may want to settle the name before release.
2. (low) `Json` types `t.float()` and `t.integer()` as `number`, while the runtime writes `null` for `NaN` and `±Infinity` (`json.test.ts` "NaN and the infinities are null"). This is a small type/runtime mismatch, and it is also how `JSON.stringify` behaves.
3. (low) Known gaps the status note admits, which I confirmed by reading: `Json<Map|Set>` lists `size`; on cyclic data `toJSON` throws `RangeError`, not `TypeError`; a row's `toJSON` writes any own property a user adds, which `Json` does not list.
4. (info) The status-note claims I checked against the code held. The markers are string-keyed (`"~fields"`, `"~preloaded"`), not the declared unique symbols the spec asks for. This is recorded as owner decision 4 (2026-10-22).

## 7. Open issues, ranked by severity

None is data loss, an injection path or a hole in Egon's own code.

| # | Severity | Issue | Blocks | Owner | Issue |
|---|---|---|---|---|---|
| P0 | **High** (process) | Release settings and repository governance not done: O1–O6 (§4.9). `main` is unprotected (the ruleset targets no branch), so `ci` is not required and any merge method is allowed | **0.1.0** | owner | proposed in §10 |
| P1 | **Medium** | `@egon-orm/zod` peer `zod: ^4.3.0` admits Zod ≤ 4.6.5 (GHSA-mrhx-c7xc-m3w5, high upstream: memory exhaustion on large arrays); `toZod` emits uncapped `z.array()` for embedded lists (`packages/zod/src/to-zod.ts:226`); the workspace pins 4.6.5 (`packages/zod/package.json:50`, `examples/blog`, `benchmarks`, `docs/site`) | **0.1.0** (recommended) | owner decision (peer range), then 21-packaging's area | proposed in §10 |
| P2 | Medium | The 50 ms per-expression budget, a `0.1.0` gate, is not met: the first expression a program checks takes 53–55 ms (one-time); the owner accepted only the completions miss (§4.2) | **0.1.0** (owner decision) | owner | §10 item 3 |
| P3 | Medium | Postgres 14 is the stated minimum (`upgrading.md:87`, `CHANGELOG.md:17`, `guide/adapters.md:35`, `getting-started.md:4` and `:51`, `tutorial.md:62`) but only 16 runs in CI; the same for MySQL 8.0.31 (8.4 in CI). `upgrading.md`'s "Tested in CI" column is honest; the guides do not say it | should before 0.1.0 | owner | proposed in §10 |
| P4 | Medium | F4: `inspect(error)` shows `detail` and the cause, which may quote a redacted value | 1.0 (owner decision) | owner / core errors | proposed in §10 |
| P5 | Medium (accepted) | Completions over 200 ms at about 140–170 connected schemas (§4.2) | 1.0 (proposed) | owner / types | roadmap row; proposed issue in §10 |
| P6 | Low–Medium | Untested logic survivors estimated by sample: query about 106 (42–237), compiler about 35 (14–78) | acceptance before **0.1.0** (owner); triage 1.0 (proposed) | owner; query, compiler | §10 item 4 |
| P7 | Low | TypeScript `next` (7.1-dev): TS5088 on `export const errors = cs.errorMessages()` with `declaration: true` (ours); TS5115 inside Zod (theirs) | before TS 7.1 ships | changeset types | proposed in §10 |
| P8 | Low | 44 dev-only advisories (11 high) in vitepress/vite, miniflare/undici/sharp, verdaccio/body-parser, tsup/esbuild, Stryker/qs, fast-uri; none in a published package | no | 21-packaging's area | proposed in §10 |
| P9 | Low | Docs build not warning-free (Vite chunk-size; the deploy job also prints a `punycode` DEP0040 warning from `actions/deploy-pages`), and nothing fails on a warning; `status/20.md` says "no warnings" | no | docs | proposed in §10 |
| P10 | Low | Leak assertions missing from the write, preload and nested conformance suites; no global teardown check (box 11.5) | no | core test support | proposed in §10 |
| P11 | Low | Pre-release wording: "under construction, nothing is published to npm yet" in `README.md:4,25`, `docs/site/index.md:29`, `guide/index.md:4,69`, `reference/roadmap.md:3,16`; and the date of "0.1.0 (unreleased)" in `CHANGELOG.md` | at release | owner / docs | part of the release checklist (§10) |
| P12 | Low | Node 22.12.0 prints `ExperimentalWarning` for `require()` of the ES modules (22.23.1 prints none); not mentioned in the getting-started note on CommonJS | no | docs | proposed in §10 |
| P13 | Low | Test-strength gaps found while re-verifying (each with evidence in §6): `changeset/sharing.test.ts:101` boundary test does not recurse into `nested/` and `validators/`; the builder immutability test leaves out about a dozen methods (`builder.test.ts:1167-1210`); five preload loading cases have no query count (`preload/index.ts:779,909,939,1115,1132`); `check-docs.mjs` `ENTRY_POINTS` misses `egon-orm/messages` (`scripts/check-docs.mjs:44-53`); about 150 plain `TypeError`/`Error` throws (option checks) have no error identifier; `CliError` is not an `EgonError`; the sandbox is used by the write suite only | no | the owning areas | proposed in §10 (one umbrella issue) |
| P14 | Info | Naming and typing notes: `ErrorMessagesOf` could now be `ErrorMessages` (freed by [#62](https://github.com/egon-orm/egon-orm/pull/62)); `Json` types floats as `number` though `NaN`/`±Infinity` serialise as `null`; the validator-promise error has id `query.validatorPromise` though it is a changeset error | no | owner (API names) | in §10 |
| P15 | Info | Not exercised before a real publish: npm provenance and trusted publishing, the release workflow's jobs on GitHub, the weekly soak workflow | first publish | owner | release checklist |

## 8. Proposed gate for 1.0

Everything here would be checked the same way as this report: re-verified, with evidence.

1. **F4 fixed** (owner decision): `ConstraintError` and `DatabaseError` get a custom inspect
   that leaves out `detail` and shows the cause on one line; `secrets.itest.ts:210-211` flips
   to `not.toContain(SECRET)`.
2. **Editor completions under 200 ms on the 200-schema project** in every connected topology
   (chain, tree, hub), measured with `scripts/type-health/measure.mjs`, and every
   expression within the 50 ms budget as the owner defines it for `0.1.0` (P2).
3. **Query and compiler survivors triaged one by one**, as the changeset area was ([#74](https://github.com/egon-orm/egon-orm/pull/74)), with a
   test for every real gap; re-run Stryker on all three areas at the 1.0 candidate, each ≥ 80%
   with no untriaged logic survivor.
4. **Step 19 done**: the published benchmark run against the README §7 budgets.
5. **Every advertised floor tested in CI**: Postgres 14 (or the floor then), MySQL 8.0.31,
   the oldest supported SQLite, Node 22.12.0, TypeScript 5.8, and the peer lower bounds
   (already done for peers and Node).
6. **TypeScript**: the consumer checks pass on the TypeScript release current at 1.0,
   including 7.1 if it has shipped (P7 fixed), and the build either moved to TypeScript 7 or
   the decision restated.
7. **Branch protection enforced** (one approval, `ci` required, squash only) for the whole
   1.0 cycle, and the weekly soak green on GitHub for at least four consecutive weeks.
8. **Release proven**: at least one real `0.x` release through the workflow, with provenance
   and trusted publishing (no `NPM_TOKEN` left).
9. **No advisory in any published package's dependency tree**, and the dev-only advisories
   with a fixed release taken.
10. **Docs**: the site builds with zero warnings and fails on one; the leak assertions (P10)
    and the other test gaps of P13 closed; a fresh-eyes run recorded in the repository.
11. **Support policy in force**: the six-month security window for the previous major
    published in `SECURITY.md` and `upgrading.md` (already written; confirm at 1.0).

## 9. Before the first publish: the checklist

Owner, in the repository settings and on npm (none done today, §4.9):

- O1 set `RELEASE=on`; O2 create the `npm` environment, deployment branches `main` only,
  required reviewers recommended; O3 `NPM_TOKEN` in that environment for the first publish,
  then trusted publishing per package and delete the token; O4 protect `main` (fix the
  `main-protection` ruleset's empty include, or add branch protection: one approval, the `ci`
  check, squash only); O5 enable private vulnerability reporting; O6 allow GitHub Actions to
  create pull requests (and give the version job a token whose PRs start CI).
- Publish a placeholder for the unscoped `egon-orm` name now, or publish `0.1.0` soon.

Owner decisions (§10 items 3 and 4):

- P2: decide the 50 ms per-expression budget (accept the miss, or exclude the one-time
  first-expression cost).
- P6: accept explicitly that `0.1.0` ships with the query and compiler survivors sampled,
  not triaged.

Before the version PR is merged:

- P1: raise the Zod peer floor to `^4.6.6` and the pins to 4.6.7 (needs the owner's
  approval: it is a peer-range change).
- P3: say "tested on Postgres 16" wherever "14 or later" is claimed, or add a 14 job.
- P11: update the "under construction" wording and the changelog date.

## 10. Needs the owner's decision

No GitHub issue exists for any item (the repository has none). Each "not ready" or proposed
1.0 item below has a proposed issue for the owner to open; I created none. Items 1 to 4 are
needed before `0.1.0` is published.

1. **Release settings (P0, not ready; before `0.1.0`).** Do O1–O6.
   - *Proposed issue:* "Release settings for 0.1.0: RELEASE variable, npm environment,
     token, branch protection, vulnerability reporting". *Body:* "Before the first publish
     (status/21-audit.md §4.9): set the repository variable RELEASE=on; create the npm
     environment restricted to main, with required reviewers; add NPM_TOKEN to it for the
     first publish, then configure trusted publishing for the six packages and delete it;
     protect main (the main-protection ruleset has an empty include list and applies to no
     branch): one approval, the ci check, squash merges only; enable private vulnerability
     reporting (SECURITY.md links to it); allow GitHub Actions to create pull requests, and
     give the version job a token whose PRs start CI. Also publish a placeholder for the
     unscoped egon-orm name."
2. **Zod peer floor (P1; before `0.1.0`).** Recommendation: raise `@egon-orm/zod`'s peer to
   `zod: ^4.6.6` for `0.1.0` and bump the workspace pins to 4.6.7; mention it in
   `CHANGELOG.md`. The alternative is to keep `^4.3.0` and document the advisory in
   `SECURITY.md`.
   - *Proposed issue:* "@egon-orm/zod: require zod 4.6.6 or later (GHSA-mrhx-c7xc-m3w5)".
     *Body:* "Zod up to 4.6.5 can exhaust memory validating a large array without a length
     constraint. toZod emits z.array() for embedded lists (packages/zod/src/to-zod.ts:226),
     so an application validating request bodies with a toZod schema on an old Zod is
     exposed. The peer range ^4.3.0 admits those versions, and the workspace pins 4.6.5.
     Raise the peer floor to ^4.6.6, pin 4.6.7, update the peer lower-bound job and
     upgrading.md's table."
3. **The 50 ms per-expression budget (P2, not ready; before `0.1.0`).** Type health is a
   `0.1.0` gate; the first expression a program checks takes 55.2 ms in my run and 53.2 ms in
   one reviewer run; all others are under 30 ms. Options: (1) accept the miss for `0.1.0`, as
   with completions; (2) define the budget as excluding the one-time cost of the first
   expression checked (the cost moves to whichever expression is checked first,
   `status/21-api.md` §3), which then meets it. Recommendation: (2), since that cost is fixed
   per program and not a property of any query; record it in `21-release.md`'s owner
   decisions.
   - *Proposed issue:* "Type health: decide the 50 ms budget for the first expression a
     program checks". *Body:* "21-release.md budgets 50 ms of check time per query
     expression and keeps type health a 0.1.0 gate. The first expression a program checks
     takes 53–55 ms in the 200-schema project (55.2 ms median of 3 on 2026-10-24,
     scripts/type-health/measure.mjs --topology tree; status/21-api.md recorded 54–63 ms);
     every other expression is under 30 ms. It is the one-time cost of resolving the
     library's types, and moves to whichever expression is checked first. Decide: accept
     the miss for 0.1.0, or define the budget to exclude that first-expression cost. If the
     cost is to be lowered, measure what in the library's entry types it resolves."
4. **Accept the sampled query and compiler survivors (P6; before `0.1.0`).** Owner decision
   4 (2026-10-23) made only the changeset survivors a `0.1.0` gate; the query and compiler
   survivors were sampled, not triaged. `0.1.0` ships that way, so the owner should **accept
   explicitly, before publishing**, that it ships with about 106 (42–237) untested query
   behaviours and about 35 (14–78) compiler ones, as estimated. Proposal: 1.0 work and a 1.0
   gate (§8.3).
   - *Proposed issue:* "Triage every logic mutation survivor in query/ and compiler/".
     *Body:* "Sampled estimates (status/21-robustness.md §4): about 106 (42–237) untested
     behaviours in query/, about 35 (14–78) in compiler/. Do what [#74](https://github.com/egon-orm/egon-orm/pull/74) did for changeset/:
     classify each of the 798 and 264 logic survivors, test each real gap against its
     hand-applied mutant, and re-run Stryker."
5. **Postgres 14 (P3).** Recommendation: add Postgres 14 to the integration matrix (one
   compose service, one job in the `ci` gate) before 1.0; for `0.1.0`, have the guides say
   "tested on 16" as `upgrading.md` does. Postgres 14 reaches end of life in November 2026,
   so the floor may move to 15 instead.
   - *Proposed issue:* "Test the advertised database floors in CI (Postgres 14, MySQL
     8.0.31)". *Body:* "upgrading.md and the guides say Postgres 14 or later and MySQL
     8.0.31 or later; CI runs Postgres 16 and MySQL 8.4 only (docker-compose.yml:15,35).
     Add jobs for the floors, or raise the floors to what is tested."
6. **F4 (P4), a 1.0 gate by the owner's decision.**
   - *Proposed issue:* "Hide detail and the driver cause from util.inspect of
     ConstraintError and DatabaseError (F4, 1.0 gate)". *Body:* "status/21-security.md F4:
     the database's text in error.detail and error.cause can quote a redacted value, and
     util.inspect(error) prints it (pinned by packages/postgres/test/secrets.itest.ts:210).
     Give both errors a custom inspect that leaves out detail and shows the cause as one
     line; keep the properties readable; flip the test."
7. **Editor completions (P5).** Accepted for `0.1.0`. Proposal: make it a 1.0 gate (§8.2).
   - *Proposed issue:* "Faster editor completions in large connected models". *Body:*
     "Completions in a where callback cost about 40 ms plus 1.1–1.2 ms per schema reachable
     through associations: 230–239 ms at 200 (chain, tree, hub), 189 ms at 150 (2026-10-24,
     scripts/type-health/measure.mjs). The likely cause is AssocKeys<S>/PreloadSpec<S>
     inferring every static member of every reachable schema (status/21-api.md §3). Make
     the association types read declared metadata and expand only where preload is used.
     Workaround in the FAQ."
8. **TypeScript next (P7).**
   - *Proposed issue:* "errorMessages() result is not serialisable under TypeScript 7.1-dev
     (TS5088)". *Body:* "In the informational CI job, export const errors =
     newUser.errorMessages() (examples/smoke/types/consumer.ts:174) fails with TS5088 under
     declaration: true on 7.1.0-dev. Re-check at 7.1 beta; if it persists, make ErrorTreeOf
     serialisable. TS5115 in the same job is inside Zod 4.6.5's declarations."
9. **Dev advisories (P8).**
   - *Proposed issue:* "Take fixed releases of the flagged development tools". *Body:*
     "pnpm audit: 44 advisories, all in development tools (status/21-audit.md §4.7):
     vitepress/vite, miniflare/wrangler (undici, sharp), verdaccio and docs express
     (body-parser), tsup/vite/vitest (esbuild), Stryker (qs), fast-uri. Bump each when a
     release old enough for minimumReleaseAge exists."
10. **Docs build warning (P9).**
    - *Proposed issue:* "Make the docs build warning-free and fail on warnings". *Body:*
      "vitepress build prints Vite's chunk-size warning (Docs run [40123401469](https://github.com/egon-orm/egon-orm/actions/runs/40123401469)), and the
      deploy job prints a punycode DEP0040 warning from actions/deploy-pages; step 20's
      acceptance says zero warnings. Split the chunk or set the limit deliberately, then
      fail the build on any warning."
11. **Leak assertions (P10).**
    - *Proposed issue:* "Assert no checked-out connection after every conformance suite".
      *Body:* "Step 11's box asks for a global teardown check; global-setup.ts only sweeps
      databases. Add the afterEach check (checkedOut(poolStats()) === 0) to the write,
      preload and nested suites, or a teardown that checks every adapter created."
12. **Test-strength gaps (P13), one umbrella issue.**
    - *Proposed issue:* "Close the test gaps found by the 0.1.0 audit". *Body:* the P13 list
      with its file references.
13. **Names (P14).** Whether to rename `ErrorMessagesOf` to `ErrorMessages` before `0.1.0`
    (cheaper now than later; recommendation: yes, or keep and say why in the API report), and
    whether the validator-promise error belongs in the `changeset` namespace (an identifier
    change, ADR 0007).
14. **Node 22.12 warning (P12).** Recommendation: one sentence in getting-started's
    CommonJS note that early 22.x releases print an ExperimentalWarning for require() of an ES module.

## Review round 1 (PR [#76](https://github.com/egon-orm/egon-orm/pull/76))

1. **"[#72](https://github.com/egon-orm/egon-orm/pull/72) merged with tier 2 red" was wrong.** On [#72](https://github.com/egon-orm/egon-orm/pull/72)'s head `5616c0c`, run [39985031082](https://github.com/egon-orm/egon-orm/actions/runs/39985031082):
   attempt 1 failed only `peer bounds (lower)` (and `ci` with it); attempt 2 was green,
   tier 2 and `ci` included, and the merge came two minutes later (16:22:26Z). The red tier 2
   was `main`'s post-merge run [39986225471](https://github.com/egon-orm/egon-orm/actions/runs/39986225471) on `8b1aeea`: the close race fixed in [#73](https://github.com/egon-orm/egon-orm/pull/73). Removed
   as evidence from O4, P0 and the step 17 finding. P0 stands without it: `main` is still
   unprotected.
2. **The 50 ms budget** is now an unmet `0.1.0` gate that needs the owner's decision (§1 item
   3, §4.2, P2 Medium, §10 item 3), not a Low item or a 1.0 aside; type health is "Not ready"
   until it is decided.
3. Step 10 box 5: the dynamic `node:fs/promises`, `node:path`, `node:url` imports of
   `migration/loader.ts` added to the evidence.
4. Step 10 box 4: `EGON_PROPERTY_RUNS` replaces the count, so it can lower it too.
5. Step 01 box 6 (`pnpm bench`): classified from CI (green in `build+publint+attw`) as
   verified with caveat, not "not run (step 19)"; counts updated.
6. Query and compiler survivors: stated as sampled, not triaged, by owner decision 4 of
   2026-10-23; their explicit acceptance is asked for in §10 item 4.
7. Step 20 box 5: the deploy job's `punycode` DEP0040 warning added.
8. P3: `getting-started.md:4` added.
9. §4.7: the `dependencies` field is absent, not empty.
10. Run IDs and PR numbers are links.

## Review round 2 (PR [#76](https://github.com/egon-orm/egon-orm/pull/76))

1. §1's recommendation line and the §9 checklist now include the 50 ms decision next to
   O1–O6 and the Zod floor.
2. The 50 ms item has a proposed issue (§10 item 3).
3. Accepting the sampled query and compiler survivors is stated as needed before `0.1.0`
   (§1 item 4, §9, §10 item 4).
4. The two measurements are given as they were: 55.2 ms (median of 3) in my run, 53.2 ms in
   one reviewer run.
5. Renumbered so that the order reads naturally: the issues in §7 are P0 to P15 in rank
   order (the 50 ms item is now P2, and the old P2 to P10 are P3 to P11), and §10 lists the
   four items needed before `0.1.0` first. The round 1 note above uses the new numbers.

## Requests

- **To 21-security's note (finished):** its F5 row and its audit numbers are superseded
  (F5 fixed in [#72](https://github.com/egon-orm/egon-orm/pull/72); `pnpm audit --prod` now reports the Zod advisory, `pnpm audit` 44). I did
  not edit it.
- **To 21-robustness's note (finished):** its summary table still gives the changeset score
  as 83.14%; [#74](https://github.com/egon-orm/egon-orm/pull/74) measured 88.14%. Not edited.
- **To `status/17.md` and `status/20.md` (finished):** "Both are required through `ci`" and
  "the build has no warnings" are false today (§6). Not edited.

## Not verified

- npm scope ownership: the scope exists with no packages; who holds it is the owner's
  statement (no npm login here).
- The mutation scores, the 30-minute soak, the 100,000-run injection test, the runtime matrix
  on Bun and Next.js, and the Postgres 14 run are taken from the status notes.
- The fresh-eyes docs test (box 20.4).
- The edge bundle size from the packed tarball (box 21a.4): a reviewer bundled `EgonError`
  from the source (842 bytes); the CI job summary was not read.
- The FAQ's 114 ms figure for declared changeset return types: not re-measured.
- Trusted publishing, provenance and the release workflow's jobs on GitHub: cannot run
  before the owner's settings.
- Benchmarks: not run (step 19); **the published benchmark has not run.**
