# Step 21 (trusted publishing): the first publish of 0.1.0 through OIDC, status

Branch `step/21-trusted-publishing`, 2026-11-09, from `main` at `c62128e` (#77). Input: the
owner decisions of 2026-11-09 (no long-lived npm token; 0.0.1 placeholders published by hand;
trusted publishers set on npmjs.com with repository `egon-orm/egon-orm`, workflow
`release.yml`, environment `npm`; the `npm` environment, the main ruleset and "Actions may
create PRs" in place).

Labels: **verified** (I ran or read it), **cited** (a source says so; not exercised here),
**unverified**.

## Owner: timing of the first release (read this first)

- **Each of the six trusted-publisher configurations expires unless that package publishes
  successfully within 2 days of the configuration being created** (**cited**,
  docs.npmjs.com/trusted-publishers, "Trusted publisher configuration expiry": "A newly
  created trusted publisher configuration must complete its first successful publish within
  2 days … If the configuration is not validated within 2 days, it expires and can no longer
  be used or edited."). Each package has its own configuration, so all six must publish
  inside their windows, not just the first. An expired one has to be deleted and created
  again.
- Everything has to fit in that window: merge this PR, set `RELEASE` to `on`, the `version`
  job opens "Version packages", approve its `ci` runs, merge it, approve the `npm`
  environment's deployment. So create the six configurations only when ready to do all of
  that within 2 days.
- **`changeset publish` stops at the first chunk that fails** (**verified**,
  `node_modules/@changesets/cli/dist/publish.mjs:168-171`, `break publishChunks`), and the
  publish plan puts `egon-orm` in a chunk of its own, ahead of the other five, which depend
  on it (the plan's chunks as the review printed them). So if the
  `egon-orm` publish fails (for example a misconfigured trusted publisher), the other five
  are never attempted and their configurations may expire too.

## Summary

| # | Item | Result |
|---|---|---|
| 1 | The npm used at publish time | **No npm runs.** `changeset publish --from-pack-dir` runs `pnpm publish <tarball>`, and pnpm 12 publishes, does the OIDC exchange and the provenance itself (Rust, no npm CLI), so npm's "npm 11.5.1" floor does not apply. **But provenance was not asked for:** pnpm 12 ignores `NPM_CONFIG_PROVENANCE`. Fixed: `PNPM_CONFIG_PROVENANCE: "true"`, a pnpm version check before publishing, and guards in the dry run and `pnpm lint`. |
| 2 | The NPM_TOKEN path | Left in place, commented as a leftover. The workflow header and CONTRIBUTING.md "Releases" now describe trusted publishing as the path and the placeholders as how packages came to exist. |
| 3 | Merging the version PR | The premise is partly outdated: GitHub's docs now say a `GITHUB_TOKEN`-made PR gets its `pull_request` runs **in an approval-required state**, so `ci` runs after the owner selects "Approve workflows to run". **A real blocker was elsewhere:** the `release dry run` job failed on any tree with no pending changeset, which is the version PR itself (and main after every release), so `ci` could never pass there. Fixed: on such a tree the dry run now publishes the tree as it stands (the version PR's own 0.1.0) instead of versioning. `ci.yml` also gets `workflow_dispatch` as a fallback. Owner decision below. |
| 4 | The dry run | Passes, now with a provenance check on each of the six tarballs. Trusted publishing itself cannot be exercised against verdaccio. |

## 1. Who publishes, and with which tool

The chain in the `publish` job (all **verified** by reading the pinned sources):

1. `changesets/action/publish@ae32849d…` (v2.1.2): `publish/action.yml:4-5` runs
   `dist/publish.js` on `node24`; `src/publish/index.ts` calls `runPublish`, which
   (`src/run.ts:191-200`) runs the CLI with `publish --from-pack-dir <dir>` through
   `getExecOutputChangesetsCli`, i.e. `node <workspace>/node_modules/@changesets/cli/bin.js`
   (`src/utils.ts:234-260`), with `...process.env` plus `GITHUB_TOKEN` (`src/run.ts:176-183`).
   The action writes no `.npmrc` and runs no npm.
2. `@changesets/cli` 3.0.3 (`node_modules/@changesets/cli/dist/`): `publish.mjs:53` picks the
   tool with `getPublishTool`; `getPublishPlan.mjs:569-590` takes `packages.tool.type` (pnpm,
   from `pnpm-workspace.yaml`) and returns the pnpm tool; its `publish$1`
   (`getPublishPlan.mjs:337-365`) runs `pnpm publish <tarball> --json --access … --tag …
   --no-git-checks` (line 349) with `sanitizeEnv(process.env)` (`:270-278`), which removes
   only the OTP variables. `info` is `pnpm info` too. npm is used only when the workspace is
   not pnpm or yarn.
3. pnpm 12.11.2 (`packageManager`; pnpm/setup installs it) is a native binary that publishes
   on its own (`pnpm/crates/publish` at tag `v12.11.2` of pnpm/pnpm):
   - `publish_packed_pkg.rs:114` resolves options with OIDC enabled for a single-package
     publish; `publish_options.rs:216-264` (comment at 241: "OIDC takes precedence over a
     configured static token, matching the npm CLI") runs `fetch_token_and_provenance_by_oidc`
     (`:127-176`), which, on GitHub Actions (`GITHUB_ACTIONS`), requests an id-token with
     audience `npm:registry.npmjs.org` from `ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN`
     (`oidc/id_token.rs:36-43`, `oidc.rs:63-107`) and exchanges it for a publish token (`oidc/auth_token.rs`, not read;
     the path `/-/npm/v1/oidc/token/exchange/package/` is in the binary's strings). A failed exchange is a warning
     ("Skipped OIDC") and falls back to static credentials.
   - Provenance: an explicit setting wins (`publish_options.rs:159`); otherwise it is on only
     if the id-token says the repository is public and npm says the package is public
     (`oidc/provenance.rs:28-60, 89-95`), and a failure to decide is a warning, not an error.
   - **pnpm reads `PNPM_CONFIG_*` and not `NPM_CONFIG_*`**
     (`pnpm/crates/config/src/env_overlay.rs:10-15`; `provenance` read as `PROVENANCE` at
     `:340`).

**What npm requires** (**cited**, https://docs.npmjs.com/trusted-publishers): npm CLI 11.5.1
or later and Node 22.14.0 or later (for the npm CLI); `id-token: write`; cloud-hosted
runners only; the workflow given by file name only, in `.github/workflows/`, case-sensitive;
`repository.url` in `package.json` matching the GitHub repository exactly; provenance
generated automatically for a public repository and package. Also: "A newly created trusted
publisher configuration must complete its first successful publish within 2 days. If the
configuration is not validated within 2 days, it expires and can no longer be used or
edited." The page does not mention pnpm.

**Does the job meet them?**

- npm CLI version: not applicable; no npm runs (above). The npm bundled with Node 22 is
  10.9.x (10.9.0 in 22.12.0, 10.9.8 in 22.23.1, checked locally), so a job that did run npm
  would not qualify. I did not pin an npm.
- `id-token: write`, GitHub-hosted runner (`ubuntu-latest`), environment `npm`, workflow
  `release.yml`: yes (**verified** in the file).
- `repository.url`: `git+https://github.com/egon-orm/egon-orm.git` in all six packages
  (**verified**; `pnpm lint` already checks it). The repository is public (**verified**, API).
- **Provenance: not met as written.** `NPM_CONFIG_PROVENANCE: "true"` is ignored by pnpm 12
  (**verified**: `NPM_CONFIG_PROVENANCE=true pnpm publish x.tgz --registry
  http://127.0.0.1:9/` went straight to the upload and failed on the connection;
  `PNPM_CONFIG_PROVENANCE=true` failed first with `ERR_PNPM_PROVENANCE_UNSUPPORTED_PROVIDER`,
  and with `GITHUB_ACTIONS=true` with `ERR_PNPM_ID_TOKEN_GITHUB_WORKFLOW_INCORRECT_PERMISSIONS`).
  Under trusted publishing pnpm would probably still have attached provenance by its own
  detection (public repo, public package), but silently skipped it on any failure to
  decide; with the `NPM_TOKEN` path, never.

**Changes:**

- `release.yml`, `publish` job: `PNPM_CONFIG_PROVENANCE: "true"` instead of
  `NPM_CONFIG_PROVENANCE`. Provenance is now required: a publish that cannot attach it
  fails rather than going out without it.
- `release.yml`, `publish` job: a "check the publisher" step, before the token step and the
  publish, fails unless the pnpm that runs in this workspace (after any switch to the pinned
  version) is the one `packageManager` pins, ignoring a `+sha512.…` suffix. It does not
  detect "another pnpm on PATH" as such: pnpm 12 answers `--version` for the version the
  project pins (`pnpm/crates/cli/src/lib.rs:230-243`, from review), and `pnpm publish`
  switches the same way, so the step checks the pnpm that will publish. It runs only
  first-party shell and `node -p`; the job still runs no install script.
- `scripts/check-release-config.mjs` (`pnpm lint`): `findWorkflowProblems` fails on an
  `NPM_CONFIG_PROVENANCE` key anywhere in `release.yml`; within the `publish` job's block
  only, on a missing `PNPM_CONFIG_PROVENANCE: "true"` (quoted or not), `id-token: write` or
  environment `npm` (scalar or `name:`); on a missing `publish` job; and on a
  `packageManager` that is not pnpm 12 or later (a `+sha512.…` suffix accepted). 11 unit
  tests with a three-job fixture; the 5 added in review round 1 (keys in another job,
  unquoted `true`, a hashed pin, the `name:` form, no `publish` job) fail on the round-0
  checker. The checker reports two problems on the old `release.yml`.
- Workflow header comments rewritten (who publishes, how authentication works).

## 2. The NPM_TOKEN path

Left as it was: the step writes `~/.npmrc` only when the secret is set, and pnpm prefers the
OIDC token to it anyway (`publish_options.rs:241`). The repository has no Actions secrets
and no variables, and the `npm` environment has no secrets (**verified**, `gh secret list`,
`gh variable list`). The comment above the step says it is unused.

The placeholders: `egon-orm`, `@egon-orm/postgres`, `sqlite`, `mysql`, `zod` and `cli` all
exist on npm (**verified**, registry HTTP 200; `egon-orm`, `postgres` and `cli` checked at
`0.0.1` latest, with a `0.0.0-stage` version too). Whether their trusted publishers are set
is **unverified**: npm does not show it without the owner's login.

CONTRIBUTING.md "Releases" now says: authentication is trusted publishing with no npm token;
pnpm publishes without the npm CLI; the placeholders and the trusted publisher fields; the
2-day expiry; the `NPM_TOKEN` leftover; provenance through `PNPM_CONFIG_PROVENANCE`; the
approval of the version PR's runs and the fallbacks.

## 3. Merging the version pull request

**What GitHub says** (**cited**, [Triggering a workflow from a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow)):
events triggered by the `GITHUB_TOKEN` do not create workflow runs, except that
"`workflow_dispatch` and `repository_dispatch` events always create workflow runs", and that
for `pull_request` (`opened`, `synchronize`, `reopened`) "when a workflow using `GITHUB_TOKEN`
creates or updates a pull request, the resulting `pull_request` event creates workflow runs
in an **approval-required** state. The pull request displays a banner in the merge box, and
a user with write access to the repository can start the runs by selecting **Approve
workflows to run**." A GitHub App or personal token instead "also lets `pull_request`
workflows run automatically (without the approval prompt described above)".

So the brief's premise ("`ci` never runs on them") no longer matches GitHub's docs: the runs
are created and wait for the owner. This is **cited, not exercised** on this repository; the
`version` job has never run (RELEASE is not set).

**A blocker the brief did not name (verified):** the `ci` gate needs the `release dry run`
job, and `scripts/release-dry-run.mjs` failed with "there is no pending changeset, so there
is nothing to release" on any tree without a pending changeset. That is the version PR
(it consumes them) and `main` after every release. So, whatever starts `ci` on the version
PR, it would have failed, the PR could not be merged, and after a release every push to
`main` would have been red. Reproduced on a simulated version PR (a clone of this branch
with `pnpm version-packages` committed): the old script failed there.

Fix (review round 1; round 0's fix versioned a made-up patch release instead, which left the
version PR's own content unchecked): with no pending changeset the dry run skips the version
step and dry-runs the publish of the tree as it stands, which is what merging the version
PR publishes. It requires one version across the published packages, a non-empty
`## <version>` section in each package `CHANGELOG.md` (the GitHub release body) and
`VERSION` at that version, then runs the publish plan, pack, provenance refusal, publish,
release notes, install and next-release checks as on any tree. **Verified** on the
simulated version PR: passed at 0.1.0; after committing `## 0.1.0 (draft)` in
`packages/zod/CHANGELOG.md` it failed with `packages/zod/CHANGELOG.md has no non-empty
"## 0.1.0" section (the GitHub release body)` (round 0's script passed on that tree; the
real release body would have been the whole file, `changesets/action` `src/utils.ts:81,
93-95`, from review).

The ruleset (**verified**, API): PR required, squash only, 0 approvals, required check `ci`
from GitHub Actions (integration 15368), not strict. A `ci` run from any event on the PR's
head commit is from that app.

**Options:**

| Option | Owner setting or secret | Effect |
|---|---|---|
| A. Approve the runs in the PR ("Approve workflows to run") | none | `ci` runs on each version-PR update after one click. Per GitHub's docs; unverified here. |
| B. Run `ci` by hand: `gh workflow run ci.yml --ref changeset-release/main` | none (needs `workflow_dispatch` in `ci.yml`, added here) | A run on the branch head commit. That a `workflow_dispatch` run satisfies the required `ci` check is my reading (same commit, same app), **unverified**. Usable only once this PR is on `main`. |
| C. Close and reopen the PR | none | The `reopened` event comes from the owner, not the `GITHUB_TOKEN`, so runs start normally (unverified here). |
| D. The `version` job dispatches `ci` itself after updating the PR | none, but `actions: write` on that job | Automatic, but a job that already holds `contents: write` and `pull-requests: write` gains `actions: write`, and each update runs `ci` twice (the dispatched run and the approval-waiting one). Not done. |
| E. A GitHub App token (`actions/create-github-app-token`) for the `version` job | a GitHub App, installed, with its id and key as secrets | Everything runs automatically; commits and PR are attributed to the App. Not done: needs owner settings. |

**Implemented:** the dry-run fix (required for any option) and `workflow_dispatch` on
`ci.yml` (enables B). The ruleset is untouched and nothing is bypassed. The dry run on a
tree with no pending changeset now checks that tree's own release content (above) instead of
failing on a precondition; on a tree with pending changesets it does what it did.

**Recommendation:** A, with B or C as the fallback. The owner already approves every publish
in the `npm` environment, so one more click on the version PR costs little, and it needs no
App, secret or new permission. Move to E only if releases become frequent enough that the
click is a burden.

## 4. The dry run

`pnpm release:dry-run` now, before the real publish to verdaccio, runs `pnpm publish
<tarball> --json` once for each of the six packed tarballs, in the package's directory as
`changeset publish` does, with `PNPM_CONFIG_PROVENANCE=true`. With no OIDC token each must
fail, and its JSON error `code` must be `ERR_PNPM_PROVENANCE_*` (locally) or
`ERR_PNPM_ID_TOKEN_*` (a CI runner without `id-token: write`); then none of the six may be
in the registry. (Round 0 ran `changeset publish` once, which stops at the first failed
chunk, so only `egon-orm` was ever tried.) This checks that the pinned pnpm reads the
variable `release.yml` sets. The real publish then runs through `changeset publish
--from-pack-dir` with `PNPM_CONFIG_PROVENANCE=false` (was `NPM_CONFIG_PROVENANCE`, which did
nothing).

**What it cannot test:** trusted publishing and provenance themselves. Both need a GitHub
Actions OIDC token and npm's registry (the token exchange, the package's trusted publisher,
Sigstore signing); verdaccio has none of it. They will be exercised only by the first real
publish. Also untested: the "check the publisher" step (it runs only in the `publish` job).

## Checks

Local, Node 22.23.4, pnpm 12.11.2 through corepack (`corepack enable --install-directory`
into my scratch directory; Homebrew's pnpm 8 not used).

| Command | Result |
|---|---|
| `pnpm release:dry-run` (round 1 script, this branch) | passed, 0.1.0; all 6 refused with `ERR_PNPM_PROVENANCE_UNSUPPORTED_PROVIDER` |
| round 1 script on a simulated version PR (`pnpm version-packages` committed) | passed, 0.1.0, publishing the tree as it stands (main's script failed there: "there is no pending changeset") |
| the same, after committing `## 0.1.0 (draft)` in `packages/zod/CHANGELOG.md` | failed: no non-empty "## 0.1.0" section |
| `node --test scripts/check-release-config.test.mjs` | 23 passed (5 of them fail on the round-0 checker) |
| `pnpm check` (round 1; includes `pnpm lint`) | passed: lint, typecheck, 6,645 unit tests, 608 type tests, build |

CI on the PR: see the PR's checks.

## Deviations, gaps and requests

- No npm pin and no `npm --version` assertion, as the brief suggested: npm does not run in
  the job. The check asserts the pnpm version instead.
- `ci.yml` is touched (one trigger) for item 3; it was not named in the brief.
- The dry run's "there is no pending changeset" failure is gone (§3): on such a tree it now
  checks the tree's own release (version, CHANGELOG sections, VERSION) and publishes it.
  Said here because it changes what a CI job fails on.
- `pnpm check` passed on the simulated version-PR tree in round 0; the other CI jobs
  (integration, docs build, smoke, consumer matrix) were not run on it.
- **Owner:** the timing at the top of this note. Also consider npm's recommended "Require
  two-factor authentication and disallow tokens" on each package after the first OIDC
  publish (cited from the same page; owner's call).
- **At the first publish** (21-audit §9 P15): check that each 0.1.0 on npm shows provenance,
  and that the job log shows the OIDC exchange, not "Skipped OIDC".
