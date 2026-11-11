# Step 21, 1.0 gate item 2 (completions), status

Branch `step/21-gate-completions`, from `main` at `a118ddf`. Inputs: `status/21-audit.md`
§4.2 and §8 item 2, `status/21-api.md` §3, `03-types.md`, the roadmap row "Faster editor
completions in large models" and the FAQ entry "Why are editor completions slow in a large
model?".

## Summary

**Met.** A completion after an edit in a `where` callback of the 200-schema project takes
20–26 ms (median of 20), down from 236–257 ms, on the chain, the tree and the hub. It no
longer depends on how many schemas are connected. The cause was not the one on record. The
fix is types only: the binding parameters of the query callbacks are declared `NoInfer<…>`.
Instantiation counts went down for every project measured, and check times for the 200-schema projects (the blog's stayed the same), and the first
query expression a program checks is now under 50 ms as well.

| Item | State |
|---|---|
| Completions < 200 ms after an edit, `where` callback, 200 schemas, chain / tree / hub | Met: 25 / 25 / 24 ms (round 1), 26 / 22 / 20 ms (round 2) |
| No query expression over 50 ms, first expression excluded | Met: at most 27.2 ms. The first expression is 22.7–29.9 ms too (was 57.7–70.4) |
| Blog and 200-schema check times and instantiations no worse | Instantiations and types lower everywhere; check time lower on the 200-schema projects, the same on the blog (0.20–0.23 s before, 0.21 s after) |
| Types only, runtime unchanged | Yes: only declarations changed; no `.js` output changes |
| API report changes listed | Below |
| Type tests green unchanged, on TypeScript 5.8.3 and 7.0.2 | Yes; see "Verification" |
| Docs | FAQ entry and roadmap row rewritten for the case that remains |
| Changeset | `faster-callback-completions.md`, patch |

## 1. Where the time went

I profiled before changing anything. All of it can be reproduced with the TypeScript language
service, in process (a new program after each edit, as tsserver makes one):

- **Instantiation counts per request.** For the completion in the 200-schema tree after an
  edit, the new checker made 117,358 instantiations and 24,078 types. In the 10-schema
  clusters project it made 24,692 and 7,025. So about 490 instantiations per reachable schema.
- **Probes that narrowed it.** A completion on `from(S001, "s").` (the query's members) cost
  689 instantiations, and one on `typeof S001` (the class's statics) 587. A
  `from(S001, "s").where(({ s }) => s.…)` without any join cost the full 116,307. So it is
  the `where` call, not the join, the completion list or the schema's own members. `select`,
  `set`, `returning` and `windows` callbacks were cheap (1,300–8,200) whatever the model.
- **The types created, in order** (`ts.startTracing` around the request, then
  `types.json`). Each reachable schema's base class, its association initialisers
  (`hasMany(() => S005, …)`) and its `changeset` method type was created, schema after
  schema, following the associations.
- **The stack** (a probe in a copy of the checker at the first time the type of `parent`
  and of `changeset` was asked for). Both times it was `inferTypeArguments` →
  `inferFromSignatures` → `inferFromContravariantTypes` (the callback's parameter) →
  `inferFromProperties` (`s`) → `inferFromTypeArguments` (the alias `Binding<typeof S001>`)
  → `inferFromObjectTypes(typeof S001, typeof S001)` → `inferFromProperties` over every
  static → `Assoc<…, typeof S000, …>` → `inferFromTypeArguments` → the next schema, and so
  on through the graph.

So the cause: **to infer `X` in `where<X>(fn: (bindings: B) => X)`, TypeScript also infers
from the callback's parameter type to the declared one.** Both are the same concrete bindings
type. TypeScript does not short-circuit identical object types here, and a class constructor
type always "could contain type variables". So inference walks from `Binding<typeof S>` into
every static member of the class: it infers each `changeset` method's return type and each
`hasMany` / `belongsTo` call. Through each association's target it then reaches every schema
connected to the query's schema. A new checker after an edit does all of it again. That is
why the cost followed the reachable count and not the depth. It is also why 21-api's
variants (annotated associations, no `changeset` methods) lowered it: they made each step of
the walk cheaper. The hypothesis on record (association and preload types mapping over
`keyof S`) was not what ran: `AssocKeys` and `PreloadSpec` were not on the path.

## 2. The fix

The callback parameters that carry the query's bindings are declared `NoInfer<…>`.
TypeScript does not infer into a `NoInfer` type, so the walk never starts. Nothing was
inferred from these parameters before either: the type arguments come from the other
arguments (`source`, `alias`, `from`, `assoc`) and from the callback's result (`X`). So every
type that callbacks receive and calls return is the same. `NoInfer` needs TypeScript 5.4; the
minimum supported is 5.8.

Changed (`packages/core/src`):

- `query/builder.ts`: the `fn` of `where`, `orWhere`, `having`, `distinct`, `groupBy`,
  `orderBy`, and the `on` of `join`, `leftJoin`, `rightJoin`, `fullJoin`, `joinAssoc`,
  `leftJoinAssoc`. The reason is in the TSDoc of `Condition`.
- `changeset/changeset.ts`: `Changeset.pipe`'s argument (`NoInfer<this>`). It walked the same
  way, from `Changeset<typeof S>` (107,359 instantiations before, 2,778 after, at 200 schemas).

The runtime is untouched: no `.js` output changes, and nothing on a hot path.

Tried and left out:

- `NoInfer` on `Query.pipe`, `Query.preload`'s callback and `repo.preload`'s callback. It
  made no difference: those cases walk through return-type inference (below), not through
  the parameter. I reverted it to keep the API change to what helps.
- `AddParams<Q, X>` rewritten with its true branch behind an `infer` (`Q extends infer Q2 ?
  Q2 : never`), to stop the return-type walk. All type tests passed, but the counts did not
  move, so I reverted it.

## 3. Measurements

`scripts/type-health/measure.mjs`, unchanged, the same method as 21-api: the built
declarations, completions after an edit in `src/where-callback.ts`, median and maximum of
20; statement times are the median of 5 traced runs. "Before" is `main` at `a118ddf`, "after"
is this branch. Both builds were saved and copied into `packages/core/dist` in turn by one
driver, two rounds, each round running all six (build × topology).

**Machine state.** Apple M2, 8 cores, 16 GB, Node 22.23.4, TypeScript 6.0.3. All twelve runs
took eight minutes, 2026-11-11 17:47 to 17:55 UTC. No Stryker process was running during any run: the
driver checked before each run (`pgrep -x stryker` and the Stryker worker processes). `pgrep -f
stryker` also matches other workers' shells that poll a Stryker log, so it was not used. Other
workers' sessions were open; the load average was 3.4–4.6 throughout.

### Completions after an edit, `where` callback, 200 schemas (median / max of 20, ms)

| Topology | Reachable | Before, round 1 | Before, round 2 | After, round 1 | After, round 2 |
|---|---|---|---|---|---|
| chain | 200 | 257 / 487 | 250 / 507 | **25 / 45** | **26 / 44** |
| tree | 200 | 249 / 499 | 254 / 507 | **25 / 46** | **22 / 45** |
| hub | 200 | 236 / 496 | 237 / 508 | **24 / 44** | **20 / 37** |

A hover after an edit: 225–250 ms before, 17–28 ms after. Without an edit: 0 ms both. The
completions offered the schema's fields in every run (`offersFields: true`). The before
medians match 21-api's sweep (244 / 244 / 255) and the audit (239 / 239 / 230).

### Check time, types and instantiations (`tsc --extendedDiagnostics`)

| Project | Types before → after | Instantiations before → after | Check time before → after (rounds 1; 2) |
|---|---|---|---|
| examples/blog | 14,730 → 14,256 | 48,563 → 46,340 | 0.20, 0.23 s → 0.21, 0.21 s |
| 200 schemas, chain | 61,843 → 61,763 | 413,957 → 413,510 | 4.20, 4.42 s → 1.21, 1.19 s |
| 200 schemas, tree | 59,175 → 59,095 | 401,512 → 401,065 | 2.59, 2.73 s → 1.19, 1.69 s |
| 200 schemas, hub | 56,695 → 56,615 | 389,037 → 388,590 | 2.45, 2.46 s → 1.22, 0.93 s |

The counts are deterministic and were the same in both rounds; the "before" counts are
21-api's exactly. The chain's check time, superlinear before (21-api: 26 s at 400 schemas),
came from the same walk: every query in the project paid for it.

### Per-expression budget (50 ms, first expression excluded)

| Project | First expression checked, before → after (median / max, ms) | Slowest after it, before → after (ms) |
|---|---|---|
| chain | 57.7 / 109.4, 70.4 / 76.7 → 26.7 / 32.8, 26.2 / 27.4 | 24.4, 30.7 → 26.2, 26.7 |
| tree | 65.1 / 66.5, 62.1 / 66.4 → 26.6 / 26.9, 29.9 / 32.5 | 26.8, 26.6 → 26.6, 24.7 |
| hub | 62.5 / 65.3, 64.9 / 78.5 → 26.1 / 27.9, 22.7 / 25.5 | 26.6, 26.6 → 27.2, 23.0 |
| examples/blog | `accounts.ts:16` 31.9–40.2 → 8.6–12.4 | 20.8–37.7 → 24.3–29.6 |

The budget is met after the first expression in every run. The first expression, the one 21-api
and the audit recorded as the only statement over 50 ms, is now under it as well, so the
exclusion is no longer needed. In round 2, before, the blog's traced runs disagreed on which
statement was checked first (measure.mjs reports it; the slowest-after-first figure, 37.7 ms,
then includes `accounts.ts:16`).

### The case that remains: a `where` inside a callback that returns the query

`preload("children", (q) => q.where(({ children }) => children./*cursor*/…))` in the
200-schema tree, measured with the same tsserver method (a scratch script, 20 edits; not part
of measure.mjs):

| | Median / max (ms) |
|---|---|
| Before | 277 / 423 |
| After | 282 / 421, 267 / 412 |
| After, project without `changeset` methods | 126 / 239 |

Unchanged. There the walk starts from return-type inference: the inner `where` call has a
contextual return type (the outer callback's result), and TypeScript infers from it into
`AddParams<this, ParamsOf<X>>`, whose true branch is the query type with its bindings. A
`pipe((q) => q.where(…))` behaves the same (122,069 instantiations after). The FAQ and the
roadmap say so, and keep the advice to declare `changeset` return types for that case. This
case is not part of the gate item as written (a `where` callback measured by measure.mjs),
but it is a query callback, so I list it for the owner below.

## 4. Tests

- **`packages/core/test/editor/completions.test.ts`** (unit, new): a language service over an
  in-memory chain of 8 and of 40 schemas, against the sources. For 12 callback kinds it asks
  for completions after an edit and checks four things: the probe compiles, both models offer
  the same completions, and the 40-schema model costs fewer than 200 instantiations more than
  the 8-schema one (before the fix, about 9,300 more). The kinds are `where`, `where` after
  `joinAssoc`, `orWhere`, `having`, `groupBy`, `distinct`, `orderBy`, the `on` of `join`,
  `leftJoin`, `joinAssoc`, `leftJoinAssoc`, and a changeset's `pipe`. Verified: all 12 fail
  on `main`'s sources and pass on this branch. It uses `Program.getInstantiationCount()`, a
  public TypeScript API, and takes about 2 s.
- **`packages/core/src/query/callbacks.test-d.ts`** (type, new, 12 tests). It pins what the
  change relies on:
  - the binding types each changed callback receives, including the nullable ones of the
    outer joins;
  - named parameters still inferred from callback results, and a join's alias and source
    from its arguments;
  - `pipe` and a changeset's `pipe` return types;
  - preload result types from the query and from `repo.preload`, the selected-shape form
    included;
  - a callback declared beforehand with a typed parameter, a generic callback, and a scope
    over `QueryWith` all still accepted;
  - a callback over a missing binding still rejected.
  It passes on `main` and on this branch, so it pins behaviour; it does not depend on the fix.
- Every existing type test passes **unchanged** (608).

## 5. API report changes (`api-report/egon-orm.api.md`, `api-report/egon-orm-testing.api.md`)

Every change wraps a callback parameter's type in `NoInfer<…>`:

- `Query.where`, `Query.orWhere` (the callback overloads), `Query.having`, `Query.distinct`
  (the callback overload), `Query.groupBy`, `Query.orderBy`: `(bindings: B)` → `(bindings:
  NoInfer<B>)`.
- `Query.join`, `leftJoin`, `rightJoin`, `fullJoin`, `joinAssoc`, `leftJoinAssoc`: `on`'s
  parameter type `T` → `NoInfer<T>`.
- `Changeset.pipe`: `(changeset: this)` → `(changeset: NoInfer<this>)`.

Why: these parameters are what the inference walk started from (§1). Compatibility: `NoInfer<T>`
is assignable both ways with `T`. Only inference is affected, and nothing was inferred from
these positions (the type arguments have other sources). A callback declared beforehand with
an explicit parameter type, a generic callback and a scope are tested above. I found no code
that compiles today and stops compiling, so I did not stop to ask. The only visible difference
is the declared signature in a hover over the method: `(bindings: NoInfer<{ … }>) => X`. A
hover over the callback's own parameters shows the same binding types as before. Patch bump:
types only, compatible.

## Decisions

- **`NoInfer` over the idea on record** (association metadata, expanding only where `preload`
  is used). The profile showed that the association and preload types were not on the path, so
  that change would not have helped. `NoInfer` removes the cause at the entry point and changes
  no type anyone reads.
- **Only where it measurably helps.** No `NoInfer` on `Query.pipe` and the preload callbacks
  (§2).
- **The nested-callback case is reported, not fixed** (below).

## Needs the owner

1. **The nested-callback case** (§3, last table): a `where` inside a `preload` or `pipe`
   callback still costs about 270 ms after an edit at 200 connected schemas. My recommendation:
   accept gate item 2 as met. It names the `where` callback that measure.mjs measures, and that
   case is at 20–26 ms. Keep the nested case on the roadmap (the row is rewritten for it). A fix
   probably means restructuring `AddParams` (the return type of `where` and the others), which
   touches most of the query builder's public signatures, so it should be its own item.
2. **The 50 ms budget's exclusion of the first expression** is no longer needed: every
   expression, the first included, is at most 32.8 ms (max of 5 runs) in these runs. The owner
   may want to drop the exclusion from the 1.0 gate (21-audit §8 item 2 / P2).

## Requests

- `docs/plan/status/21-api.md` §3 still describes the cause as the association and preload
  types. It is a record of what was measured then, so I left it. §1 here supersedes its
  "cause" paragraph.

## Verification

- `pnpm check`: passes (lint, typecheck, unit with coverage, type tests, build).
- `pnpm api:check`: up to date for 9 entry points. `pnpm test:types`: 36 files, 620 tests.
- The consumer type check (`examples/smoke/consumer.mjs --no-runtime --typescript …`, as the
  CI `typescript` job runs it): every program passes on 5.8.3 and on 7.0.2.
- `packages/core` with its tests, type-checked with `tsc --noEmit` on TypeScript 5.8.3: clean.
  On 7.0.2, three errors in `error-messages.test-d.ts:160` and `schema/schema.test-d.ts:958,961`
  (an unused `@ts-expect-error` and an overload message). **They are the same on `main`**, not
  from this change, and CI does not run the type tests on 7.x (only the consumer check).
- `pnpm test:integration`: not run. The change is declarations only, with no runtime code.

## Not verified

- Timings on another machine. Every number is from the one M2 laptop, under the load stated.
- The nested-callback numbers come from a scratch tsserver script with the same method, not
  from measure.mjs.
