# Step 21 (changeset gaps): every logic survivor of the changeset area, status

Branch `step/21-changeset-gaps`, 2026-10-24, rebased on `main` at `1f83d77` (#73,
robustness). Owner decision 4 of 2026-10-23: the changeset survivors are a `0.1.0` gate,
closed with tests only; a real bug would stop the work and be reported first. Input: the
changeset run of `status/21-robustness.md` §4 (83.14%, `7bda82b`), its 530 logic survivors.
Review round 1 (below) found the ledger's equivalent class less reliable than the first
version of this note claimed; every equivalent row was read again. Review rounds 2 and 3
found more that a key planted on `Object.prototype` reaches. The counts here are those
after all three rounds.

## Summary

| Item | Result |
|---|---|
| Logic survivors of the base run, each looked at | **530 of 530**: 202 now tested, 123 equivalent, 205 low value (3 of them held for the owner, see Requests) |
| Real gaps closed | **203** (202 of the 530, and one the first re-run showed), each with a test checked against its hand-applied mutant |
| Production bugs found | **None**. Every gap was a missing test. One behaviour is asked of the owner (a field name listed twice gives two identical errors) |
| Changeset area, Stryker after the tests | **88.14%** (from 83.14%), on `01b6cf0`; the tests of rounds 2 and 3 came after it and were checked by hand, not by another run |
| Files changed | Test files only, and this note and `status/21-robustness.md`; no source or config change |

Tests added (all unit tests, no database), each in the test file of its subject:

- `changeset/cast.test.ts`: a value compared with the current value; sources that are
  not one (`cast(undefined)`, `types` of `undefined`, `types` without `data`).
- `changeset/change.test.ts`: `merge` of errors and actions, reads of an embed change,
  `applyChanges` (defaults, embeds, a schemaless field without a value), `change()` and
  changesets without a schema class.
- `changeset/constraints.test.ts`: default names over two columns, `optimisticLock`.
- `changeset/validations.test.ts`: `validateRequired`, null skipped by every validator,
  `validateSubset`, `validateLength`, `validateNumber`, `validateConfirmation` (a null
  confirmation with a type that accepts null), `validateChange` outcomes and error keys.
- `changeset/nested/nested.test.ts`: the nested-change describes, `embedValue`,
  `missingEmbedded`, `embedChanges`, `buildAssoc`, and a block for keyless targets, odd
  params, custom key types and applied rows.
- `changeset/validators/validate.test.ts`: routing (with a symbol in a path), `only`,
  `apply`, `validateField`.
- `changeset/validators/generated.test.ts`: the builders of a schema class.
- `test/security/hostile-params.test.ts`: under a key planted on `Object.prototype` (its
  `plant()` helper and cleanup), a stored row cast again is no change, a changeset that
  settles a relation stays valid, an unchanged embedded item stays the stored row, a
  validator does not see the key, dropped routed issues leave the parent valid, a field's
  name planted with the value given is still a change, and an association's name planted
  as loaded (`[]`, or `null` for a to-one) is still not preloaded.
- `changeset/validators/codegen-late.test.ts` (9 cases): a runtime that refuses
  `new Function` after N constructions. It stays a file of its own because each case
  stubs the global `Function` and loads the modules afresh (`vi.resetModules()`), so the
  schema builders are generated, or refused, inside the case; in a shared file the
  modules of the other tests would already be loaded and their builders made.

## Method

1. The base run is the changeset run of the robustness step: `7bda82b`, 4,077 mutants,
   3,358 killed, 29 timeouts, 662 survived, 25 without coverage, 3 runtime errors, 83.14%.
   Its 687 survivors split, by `scripts/mutation-sample.mjs`, into 81 error ids (rejected by
   tsc, verified by sample in `status/21-robustness.md`), 76 error-message texts (low value,
   as there) and **530 logic survivors**. This step is about the 530. The base report itself
   was not kept (the later runs overwrote `reports/mutation/changeset.json`; only a copy in
   my scratch directory was used for the ledger), so its per-file scores below cannot be
   checked from the repository.
2. Each logic survivor was read against the source, file by file. In review round 1 every
   row classed equivalent (164) was read again against inputs at the edges: symbols, `-0`,
   `null` and `undefined` items in params, empty keys (`primaryKey: false`), fields with
   several options (`.default()` with `.autogenerate()`), custom types whose cast accepts
   `null` or refuses its own values, names listed twice, and rows that come from
   `applyChanges` (a new embedded row there can lack a key or a required value). In round
   2, every row of every class whose reason rests on a plain object having no inherited
   keys was checked again under a key planted on `Object.prototype`, and in round 3 every
   row of every class at a `hasOwn` guard in front of a direct property read whose name
   comes from schema metadata (a field or relation name), or whose reason rests on a
   property being absent. Where I
   was not sure, a scratch test was run against the hand-applied mutant.
3. Each was put in one class:
   - **tested**: a real gap. A test was written and run against the mutant applied by hand
     (one replacement in the source, the test file run, the source put back); the test fails
     with the mutant and passes without it.
   - **equivalent**: the mutant cannot change behaviour in a state the API can reach (a
     check that another check already makes, a shortcut to the same result, a value that
     cannot occur there). A mutant that returns an equal new object where the source returns
     the same one is equivalent: the API does not promise object identity. The reason is
     given per mutant.
   - **low value**: only a message, a function name in a message, an advice parameter, or
     an input or state the types forbid (misuse), including which error such a misuse gets
     (a `TypeError` instead of a `QueryError`) and whether a readonly value is frozen.
   - **tool artifact (verified by hand)**: a mutant the test suite kills but Stryker reports
     as survived. None of the 530 is one. (The first version of this note named one; review
     round 1 showed it was an equivalent mutant that my harness had applied at the wrong
     line.)
4. The harness replaces the first occurrence of a text. Each hand check in round 1 counted
   the occurrences first and mutated the one Stryker names; a text that occurs twice
   (`finishOne(..., false, ...)` at lines 625 and 632 of `nested/change.ts`, two blocks in
   `validate.ts` and `changeset.ts`) was given with enough context to be unique.
5. Stryker was re-run on the whole changeset area at the end, and its survivors were
   matched with the ledger.

Mutant ids in the ledger are those of the base run. Ids change when the sources or tests
change, so the runs were compared by content: file, mutator, original text, replacement and
the order of equal keys (4,075 of 4,082 mutants matched; the 7 unmatched were all killed).

## Results

| File | Logic survivors | Tested now | Equivalent | Low value |
|---|---|---|---|---|
| `changeset.ts` | 149 | 43 | 23 | 83 |
| `nested/change.ts` | 117 | 55 | 26 | 36 |
| `nested/relation.ts` | 97 | 31 | 17 | 49 |
| `validators/validate.ts` | 93 | 39 | 30 | 24 |
| `nested/embed.ts` | 33 | 25 | 8 | 0 |
| `spec.ts` | 20 | 6 | 3 | 11 |
| `measure.ts` | 12 | 0 | 12 | 0 |
| `nested/build.ts` | 6 | 2 | 2 | 2 |
| `validators/generated.ts` | 3 | 1 | 2 | 0 |
| **all** | **530** | **202** | **123** | **205** |

Plus one gap outside the 530 (`nested/relation.ts:310`, below), so 203 tested in all.
Two equivalent rows and one low-value row were killed by the final run anyway (a test
written for another mutant reaches them, or a timeout): 3270 (`spec.ts:131`, a timeout),
4000 (`validators/validate.ts:597`) and 3266 (`spec.ts:128`, a timeout). They keep their
class in the ledger. (A third equivalent row the first version of this sentence counted,
1552, has been tested since round 3.) The full
ledger, one row per mutant, is in the appendix.

What the real gaps were, in short (the ledger names the test for each):

- `changeset.ts`: `merge` of actions and constraint errors, `optimisticLock`, null skipped
  by every validator, `validateSubset` compared by value, `validations()` exactly,
  `getField`/`fetchField` on built rows, composite constraint names, `applyChanges` with
  and without a schema class, `change()` refusing an embed, schemaless merges, a null
  confirmation with a type that accepts null, the keys of an error without a validation.
- `nested/change.ts` and `nested/relation.ts`: parent validity from children, `required`,
  stored rows put back, duplicates in a cast, to-one `onReplace` paths, `putAssoc(null)`,
  key casting of to-one embeds, keyless list comparison (null, dates, lists, defaults given
  by a function, a stored row put back as its changeset), `leaves()` per relation kind,
  `indexOfRow`, `NotLoadedError` fields, `keyFinder` with a key two rows share, a has-many
  to a keyless schema, options given as a list, `null`/`undefined`/non-plain items in
  params, a key type whose cast refuses its own values, applied embedded rows without a key
  or a required value, a key planted on `Object.prototype` (no change, still valid, an
  association still not preloaded).
- `validators/validate.ts`: routing of issues to children (leaving children, embedded
  lists, positions as text, a symbol where a position would be), `only`, `apply` over
  nulls, dates, undefined and a field with no value yet, a Standard Schema result with
  `issues: []`, a rejected promise from `validateField`, a key planted on
  `Object.prototype` (not seen by a validator, no error of the parent).
- `nested/embed.ts`: `missingEmbedded` and `embedChanges` in full, virtual fields of
  embedded rows, a field with both a default and autogenerate, an unchanged item under a
  planted key.
- `spec.ts`: a source that is not one gets the `QueryError` its contract names.
- `validators/generated.ts`: a runtime that refuses code generation late, and the builders
  of a schema class made once and kept.

## The final Stryker run

`pnpm test:mutation changeset`, started 02:12 on `01b6cf0` (clean tree), concurrency 2,
`ignoreStatic: false`, 35 min. Free disk stayed at 57 GB; `.stryker-tmp` 19 MB,
`reports/` 62 MB.

| Run | Mutants | Killed | Timeout | Survived | No coverage | Runtime error | Score |
|---|---|---|---|---|---|---|---|
| base (`7bda82b`) | 4,077 | 3,358 | 29 | 662 | 25 | 3 | 83.14% |
| before review round 1 (`c655c31`) | 4,082 | 3,527 | 32 | 511 | 11 | 1 | 87.21% |
| final (`01b6cf0`) | 4,082 | 3,560 | 37 | 474 | 10 | 1 | **88.14%** |

Per file, base to final: `changeset.ts` 85.96% to 88.69%, `nested/change.ts` 79.19% to
86.87%, `nested/relation.ts` 69.21% to 76.84%, `validators/validate.ts` 86.51% to 91.37%,
`nested/embed.ts` 83.16% to 95.41%, `spec.ts` 84.85% to 90.45%, `nested/build.ts` 82.43%
to 85.14%, `validators/generated.ts` 88.46% to 92.31%, `measure.ts` 88.12% (unchanged: its
12 survivors are all equivalent). `nested/relation.ts` stays lowest because most of its
survivors are error messages and their advice parameters (low value).

The final run's 484 survivors: 76 error ids, 76 error messages, 332 logic. Error ids went
from 81 to 76 because five new tests match the error id in the message they expect, which
kills the mutants that blank those ids: `query.changesetSource`, `query.schemalessShape`
and `query.schemalessData` (`spec.ts`, the `cast` sources that are not one), and
`query.nestedOptions` and `query.nestedValue` (`nested/change.ts`, list options and a
non-plain value given to `putAssoc`). The 332 logic survivors are 121
equivalent, 204 low value, and the 7 rows tested in review rounds 2 and 3, after this run:
their tests were checked against the hand-applied mutants, and Stryker was not run again
for them (coordinator, 2026-10-24). One more row tested in round 3 (1552) was already
killed in this run (a timeout).

Earlier runs showed these, each applied by hand again:

