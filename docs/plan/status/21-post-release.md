# Step 21 (post-release): after the 0.1.0 publish, status

Branch `step/21-post-release`, 2026-11-10, from `main` at `592b861` ("Version packages",
#79). Docs only: no package source changes and no changeset, so this PR starts no version
PR and no publish.

Labels: **verified** (I ran or read it), **owner** (reported by the owner, not checked by
me).

## What happened

- `egon-orm@0.1.0` and `@egon-orm/postgres@0.1.0` were published by release run
  [42717306800](https://github.com/egon-orm/egon-orm/actions/runs/42717306800) (push of #79),
  on 2026-11-09; npm's `time` field says 23:22:26 and 23:22:32 UTC (**verified**, registry).
- The same run failed for `@egon-orm/cli`, `mysql`, `sqlite` and `zod` with
  `ERR_PNPM_FAILED_TO_PUBLISH … (status 404 Not Found)` (**verified**, run log). Cause: their
  trusted-publisher configurations named the workflow `package.yml` instead of `release.yml`
  (**owner**). The owner fixed them and started run
  [42862675990](https://github.com/egon-orm/egon-orm/actions/runs/42862675990)
  (`workflow_dispatch`, `main`, `592b861`), which published the four on 2026-11-10; npm's
  `time` says 17:30:31 to 17:33:23 UTC (**verified**).
- Each of the six `0.1.0` versions has an SLSA v1 provenance attestation naming
  `.github/workflows/release.yml`, `refs/heads/main` and its run (**verified**, decoded from
  the attestations npm serves). Six tags `<name>@0.1.0` at `592b861` and six GitHub releases
  exist (**verified**, `git ls-remote`, `gh release list`). `latest` is `0.1.0` for all six.
  The owner also reports that a fresh `npm install` and `import` work (**owner**; I did not
  repeat it).

## Changes

| # | Item | Where |
|---|---|---|
| 1 | Pre-release wording (P11) | `README.md:4`: the "under construction" badge is now the npm version badge. `README.md:25`: "Status: 0.x", 0.1.0 is on npm, minor releases can break before 1.0, with a link to the versioning policy. `docs/site/index.md` and `docs/site/guide/index.md`: the "Work in progress" warning is now a "0.x release" info box with the same two facts and a link to Upgrading. `guide/index.md` ("What it costs"): "Young. The first release is 0.1.0, …". `reference/roadmap.md`: the intro line likewise; the "Before the first release" section is gone: release hardening is done, and the performance row (step 19, not run) moved into the planned table, now headed "Planned" |
| 2 | Changelog date | `CHANGELOG.md`: `## 0.1.0 (2026-11-10)` |
| 3 | Release checklist | `status/21-audit.md` §9: each item ticked, or left open, with a dated state note; new §9.1 on the partial publish; P11 and P15 annotated in the §7 table. Nothing else in the report changed |
| 4 | Release procedure | `CONTRIBUTING.md` "Releases": the trusted publisher's workflow filename must be exactly `release.yml` (otherwise npm answers 404); a partly failed publish is retried with `gh workflow run release.yml --ref main` |

## Decisions

- **Changelog date 2026-11-10.** `egon-orm` and `@egon-orm/postgres` reached npm on
  2026-11-09 (UTC) and the other four on 2026-11-10. The entry carries the day the release
  was complete, as the owner asked. The per-package `CHANGELOG.md` files have no dates
  (Changesets writes none), so nothing else changed.
- **Install command.** I kept the existing commands (`npm install egon-orm @egon-orm/postgres
  pg` on the site, `pnpm add … pg` in the README, the same in getting-started): `pg` is a
  peer dependency of `@egon-orm/postgres`, so `npm install egon-orm @egon-orm/postgres` alone
  is not the full install. Getting-started already says how to install and had no
  pre-release wording, so it is unchanged.
- **Left as they are:** `guide/queries-advanced.md` "Not in the first release" and the
  roadmap rows planned after it (still true of 0.1.0); `upgrading.md` "The first release".
- **P15 stays unticked.** Provenance, trusted publishing and the release jobs are checked;
  the weekly soak is not exercised by a release. `robustness.yml` has run on its schedule
  (`17 3 * * 1`) three times, 2026-10-26, 2026-11-02 and 2026-11-09, all green (the
  2026-11-09 `soak` job ran 31 minutes at `c62128e`); none since the release.

## Verification

- Item 4, the retry claim (**verified** against the logs of run 42862675990): `select mode`
  ran `changeset publish-plan`, which printed "These packages will be published as they were
  not found in the registry: @egon-orm/cli@0.1.0, @egon-orm/mysql@0.1.0,
  @egon-orm/sqlite@0.1.0, @egon-orm/zod@0.1.0" and "2 packages are already published"; the
  `publish` step counted to 4 ("Publishing packages (3/4)") and printed "Successfully
  published" for exactly those four, then "Created git tags". The GitHub releases of
  `egon-orm` and `@egon-orm/postgres` are still the ones from 2026-11-09. The run was a
  `workflow_dispatch` on `main`; that `gh workflow run release.yml --ref main` is the
  command the owner typed is **owner** (the run's event and ref match it).
- Item 4, the 404 (**verified**, run 42717306800): the four failures are each
  `status 404 Not Found: {"error":"Not found"}`. That the wrong filename is what makes npm
  answer 404 rests on the owner's diagnosis and the retry succeeding after the fix; I could
  not see the npmjs.com configurations.
- Mode "none" on merge of this PR: `.changeset/` holds only `config.json` and `README.md`
  (no pending changeset; `changeset status --since origin/main` lists no package to bump) and
  all six manifests say `0.1.0`, which is on npm; `changeset publish-plan`, run locally on
  this branch against the npm registry, writes `"plan": []`. So `select-mode` has neither
  "version" nor "publish" to select (release.yml: "none" otherwise), and no job after
  `select mode` runs. I did not run the `select-mode` action itself.
- Repository settings read with `gh api` (for the §9 notes): `RELEASE=on`; environment
  `npm` with required reviewers and deployment branch `main`; no Actions secrets; private
  vulnerability reporting enabled; `can_approve_pull_request_reviews: true`; rules on `main`:
  required check `ci`, squash only, deletion and non-fast-forward blocked,
  `required_approving_review_count: 0`.
- `pnpm check`, `pnpm lint` and `pnpm docs:build`: see the PR.

## Not verified

- The trusted-publisher configurations on npmjs.com (now `release.yml` for all six).
- A fresh install from npm (the owner did it).
- The weekly soak after the release (none has run since).

## Observations

- npm lists a `0.0.0-stage` version of each package besides `0.0.1` and `0.1.0`. I do not
  know where it came from and did not touch it; `latest` is `0.1.0`.
- The rules on `main` require 0 approvals, where §9 O4 asked for one. Recorded in the §9
  state note, not changed.

## Requests

None.
