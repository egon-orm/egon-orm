# Security

## Reporting a vulnerability

Report it privately through GitHub: on [egon-orm/egon-orm](https://github.com/egon-orm/egon-orm),
open **Security → Report a vulnerability**
([direct link](https://github.com/egon-orm/egon-orm/security/advisories/new)). Please do not
open a public issue, pull request or discussion for it.

Say which package and version you used, and how to reproduce the problem (a query, a
changeset or a schema that shows it), and what an attacker gains. We confirm the report,
work on a fix in a private advisory, and credit you when it is published unless you ask us
not to. Please keep the details private until a fixed release is out.

## Supported versions

Security fixes ship in a patch release of the latest minor line (before 1.0, the latest
`0.y`). There are no backports before 1.0. From 1.0, the previous major also gets security
fixes for six months after the next major is released. A supported database version stays
supported until at least its own end of life. (All three are owner decisions of
2026-10-22.) The versioning and support policy, including the supported Node.js,
TypeScript and database versions, is in the
[upgrade guide](https://egon-orm.github.io/egon-orm/reference/upgrading#security-fixes).

## Threat model

Egon builds SQL and runs it for an application. **Trusted:** the application's code (its
schemas, the queries it builds, the literal text of `fragment` templates, migration files,
the config), the database server, the driver and the runtime. **Untrusted:** every value
the application passes in (params given to `cast()`, values in queries, named parameters)
and the data the database holds. The library defends trusted code against untrusted
values; it cannot defend an application against its own code.

| Concern | What Egon guarantees | What stays the application's job |
|---|---|---|
| SQL injection | Every value in a query, a write or `repo.raw` is a bound parameter. Table, column, alias, CTE, window, savepoint and database-schema names are quoted. Operators, functions, lock clauses, join kinds and `explain` options come from fixed tables; anything else is refused. A custom column type's SQL must be a plain type name. Migration DDL quotes names and writes constants with the dialect's literal writer (for a UTF-8 client encoding, which the drivers use). | The literal text of a `fragment` is SQL: never build it from input (the tag refuses anything but a template literal). For a name chosen at run time, use `fragment.ident()`, which accepts identifiers only, and check the name against your own list. |
| Mass assignment | `cast()` reads only the fields it is given in its permitted list, and only the params' own properties. Associations and embeds are read only by `castAssoc` / `castEmbed`. | `change()`, `putAssoc` and `putEmbed` take trusted values: do not pass request bodies to them. |
| Prototype pollution | Params are never merged into a prototype: `__proto__`, `constructor` and `prototype` keys are inert data, no field can be named `__proto__` or `constructor`, and JSON output keeps a `__proto__` key as an own property. Every options object, whether you pass it or it is one of Egon's own defaults, is read as own properties only, so a key planted on `Object.prototype` is never taken as an option (owner decision, 2026-10-24). | The database drivers read their own configuration objects, which Egon builds and hands them; what they do with a polluted `Object.prototype` is theirs. |
| Resource use | Work grows linearly with the size of the input: integer, float, uuid, date, time and timestamp text is length-checked before it is parsed, decimal text has no length limit and is parsed in one pass, JSON documents are limited to 500 levels, and nested items are matched to loaded rows through an index (for integer, text and uuid keys). The built-in regular expressions cannot backtrack catastrophically. | Limit the size of request bodies. A changeset function that calls itself for a self-referential embed or association recurses once per level of the input, and fails with a stack overflow on a very deep one. `validateFormat` runs your regular expression. |
| Secrets | A `.redact()` field's value is left out of `util.inspect` of rows and changesets, `toJSON`, log lines (`log: { params: true }` shows `**redacted**`), query events, and the messages of every error Egon throws. Connection strings and passwords are in no error message and cannot be reached by inspecting a repo, an adapter or a transaction. `JSON.stringify(error)` is `{ name, code, id }`. | The database's own text is kept as it is: `ConstraintError.detail` and `error.cause` (the driver's error) may quote the conflicting value, which `util.inspect(error)` shows. Log errors by `message` or `toJSON()`, not by inspecting the object. `changeset.params` and `repo.toSql()` hold values as given. |
| Code generation | Row factories, validator inputs and row decoders may be generated with `new Function`. The generated source holds names only as JSON string literals, never values. `codegen: false` on `Schema()`, `EmbeddedSchema()` and `createRepo()` turns it off; where the runtime refuses it (a Content Security Policy, a Cloudflare Worker handling a request), the same work is done without it. A changeset without a schema class (`cast({ data, types }, …)`) never generates code (owner decision, 2026-10-22). | Under a strict Content Security Policy, pass `codegen: false` to every `Schema()`, `EmbeddedSchema()` and `createRepo()`, so that the policy has no attempt to report. |
| Dependencies | `egon-orm` has no runtime dependency. The adapters' drivers (`pg`, `mysql2`, `better-sqlite3`) and Zod are peer dependencies that you install and update. | Keep the drivers up to date. |

Out of scope: the database server's own security (authentication, TLS settings, row-level
access), statements an application chooses to run (an expensive query it builds from
input), and migration files from untrusted sources (a migration is code).