- **`nested/relation.ts:310`, `!level.has(value)` → `true`** (the last of two rows with one
  key would win in `keyFinder`'s index). Killed in the base run, survived on `c655c31`:
  the only test that reached it was a fast-check property in
  `test/security/hostile-params.test.ts` without a fixed seed, which draws a shared key only
  sometimes. A fixed test was added (`a7ed0dd`, now "a key that two rows share finds the
  first of them" in `nested.test.ts`); it is killed in the final run.
- `validate.ts:539`, three mutants of `staying()`: reclassified **equivalent**: every item
  of a nested list in the changes is a changeset of a relation (`change()` and `putChange`
  refuse relation fields, cast and put make every item a changeset), so the two conditions
  before `leaves()` never decide the result.
- `validate.ts:630`, `a === undefined` → `false` in `apply`'s `same()`: a real gap (a field
  of a new record with no value yet, compared as a date). **Tested**.
- `validate.ts:630`, `b === undefined` → `false`: **low value**. Output values of
  `undefined` are skipped before `same()`; only a custom type whose cast succeeds with
  `undefined` reaches it.
- `generated.ts:71-74`, four static mutants that make `generatedBuilders` never generate
  (or never cache). Killed in the base run by the old test that a schemaless changeset
  generates code; owner decision F5 (#72) reversed that, and the new test counts
  `new Function` calls that schema definition also makes, so it no longer sees them.
  **Tested** (`validators/generated.test.ts`).

## Checks

- `pnpm check` (lint, typecheck, unit with coverage, type tests, build) passed on
  `01b6cf0` (unit: 156 files, 6,565 tests; type tests: 35 files, 608 tests), and again
  after round 2 (unit: 6,569 tests) and round 3 (unit: 156 files, 6,573 tests; type tests: 35
  files, 608 tests).
- No integration test was run: this step changes unit tests only.

## Checks I changed, exempted or worked around

None. No configuration changed, no Stryker patch, no TypeScript checker for Stryker.

## Gaps and unverified claims

- The equivalent and low-value classes are my reading of the source, read twice for the
  equivalent rows; each has its reason in the ledger, but they were not each proven by a
  test. Scratch tests against the hand-applied mutant back the ones I was unsure of (the
  `-0` keys in `keyFinder`, `finishOne`'s `required` at line 632, `new User()`, rows from
  `applyChanges`, a key planted on `Object.prototype`).

## Requests

**Resolved (2026-10-24).** The owner decided all three on 2026-10-24, and
`step/21-hardening` made the changes: a name listed twice is processed once (option b),
every options read is of own properties only, and mutation runs seed fast-check. See
`status/21-hardening.md`. The behaviour the rows held for the owner (411, 1526, 1544) turn on is now tested
there (the code changed, so those mutants are not the same ones; not re-run). The requests as they were raised:

- **For the owner: a field name listed twice.** `validateRequired(["email", "email"])` on a
  blank email gives two identical "can't be blank" errors, and a first
  `cast(User, { age: "x" }, ["age", "age"])` two identical cast errors; a cast over an
  earlier changeset dedupes. Three mutants turn on it (ids 411, 1526, 1544). They are held
  as low value until the owner says whether two errors are intended (then a test pins it)
  or not (then it is a source change, outside this tests-only step).
- **For the owner: options objects inherit keys planted on `Object.prototype`.** Found by
  the reviewer in rounds 4 and 5. Every option is read as a plain property, so any option
  key planted on `Object.prototype` reaches an options object the developer passes (even
  `{}`); without an options object the defaults are right, except where the default is
  itself an object (below). Confirmed by the reviewer with scratch tests:
  - `message`: `validateRequired(["email"], {})` reports the planted text instead of
    "can't be blank";
  - `emptyValues: ["a@b.c"]`: `cast(User, { email: "a@b.c" }, ["email"], {})` reports
    "can't be blank";
  - `forceChanges: true`: casting the same value again records a change;
  - an exception to "without an options object the defaults are right": `castAssoc` and
    `castEmbed` read `options ?? EMPTY`, and `EMPTY` (`Object.freeze({})`,
    `nested/change.ts:37`) still inherits from `Object.prototype`, so with `required: true`
    planted, `castAssoc("leaves")` with no options reports "can't be blank".

  Found by reading the source, not run: `trim` (`validateRequired`), `required`
  (`castAssoc`/`castEmbed`, and `validateConfirmation`'s `options?.required` at
  `changeset.ts:1178`), `errorKey`, `name` and `match` (the constraint declarations),
  `codegen` (schema and repo options), and the options of `castAssoc`/`castEmbed` (`with`)
  and of `validate()` (`scope`, `apply`, `only`). This list may not be complete: the
  follow-up fix has to check every read of an option, including frozen defaults that still
  inherit from `Object.prototype`. The fix is to read options as own properties only,
  everywhere they are read: a source change outside this tests-only step.
- **For the owner: seeding the fast-check properties in mutation runs.** A property without
  a fixed seed can kill a mutant in one run and not the next (`nested/relation.ts:310`
  above), so a mutation run cannot be repeated exactly. The reviewer's suggestion: a setup
  file that calls `fc.configureGlobal({ seed })` only in `vitest.mutation.config.ts`,
  leaving the normal test runs unseeded. Outside this step's files; needs an owner
  decision.

## Review round 1

Review of `4e98be2` (separate reviewer): CHANGES REQUESTED. The sampled tested rows (10 of
10) were killed by the tests the ledger names; 4 of 15 sampled equivalent rows were
untested behaviours. Fixed in this round:

1. **Wrong equivalent rows.** Tested now: `validate.ts:527` (ids 3923, 3927, 3929, 3930,
   a symbol in an issue path), `embed.ts:76` (2651, and 2647 beside it: a field with a
   default and autogenerate), `change.ts:284` (2082: a has-many to a `primaryKey: false`
   schema kept a stored row on `putAssoc(name, [])` instead of deleting it). The re-read of
   all 164 equivalent rows (Method step 2) moved 20 more to tested (a null confirmation;
   list options; params items that are `null`, `undefined` or a `Date`; a custom key type;
   applied embedded rows; `cast` sources that are not one) 7 to low value (frozen-ness,
   error messages of a `TypeError`, misuse), and 2 to the rows held for the owner (1526, 1544). Row 11 of the first sample in
   `status/21-robustness.md` is corrected there, with rows 24-27 of the same sample, and
   that sample's counts and estimate are recomputed (11 real gaps in 30, not 8).
2. **`change.ts:632` (id 2578)** is equivalent, not a tool artifact: my harness had applied
   the mutant at line 625; at line 632 `next` is always a changeset, and `required` acts
   only when it is `null`. Checked by hand: all 553 changeset tests pass with it.
3. **Tests moved** from the three `gaps.test.ts` files into the files of their subjects (see
   the Summary), without the provenance headers; `codegen-late.test.ts` stays (module state,
   see the Summary).
4. **Low-value rows that callers see.** Tested now: `change.ts:322` (2150), `changeset.ts:231`
   (92) and `:2027` (1363). Equivalent: `relation.ts:308` and `:325` (3083, 3107): `-0` and
   `0` are one key in a `Map` and in the scan, which compares with `===` first (both survive
   the `keyFinder` properties when applied by hand). Held for the owner:
   `changeset.ts:881` (411), with ids 1526 and 1544 (Requests). The reason of
   `changeset.ts:1975` (1288) now says a `null` item throws a `TypeError` instead of the
   `QueryError`.
5. The placeholder test "Post exists for the shared imports" is gone with its import.
6. The unseeded fast-check caveat moved to Requests.
7. The note says the base report was not kept (Method step 1).

## Review round 2

Review of `b03cb37`: CHANGES REQUESTED, one finding. Round 1 verified; no test was lost in
the move.

1. **Rows that rest on "no inherited keys".** Four rows classed equivalent were wrong once
   `Object.prototype` holds an enumerable key, which the repo treats as in scope
   (`test/security/hostile-params.test.ts`). Each now has a test under a key planted with
   that file's `plant()` helper, checked against its hand-applied mutant: 2132
   (`nested/change.ts:308`, a stored row cast again records a change), 2619
   (`nested/embed.ts:59`, an unchanged item becomes a new row), 1974 (`nested/change.ts:164`,
   every changeset that settles a relation becomes invalid), 3999
   (`validators/validate.ts:595`, the validator sees the planted key). A search of the
   ledger for every for…in loop and every reason about plain objects or own properties
   (my search in this round) found one more: 3988 (`validators/validate.ts:580`, "the loop only visits keys the
   errors have"): under a planted key the parent turned invalid after routing. Tested the
   same way. 1956 (`nested/change.ts:152`) and 2761 (`nested/embed.ts:182`) hold: the
   planted value is plain data, which is no changeset or nested value, so it is skipped
   either way (both survive by hand under the planted key); their reasons now say so.
   Row 30 (`changeset.ts:200`) holds as well: it reads with `hasOwn`, which a planted key
   does not reach.
2. The Summary, the Results table, the final-run lines and the round sections carry the new
   counts (after round 3: 202 tested, 123 equivalent, 205 low value).
3. The final-run section explains why error ids went from 81 to 76 (five tests match an id each, three of them in `spec.ts`).

Stryker was not re-run for this round; the five new tests were checked by hand.

## Review round 3

Review of `970a980`: CHANGES REQUESTED. The five pollution tests and `plant()`'s cleanup
were confirmed.

1. **2957 and 2958 (`nested/relation.ts:206`)**, found by the reviewer: classed equivalent
   because "an absent association reads as undefined". With the association's name planted
   on `Object.prototype` as `[]` (or `null` for a to-one), either mutant takes an
   association that was never preloaded as loaded and empty: `putAssoc` throws no
   `NotLoadedError`, and the stored rows are neither deleted nor replaced. Tested now
   ("an association's name planted as loaded and empty is still not preloaded", and a
   to-one variant with `null`), both failing with each mutant applied by hand.
   My round-2 search covered for…in loops and reasons about plain objects, not `hasOwn`
   guards in front of a direct read. I widened it: every row in every class on a line with
   a `hasOwn` guard or an `in` loop, and every row whose reason rests on a property being
   absent, `undefined` or inherited (30 rows that were not tested). That search found one
   more: **1552 (`changeset.ts:2286`)**: with a field's name planted, `hasOwn(baseChanges,
   name)` → `true` reads the planted value as an earlier change, so a new record cast with
   that same value records no change. Tested ("a field's name planted with the value given
   is still a change of a new record"). It was already killed in the final run (a timeout),
   so the score does not move; its class was wrong. The others hold, each checked by hand
   where it has a guard: 408 and 1992 copy own keys only; 3912 and 2682-2684 read a planted
   value, which is plain data and never a changeset; 30 and 1821 read rows, whose fields
   are own properties; 3292 and 3294 stay low value (misuse: with a planted `types`, the
   mutant would take a plain object as a changeset without a schema class).
2. The test that checked two behaviours is split into "a validator does not see it" (3999)
   and "routed issues that the child drops leave the parent valid" (3988).
3. The round sections name the extra rows and the search that found each.

Stryker was not re-run for this round; the three new tests were checked by hand.

## Appendix: the ledger

One row per logic survivor of the base run (`7bda82b`), by file and line. Ids are those of
that run. "Tested now" rows name the test that kills the mutant.

### `changeset.ts`

| Id | Line | Mutant | Class | Reason, or the test that kills it now |
|---|---|---|---|---|
| 30 | 200 | ConditionalExpression: `spec.model === null` → `true` | equivalent | schema rows hold every field as an own property; only schemaless data can lack one |
| 49 | 207 | ConditionalExpression: `b === null` → `false` | tested | null over a stored value is a change, whatever the type (cast.test.ts) |
| 51 | 207 | ConditionalExpression: `b === undefined` → `false` | low value | new value undefined reaches same() only through changed({ to: undefined }) |
| 64 | 213 | ConditionalExpression: `typeof value !== "string"` → `false` | tested | validateRequired: an empty list is not blank (validations.test.ts) |
| 92 | 231 | ConditionalExpression: `validation === undefined` → `false` | tested | an error returned without a validation has no validation key (validations.test.ts) |
| 100 | 236 | ConditionalExpression: `a === b` → `false` | equivalent | identity shortcut; the field comparison gives the same answer |
| 112 | 239 | ConditionalExpression: `a.constraint === b.constraint` → `true` | tested | merge keeps errors that differ only in constraint (change.test.ts) |
| 134 | 263 | ConditionalExpression: `existing !== undefined && list.length === exi` → `false` | equivalent | returns an equal new object instead of the same one |
| 147 | 268 | ConditionalExpression: `typeof key !== "string"` → `false` | low value | a non-string error key (misuse) is accepted instead of refused |
| 199 | 505 | BooleanLiteral: `false` → `true` | equivalent | #check appends only when the key has no error yet, so dedupe cannot change the list |
| 203 | 535 | StringLiteral (static): `"putChange"` → `""` | low value | function name in an error message |
| 207 | 549 | StringLiteral: `"forceChange"` → `""` | low value | function name in an error message |
| 209 | 549 | StringLiteral: `"forceChange"` → `""` | low value | function name in an error message |
| 249 | 586 | StringLiteral: `"deleteChange"` → `""` | low value | function name in an error message |
| 251 | 603 | StringLiteral: `"updateChange"` → `""` | low value | function name in an error message |
| 256 | 606 | StringLiteral: `"updateChange"` → `""` | low value | function name in an error message |
| 281 | 631 | ConditionalExpression: `this.action !== null` → `true` | tested | merge takes the other side's action when this one has none (nested/nested.test.ts) |
| 285 | 631 | ConditionalExpression: `this.action !== other.action` → `true` | tested | merge of two changesets with the same action (change.test.ts) |
| 306 | 698 | StringLiteral: `"getField"` → `""` | low value | function name in an error message |
| 307 | 702 | StringLiteral: `"built"` → `""` | tested | getField gives an embed change as a built row (change.test.ts) |
| 313 | 721 | StringLiteral: `"getChange"` → `""` | low value | function name in an error message |
| 315 | 741 | StringLiteral: `"fetchField"` → `""` | low value | function name in an error message |
| 319 | 744 | StringLiteral: `"built"` → `""` | tested | fetchField gives an embed change as a built row (change.test.ts) |
| 329 | 764 | StringLiteral: `"fetchChange"` → `""` | low value | function name in an error message |
| 332 | 786 | StringLiteral: `"isChanged"` → `""` | low value | function name in an error message |
| 372 | 859 | StringLiteral: `"validateRequired"` → `""` | low value | function name in an error message |
| 379 | 863 | ConditionalExpression: `typeof names === "string"` → `false` | tested | validateRequired with one name as a string adds one error (cast.test.ts) |
| 381 | 863 | StringLiteral: `"string"` → `""` | tested | validateRequired with one name as a string adds one error (cast.test.ts) |
| 391 | 866 | StringLiteral: `"validateRequired"` → `""` | low value | function name in an error message |
| 408 | 880 | ConditionalExpression: `hasOwn(nextChanges, name)` → `true` | equivalent | without() of a key that is not there copies the same changes; without() copies own keys only, so a planted key changes nothing |
| 411 | 881 | BooleanLiteral: `false` → `true` | low value | held for the owner: a field name listed twice gives two identical errors on the source and one under the mutant; whether that is intended is asked under Requests (validateRequired) |
| 416 | 897 | StringLiteral: `"validateFormat"` → `""` | low value | function name in an error message |
| 432 | 904 | ConditionalExpression: `value !== null` → `true` | tested | validateFormat skips null (cast.test.ts) |
| 439 | 905 | StringLiteral: `"validateFormat"` → `""` | low value | function name in an error message |
| 460 | 959 | ConditionalExpression: `validation === "inclusion"` → `true` | low value | chooses the function name used in error messages |
| 461 | 959 | ConditionalExpression: `validation === "inclusion"` → `false` | low value | chooses the function name used in error messages |
| 462 | 959 | EqualityOperator: `validation === "inclusion"` → `validation !== "inclusion"` | low value | chooses the function name used in error messages |
| 463 | 959 | StringLiteral: `"inclusion"` → `""` | low value | chooses the function name used in error messages |
| 464 | 959 | StringLiteral: `"validateInclusion"` → `""` | low value | function name in an error message |
| 465 | 959 | StringLiteral: `"validateExclusion"` → `""` | low value | function name in an error message |
| 472 | 962 | ObjectLiteral: `(several lines)` → `{}` | low value | advice parameters of an error |
| 473 | 963 | ObjectLiteral: `{ fn }` → `{}` | low value | advice parameters of an error |
| 483 | 968 | ConditionalExpression: `value !== null` → `true` | tested | validateInclusion and validateExclusion skip null (cast.test.ts) |
| 493 | 991 | StringLiteral: `"validateSubset"` → `""` | low value | function name in an error message |
| 508 | 997 | ConditionalExpression: `value !== null` → `true` | tested | validateSubset skips null (cast.test.ts) |
| 514 | 998 | StringLiteral: `"validateSubset"` → `""` | low value | function name in an error message |
| 524 | 1000 | LogicalOperator: `allowed === element \|\| deepEqual(allowed, e` → `allowed === element && deepEqual(al` | tested | validateSubset compares object elements by value (cast.test.ts) |
| 525 | 1000 | ConditionalExpression: `allowed === element` → `false` | equivalent | identity shortcut; deepEqual gives the same answer |
| 532 | 1007 | StringLiteral: `"subset"` → `""` | tested | validations() names the subset entry and its values (validations.test.ts) |
| 533 | 1007 | StringLiteral: `"values"` → `""` | tested | validations() names the subset entry and its values (validations.test.ts) |
| 536 | 1029 | StringLiteral: `"validateLength"` → `""` | low value | function name in an error message |
| 540 | 1030 | ConditionalExpression: `typeof options !== "object"` → `false` | low value | options that are not an object are refused anyway, by the no-limit check |
| 564 | 1037 | CallExpression: `checkLimit(is);` → `;` | tested | validateLength checks is (cast.test.ts) |
| 588 | 1047 | StringLiteral: `"validateLength"` → `""` | low value | function name in an error message |
| 621 | 1065 | StringLiteral: `"validateLength"` → `""` | low value | function name in an error message |
| 634 | 1070 | ConditionalExpression: `min !== undefined` → `true` | equivalent | length < undefined is false |
| 643 | 1072 | ConditionalExpression: `max !== undefined` → `true` | equivalent | length > undefined is false |
| 666 | 1097 | StringLiteral: `"validateNumber"` → `""` | low value | function name in an error message |
| 668 | 1098 | ConditionalExpression: `typeof options !== "object" \|\| options === ` → `false` | low value | options that are not an object are refused anyway (unknown option or no limit) |
| 669 | 1098 | LogicalOperator: `typeof options !== "object" \|\| options === ` → `typeof options !== "object" && opti` | low value | options that are not an object are refused anyway (unknown option or no limit) |
| 670 | 1098 | ConditionalExpression: `typeof options !== "object"` → `false` | low value | options that are not an object are refused anyway (unknown option or no limit) |
| 673 | 1098 | ConditionalExpression: `options === null` → `false` | low value | options that are not an object are refused anyway (unknown option or no limit) |
| 675 | 1098 | BlockStatement: `(several lines)` → `{}` | low value | options that are not an object are refused anyway (unknown option or no limit) |
| 687 | 1105 | UpdateOperator: `limits++` → `limits--` | equivalent | the count is only compared with zero; a negative count is not zero either |
| 725 | 1123 | ConditionalExpression: `value !== null` → `true` | tested | validateNumber skips null (cast.test.ts) |
| 738 | 1125 | StringLiteral: `"validateNumber"` → `""` | low value | function name in an error message |
| 757 | 1162 | StringLiteral: `"validateConfirmation"` → `""` | low value | function name in an error message |
| 760 | 1163 | StringLiteral: `"validateConfirmation"` → `""` | low value | function name in an error message |
| 767 | 1168 | ConditionalExpression: `params !== null` → `true` | tested | validateConfirmation on a changeset without params (cast.test.ts) |
| 796 | 1199 | StringLiteral: `"validateAcceptance"` → `""` | low value | function name in an error message |
| 799 | 1200 | StringLiteral: `"validateAcceptance"` → `""` | low value | function name in an error message |
| 821 | 1231 | StringLiteral: `"validateChange"` → `""` | low value | function name in an error message |
| 844 | 1241 | StringLiteral: `"change"` → `""` | tested | validations() records a passing validateChange (validations.test.ts) |
| 845 | 1245 | StringLiteral: `"change"` → `""` | tested | validations() records a failing validateChange (validations.test.ts) |
| 846 | 1248 | BooleanLiteral: `false` → `true` | low value | dedupes only two identical issues returned by one validator call |
| 847 | 1249 | BooleanLiteral: `false` → `true` | tested | a failing validateChange makes the changeset invalid (cast.test.ts) |
| 858 | 1453 | StringLiteral: `"addError"` → `""` | low value | function name in an error message |
| 868 | 1456 | ConditionalExpression: `meta === undefined` → `false` | low value | only whether the meta of the error is frozen differs; meta is readonly by type |
| 889 | 1508 | StringLiteral: `"uniqueConstraint"` → `""` | low value | function name in an error message |
| 896 | 1515 | StringLiteral: `"uniqueConstraint"` → `""` | low value | function name in an error message |
| 898 | 1532 | StringLiteral: `"foreignKeyConstraint"` → `""` | low value | function name in an error message |
| 902 | 1536 | StringLiteral: `"foreignKeyConstraint"` → `""` | low value | function name in an error message |
| 904 | 1539 | StringLiteral: `"foreignKeyConstraint"` → `""` | low value | function name in an error message |
| 906 | 1555 | StringLiteral: `"assocConstraint"` → `""` | low value | function name in an error message |
| 919 | 1566 | StringLiteral: `"assocConstraint"` → `""` | low value | function name in an error message |
| 920 | 1566 | StringLiteral: `"_"` → `""` | tested | assocConstraint default name of a two-column key (change.test.ts) |
| 922 | 1569 | StringLiteral: `"assocConstraint"` → `""` | low value | function name in an error message |
| 924 | 1587 | StringLiteral: `"noAssocConstraint"` → `""` | low value | function name in an error message |
| 951 | 1599 | StringLiteral: `"_"` → `""` | tested | noAssocConstraint default name of a two-column key (change.test.ts) |
| 953 | 1602 | StringLiteral: `"noAssocConstraint"` → `""` | low value | function name in an error message |
| 956 | 1618 | StringLiteral: `"checkConstraint"` → `""` | low value | function name in an error message |
| 972 | 1622 | ArrowFunction: `() => options.name` → `() => undefined` | equivalent | checkConstraint always has a name, which wins over the default |
| 976 | 1637 | StringLiteral: `"exclusionConstraint"` → `""` | low value | function name in an error message |
| 980 | 1641 | StringLiteral: `"exclusionConstraint"` → `""` | low value | function name in an error message |
| 982 | 1644 | StringLiteral: `"exclusionConstraint"` → `""` | low value | function name in an error message |
| 996 | 1653 | ConditionalExpression: `this.#spec.model === null` → `true` | low value | chooses the wording of an error message |
| 1083 | 1736 | StringLiteral: `"optimisticLock"` → `""` | low value | function name in an error message |
| 1101 | 1741 | ConditionalExpression: `current === undefined` → `false` | tested | optimisticLock refuses a field with no current value (constraints.test.ts) |
| 1112 | 1744 | ConditionalExpression: `increment === undefined` → `true` | tested | a field with no current value is refused; a custom incrementer works on any type (constraints.test.ts) |
| 1141 | 1819 | StringLiteral: `"validateUniqueAsync"` → `""` | low value | function name in an error message |
| 1167 | 1892 | ConditionalExpression: `value !== undefined` → `true` | low value | a JSON key holding undefined, which JSON.stringify drops |
| 1207 | 1930 | ConditionalExpression: `value <= limit` → `true` | tested | equalTo fails for a value above the limit (validations.test.ts) |
| 1231 | 1946 | ConditionalExpression: `confirmation === undefined \|\| confirmation ` → `false` | tested | a null confirmation does not match, even for a type whose cast turns null into the value (validations.test.ts) |
| 1232 | 1946 | LogicalOperator: `confirmation === undefined \|\| confirmation ` → `confirmation === undefined && confi` | tested | a null confirmation does not match, even for a type whose cast turns null into the value (validations.test.ts) |
| 1233 | 1946 | ConditionalExpression: `confirmation === undefined` → `false` | equivalent | validateConfirmation passes no undefined confirmation (it checks params[key] !== undefined first) |
| 1235 | 1946 | ConditionalExpression: `confirmation === null` → `false` | tested | a null confirmation does not match, even for a type whose cast turns null into the value (validations.test.ts) |
| 1251 | 1952 | ConditionalExpression: `typeof limit !== "number"` → `false` | equivalent | a limit that is not a number fails Number.isInteger too |
| 1262 | 1960 | BlockStatement: `(several lines)` → `{}` | tested | a validator given a value of the wrong type throws a QueryError (cast.test.ts) |
| 1271 | 1969 | ConditionalExpression: `result === null` → `false` | tested | validateChange returning null is no issue (validators/validate.test.ts) |
| 1274 | 1970 | ConditionalExpression: `Array.isArray(result) && result.length === 0` → `false` | equivalent | an empty list maps to an empty list |
| 1288 | 1975 | ConditionalExpression: `(several lines)` → `true` | low value | a validator result of the wrong shape (misuse): under the mutant a null item throws a TypeError instead of the QueryError |
| 1289 | 1975 | LogicalOperator: `(several lines)` → `typeof item === "object" \|\| item ` | low value | a validator result of the wrong shape (misuse) is taken instead of refused |
| 1290 | 1975 | ConditionalExpression: `typeof item === "object"` → `true` | low value | only a function returned as an error, with a message property, which the return type forbids |
| 1293 | 1976 | ConditionalExpression: `item !== null` → `true` | low value | a null item (misuse) throws a TypeError instead of a QueryError |
| 1329 | 2000 | ConditionalExpression: `at.validation !== undefined` → `true` | equivalent | the descriptor of an entry without a validation already holds its options |
| 1361 | 2025 | ConditionalExpression: `hasOwn(data, field.name) \|\| hasOwn(changes,` → `false` | tested | schemaless applyChanges keeps the data's value over the default (cast.test.ts) |
| 1362 | 2025 | LogicalOperator: `hasOwn(data, field.name) \|\| hasOwn(changes,` → `hasOwn(data, field.name) && hasOwn(` | tested | schemaless applyChanges keeps the data's value over the default (cast.test.ts) |
| 1363 | 2027 | ConditionalExpression: `value !== undefined` → `true` | tested | without a schema class, a field with no value and no default is not a key (change.test.ts) |
| 1371 | 2034 | ConditionalExpression: `!hasOwn(changes, name)` → `false` | tested | schemaless applyChanges keeps an embed with no change (cast.test.ts) |
| 1373 | 2036 | StringLiteral: `"built"` → `""` | tested | schemaless applyChanges gives a built embed row (change.test.ts) |
| 1382 | 2046 | StringLiteral: `"built"` → `""` | tested | applyChanges gives a built embed row (change.test.ts) |
| 1397 | 2070 | MethodExpression: `value.some((item) => item instanceof Changese` → `value.every(item => item instanceof` | equivalent | a nested list is all changesets or none |
| 1404 | 2088 | ConditionalExpression: `shown !== changes[key]` → `true` | equivalent | copies the changes when nothing differs; the same values |
| 1413 | 2099 | BooleanLiteral: `false` → `true` | equivalent | the struct formatter redacts the same fields again; the output is the same |
| 1435 | 2146 | ConditionalExpression: `value.length > 0` → `true` | equivalent | an empty list has no child errors either way |
| 1436 | 2146 | EqualityOperator: `value.length > 0` → `value.length >= 0` | equivalent | an empty list has no child errors either way |
| 1438 | 2146 | MethodExpression: `value.every((item) => item instanceof Changes` → `value.some(item => item instanceof ` | equivalent | a nested list is all changesets or none |
| 1464 | 2239 | BlockStatement: `(several lines)` → `{}` | low value | cast() permitted that is not an array (misuse) is not refused |
| 1526 | 2265 | ConditionalExpression: `base !== undefined` → `true` | low value | held for the owner: a field name listed twice gives two identical errors on the source and one under the mutant; whether that is intended is asked under Requests (a first cast, null for a required field) |
| 1527 | 2265 | ConditionalExpression: `base !== undefined` → `false` | tested | casting null twice reports the required error once (cast.test.ts) |
| 1528 | 2265 | EqualityOperator: `base !== undefined` → `base === undefined` | tested | casting null twice reports the required error once (cast.test.ts) |
| 1536 | 2273 | ConditionalExpression: `result.meta === undefined` → `false` | equivalent | spreading undefined meta adds nothing |
| 1544 | 2278 | ConditionalExpression: `base !== undefined` → `true` | low value | held for the owner: a field name listed twice gives two identical errors on the source and one under the mutant; whether that is intended is asked under Requests (a first cast, a value the type refuses) |
| 1552 | 2286 | ConditionalExpression: `hasOwn(baseChanges, name)` → `true` | tested | a field's name planted with the value given is still a change of a new record (test/security/hostile-params.test.ts) |
| 1573 | 2305 | ConditionalExpression: `base.params === null` → `false` | equivalent | spreading null params adds nothing |
| 1600 | 2353 | StringLiteral (static): `"change"` → `""` | low value | function name in an error message |
| 1606 | 2370 | ConditionalExpression (static): `typeof values !== "object" \|\| values === nu` → `false` | low value | change() values that are not an object (misuse) are refused anyway, with another error |
| 1607 | 2370 | LogicalOperator (static): `typeof values !== "object" \|\| values === nu` → `typeof values !== "object" && value` | low value | change() values that are not an object (misuse) are refused anyway, with another error |
| 1608 | 2370 | ConditionalExpression (static): `typeof values !== "object"` → `false` | low value | change() values that are not an object (misuse) are refused anyway, with another error |
| 1611 | 2370 | ConditionalExpression (static): `values === null` → `false` | low value | change() with null values (misuse) throws a TypeError instead of a QueryError |
| 1613 | 2370 | BlockStatement: `(several lines)` → `{}` | low value | change() values that are not an object (misuse) are refused anyway, with another error |
| 1622 | 2377 | StringLiteral (static): `"change"` → `""` | low value | function name in an error message |
| 1624 | 2378 | ConditionalExpression (static): `spec.embeds.has(key)` → `false` | tested | refuses an embed field, which putEmbed changes (change.test.ts) |
| 1625 | 2378 | BlockStatement: `(several lines)` → `{}` | tested | refuses an embed field, which putEmbed changes (change.test.ts) |
| 1629 | 2379 | ObjectLiteral: `{ params: { key } }` → `{}` | low value | advice parameters of an error |
| 1630 | 2379 | ObjectLiteral: `{ key }` → `{}` | low value | advice parameters of an error |
| 1639 | 2410 | ConditionalExpression: `changeset.data === null` → `true` | equivalent | applied() of a loaded row's changeset is harmless; its result is discarded |
| 1658 | 2556 | BooleanLiteral: `false` → `true` | low value | dedupes only identical issues added in one call |
| 1662 | 2583 | StringLiteral: `"valueBefore"` → `""` | low value | function name in an error message |

### `nested/change.ts`

| Id | Line | Mutant | Class | Reason, or the test that kills it now |
|---|---|---|---|---|
| 1846 | 41 | StringLiteral (static): `"required"` → `""` | tested | a nested required error has the validation required (cast.test.ts) |
| 1867 | 73 | LogicalOperator: `typeof options !== "object" \|\| options === ` → `(typeof options !== "object" \|\| o` | tested | options given as a list are refused (nested/nested.test.ts) |
| 1868 | 73 | ConditionalExpression: `typeof options !== "object" \|\| options === ` → `false` | equivalent | isItem refuses the same options anyway |
| 1869 | 73 | LogicalOperator: `typeof options !== "object" \|\| options === ` → `typeof options !== "object" && opti` | equivalent | isItem refuses the same options anyway |
| 1870 | 73 | ConditionalExpression: `typeof options !== "object"` → `false` | equivalent | isItem refuses the same options anyway |
| 1873 | 73 | ConditionalExpression: `options === null` → `false` | equivalent | isItem refuses the same options anyway |
| 1945 | 119 | ConditionalExpression: `child.model === null` → `true` | low value | wording of an error message |
| 1946 | 119 | ConditionalExpression: `child.model === null` → `false` | low value | wording of an error message |
| 1947 | 119 | EqualityOperator: `child.model === null` → `child.model !== null` | low value | wording of an error message |
| 1949 | 120 | ObjectLiteral: `{ params: { target: relation.targetMeta.name ` → `{}` | low value | advice parameters of an error |
| 1950 | 120 | ObjectLiteral: `{ target: relation.targetMeta.name }` → `{}` | low value | advice parameters of an error |
| 1956 | 152 | ConditionalExpression: `!hasOwn(changes, key)` → `false` | equivalent | a key planted on Object.prototype is visited, but its value is plain data, which is no changeset or nested value, so it is skipped either way; checked by hand under a planted key |
| 1958 | 154 | ConditionalExpression: `value instanceof Changeset` → `false` | tested | an invalid single child makes the parent invalid (nested/nested.test.ts) |
| 1959 | 154 | BlockStatement: `(several lines)` → `{}` | tested | an invalid single child makes the parent invalid (nested/nested.test.ts) |
| 1962 | 155 | ConditionalExpression: `!value.valid` → `false` | tested | an invalid single child makes the parent invalid (nested/nested.test.ts) |
| 1963 | 155 | BooleanLiteral: `false` → `true` | tested | an invalid single child makes the parent invalid (nested/nested.test.ts) |
| 1974 | 164 | ConditionalExpression: `hasOwn(errors, key)` → `true` | tested | a changeset that settles a relation stays valid, under a planted key (test/security/hostile-params.test.ts) |
| 1980 | 174 | ConditionalExpression: `existing === undefined` → `true` | tested | a relation keeps both of two errors of its own (nested/nested.test.ts) |
| 1984 | 174 | ArrayDeclaration (no coverage): `[...existing, error]` → `[]` | tested | a relation keeps both of two errors of its own (nested/nested.test.ts) |
| 1987 | 190 | ConditionalExpression: `value === undefined` → `false` | tested | dropping a nested change leaves no key holding undefined (cast.test.ts) |
| 1992 | 191 | ConditionalExpression: `!hasOwn(before, relation.name)` → `false` | equivalent | a copy without an absent key holds the same changes; the copy takes own keys only, so a planted key changes nothing |
| 1995 | 194 | ConditionalExpression: `key !== relation.name` → `false` | tested | dropping a nested change keeps the other changes (nested/nested.test.ts) |
| 2000 | 202 | ConditionalExpression: `changes === before && errors === parent.error` → `false` | equivalent | rebuilds an equal changeset instead of returning the same one |
| 2012 | 208 | ConditionalExpression: `relation.kind === "embed"` → `true` | low value | chooses the advice of an error |
| 2013 | 208 | ConditionalExpression: `relation.kind === "embed"` → `false` | low value | chooses the advice of an error |
| 2014 | 208 | EqualityOperator: `relation.kind === "embed"` → `relation.kind !== "embed"` | low value | chooses the advice of an error |
| 2019 | 210 | StringLiteral: `'{ onReplace: "${relation.many ? "delete" : "` → `''` | low value | advice of an error |
| 2020 | 210 | StringLiteral: `"delete"` → `""` | low value | advice of an error |
| 2021 | 210 | StringLiteral: `"update"` → `""` | low value | advice of an error |
| 2026 | 214 | ObjectLiteral: `(several lines)` → `{}` | low value | advice parameters of an error |
| 2027 | 215 | ObjectLiteral: `(several lines)` → `{}` | low value | advice parameters of an error |
| 2030 | 218 | ConditionalExpression: `relation.kind === "embed"` → `true` | low value | advice parameters of an error |
| 2031 | 218 | ConditionalExpression: `relation.kind === "embed"` → `false` | low value | advice parameters of an error |
| 2032 | 218 | EqualityOperator: `relation.kind === "embed"` → `relation.kind !== "embed"` | low value | advice parameters of an error |
| 2033 | 218 | StringLiteral: `"embed"` → `""` | low value | advice parameters of an error |
| 2034 | 218 | StringLiteral: `""` → `"Stryker was here!"` | low value | advice parameters of an error |
| 2035 | 218 | StringLiteral: `', "deleteIfExists", "setNull"'` → `""` | low value | advice parameters of an error |
| 2036 | 219 | StringLiteral: `""` → `"Stryker was here!"` | low value | advice parameters of an error |
| 2037 | 219 | StringLiteral: `' and "update"'` → `""` | low value | advice parameters of an error |
| 2042 | 233 | ConditionalExpression: `assoc === undefined` → `false` | equivalent | only embeds have no association, and an embed cannot take setNull |
| 2068 | 254 | OptionalChaining: `assoc?.relatedKey` → `assoc.relatedKey` | equivalent | only embeds have no association, and an embed cannot take setNull |
| 2069 | 254 | ArrayDeclaration (no coverage): `[]` → `["Stryker was here"]` | equivalent | only embeds have no association, and an embed cannot take setNull |
| 2082 | 284 | ConditionalExpression: `relation.kind === "embed"` → `true` | tested | a has-many to a schema without a primary key deletes a stored row left out (nested/nested.test.ts) |
| 2110 | 295 | ConditionalExpression: `children.length === 0` → `true` | tested | required is met by children (validators/validate.test.ts) |
| 2118 | 297 | ConditionalExpression: `extra.length === 0` → `true` | tested | with an error on it, the relation keeps its change (nested/nested.test.ts) |
| 2125 | 307 | ConditionalExpression: `!child.valid \|\| child.action !== "update"` → `false` | tested | a stored row put back with an error and no change makes the parent invalid (nested/nested.test.ts) |
| 2126 | 307 | LogicalOperator: `!child.valid \|\| child.action !== "update"` → `!child.valid && child.action !== "u` | tested | a stored row put back with an error and no change makes the parent invalid (nested/nested.test.ts) |
| 2128 | 307 | ConditionalExpression: `child.action !== "update"` → `false` | equivalent | a matched child always comes from childOf as an update |
| 2131 | 307 | BooleanLiteral (no coverage): `false` → `true` | tested | a stored row put back with an error and no change makes the parent invalid (nested/nested.test.ts) |
| 2132 | 308 | ConditionalExpression: `hasOwn(child.changes, key)` → `true` | tested | the same stored row cast again records no change, under a planted key (test/security/hostile-params.test.ts) |
| 2148 | 322 | ConditionalExpression: `child.action !== "insert" \|\| !child.valid` → `false` | tested | an invalid keyless item equal to the stored one is a change (nested/nested.test.ts) |
| 2149 | 322 | LogicalOperator: `child.action !== "insert" \|\| !child.valid` → `child.action !== "insert" && !child` | tested | an invalid keyless item equal to the stored one is a change (nested/nested.test.ts) |
| 2150 | 322 | ConditionalExpression: `child.action !== "insert"` → `false` | tested | a stored row of a keyless list put back as its own changeset is written again (nested/nested.test.ts) |
| 2167 | 336 | ConditionalExpression: `value instanceof Changeset \|\| Array.isArray` → `false` | tested | a keyless item with a list value is always a change (nested/nested.test.ts) |
| 2168 | 336 | LogicalOperator: `value instanceof Changeset \|\| Array.isArray` → `value instanceof Changeset && Array` | tested | a keyless item with a list value is always a change (nested/nested.test.ts) |
| 2169 | 336 | BooleanLiteral (no coverage): `false` → `true` | tested | a keyless item with a list value is always a change (nested/nested.test.ts) |
| 2171 | 338 | ConditionalExpression: `value === stored` → `false` | tested | a keyless item with an equal null is no change (cast.test.ts) |
| 2174 | 339 | ConditionalExpression: `value === null \|\| value === undefined \|\| ` → `false` | tested | a keyless item with a date replaced by null, or null by a date, is a change (nested/nested.test.ts) |
| 2175 | 339 | LogicalOperator: `value === null \|\| value === undefined \|\| ` → `(value === null \|\| value === unde` | tested | a keyless item with a date replaced by null, or null by a date, is a change (nested/nested.test.ts) |
| 2176 | 339 | ConditionalExpression: `value === null \|\| value === undefined \|\| ` → `false` | tested | a keyless item with a date replaced by null, or null by a date, is a change (nested/nested.test.ts) |
| 2177 | 339 | LogicalOperator: `value === null \|\| value === undefined \|\| ` → `(value === null \|\| value === unde` | tested | a keyless item with a date replaced by null, or null by a date, is a change (nested/nested.test.ts) |
| 2178 | 339 | ConditionalExpression: `value === null \|\| value === undefined` → `false` | tested | a keyless item with a date replaced by null, or null by a date, is a change (nested/nested.test.ts) |
| 2179 | 339 | LogicalOperator: `value === null \|\| value === undefined` → `value === null && value === undefin` | tested | a keyless item with a date replaced by null, or null by a date, is a change (nested/nested.test.ts) |
| 2180 | 339 | ConditionalExpression: `value === null` → `false` | tested | a keyless item with a date replaced by null is a change (nested/nested.test.ts) |
| 2182 | 339 | ConditionalExpression: `value === undefined` → `false` | tested | a keyless item missing a required date is a change (nested/nested.test.ts) |
| 2184 | 339 | ConditionalExpression: `stored === null` → `false` | tested | a keyless item with null replaced by a date is a change (nested/nested.test.ts) |
| 2186 | 339 | ConditionalExpression: `stored === undefined` → `false` | tested | an applied keyless embedded row without a required date is compared without fault (nested/nested.test.ts) |
| 2188 | 339 | BooleanLiteral (no coverage): `false` → `true` | tested | a keyless item with a date replaced by null is a change (nested/nested.test.ts) |
| 2195 | 347 | ConditionalExpression: `fallback !== undefined` → `true` | tested | a keyless item compares with a default given by a function (change.test.ts) |
| 2198 | 347 | ConditionalExpression: `fallback.kind === "value"` → `true` | tested | a keyless item compares with a default given by a function (change.test.ts) |
| 2207 | 354 | ConditionalExpression: `data === null \|\| typeof data !== "object" \` → `true` | tested | a change of a copy with the stored key is that row (nested/nested.test.ts) |
| 2214 | 354 | ConditionalExpression: `typeof data !== "object"` → `false` | equivalent | a child's data is a row or null, never a primitive |
| 2215 | 354 | EqualityOperator: `typeof data !== "object"` → `typeof data === "object"` | tested | a change of a copy with the stored key is that row (nested/nested.test.ts) |
| 2216 | 354 | StringLiteral: `"object"` → `""` | tested | a change of a copy with the stored key is that row (nested/nested.test.ts) |
| 2217 | 354 | ConditionalExpression: `relation.key.length === 0` → `false` | equivalent | indexOfRow with an empty key finds nothing anyway |
| 2218 | 354 | EqualityOperator: `relation.key.length === 0` → `relation.key.length !== 0` | tested | a change of a copy with the stored key is that row (nested/nested.test.ts) |
| 2221 | 355 | ConditionalExpression: `indexOfRow([current], relation.key, data) ===` → `false` | tested | a change of a copy with the stored key is that row (nested/nested.test.ts) |
| 2223 | 355 | ArrayDeclaration: `[current]` → `[]` | tested | a change of a copy with the stored key is that row (nested/nested.test.ts) |
| 2259 | 389 | ConditionalExpression: `(several lines)` → `default:` | equivalent | both cases only break |
| 2270 | 395 | OptionalChaining: `relation.assoc?.ownerKey` → `relation.assoc.ownerKey` | equivalent | a belongsTo relation always has its association |
| 2271 | 395 | ArrayDeclaration (no coverage): `[]` → `["Stryker was here"]` | equivalent | a belongsTo relation always has its association |
| 2283 | 405 | ConditionalExpression: `next === null` → `true` | tested | required is met by a value on a to-one relation (nested/nested.test.ts) |
| 2290 | 407 | ConditionalExpression: `extra.length === 0` → `true` | tested | a blank to-one relation keeps its change (nested/nested.test.ts) |
| 2304 | 408 | ConditionalExpression: `next !== null` → `true` | equivalent | kept is false when next is null, so the rest is never read |
| 2308 | 434 | StringLiteral: `"castEmbed"` → `""` | low value | function name in an error message |
| 2309 | 434 | StringLiteral: `"castAssoc"` → `""` | low value | function name in an error message |
| 2311 | 435 | StringLiteral: `"assoc"` → `""` | low value | kind name in an error message |
| 2319 | 442 | ObjectLiteral: `{ params: { embed: embed ? "putEmbed" : "putA` → `{}` | low value | advice parameters of an error |
| 2320 | 442 | ObjectLiteral: `{ embed: embed ? "putEmbed" : "putAssoc" }` → `{}` | low value | advice parameters of an error |
| 2365 | 465 | ConditionalExpression: `at >= 0` → `true` | equivalent | taken never holds -1 |
| 2377 | 469 | UnaryOperator: `-1` → `+1` | tested | a duplicate in a cast does not keep another stored row (nested/nested.test.ts) |
| 2378 | 472 | ConditionalExpression: `at >= 0` → `true` | equivalent | adding -1 to taken changes nothing that is read |
| 2399 | 485 | BooleanLiteral: `true` → `false` | tested | a to-one cast key given as text is cast before it is matched (nested/nested.test.ts) |
| 2403 | 487 | ConditionalExpression: `existing !== undefined` → `true` | tested | onReplace update with no row there inserts (nested/nested.test.ts) |
| 2441 | 518 | ObjectLiteral: `{ params: { target: relation.targetMeta.name ` → `{}` | low value | advice parameters of an error |
| 2442 | 518 | ObjectLiteral: `{ target: relation.targetMeta.name }` → `{}` | low value | advice parameters of an error |
| 2448 | 527 | BooleanLiteral: `false` → `true` | tested | putAssoc matches a plain object by its key as given, without casting (nested/nested.test.ts) |
| 2455 | 529 | EqualityOperator: `at >= 0` → `at > 0` | tested | putAssoc of a plain object for the first stored row is an update (nested/nested.test.ts) |
| 2460 | 530 | EqualityOperator: `at >= 0` → `at > 0` | tested | putAssoc of a plain object for the first stored row is an update (nested/nested.test.ts) |
| 2467 | 535 | ObjectLiteral: `{ params: { target: relation.targetMeta.name ` → `{}` | low value | advice parameters of an error |
| 2468 | 535 | ObjectLiteral: `{ target: relation.targetMeta.name }` → `{}` | low value | advice parameters of an error |
| 2474 | 549 | ConditionalExpression: `field !== undefined` → `true` | equivalent | a key that is not a field is no embed either way |
| 2492 | 552 | ArrayDeclaration: `[]` → `["Stryker was here"]` | equivalent | a placeholder entry reads an undefined value and is skipped |
| 2498 | 558 | ObjectLiteral: `{ params: { target: targetMeta.name } }` → `{}` | low value | advice parameters of an error |
| 2499 | 558 | ObjectLiteral: `{ target: targetMeta.name }` → `{}` | low value | advice parameters of an error |
| 2501 | 563 | ArrayDeclaration: `[]` → `["Stryker was here"]` | equivalent | a placeholder entry reads an undefined value and is skipped |
| 2504 | 565 | ConditionalExpression: `value === undefined` → `false` | tested | an association key holding undefined in a plain object is skipped (nested/nested.test.ts) |
| 2506 | 566 | MethodExpression: `targetMeta.embeds.some((embed) => embed.name ` → `targetMeta.embeds.every(embed => em` | tested | an association of a target without embeds is put as an association (nested/nested.test.ts) |
| 2508 | 566 | ConditionalExpression: `embed.name === key` → `true` | tested | an association of a target with embeds is put as an association (nested/nested.test.ts) |
| 2512 | 586 | StringLiteral: `"putEmbed"` → `""` | low value | function name in an error message |
| 2515 | 587 | StringLiteral: `"assoc"` → `""` | low value | kind name in an error message |
| 2523 | 589 | ObjectLiteral: `(several lines)` → `{}` | low value | advice parameters of an error |
| 2524 | 590 | ObjectLiteral: `{ what: relation.many ? "a list" : "a value o` → `{}` | low value | advice parameters of an error |
| 2540 | 604 | ArrayDeclaration: `[]` → `["Stryker was here"]` | equivalent | a placeholder row has no key fields and matches nothing |
| 2569 | 629 | ConditionalExpression: `at < 0` → `true` | equivalent | a matched value gives the same update of the stored row either way |
| 2570 | 629 | EqualityOperator: `at < 0` → `at <= 0` | equivalent | a matched value gives the same update of the stored row either way |
| 2578 | 632 | BooleanLiteral: `false` → `true` | equivalent | required acts only when next is null, and at line 632 next is always a changeset (the putItem child, or withAction(...)) |

### `nested/relation.ts`

| Id | Line | Mutant | Class | Reason, or the test that kills it now |
|---|---|---|---|---|
| 2775 | 57 | BlockStatement: `(several lines)` → `{}` | low value | describe() words a value for error messages only |
| 2776 | 58 | ConditionalExpression: `value === null` → `true` | low value | describe() words a value for error messages only |
| 2777 | 58 | ConditionalExpression: `value === null` → `false` | low value | describe() words a value for error messages only |
| 2778 | 58 | EqualityOperator: `value === null` → `value !== null` | low value | describe() words a value for error messages only |
| 2779 | 58 | StringLiteral (no coverage): `"null"` → `""` | low value | describe() words a value for error messages only |
| 2780 | 59 | ConditionalExpression: `Array.isArray(value)` → `true` | low value | describe() words a value for error messages only |
| 2781 | 59 | ConditionalExpression: `Array.isArray(value)` → `false` | low value | describe() words a value for error messages only |
| 2782 | 59 | StringLiteral (no coverage): `"an array"` → `""` | low value | describe() words a value for error messages only |
| 2783 | 60 | ConditionalExpression: `typeof value === "object"` → `true` | low value | describe() words a value for error messages only |
| 2784 | 60 | ConditionalExpression: `typeof value === "object"` → `false` | low value | describe() words a value for error messages only |
| 2785 | 60 | EqualityOperator: `typeof value === "object"` → `typeof value !== "object"` | low value | describe() words a value for error messages only |
| 2786 | 60 | StringLiteral: `"object"` → `""` | low value | describe() words a value for error messages only |
| 2787 | 60 | StringLiteral (no coverage): `"an object"` → `""` | low value | describe() words a value for error messages only |
| 2788 | 60 | StringLiteral: `'a ${typeof value}'` → `''` | low value | describe() words a value for error messages only |
| 2790 | 78 | ConditionalExpression: `model === null` → `true` | equivalent | the relation cache; without it the same relation is built again |
| 2793 | 80 | ConditionalExpression: `byName === undefined` → `true` | equivalent | the relation cache; without it the same relation is built again |
| 2797 | 82 | CallExpression: `relations.set(cacheKey, byName);` → `;` | equivalent | the relation cache; without it the same relation is built again |
| 2807 | 88 | ConditionalExpression: `known !== undefined` → `false` | equivalent | the relation cache; without it the same relation is built again |
| 2813 | 91 | CallExpression: `byName.set(id, relation);` → `;` | equivalent | the relation cache; without it the same relation is built again |
| 2814 | 95 | BlockStatement: `(several lines)` → `{}` | low value | owner name in an error message |
| 2815 | 96 | ConditionalExpression: `model === null` → `true` | low value | owner name in an error message |
| 2816 | 96 | ConditionalExpression: `model === null` → `false` | low value | owner name in an error message |
| 2817 | 96 | EqualityOperator: `model === null` → `model !== null` | low value | owner name in an error message |
| 2818 | 96 | StringLiteral (no coverage): `"this changeset without a schema class"` → `""` | low value | owner name in an error message |
| 2826 | 107 | ConditionalExpression: `field === undefined` → `false` | equivalent | a missing field has no embed type either, so the same branch is taken |
| 2840 | 112 | ObjectLiteral: `{ params: { fn: fn === "castEmbed" ? "castAss` → `{}` | low value | advice parameters of an error |
| 2841 | 112 | ObjectLiteral: `{ fn: fn === "castEmbed" ? "castAssoc" : "put` → `{}` | low value | advice parameters of an error |
| 2842 | 112 | ConditionalExpression: `fn === "castEmbed"` → `true` | low value | advice parameters of an error |
| 2843 | 112 | ConditionalExpression: `fn === "castEmbed"` → `false` | low value | advice parameters of an error |
| 2844 | 112 | EqualityOperator: `fn === "castEmbed"` → `fn !== "castEmbed"` | low value | advice parameters of an error |
| 2855 | 120 | ObjectLiteral: `{ params: { fn, other: fn === "castEmbed" ? "` → `{}` | low value | advice parameters of an error |
| 2856 | 120 | ObjectLiteral: `{ fn, other: fn === "castEmbed" ? "cast" : "p` → `{}` | low value | advice parameters of an error |
| 2857 | 120 | ConditionalExpression: `fn === "castEmbed"` → `true` | low value | advice parameters of an error |
| 2858 | 120 | ConditionalExpression: `fn === "castEmbed"` → `false` | low value | advice parameters of an error |
| 2859 | 120 | EqualityOperator: `fn === "castEmbed"` → `fn !== "castEmbed"` | low value | advice parameters of an error |
| 2864 | 127 | ConditionalExpression: `model === null` → `true` | low value | owner name shown in errors of a changeset without a schema class |
| 2867 | 127 | StringLiteral: `"schemaless"` → `""` | low value | owner name shown in errors of a changeset without a schema class |
| 2896 | 159 | ObjectLiteral: `{ params: { fn: fn === "castAssoc" ? "castEmb` → `{}` | low value | advice parameters of an error |
| 2897 | 159 | ObjectLiteral: `{ fn: fn === "castAssoc" ? "castEmbed" : "put` → `{}` | low value | advice parameters of an error |
| 2898 | 159 | ConditionalExpression: `fn === "castAssoc"` → `true` | low value | advice parameters of an error |
| 2899 | 159 | ConditionalExpression: `fn === "castAssoc"` → `false` | low value | advice parameters of an error |
| 2900 | 159 | EqualityOperator: `fn === "castAssoc"` → `fn !== "castAssoc"` | low value | advice parameters of an error |
| 2904 | 162 | ArrayDeclaration: `[...ownerMeta.assocs().keys()]` → `[]` | low value | list of associations in an error message |
| 2908 | 165 | ConditionalExpression: `names.length === 0` → `true` | low value | list of associations in an error message |
| 2949 | 202 | ConditionalExpression: `value === null` → `false` | tested | a to-one embed stored as null holds no row (nested/nested.test.ts) |
| 2957 | 206 | ConditionalExpression: `!hasOwn(data, name)` → `false` | tested | an association's name planted as loaded and empty is still not preloaded; a to-one variant with null (test/security/hostile-params.test.ts) |
| 2958 | 206 | BlockStatement: `(several lines)` → `{}` | tested | an association's name planted as loaded and empty is still not preloaded; a to-one variant with null (test/security/hostile-params.test.ts) |
| 2960 | 207 | ObjectLiteral: `{ schema: relation.ownerName, association: na` → `{}` | tested | NotLoadedError names the schema and the association (constraints.test.ts) |
| 2974 | 213 | ObjectLiteral: `{ schema: relation.ownerName, association: na` → `{}` | tested | NotLoadedError names the schema and the association (constraints.test.ts) |
| 2989 | 232 | ConditionalExpression: `value === undefined \|\| value === null` → `false` | tested | an applied new embedded row without its key matches no item without a key (nested/nested.test.ts) |
| 2990 | 232 | LogicalOperator: `value === undefined \|\| value === null` → `value === undefined && value === nu` | tested | an applied new embedded row without its key matches no item without a key (nested/nested.test.ts) |
| 2991 | 232 | ConditionalExpression: `value === undefined` → `false` | tested | an applied new embedded row without its key matches no item without a key (nested/nested.test.ts) |
| 2993 | 232 | ConditionalExpression: `value === null` → `false` | equivalent | a stored key is never null: a primary key cannot be nullable, decoding refuses null in it, and an applied new row lacks it as undefined |
| 3000 | 233 | ConditionalExpression: `!cast` → `false` | tested | putAssoc matches a key as given, without casting (nested/nested.test.ts) |
| 3001 | 233 | BlockStatement: `(several lines)` → `{}` | tested | putAssoc matches a key as given, without casting (nested/nested.test.ts) |
| 3005 | 238 | ConditionalExpression: `!result.success` → `false` | tested | an applied new embedded row without its key matches no item without a key (nested/nested.test.ts) |
| 3009 | 245 | ConditionalExpression: `a === b` → `false` | equivalent | identity shortcut; key values are never null |
| 3013 | 246 | ConditionalExpression: `a === null \|\| a === undefined \|\| b === nu` → `false` | low value | null keys never reach this; only a key type whose equal throws on null would notice |
| 3014 | 246 | LogicalOperator: `a === null \|\| a === undefined \|\| b === nu` → `(a === null \|\| a === undefined \|` | low value | null keys never reach this; only a key type whose equal throws on null would notice |
| 3015 | 246 | ConditionalExpression: `a === null \|\| a === undefined \|\| b === nu` → `false` | low value | null keys never reach this; only a key type whose equal throws on null would notice |
| 3016 | 246 | LogicalOperator: `a === null \|\| a === undefined \|\| b === nu` → `(a === null \|\| a === undefined) &` | low value | null keys never reach this; only a key type whose equal throws on null would notice |
| 3017 | 246 | ConditionalExpression: `a === null \|\| a === undefined` → `false` | low value | null keys never reach this; only a key type whose equal throws on null would notice |
| 3018 | 246 | LogicalOperator: `a === null \|\| a === undefined` → `a === null && a === undefined` | low value | null keys never reach this; only a key type whose equal throws on null would notice |
| 3019 | 246 | ConditionalExpression: `a === null` → `false` | low value | null keys never reach this; only a key type whose equal throws on null would notice |
| 3021 | 246 | ConditionalExpression: `a === undefined` → `false` | low value | null keys never reach this; only a key type whose equal throws on null would notice |
| 3023 | 246 | ConditionalExpression: `b === null` → `false` | low value | null keys never reach this; only a key type whose equal throws on null would notice |
| 3025 | 246 | ConditionalExpression: `b === undefined` → `false` | low value | null keys never reach this; only a key type whose equal throws on null would notice |
| 3050 | 276 | UnaryOperator: `-0` → `+0` | equivalent | treating 0 as inexact only falls back to a scan, which finds the same row |
| 3056 | 297 | ConditionalExpression: `rows.length < INDEX_MIN_ROWS` → `false` | equivalent | indexing a short list finds the same rows as scanning it |
| 3057 | 297 | EqualityOperator: `rows.length < INDEX_MIN_ROWS` → `rows.length <= INDEX_MIN_ROWS` | equivalent | indexing a short list finds the same rows as scanning it |
| 3075 | 307 | ConditionalExpression: `value === null \|\| value === undefined` → `false` | equivalent | a row with no key value is indexed under null, which no lookup asks for |
| 3076 | 307 | LogicalOperator: `value === null \|\| value === undefined` → `value === null && value === undefin` | equivalent | a row with no key value is indexed under null, which no lookup asks for |
| 3077 | 307 | ConditionalExpression: `value === null` → `false` | equivalent | a row with no key value is indexed under null, which no lookup asks for |
| 3079 | 307 | ConditionalExpression: `value === undefined` → `false` | equivalent | a row with no key value is indexed under null, which no lookup asks for |
| 3083 | 308 | ConditionalExpression: `!mapsExactly(value)` → `false` | equivalent | -0 and 0 are one key in a Map and in the scan, which compares with === first; checked by hand against the keyFinder properties |
| 3107 | 325 | ConditionalExpression: `!mapsExactly(value)` → `false` | equivalent | -0 and 0 are one key in a Map and in the scan, which compares with === first; checked by hand against the keyFinder properties |
| 3114 | 336 | ConditionalExpression: `key.length === 0` → `false` | tested | indexOfRow without a key finds a row by identity (cast.test.ts) |
| 3116 | 337 | BooleanLiteral: `false` → `true` | tested | a stored row put back is matched by its key, also for a key type whose cast refuses its own values (nested/nested.test.ts) |
| 3118 | 338 | ConditionalExpression: `values === undefined` → `false` | tested | without a key, a row is found by identity; a row with no key value is found nowhere (nested/nested.test.ts) |
| 3120 | 338 | UnaryOperator (no coverage): `-1` → `+1` | tested | without a key, a row is found by identity; a row with no key value is found nowhere (nested/nested.test.ts) |
| 3128 | 348 | ConditionalExpression: `assoc === undefined \|\| (assoc.kind !== "has` → `false` | tested | leaves() for has-many, has-one and embed relations (nested/nested.test.ts) |
| 3129 | 348 | LogicalOperator: `assoc === undefined \|\| (assoc.kind !== "has` → `assoc === undefined && assoc.kind !` | tested | leaves() for has-many, has-one and embed relations (nested/nested.test.ts) |
| 3130 | 348 | ConditionalExpression: `assoc === undefined` → `false` | tested | leaves() for has-many, has-one and embed relations (nested/nested.test.ts) |
| 3132 | 348 | ConditionalExpression: `assoc.kind !== "hasMany" && assoc.kind !== "h` → `false` | low value | only a child that sets a belongs-to or many-to-many target's primary key to null, which the key's type forbids |
| 3137 | 348 | ConditionalExpression (no coverage): `assoc.kind !== "hasOne"` → `true` | tested | leaves() for has-many, has-one and embed relations (nested/nested.test.ts) |
| 3138 | 348 | EqualityOperator (no coverage): `assoc.kind !== "hasOne"` → `assoc.kind === "hasOne"` | tested | leaves() for has-many, has-one and embed relations (nested/nested.test.ts) |
| 3139 | 348 | StringLiteral (no coverage): `"hasOne"` → `""` | tested | leaves() for has-many, has-one and embed relations (nested/nested.test.ts) |
| 3140 | 348 | BooleanLiteral (no coverage): `false` → `true` | tested | leaves() for has-many, has-one and embed relations (nested/nested.test.ts) |
| 3143 | 350 | LogicalOperator: `!hasOwn(changes, name) \|\| changes[name] !==` → `!hasOwn(changes, name) && changes[n` | tested | leaves() for has-many, has-one and embed relations (nested/nested.test.ts) |
| 3145 | 350 | ConditionalExpression: `changes[name] !== null` → `false` | tested | leaves() for has-many, has-one and embed relations (nested/nested.test.ts) |
| 3152 | 356 | LogicalOperator: `typeof value === "object" && value !== null &` → `typeof value === "object" && value ` | tested | items of the params that are null, undefined or not plain objects make the list invalid (nested/nested.test.ts); a value given to putAssoc that is not a plain object is refused |
| 3153 | 356 | ConditionalExpression: `typeof value === "object" && value !== null &` → `true` | tested | items of the params that are null, undefined or not plain objects make the list invalid (nested/nested.test.ts) |
| 3154 | 356 | LogicalOperator: `typeof value === "object" && value !== null &` → `typeof value === "object" && value ` | tested | items of the params that are null, undefined or not plain objects make the list invalid (nested/nested.test.ts) |
| 3155 | 356 | ConditionalExpression: `typeof value === "object" && value !== null` → `true` | tested | items of the params that are null, undefined or not plain objects make the list invalid (nested/nested.test.ts) |
| 3156 | 356 | LogicalOperator: `typeof value === "object" && value !== null` → `typeof value === "object" \|\| valu` | tested | items of the params that are null, undefined or not plain objects make the list invalid (nested/nested.test.ts) |
| 3157 | 356 | ConditionalExpression: `typeof value === "object"` → `true` | tested | items of the params that are null, undefined or not plain objects make the list invalid (nested/nested.test.ts) |
| 3160 | 356 | ConditionalExpression: `value !== null` → `true` | tested | items of the params that are null, undefined or not plain objects make the list invalid (nested/nested.test.ts) |

### `validators/validate.ts`

| Id | Line | Mutant | Class | Reason, or the test that kills it now |
|---|---|---|---|---|
| 3402 | 65 | ConditionalExpression: `fields === lastFields` → `false` | equivalent | the value-table cache; without it the same table is built again |
| 3404 | 67 | ConditionalExpression: `table === undefined` → `true` | equivalent | the value-table cache; without it the same table is built again |
| 3409 | 72 | ConditionalExpression: `builders === undefined` → `true` | equivalent | the generic builder gives the same values as the generated one |
| 3414 | 75 | CallExpression: `tables.set(fields, table);` → `;` | equivalent | the value-table cache; without it the same table is built again |
| 3479 | 141 | ConditionalExpression: `typeof props !== "object"` → `false` | equivalent | props that are not an object fail the version check anyway |
| 3513 | 173 | ObjectLiteral (static): `(several lines)` → `{}` | equivalent | the empty default options read as the same falsy options |
| 3582 | 204 | ConditionalExpression: `typeof name === "string"` → `true` | equivalent | a name that is not a string finds no field either way, and the error is chosen again below |
| 3596 | 209 | ArrayDeclaration: `[...fields.keys()]` → `[]` | low value | list of fields in an error message |
| 3608 | 231 | ConditionalExpression: `value !== undefined` → `true` | tested | with only, a listed field without a value is not a key (validators/validate.test.ts) |
| 3613 | 243 | ConditionalExpression: `data !== null && changeset.model !== null` → `false` | equivalent | the values before the changes of a loaded row are the row's values |
| 3641 | 287 | ConditionalExpression: `typeof value === "function"` → `false` | low value | only a function with a then method would be taken for a promise |
| 3643 | 287 | StringLiteral: `"function"` → `""` | low value | only a function with a then method would be taken for a promise |
| 3655 | 300 | ConditionalExpression: `typeof result !== "object"` → `false` | low value | a Standard Schema result that is not an object (a broken library) is taken as a success |
| 3675 | 322 | ConditionalExpression: `result.length > 0` → `true` | equivalent | an empty list of issues and no list both mean no issues to the caller |
| 3677 | 322 | EqualityOperator: `result.length > 0` → `result.length >= 0` | equivalent | an empty list of issues and no list both mean no issues to the caller |
| 3696 | 342 | EqualityOperator: `last >= 0xd800` → `last > 0xd800` | low value | truncation of a value shown in an error message |
| 3699 | 342 | EqualityOperator: `last <= 0xdbff` → `last < 0xdbff` | low value | truncation of a value shown in an error message |
| 3756 | 382 | ConditionalExpression: `Object.getPrototypeOf(raw) === Array.prototyp` → `false` | equivalent | copying a plain array path gives the same path |
| 3771 | 390 | ConditionalExpression: `typeof segment === "object" && segment !== nu` → `true` | low value | a null segment is still refused with a TypeError, with another message |
| 3773 | 390 | LogicalOperator: `typeof segment === "object" && segment !== nu` → `typeof segment === "object" \|\| se` | low value | a null path segment (misuse) throws a TypeError of another wording |
| 3774 | 390 | ConditionalExpression: `typeof segment === "object"` → `true` | equivalent | a primitive segment has no key and is refused anyway |
| 3777 | 390 | ConditionalExpression: `segment !== null` → `true` | low value | a null path segment (misuse) throws a TypeError of another wording |
| 3792 | 411 | ConditionalExpression: `typeof raw !== "object" \|\| raw === null` → `false` | low value | a null issue (misuse) throws a TypeError of another wording |
| 3793 | 411 | LogicalOperator: `typeof raw !== "object" \|\| raw === null` → `typeof raw !== "object" && raw === ` | low value | a null issue (misuse) throws a TypeError of another wording |
| 3794 | 411 | ConditionalExpression: `typeof raw !== "object"` → `false` | low value | an undefined issue is still refused with a TypeError, with another message |
| 3797 | 411 | ConditionalExpression: `raw === null` → `false` | low value | a null issue (misuse) throws a TypeError of another wording |
| 3815 | 421 | ConditionalExpression: `meta === null` → `false` | low value | an issue meta of null (misuse) is accepted instead of refused |
| 3825 | 432 | ConditionalExpression: `meta === undefined` → `false` | equivalent | spreading undefined meta adds nothing |
| 3850 | 478 | ConditionalExpression: `typeof head === "string"` → `true` | equivalent | a head that is not a string is no field and no nested key either way |
| 3859 | 479 | ConditionalExpression: `options.only === undefined \|\| options.only.` → `true` | tested | with only, an issue on a relation that is not listed is dropped (validators/validate.test.ts) |
| 3885 | 495 | ConditionalExpression: `typeof head === "string"` → `true` | equivalent | a head that is not a string is no field and no nested key either way |
| 3903 | 501 | ConditionalExpression: `path.length === 1` → `false` | low value | an empty path either way; only whether it is frozen differs, and the path is readonly by type |
| 3912 | 522 | ConditionalExpression: `!hasOwn(changes, head)` → `false` | equivalent | an absent key reads as undefined, which is no nested change either way; a key planted on Object.prototype under that name is plain data, never a changeset, so it changes nothing either |
| 3916 | 524 | UnaryOperator: `-1` → `+1` | equivalent | the index of a single nested child is not read |
| 3919 | 525 | ConditionalExpression: `!Array.isArray(value) \|\| !isNestedValue(val` → `false` | tested | an issue on an item of a plain list field stays on the field (validators/validate.test.ts) |
| 3920 | 525 | LogicalOperator: `!Array.isArray(value) \|\| !isNestedValue(val` → `!Array.isArray(value) && !isNestedV` | tested | an issue on an item of a plain list field stays on the field (validators/validate.test.ts) |
| 3923 | 527 | ConditionalExpression: `typeof at === "number"` → `true` | tested | a symbol where a position would be sends the issue to the parent (validators/validate.test.ts) |
| 3927 | 527 | ConditionalExpression: `typeof at === "string" && /^\\d+$/.test(at)` → `true` | tested | a symbol where a position would be sends the issue to the parent (validators/validate.test.ts) |
| 3929 | 527 | LogicalOperator: `typeof at === "string" && /^\\d+$/.test(at)` → `typeof at === "string" \|\| /^\\d+$` | tested | a symbol where a position would be sends the issue to the parent (validators/validate.test.ts) |
| 3930 | 527 | ConditionalExpression: `typeof at === "string"` → `true` | tested | a symbol where a position would be sends the issue to the parent (validators/validate.test.ts) |
| 3933 | 527 | Regex: `/^\\d+$/` → `/\\d+$/` | equivalent | a position that is not a whole number finds no child either way |
| 3934 | 527 | Regex: `/^\\d+$/` → `/^\\d+/` | equivalent | a position that is not a whole number finds no child either way |
| 3935 | 527 | Regex: `/^\\d+$/` → `/^\\d$/` | tested | a position given as text from 10 on, and one that is not a number (validations.test.ts) |
| 3937 | 527 | UnaryOperator (no coverage): `-1` → `+1` | tested | a position given as text from 10 on, and one that is not a number (validations.test.ts) |
| 3939 | 528 | ConditionalExpression: `position < 0` → `false` | equivalent | a position that is not a whole number finds no child either way |
| 3951 | 539 | ConditionalExpression: `!(item instanceof Changeset) \|\| relation ==` → `true` | tested | a child that leaves the relation is skipped when positions are counted (validators/validate.test.ts) |
| 3954 | 539 | ConditionalExpression: `!(item instanceof Changeset) \|\| relation ==` → `false` | equivalent | every item of a nested list in the changes is a changeset of a relation (change() and putChange refuse relation fields), so the condition is the same as !leaves(...) |
| 3955 | 539 | LogicalOperator: `!(item instanceof Changeset) \|\| relation ==` → `!(item instanceof Changeset) && rel` | equivalent | every item of a nested list in the changes is a changeset of a relation, so || and && give the same result |
| 3956 | 539 | BooleanLiteral: `!(item instanceof Changeset)` → `item instanceof Changeset` | tested | a child that leaves the relation is skipped when positions are counted (validators/validate.test.ts) |
| 3957 | 539 | ConditionalExpression: `relation === undefined` → `false` | equivalent | a list holding changesets always belongs to a relation: a changeset without a schema class has only embed fields |
| 3958 | 539 | EqualityOperator: `relation === undefined` → `relation !== undefined` | tested | a child that leaves the relation is skipped when positions are counted (validators/validate.test.ts) |
| 3961 | 545 | BlockStatement: `(several lines)` → `{}` | tested | a child that leaves the relation is skipped when positions are counted (validators/validate.test.ts) |
| 3963 | 546 | ConditionalExpression: `fieldsOf(changeset).has(key)` → `false` | tested | an issue reaches an item of an embedded list (validators/validate.test.ts) |
| 3964 | 546 | StringLiteral (no coverage): `"validate"` → `""` | low value | function name in an error message |
| 3965 | 546 | StringLiteral (no coverage): `"embed"` → `""` | tested | an issue reaches an item of an embedded list (validators/validate.test.ts) |
| 3966 | 547 | ConditionalExpression: `changeset.model === null` → `true` | tested | a child that leaves the relation is skipped when positions are counted (validators/validate.test.ts) |
| 3967 | 547 | ConditionalExpression: `changeset.model === null` → `false` | equivalent | a changeset without a schema class has no associations to route into |
| 3968 | 547 | EqualityOperator: `changeset.model === null` → `changeset.model !== null` | tested | a child that leaves the relation is skipped when positions are counted (validators/validate.test.ts) |
| 3969 | 547 | StringLiteral: `"validate"` → `""` | low value | function name in an error message |
| 3970 | 547 | StringLiteral: `"assoc"` → `""` | equivalent | any relation kind but embed is looked up as an association |
| 3976 | 559 | BooleanLiteral: `false` → `true` | equivalent | the children's apply option is never read: only routed issues reach them |
| 3979 | 563 | MethodExpression: `value.slice()` → `value` | tested | validate leaves the earlier changeset's nested list alone (change.test.ts) |
| 3988 | 580 | ConditionalExpression: `hasOwn(out.errors, key)` → `true` | tested | dropped routed issues leave the parent valid, under a planted key (test/security/hostile-params.test.ts) |
| 3989 | 580 | ConditionalExpression: `hasOwn(out.errors, key)` → `false` | tested | the parent's own error keeps it invalid when every routed issue is dropped (validators/validate.test.ts) |
| 3990 | 580 | BooleanLiteral: `false` → `true` | tested | the parent's own error keeps it invalid when every routed issue is dropped (validators/validate.test.ts) |
| 3999 | 595 | ConditionalExpression: `!hasOwn(changes, key)` → `false` | tested | a validator does not see a planted key (test/security/hostile-params.test.ts) |
| 4000 | 597 | ConditionalExpression: `fields.has(key)` → `true` | equivalent | only lists field names, so an association name is never in it |
| 4013 | 599 | ConditionalExpression: `only !== undefined` → `false` | tested | with only, an association change is left out (validators/validate.test.ts) |
| 4017 | 602 | ConditionalExpression: `Array.isArray(value)` → `true` | tested | a to-one change of null is seen as null (validators/validate.test.ts) |
| 4031 | 630 | ConditionalExpression: `a === null \|\| a === undefined \|\| b === nu` → `false` | tested | apply: null over a stored date and a date over null are changes (validators/validate.test.ts) |
| 4032 | 630 | LogicalOperator: `a === null \|\| a === undefined \|\| b === nu` → `(a === null \|\| a === undefined \|` | tested | apply: null over a stored date and a date over null are changes (validators/validate.test.ts) |
| 4033 | 630 | ConditionalExpression: `a === null \|\| a === undefined \|\| b === nu` → `false` | tested | apply: null over a stored date and a date over null are changes (validators/validate.test.ts) |
| 4034 | 630 | LogicalOperator: `a === null \|\| a === undefined \|\| b === nu` → `(a === null \|\| a === undefined) &` | tested | apply: null over a stored date and a date over null are changes (validators/validate.test.ts) |
| 4035 | 630 | ConditionalExpression: `a === null \|\| a === undefined` → `false` | tested | apply: null over a stored date and a date over null are changes (validators/validate.test.ts) |
| 4036 | 630 | LogicalOperator: `a === null \|\| a === undefined` → `a === null && a === undefined` | tested | apply: null over a stored date and a date over null are changes (validators/validate.test.ts) |
| 4037 | 630 | ConditionalExpression: `a === null` → `false` | tested | apply: null over a stored date and a date over null are changes (validators/validate.test.ts) |
| 4039 | 630 | ConditionalExpression: `a === undefined` → `false` | tested | apply: a field of a new record with no value yet takes the output, also for a date type (cast.test.ts) |
| 4041 | 630 | ConditionalExpression: `b === null` → `false` | tested | apply: null over a stored date and a date over null are changes (validators/validate.test.ts) |
| 4043 | 630 | ConditionalExpression: `b === undefined` → `false` | low value | the output value: undefined is skipped before same(); only a custom type whose cast succeeds with undefined reaches it |
| 4050 | 645 | ConditionalExpression: `typeof output !== "object"` → `false` | equivalent | Object.keys of a primitive output names no field |
| 4061 | 652 | ConditionalExpression: `value === undefined` → `false` | tested | apply ignores an output key holding undefined (cast.test.ts) |
| 4074 | 660 | ConditionalExpression: `result.meta === undefined` → `false` | equivalent | spreading undefined meta adds nothing |
| 4132 | 736 | ConditionalExpression: `issues.length === 0` → `false` | tested | a result with an empty list of issues is a success and its output is applied (validators/validate.test.ts) |
| 4139 | 763 | StringLiteral: `"validate"` → `""` | low value | function name in an error message |
| 4149 | 789 | StringLiteral: `"validateAsync"` → `""` | low value | function name in an error message |
| 4168 | 822 | ConditionalExpression: `issues.length === 0` → `false` | equivalent | adding no issues to a field leaves the changeset valid |
| 4173 | 846 | StringLiteral: `"validateField"` → `""` | low value | function name in an error message |
| 4175 | 847 | StringLiteral: `"validateField"` → `""` | low value | function name in an error message |
| 4187 | 852 | CallExpression: `discard(result);` → `;` | tested | a rejected promise from validateField is refused without an unhandled rejection (validators/validate.test.ts) |
| 4196 | 878 | StringLiteral: `"validateFieldAsync"` → `""` | low value | function name in an error message |
| 4198 | 879 | StringLiteral: `"validateFieldAsync"` → `""` | low value | function name in an error message |
| 4204 | 881 | ConditionalExpression: `value === null` → `false` | tested | validateFieldAsync skips a null value and records the validator (validators/validate.test.ts) |
| 4206 | 881 | ObjectLiteral: `{ schema: validator }` → `{}` | tested | validateFieldAsync skips a null value and records the validator (validators/validate.test.ts) |

### `nested/embed.ts`

| Id | Line | Mutant | Class | Reason, or the test that kills it now |
|---|---|---|---|---|
| 2587 | 26 | ConditionalExpression: `item instanceof Changeset` → `true` | tested | an issue on an item of a plain list field stays on the field (validators/validate.test.ts) |
| 2590 | 27 | BooleanLiteral: `false` → `true` | tested | an issue on an item of a plain list field stays on the field (validators/validate.test.ts) |
| 2596 | 41 | LogicalOperator: `!Array.isArray(value) \|\| !isNestedValue(val` → `!Array.isArray(value) && !isNestedV` | equivalent | a list that is no nested change is copied with the same items |
| 2601 | 44 | ConditionalExpression: `item instanceof Changeset` → `true` | equivalent | the items of a nested embed list are all changesets |
| 2619 | 59 | ConditionalExpression: `hasOwn(changeset.changes, key)` → `true` | tested | an unchanged embedded item stays the stored row, under a planted key (test/security/hostile-params.test.ts) |
| 2622 | 60 | BooleanLiteral (no coverage): `false` → `true` | tested | an unchanged stored embed item is the stored row (nested/nested.test.ts) |
| 2625 | 66 | ConditionalExpression: `data !== null && !hasChanges(child)` → `false` | tested | an unchanged stored embed item is the stored row (nested/nested.test.ts) |
| 2647 | 76 | ConditionalExpression: `data !== null` → `false` | tested | an embedded field with a default and autogenerate takes the default on insert, a value on update (nested/nested.test.ts) |
| 2651 | 76 | ConditionalExpression: `field.default === undefined` → `true` | tested | an embedded field with a default and autogenerate takes the default on insert, a value on update (nested/nested.test.ts) |
| 2667 | 89 | ConditionalExpression: `hasOwn(changes, field.name)` → `true` | tested | a built embed row keeps a stored virtual field, and a new one has none (nested/nested.test.ts) |
| 2670 | 90 | ConditionalExpression: `data !== null` → `false` | tested | a built embed row keeps a stored virtual field, and a new one has none (nested/nested.test.ts) |
| 2678 | 103 | StringLiteral (static): `"required"` → `""` | tested | missingEmbedded reports with the required validation (nested/nested.test.ts) |
| 2682 | 123 | ConditionalExpression: `embedTypeInfo(field.type) === undefined \|\| ` → `false` | equivalent | a field that is no embed holds no nested change, so nothing is checked either way; a key planted on Object.prototype under that name is plain data, never a changeset, so it changes nothing either |
| 2683 | 123 | LogicalOperator: `embedTypeInfo(field.type) === undefined \|\| ` → `embedTypeInfo(field.type) === undef` | equivalent | a field that is no embed holds no nested change, so nothing is checked either way; a key planted on Object.prototype under that name is plain data, never a changeset, so it changes nothing either |
| 2684 | 123 | ConditionalExpression: `embedTypeInfo(field.type) === undefined` → `false` | equivalent | a field that is no embed holds no nested change, so nothing is checked either way; a key planted on Object.prototype under that name is plain data, never a changeset, so it changes nothing either |
| 2695 | 128 | ObjectLiteral: `{ ...changes }` → `{}` | tested | missingEmbedded keeps the other changes (nested/nested.test.ts) |
| 2696 | 131 | ConditionalExpression: `Array.isArray(value)` → `true` | tested | missingEmbedded of a null embed change (nested/nested.test.ts) |
| 2702 | 134 | ConditionalExpression: `!(item instanceof Changeset) \|\| (item as An` → `false` | tested | missingEmbedded skips a deleted item (nested/nested.test.ts) |
| 2703 | 134 | LogicalOperator: `!(item instanceof Changeset) \|\| (item as An` → `!(item instanceof Changeset) && (it` | tested | missingEmbedded skips a deleted item (nested/nested.test.ts) |
| 2705 | 134 | ConditionalExpression: `(item as AnyChangeset).action === "delete"` → `false` | tested | missingEmbedded skips a deleted item (nested/nested.test.ts) |
| 2707 | 134 | StringLiteral: `"delete"` → `""` | tested | missingEmbedded skips a deleted item (nested/nested.test.ts) |
| 2712 | 137 | MethodExpression: `value.slice()` → `value` | tested | missingEmbedded leaves the earlier list alone (change.test.ts) |
| 2713 | 140 | ConditionalExpression: `list !== undefined` → `true` | tested | a second embed with nothing missing keeps its change (nested/nested.test.ts) |
| 2718 | 141 | ObjectLiteral: `{ ...changes }` → `{}` | tested | missingEmbedded keeps the other changes (nested/nested.test.ts) |
| 2723 | 146 | BooleanLiteral: `false` → `true` | tested | missingEmbedded marks the parent invalid (nested/nested.test.ts) |
| 2733 | 159 | ConditionalExpression: `data === null` → `true` | tested | a stored row with null in its generated key is reported (validations.test.ts) |
| 2756 | 165 | BooleanLiteral: `false` → `true` | tested | missingEmbedded marks the child invalid (cast.test.ts) |
| 2761 | 182 | ConditionalExpression: `!hasOwn(changes, key)` → `false` | equivalent | a key planted on Object.prototype is visited, but its value is plain data, which is no changeset or nested value, so it is skipped either way; checked by hand under a planted key |
| 2764 | 184 | ConditionalExpression: `!isNestedValue(value)` → `false` | equivalent | a value that is no nested change becomes the same value |
| 2766 | 186 | ConditionalExpression: `field === undefined \|\| embedTypeInfo(field.` → `false` | tested | embedChanges leaves an association change as it is (cast.test.ts) |
| 2767 | 186 | LogicalOperator: `field === undefined \|\| embedTypeInfo(field.` → `field === undefined && embedTypeInf` | tested | embedChanges leaves an association change as it is (cast.test.ts) |
| 2768 | 186 | ConditionalExpression: `field === undefined` → `false` | tested | embedChanges leaves an association change as it is (cast.test.ts) |
| 2770 | 186 | ConditionalExpression: `embedTypeInfo(field.type) === undefined` → `false` | equivalent | a field that is no embed holds no nested change |

### `spec.ts`

| Id | Line | Mutant | Class | Reason, or the test that kills it now |
|---|---|---|---|---|
| 3200 | 66 | ConditionalExpression: `typeof types !== "object"` → `false` | tested | undefined, types of undefined, or types without data are refused with a QueryError (cast.test.ts) |
| 3211 | 73 | ConditionalExpression: `spec !== undefined` → `false` | tested | two changesets of the same data and types are of the same record (change.test.ts) |
| 3254 | 98 | LogicalOperator: `state.column ?? name` → `state.column && name` | equivalent | a field without a schema class has no table, so its column is never read |
| 3262 | 122 | CallExpression: `byTypes.set(types, spec);` → `;` | tested | two changesets of the same data and types are of the same record (change.test.ts) |
| 3266 | 128 | ConditionalExpression: `!isRow(value)` → `false` | low value | only an object made from a schema's prototype outside a query (rows have no public constructor): misuse |
| 3270 | 131 | ConditionalExpression: `typeof prototype === "object"` → `true` | equivalent | an object that is not a row has no schema class either way |
| 3282 | 150 | ConditionalExpression: `typeof target === "object"` → `true` | tested | undefined, types of undefined, or types without data are refused with a QueryError (cast.test.ts) |
| 3292 | 153 | ConditionalExpression: `isPlainObject(target) && Object.hasOwn(target` → `true` | low value | an object without types (misuse) is refused with another error; with a planted types key the mutant would take such an object as a changeset without a schema class, which is still misuse |
| 3294 | 153 | LogicalOperator: `isPlainObject(target) && Object.hasOwn(target` → `isPlainObject(target) \|\| Object.h` | low value | an object without types (misuse) is refused with another error; with a planted types key the mutant would take such an object as a changeset without a schema class, which is still misuse |
| 3302 | 156 | ConditionalExpression: `typeof data !== "object"` → `false` | tested | undefined, types of undefined, or types without data are refused with a QueryError (cast.test.ts) |
| 3335 | 183 | ConditionalExpression: `typeof params === "object"` → `true` | low value | wording of an error message |
| 3336 | 183 | ConditionalExpression: `typeof params === "object"` → `false` | low value | wording of an error message |
| 3337 | 183 | EqualityOperator: `typeof params === "object"` → `typeof params !== "object"` | low value | wording of an error message |
| 3338 | 183 | StringLiteral: `"object"` → `""` | low value | wording of an error message |
| 3339 | 184 | StringLiteral: `"an object that is not plain"` → `""` | low value | wording of an error message |
| 3340 | 185 | StringLiteral: `'a ${typeof params}'` → `''` | low value | wording of an error message |
| 3345 | 194 | ConditionalExpression (static): `typeof name === "string"` → `true` | equivalent | a name that is not a string finds no field either way |
| 3353 | 196 | ConditionalExpression: `typeof name !== "string"` → `false` | low value | a name that is not a string (misuse) is refused with another error |
| 3356 | 196 | BlockStatement: `(several lines)` → `{}` | low value | a name that is not a string (misuse) is refused with another error |
| 3362 | 199 | OptionalChaining: `spec.meta?.assocs` → `spec.meta.assocs` | tested | an unknown field of a changeset without a schema class is a QueryError (cast.test.ts) |

### `measure.ts`

| Id | Line | Mutant | Class | Reason, or the test that kills it now |
|---|---|---|---|---|
| 1665 | 15 | BooleanLiteral: `true` → `false` | equivalent | always segmenting gives the same count |
| 1667 | 16 | EqualityOperator: `i < text.length` → `i <= text.length` | equivalent | reading past the end gives NaN, which matches no range |
| 1671 | 19 | ConditionalExpression: `code >= 0x80 \|\| code === 0x0d` → `true` | equivalent | the fast path and the segmenter count these characters alike |
| 1675 | 19 | EqualityOperator: `code >= 0x80` → `code > 0x80` | equivalent | the fast path and the segmenter count these characters alike |
| 1678 | 19 | EqualityOperator: `code === 0x0d` → `code !== 0x0d` | equivalent | the fast path and the segmenter count these characters alike |
| 1682 | 24 | ConditionalExpression: `simple` → `false` | equivalent | always segmenting gives the same count |
| 1684 | 25 | ObjectLiteral: `{ granularity: "grapheme" }` → `{}` | equivalent | grapheme is the segmenter's default granularity |
| 1689 | 34 | EqualityOperator: `i < text.length - 1` → `i <= text.length - 1` | equivalent | reading past the end gives NaN, which matches no range |
| 1691 | 34 | ArithmeticOperator: `text.length - 1` → `text.length + 1` | equivalent | reading past the end gives NaN, which matches no range |
| 1744 | 54 | ConditionalExpression: `i + 1 < text.length` → `true` | equivalent | reading past the end gives NaN, which is no low surrogate |
| 1745 | 54 | EqualityOperator: `i + 1 < text.length` → `i + 1 <= text.length` | equivalent | reading past the end gives NaN, which is no low surrogate |
| 1747 | 54 | ArithmeticOperator: `i + 1` → `i - 1` | equivalent | reading past the end gives NaN, which is no low surrogate |

### `nested/build.ts`

| Id | Line | Mutant | Class | Reason, or the test that kills it now |
|---|---|---|---|---|
| 1785 | 50 | ConditionalExpression: `assoc.kind !== "hasOne"` → `true` | tested | buildAssoc builds the child of a has-one association (nested/nested.test.ts) |
| 1787 | 50 | StringLiteral: `"hasOne"` → `""` | tested | buildAssoc builds the child of a has-one association (nested/nested.test.ts) |
| 1812 | 60 | ObjectLiteral: `{ params: { owner: ownerMeta.name } }` → `{}` | low value | advice parameters of an error |
| 1813 | 60 | ObjectLiteral: `{ owner: ownerMeta.name }` → `{}` | low value | advice parameters of an error |
| 1821 | 68 | ConditionalExpression: `value === undefined` → `false` | equivalent | a row holds every field, so a key value is null, never undefined |
| 1841 | 86 | ConditionalExpression: `values !== undefined` → `true` | equivalent | change() with no values returns the changeset as it is |

### `validators/generated.ts`

| Id | Line | Mutant | Class | Reason, or the test that kills it now |
|---|---|---|---|---|
| 3387 | 80 | StringLiteral (static): `"\\n"` → `""` | equivalent | the generated statements are valid on one line as well |
| 3389 | 86 | ConditionalExpression (static): `makeBuild === undefined` → `false` | equivalent | once generation is refused, the next generateFunction is refused too and returns first |
| 3394 | 92 | ConditionalExpression (static): `outerBefore === undefined` → `false` | tested | generation refused after some functions: validate falls back to loops (validators/codegen-late.test.ts) |
