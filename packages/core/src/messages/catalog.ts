/**
 * The catalog of full error messages: for every identifier Egon throws, what to do about
 * it. The default message of an error is its identifier, a short sentence and a docs link;
 * `useFullErrorMessages(messages)` adds the entry of this catalog after the sentence.
 * `{{name}}` is replaced by the error's parameter of that name.
 *
 * The keys of this object are the `ErrorId` type of `errors.ts`. Every identifier a source file
 * throws has an entry, and every entry is thrown somewhere (`pnpm docs:check` checks
 * both); the docs pages under `reference/errors/` are generated from it.
 *
 * @module
 */
/**
 * The full text of every error message, by identifier: the advice that follows the short
 * sentence.
 *
 * @example
 * ```ts
 * import { useFullErrorMessages } from "egon-orm";
 * import { messages } from "egon-orm/messages";
 *
 * useFullErrorMessages(messages);
 * ```
 */
export const messages = {
  // --- cast ---
  "cast.bigintFraction": "Read a fractional numeric column with t.decimal().",
  "cast.bigintNumberRange": "Declare the field as t.bigint() to read it as a bigint.",
  "cast.bigintNumberString":
    "Check the column holds whole numbers; read it with t.decimal() if it holds fractions.",
  "cast.dateInvalidWrite": 'Pass a valid Date, or a "YYYY-MM-DD" string.',
  "cast.dateRange":
    "Pass a Date in the years 1 to 9999, or declare the field as t.date() to work with strings.",
  "cast.dateRead": "Declare the field as t.date() to read it as a string.",
  "cast.embedFieldMissing":
    "Give it a .default(…) (or make it .nullable()) so that rows stored before it existed can be read.",
  "cast.embedGeneratedMissing":
    "Write the row through a changeset or insertAll(), which fill the generated value.",
  "cast.embedInvalidDate":
    "Store a valid Date: the value was created with new Date() from something that is not a date.",
  "cast.embedListNotArray": "Pass an array of the embedded values; an empty list is [].",
  "cast.embedNotObject":
    "Fix the stored JSON: an embedOne column holds a JSON object (or null for a nullable embed).",
  "cast.embedStoredField":
    "Fix the stored JSON, or change the embedded field's type to what the column holds.",
  "cast.embedStoredListNotArray":
    "Fix the stored JSON: an embedMany column holds a JSON array (or null for a nullable embed).",
  "cast.embedWrite": "Write the embed through a changeset (castEmbed or putEmbed), which checks each field.",
  "cast.enumStoredValue": "Add it to the enum, or fix the stored data.",
  "cast.enumWriteValue":
    "Write one of the enum's members; a changeset's cast rejects other values before they reach the database.",
  "cast.floatNotFinite": "Store a finite number, or null.",
  "cast.floatNotNumber":
    "The column or expression is not of a floating-point type (Postgres reads numeric columns as text). Declare the field t.decimal() for a decimal column, or change the column's type.",
  "cast.integerNotNumber":
    "The column or expression is not of an integer type (Postgres reads bigint, bigserial and numeric columns as text; MySQL's / returns a decimal). Declare the field t.bigint({ mode: \"number\" }) for a 64-bit integer column, or t.decimal() for a decimal, or change the column's type.",
  "cast.jsonInvalid": "Fix the stored text, or read the column with t.string().",
  "cast.paramsNotObject":
    "Pass the params as a plain object, such as a parsed request body; null and undefined count as no params.",
  "cast.timestampInvalidDate": "Pass a valid Date: one made from something that is not a date is invalid.",
  "cast.timestampYearRange": "Pass a date in the years 0 to 9999.",
  "cast.unsafeInteger": "Read it with t.bigint().",

  // --- constraint ---
  "constraint.undeclared": "Add: {{add}}",
  "constraint.violated":
    "To report this as a changeset error instead of an exception, declare the constraint on the changeset before the write: uniqueConstraint for a unique constraint, foreignKeyConstraint for a foreign key (or noAssocConstraint on the referenced side), checkConstraint, exclusionConstraint, or validateRequired for a not-null column.",

  // --- database ---
  "database.aborted":
    "The caller's AbortSignal fired, and the database was asked to cancel the statement; inside a transaction, the transaction is rolled back.",
  "database.abortedBefore":
    "The caller's AbortSignal had fired before the statement was sent; nothing was sent to the database.",
  "database.abortedNotCancelled":
    "error.cause says why cancelling failed (an AggregateError of the cancel's error and the statement's own, when the statement then failed too); where the runtime cannot cancel (no node:net and node:tls, as on a Worker without nodejs_compat), the statement always runs to its end. The connection is not reused.",
  "database.abortedQueued": "The caller's AbortSignal fired; nothing was sent to the database.",
  "database.abortedWaiting":
    "The caller's AbortSignal fired; nothing was sent to the database. A larger pool, or fewer statements at once, shortens the wait.",
  "database.adapterClosed": "Create a new adapter to keep using the database.",
  "database.callTimeout": "Give the call a larger timeoutMs: it covers every statement the call runs.",
  "database.cancelFailed":
    "The connection takes no more statements; release it (it is closed, not pooled) and acquire a new one.",
  "database.closed": "Create a new adapter to keep using the database.",
  "database.connectionFailed":
    "Check that the database is running and that the connection settings are right; the cause is the driver's error.",
  "database.connectionReleased": "Acquire a new connection.",
  "database.locked":
    "Another connection holds the lock. Retry the statement or the transaction (the error is retryable), or let SQLite wait for the lock with the busy_timeout pragma.",
  "database.openFailed":
    "Check the filename and its directory's permissions; the cause is the driver's error.",
  "database.rejected":
    "The cause is the driver's error, with the database's full report; error.sql is the statement. Look the SQL state up in the database's documentation.",
  "database.streamConnectionGone":
    "Keep the connection until the stream is finished, or leave the for-await loop first.",
  "database.timeout":
    "Give the call a larger timeoutMs, or make the statement faster (an index, a narrower query); inside a transaction, the transaction is rolled back.",
  "database.timeoutNotCancelled":
    "error.cause says why cancelling failed (an AggregateError of the cancel's error and the statement's own, when the statement then failed too); where the runtime cannot cancel (no node:net and node:tls, as on a Worker without nodejs_compat), the statement always runs to its end. The connection is not reused.",
  "database.timeoutQueued":
    "Give the call a larger timeoutMs, or run fewer statements at once on the transaction.",
  "database.timeoutSpent":
    "Give the call a larger timeoutMs: the time is shared by every statement of a call.",
  "database.timeoutWaiting":
    "Nothing was sent to the database. Give the pool more connections, run fewer statements at once, or give the call a larger timeoutMs.",
  "database.transactionTimeout": "Give the transaction a larger timeoutMs, or do less in it.",
  "database.unreachable": "Check that it is running and that the connection settings are right.",

  // --- general ---
  invalidChangeset:
    'Fix the input, or call the variant without "OrThrow" to get the changeset back as a Result instead of an exception.',

  // --- migration ---
  "migration.buildFailed":
    "The cause is the error the migration's up() or down() threw while it described its statements; fix the migration.",
  "migration.changeNotSupported":
    "change() is not supported: write the change in up(m) and what undoes it in down(m).",
  "migration.concurrentIndexInTransaction": "Add transaction: false to its defineMigration().",
  "migration.constantType": "Pass a string, a finite number, a bigint, a boolean or null.",
  "migration.customTypeSql":
    'Give the custom type a plain SQL type name, such as "citext" or "numeric(10, 2)".',
  "migration.ddlParams": "Write the constant in the template text, or use fragment.ident() for a name.",
  "migration.dialectUnsupported": "See Dialect support for the databases migrations run on.",
  "migration.failed":
    "The cause is the database's error, and sql the statement that failed. Fix the migration and run it again; what stays applied is said above.",
  "migration.featureUnsupported": "See Dialect support for what each database supports.",
  "migration.fileName": 'Rename it, for example "20261012093000_{{match}}.{{match1}}".',
  "migration.generatedKeyAlone":
    "Make the generated key the table's only key column, or give it a plain integer type.",
  "migration.indexMethod": "Use one of the methods the database has, or write the statement with m.sql`…`.",
  "migration.loadFailed":
    "The cause is the error importing the file threw; fix the file, or the migration it defines.",
  "migration.lockTimeout": "Wait for the other runner to finish, or give a larger lockTimeoutMs.",
  "migration.lockTimeoutClaimed":
    'If no runner is running, one stopped while it ran a migration without a transaction: check what that migration did, then delete the row with version {{claim}} from "{{table}}".',
  "migration.missingSteps":
    "A migration has both up(m) and down(m); when there is nothing to undo, write down() {} with a // noop comment.",
  "migration.modifyWhole": 'Give modify() both notNull and default (null for none) for "{{column}}".',
  "migration.noExport":
    'Export the result of defineMigration() as "migration" (export const migration = defineMigration(…)) or as the default export.',
  "migration.numberConstant": "Pass a finite number.",
  "migration.readDirectory":
    "Check that the directory exists and can be read; the cause has the system's error.",
  "migration.rollbackMissingFile":
    "Restore its file, or remove the version from the tracking table if it is really gone.",
  "migration.stringConstant": "Remove the NUL character or lone surrogate from the string.",
  "migration.timestampColumn":
    'If it was created by another tool, pass its timestamp column: createMigrator({ timestampColumn: "inserted_at" }) (or whatever it is called).',
  "migration.trackingVersion":
    "Fix the row in the tracking table: versions are 14-digit whole numbers (YYYYMMDDHHMMSS).",
  "migration.transactionLeftOpen":
    "End every transaction a migration opens with m.sql`commit` (or let the runner wrap it: leave transaction: false out).",
  "migration.typescriptLoader":
    'Run it with one: Node 22.18 or later strips types by itself (on 22.12 to 22.17 set NODE_OPTIONS=--experimental-strip-types, as in NODE_OPTIONS=--experimental-strip-types npx egon migrate), or use tsx (NODE_OPTIONS="--import tsx"), or Bun. Or compile the migrations to .js.',
  "migration.unsupportedFeature":
    "See Dialect support for what {{dialect}} supports; m.sql`…` can run any statement the builder has no method for.",
  "migration.versionTwice": "Give one of them a new version.",

  // --- general ---
  multipleResults: "Narrow the query until it matches a single row, add limit(1), or use all().",
  noResults: 'Use the variant without "OrThrow" (it returns null) if a missing row is not an error.',
  notLoaded:
    'Preload it first: add .preload("{{association}}") to the query, or call repo.preload(rows, "{{association}}").',

  // --- query ---
  "query.addErrorMessage": 'Pass the message as a string, as in addError("email", "is taken").',
  "query.aggregateArgument": "Pass an expression, such as p.views.",
  "query.aggregateField": 'Name the field: repo.aggregate(query, "{{fn}}", "views").',
  "query.aggregateFunction": 'repo.aggregate() takes "count", "sum", "avg", "min" or "max".',
  "query.aggregateRootSchema":
    "Aggregate a query rooted at a schema class, or compute the aggregate in the query's own select and read it with repo.one(…).",
  "query.aggregateSubquerySelect":
    'The query must select the column "{{field}}" of its root binding "{{alias}}": whole rows of the root, or an object whose key "{{field}}" is that column. Otherwise compute the aggregate in the query\'s own select and read it with repo.one(…).',
  "query.aggregateUnknown": "Use the aggregates the query builder offers, or write the call as a fragment.",
  "query.aggregateUnknownColumn": "Aggregate a stored field of the schema; a virtual field has no column.",
  "query.aliasMissing": 'Give the binding an alias, a non-empty string: {{clause}}(User, "u").',
  "query.aliasProto":
    "Choose another alias: the bindings are passed to callbacks as one object keyed by alias.",
  "query.aliasReserved":
    'Aliases that start with "$" are reserved for the bindings the builder adds itself; choose another.',
  "query.aliasTaken": "Each binding needs its own alias; for a self-join, give the second one another name.",
  "query.applyActionUnknown": 'Use "insert", "update", "delete", "replace" or "ignore".',
  "query.applyChangesNewRecord":
    "A row the database never returned cannot exist. Insert it with the repo instead.",
  "query.assocConstraintKind":
    "It applies to belongsTo associations; for the other side, use noAssocConstraint.",
  "query.assocJoinName":
    'Pass the name of an association second: {{clause}}("{{from}}", "posts", "{{name}}").',
  "query.assocJoinNoSchema": "Start the join from a binding of a schema class.",
  "query.assocJoinStart": 'Pass the alias of the binding to start from first: {{clause}}("u", "posts", "p").',
  "query.assocJoinUnknown": "Name an association the schema declares as a static member.",
  "query.assocJoinUnknownStart": "Start from a binding the query has: the root alias, or one a join added.",
  "query.assocUnknown": "Name an association the schema declares as a static member.",
  "query.astBooleanOperator":
    "The query tree is malformed: queries built with from() and the builder methods never produce this, a tree built or changed by hand can. If it came from the builder, please report it.",
  "query.astCaseEmpty":
    "The query tree is malformed: caseWhen() needs at least one branch when it is called, so this one was built or changed by hand.",
  "query.astCastType":
    "The query tree is malformed: queries built with from() and the builder methods never produce this, a tree built or changed by hand can. If it came from the builder, please report it.",
  "query.astCrossJoinCondition":
    "The query tree is malformed: crossJoin() takes no condition, so this one was built or changed by hand.",
  "query.astCteName":
    "The query tree is malformed: withCte() refuses an empty name when it is called, so this one was built or changed by hand.",
  "query.astFragmentStrings":
    "The query tree is malformed: a fragment made with the fragment`…` tag always has one more string than arguments.",
  "query.astFragmentStringType":
    "The query tree is malformed: a fragment made with the fragment`…` tag always has string parts.",
  "query.astIdent":
    "The query tree is malformed: fragment.ident() refuses such names when it is called, so this one was changed afterwards.",
  "query.astIdentifier":
    "The query tree is malformed: queries built with from() and the builder methods never produce this, a tree built or changed by hand can. If it came from the builder, please report it.",
  "query.astInsertCell": "The insert plan is malformed: the repo never produces this cell kind.",
  "query.astInsertSource": "The insert plan is malformed: the repo always passes values, cells or a query.",
  "query.astJoinKind":
    "The query tree is malformed: queries built with from() and the builder methods never produce this, a tree built or changed by hand can. If it came from the builder, please report it.",
  "query.astJsonPathEmpty":
    "The query tree is malformed: path() refuses an empty path when it is called, so this one was built or changed by hand.",
  "query.astLiteral": "Bind every other value with val(value); only those few are written into the SQL text.",
  "query.astLock":
    "The query tree is malformed: lock() takes a mode or a fragment, so this one was built or changed by hand.",
  "query.astNodeKind":
    "The query tree is malformed: queries built with from() and the builder methods never produce this, a tree built or changed by hand can. If it came from the builder, please report it.",
  "query.astNullsOrder":
    "The query tree is malformed: queries built with from() and the builder methods never produce this, a tree built or changed by hand can. If it came from the builder, please report it.",
  "query.astOperation": 'Pass "all", "updateAll" or "deleteAll".',
  "query.astOperator":
    "The query tree is malformed: queries built with from() and the builder methods never produce this, a tree built or changed by hand can. If it came from the builder, please report it.",
  "query.astParamCount": "Build queries with from(), or compute params with collectParams.",
  "query.astParamName":
    "The query tree is malformed: queries built with from() and the builder methods never produce this, a tree built or changed by hand can. If it came from the builder, please report it.",
  "query.astSelectObject":
    "The query tree is malformed: queries built with from() and the builder methods never produce this, a tree built or changed by hand can. If it came from the builder, please report it.",
  "query.astSelectShape":
    "The query tree is malformed: queries built with from() and the builder methods never produce this, a tree built or changed by hand can. If it came from the builder, please report it.",
  "query.astSetOperation":
    "The query tree is malformed: queries built with from() and the builder methods never produce this, a tree built or changed by hand can. If it came from the builder, please report it.",
  "query.astSortDirection":
    "The query tree is malformed: queries built with from() and the builder methods never produce this, a tree built or changed by hand can. If it came from the builder, please report it.",
  "query.astSourceAlias":
    "The query tree is malformed: queries built with from() and the builder methods never produce this, a tree built or changed by hand can. If it came from the builder, please report it.",
  "query.astSourceAliasTwice": "Give each source its own alias.",
  "query.astSourceKind":
    "The query tree is malformed: queries built with from() and the builder methods never produce this, a tree built or changed by hand can. If it came from the builder, please report it.",
  "query.astTupleEmpty":
    "The query tree is malformed: tuple() refuses an empty list, so this one was built or changed by hand.",
  "query.astUnaryOperator":
    "The query tree is malformed: queries built with from() and the builder methods never produce this, a tree built or changed by hand can. If it came from the builder, please report it.",
  "query.astWindowName":
    "The query tree is malformed: windows() refuses such names when it is called, so this one was changed afterwards.",
  "query.batchStepName": "Choose another name for the step: its result is kept under it.",
  "query.batchStepTwice": "Step names are unique: their results are kept under them.",
  "query.booleanArguments": "Pass boolean expressions, such as u.age.gte(18).",
  "query.booleanExpected": "Pass a boolean expression, such as u.age.gte(18), or true or false.",
  "query.buildAssocKeyValue": "Leave it out: buildAssoc sets it.",
  "query.buildAssocKind":
    "buildAssoc makes a child of a hasOne or hasMany; for the others, insert the row and use putAssoc.",
  "query.buildAssocParent": "Pass a loaded {{owner}} row, as returned by a query or a write.",
  "query.buildAssocParentKey": "Pass a row that has its key: one returned by a query or a write.",
  "query.buildAssocSchema": 'Pass the schema class first: buildAssoc(User, user, "posts", { … }).',
  "query.buildAssocUnknown": "Name an association the schema declares.",
  "query.callbackExpected": "Pass a callback that receives the bindings: {{clause}}(({ u }) => …).",
  "query.caseCondition": "Pass a boolean expression, such as u.age.lt(18).",
  "query.castEmbed": 'Cast it with castEmbed("{{name}}", …) instead.',
  "query.castEmptyValues": 'Pass emptyValues as an array, as in { emptyValues: ["", "n/a"] }.',
  "query.castNestedWithoutParams": "Use {{embed}} for values you trust.",
  "query.castPermitted": 'Pass the permitted field names as an array: cast(User, params, ["email"]).',
  "query.castType": "Pass a field type, such as t.integer() or t.string(), to name the type.",
  "query.changeEmbed": 'Change it with putEmbed("{{key}}", …) instead.',
  "query.changesetConstructor": "Make one with cast(User, params, [...]) or change(User, values).",
  "query.changesetFieldUnknown": "Name one of the schema's fields; a typo is the usual cause.",
  "query.changesetSource":
    "Pass a schema class (for a new record), a row (for an update), a changeset, or { data, types } for a changeset without a schema class.",
  "query.changeValues": 'Pass the values as an object: change(User, { email: "…" }).',
  "query.checkConstraintName":
    'Pass the constraint\'s name: checkConstraint("age", { name: "users_age_check" }).',
  "query.checkoutEnded": "Await every call inside the callback.",
  "query.closeNotRoot":
    "Call it on the repo createRepo made, not on the repo of a transaction, a checkout or a sandbox.",
  "query.coalesceArguments": "Pass at least two expressions or values, as in coalesce(u.nickname, u.name).",
  "query.columnKindUnsupported":
    "See Dialect support for the column types {{dialect}} has, or use a custom type with its SQL name.",
  "query.combinedClause":
    'Add any other clause to a side before combining, or wrap the combined query: from(subquery(q), "s").',
  "query.combinedOrderBy": "Order by expressions the query selects, or by their names with selectedAs(…).",
  "query.combinedOrderByAmbiguous": "Name the one to sort by with selectedAs(…) and order by that name.",
  "query.compareNull":
    "A comparison with null is always unknown in SQL, so it would match nothing: use isNull() or isNotNull(), or isDistinctFrom() to compare treating null as a value.",
  "query.compileArgument": 'Pass a query: from(User, "u")….',
  "query.compileFragmentArgument": "Pass a fragment: fragment`select …`.",
  "query.concatEmpty": "Pass at least one value or expression to append.",
  "query.conditionExpected": "Return a condition from the callback, such as ({ u }) => u.age.gte(18).",
  "query.conditionNotBoolean": "Compare it: {{clause}}(({ u }) => u.age.gte(18)).",
  "query.constraintMatch": 'Pass match: "exact" (the default), "suffix" or "prefix".',
  "query.constraintMessage": 'Pass the message as a string, as in { message: "is taken" }.',
  "query.constraintName": 'Pass the name as a non-empty string, as in { name: "users_email_key" }.',
  "query.constraintNoTable": 'Pass it: { name: "…" }.',
  "query.constraintOptions": 'Pass the options as an object, as in { name: "users_email_key" }.',
  "query.constraintUnknownAssoc": "Name an association the schema declares.",
  "query.cteFragmentBody": "Read the CTE in the main query; to write rows, run the statement on its own.",
  "query.cteMaterialized": "Pass materialized: true or false, or leave it out to let the database decide.",
  "query.cteName": 'Pass a name first, a non-empty string: withCte("tree", query).',
  "query.cteNameTwice": "Give each CTE its own name.",
  "query.cteOptions": "Pass the options as an object: { recursive: true }.",
  "query.cteRecursive": "Pass recursive: true or false, or leave it out.",
  "query.cteShape": 'Refer to it with the same query: cte("{{name}}", query).',
  "query.cteSourceEmbedded": "Pass the schema class of a table, or the CTE's query.",
  "query.cteSourceName": 'Pass the CTE\'s name first, a non-empty string: cte("tree", Category).',
  "query.cteSourceShape":
    'Pass the schema class of its rows, cte("{{name}}", Category), or the CTE\'s query.',
  "query.cteTwice": "Give each CTE its own name.",
  "query.cteUndefined": 'Define it on the query with withCte("{{name}}", query), or read another source.',
  "query.cteUnknownOption": "withCte() takes recursive and materialized.",
  "query.cteWithPreloads": "Preload in the query that reads the CTE.",
  "query.cteWithUpdate": "A CTE that writes rows is not supported; run the update on its own.",
  "query.customTypeSql":
    'Give the custom type a plain SQL type name, such as "citext", "numeric(10, 2)" or "public.mood[]".',
  "query.deferrableUnsupported": "Leave deferrable out on {{dialect}}.",
  "query.deleteNoKey": "The delete plan is malformed: the repo always finds the row by its primary key.",
  "query.distinctTwice": "A query has one distinct: call distinct() once, with every expression it needs.",
  "query.dynamicBinding":
    'Use the dynamic expression in a query that has the binding "{{alias}}" of {{schema}}, or build it for this query\'s bindings.',
  "query.dynamicCallback": "Pass a callback that receives the bindings: dynamic(({ u }) => u.age.gte(18)).",
  "query.dynamicCombine": "Pass another dynamic expression: a.{{method}}(dynamic(…)).",
  "query.dynamicCondition": "Combine conditions, such as dynamic(({ u }) => u.age.gte(18)).",
  "query.dynamicFieldBinding": "Pass a binding first, such as u in ({ u }) => field(u, name).",
  "query.dynamicFieldUnknown":
    "Name a column of the binding; check the name a request supplied before building the query.",
  "query.dynamicSchemaClass": "Name a schema class, such as { {{alias}}: User }.",
  "query.dynamicSchemas": "Pass the schemas by alias first: dynamic({ u: User }, ({ u }) => …).",
  "query.dynamicSecondCallback": "Pass a callback second: dynamic({ u: User }, ({ u }) => u.age.gte(18)).",
  "query.emitterTwice": "Register each node kind once.",
  "query.errorKey": 'Pass a field name, or another non-empty key, as in addError("base", "…").',
  "query.excludeCombined": 'Exclude it from that side before combining, or exclude("setOperations") first.',
  "query.excludeGroupByHaving": 'Exclude "having" first: q.exclude("having").exclude("groupBy").',
  "query.excludeUnknown":
    "exclude() takes where, select, distinct, groupBy, having, orderBy, limit, offset, lock, preload, set, windows, withCte or setOperations.",
  "query.existsQuery":
    'Pass a query built with from(), as in exists(from(Post, "p").where(({ p }) => p.authorId.eq(u.id))).',
  "query.explainAnalyze": "Pass analyze: true or false, or leave it out.",
  "query.explainAnalyzeJson": "Use one of the two on {{dialect}}.",
  "query.explainAnalyzeUnsupported": "Leave the option out on {{dialect}}.",
  "query.explainFormat": 'Pass format: "text" or "json", or leave it out.',
  "query.explainFormatUnsupported": "Leave the option out on {{dialect}}.",
  "query.expressionExpected":
    "Return an expression or an array of them from the callback, such as ({ u }) => [u.id].",
  "query.fieldIsAssoc": "Associations are changed through castAssoc and putAssoc.",
  "query.fieldNameType": "Pass the field name as a string.",
  "query.fieldNotEmbed": "Use it on a t.embedOne() field; for other JSON use path() or pathText().",
  "query.fieldNotReadable": 'Read it with path("{{column}}") instead.',
  "query.fieldUnknown": "Name a stored field of the embedded schema.",
  "query.fieldValidatorPromise":
    "An async validator runs with validateFieldAsync(); validateField() is synchronous.",
  "query.filterArgument": 'Pass a callback, or an object of field values: {{clause}}({ role: "admin" }).',
  "query.filterCondition": "Pass a boolean expression, such as p.published or p.views.gt(10).",
  "query.filterUndefined":
    "Leave the key out, or add the clause only when there is a value: if (value !== undefined) q = q.where({ {{key}}: value }).",
  "query.filterUnknownField":
    "Use a field name the schema declares (not its column name); a virtual field cannot be filtered on.",
  "query.formatPattern": "Pass a regular expression, such as /^[^@\\s]+@[^@\\s]+$/.",
  "query.fragmentCall":
    "Write the SQL between backquotes, fragment`lower(…)`, not fragment(text). Calling it as a function would turn a string into SQL text, so it is refused.",
  "query.fragmentOrderItem": "Interpolate the expression, and write ASC or DESC in the template.",
  "query.fragmentValue":
    "An array of expressions is not bound: interpolate each expression on its own. For a JSON value pass val(value, t.json()).",
  "query.functionUnknown":
    "Use the functions the query builder offers, or write the call as a fragment, interpolating its arguments: fragment`my_function(…)`.",
  "query.getByValues": 'Pass an object of field values: repo.{{method}}(User, { email: "ada@example.com" }).',
  "query.getCompositeId": "Pass the id as an object with a value for every key field.",
  "query.getIdArray":
    'To read several rows by key, use repo.all(from({{name}}, "x").where(({ x }) => x.{{name1}}.in(ids))).',
  "query.getIdField":
    "Give every key field a value; null or undefined usually means a value missing upstream.",
  "query.getIdObject": "The id is the value of the key field, as in repo.get({{schema}}, 42).",
  "query.getIdUnknownField": "Pass only the key fields in the id object.",
  "query.getMissingId":
    "This is almost always a missing value upstream (an unparsed route parameter, a field that was never set); check it before reading.",
  "query.getNoPrimaryKey": "Use repo.getBy({{name}}, { … }) instead.",
  "query.havingCallback": "Pass a callback: {{clause}}(({ p }) => count(p.id).gt(3)).",
  "query.havingWithoutGroupBy": "Add groupBy(…) before having(…), or use where() to filter rows.",
  "query.identName":
    "Pass an identifier: a letter or underscore, then letters, digits, underscores or $ (/^[A-Za-z_][A-Za-z0-9_$]*$/). The name given does not match, so it was refused.",
  "query.inclusionValues": 'Pass the values as an array, as in {{fn}}("role", ["admin", "member"]).',
  "query.inOperand":
    "Pass an array of values, as in u.id.in([1, 2, 3]), an expression of array type, or a query that selects one column.",
  "query.insertAllMixedColumns":
    "Give every row the same fields, or insert the rows in groups of the same fields.",
  "query.insertAllNeverWritable": "Leave the field out of the rows: the database fills it.",
  "query.insertAllQuerySelect":
    "Select an object whose keys are the fields to fill, such as .select(({ u }) => ({ email: u.email, name: u.name })).",
  "query.insertAllQueryValue":
    "A subquery that selects one value is written scalar(query), which also types it.",
  "query.insertAllSelectNeverWritable": "Leave the field out of the select: the database fills it.",
  "query.insertAllSelectValue": "Select an expression; for a value, val(value, t.integer()).",
  "query.insertCellsColumns":
    "The insert plan is malformed: the repo always gives an insert of cells its columns.",
  "query.insertCellsRowLength": "Give every row one cell per column.",
  "query.insertDefaultsNoColumn": "Give the schema a column the database fills, or insert values.",
  "query.insertLoadedRow": "Update it with repo.update(), or use repo.insertOrUpdate().",
  "query.insertNoRow":
    "The database reported no row for the insert; check triggers or rules on the table that may skip it.",
  "query.insertNoRows": "Pass at least one row; insertAll() of an empty list runs no statement.",
  "query.insertQueryColumns":
    "The insert plan is malformed: the repo always gives an insert from a query its columns.",
  "query.insertRowCount": "The insert plan is malformed: the repo always passes a whole number of rows.",
  "query.insertRowTooWide":
    "Write fewer columns per row, or split the table: a statement may have at most {{maxParams}} parameters.",
  "query.insertValuesRows":
    "The insert plan is malformed: the repo always passes a whole number of rows, at least one.",
  "query.isolationUnsupported": "See Dialect support for the isolation levels {{dialect}} has.",
  "query.joinPreloadCallbackLimit":
    'Preload "{{many}}" with a separate query instead (preload("{{many}}") in the callback).',
  "query.joinPreloadLimit":
    'Preload "{{many}}" with a separate query instead (preload("{{many}}"), or a callback with its own per-parent limit), or read the rows with repo.all() and no limit.',
  "query.joinPreloadNoKey": "Preload with a separate query instead.",
  "query.joinPreloadUnderThrough": "Preload the nested association with a separate query instead.",
  "query.jsonPathKey": "Pass the keys as strings, or whole numbers from 0 for array positions.",
  "query.jsonPathKeyExpression": "Pass the keys of the path as strings or whole numbers.",
  "query.jsonPathKeyQuote":
    "Read such a key with a fragment, or store the JSON with keys without quotes and backslashes.",
  "query.lateralReference":
    "Lateral joins are not supported yet: move the condition to the join's on, or use the subquery in where with exists() or in().",
  "query.lengthCount": 'Pass count: "graphemes" (the default), "codepoints" or "bytes".',
  "query.lengthNoLimit": 'Pass is, min or max, as in validateLength("name", { min: 2 }).',
  "query.lengthOptions": "Pass the limits as an object: { min: 2, max: 80 }.",
  "query.lengthWholeNumbers": "Pass whole numbers of 0 or more, as in { min: 2, max: 80 }.",
  "query.limitValue":
    'Pass a non-negative whole number, or a named parameter: {{clause}}(param("{{clause}}", t.integer())).',
  "query.listNull":
    "x {{operator}} (…, NULL) never matches the null: filter it out and add isNull() separately.",
  "query.listParamsUnsupported":
    "Use the list with in(), which expands it to one parameter per item, or see Dialect support for what {{dialect}} supports.",
  "query.listUndefined": "Remove the undefined items from the list; every item must be a value.",
  "query.litValue": "Every other value is bound: use val(value) instead.",
  "query.lockArgument":
    'Pass a mode ("update", "share", "noKeyUpdate", "keyShare"), or a fragment of SQL for any other lock clause.',
  "query.lockClause": "Use a fragment for that lock clause: lock(fragment`…`).",
  "query.lockCombined": "Lock the rows in a separate query, or lock each side before combining.",
  "query.lockIncrementer":
    'Pass a function that makes the next value, as in optimisticLock("version", (v) => v + 1).',
  "query.lockMode":
    'Pass "update", "share", "noKeyUpdate" or "keyShare", optionally with { skipLocked: true } or { noWait: true }, or a fragment for any other lock clause.',
  "query.lockNotNumber":
    "Only a number or a bigint has a default increment: pass a function that makes the next value as the second argument of optimisticLock().",
  "query.lockNoValue": "Give the field a default, such as t.integer().default(1).",
  "query.lockOptions": "Pass the options as an object: { skipLocked: true } or { noWait: true }.",
  "query.lockSkipAndNoWait": "Choose one: a lock either skips locked rows or fails on them.",
  "query.lockUnknownOption": "lock() takes skipLocked and noWait.",
  "query.mergeActions": "Merge changesets with the same action, or set one with applyAction() first.",
  "query.mergeArgument": "Pass another changeset, as in a.merge(b).",
  "query.mergeOtherRecord": "Merge changesets made from the same row (or class, for a new record).",
  "query.messageFunctionResult":
    'Return the message as a string from the message function, as in (meta) => "must be at least " + meta.min.',
  "query.messageOption": 'Pass a string, or a function that returns one, as in { message: "is required" }.',
  "query.namedParamMissing":
    "Pass a value for every named parameter in the params argument: repo.all(q, { {{first}}: … }).",
  "query.namedParamUnknown": "Pass only the named parameters the query declares with param().",
  "query.nestedAssocNotEmbed": 'Use {{fn}}("{{name}}", …).',
  "query.nestedChildSchema": "Make every child changeset from {{target}}, or from one of its rows.",
  "query.nestedDuplicate": "Give each row once.",
  "query.nestedEmbedNotAssoc": 'Use {{fn}}("{{name}}", …).',
  "query.nestedName": "Pass the name of the association or embed as a string.",
  "query.nestedNoChangeset":
    "Give the schema a static changeset function, or pass one: { with: (row, params) => cast(row, params, [...]) }.",
  "query.nestedNoSchema": "Make the changeset from a schema class or a row to change associations.",
  "query.nestedNotArray": "Give an array of values.",
  "query.nestedNotEmbed":
    "{{fn}} changes fields declared with t.embedOne or t.embedMany; change other fields with {{other}}.",
  "query.nestedOptions": "Pass the options as an object, such as { required: true }.",
  "query.nestedRequired": "Pass required: true or false, or leave it out.",
  "query.nestedRowSchema": "Pass a {{target}} row, a changeset of one, or a plain object of its fields.",
  "query.nestedThroughReadOnly": "Change the associations it goes through instead.",
  "query.nestedTransactionLeftRunning": "Await tx.transaction(…) inside the callback.",
  "query.nestedTransactionOpen":
    "Run the statements on the repo the nested callback was given (tx.transaction(async (inner) => …) runs them on inner), or await the nested transaction first.",
  "query.nestedUndefined": "Give {{what}}.",
  "query.nestedUnknownAssoc": "Name an association the schema declares.",
  "query.nestedUnknownField": "Name an embed field the schema declares.",
  "query.nestedUnknownKey": "Pass only the fields and associations {{target}} declares.",
  "query.nestedUnknownOption": "The options are with and required.",
  "query.nestedValue":
    "Pass a {{target}} row, a changeset of one, or a plain object of its fields for each value.",
  "query.nestedWith":
    "Pass with: (row, params) => cast(row, params, [...]), the function that makes a child changeset.",
  "query.noAssocConstraintKind": "It applies to hasOne and hasMany associations with a foreign key.",
  "query.noDialectTable": "Run SQL text with adapter.execute() instead.",
  "query.notFromFrom": 'Make a query with from(), as in from(User, "u").',
  "query.notWholeNumber": "Give a fraction a float type, val(2.5, t.float()), or round it.",
  "query.nullNotAllowed": "Pass a value; to test for SQL NULL use isNull() or isNotNull().",
  "query.numberLimit": "Pass the limit as a number (or a bigint for bigint fields), as in { lessThan: 100 }.",
  "query.numberNoLimit": "Pass at least one limit, such as { greaterThan: 0 }.",
  "query.numberOptions": "Pass the limits as an object: { greaterThan: 0 }.",
  "query.numberUnknownOption": "Pass only the options validateNumber() takes, as in { greaterThan: 0 }.",
  "query.onConflictKey": 'Pass { target, update }, as in onConflict: { target: ["email"], update: "all" }.',
  "query.onConflictNested": "Write the parent first, then the children.",
  "query.onConflictNoColumn": "Write a schema that has columns, or leave onConflict out.",
  "query.onConflictNoUpdate": 'Use onConflict: "nothing" instead.',
  "query.onConflictOption": '(There is no spelling for "raise": leave the option out.)',
  "query.onConflictShape":
    'Pass onConflict: "nothing", or { target, update }, as in { target: ["email"], update: "all" }.',
  "query.onConflictTarget": "Name the target: the conflicting fields, { constraint } or a fragment.",
  "query.onConflictTargetEmpty":
    "List at least one field in the target, or give { constraint: name } or a fragment.",
  "query.onConflictTargetOption":
    'Pass a list of field names, { constraint: "name" } or a fragment as the target.',
  "query.onConflictTargetShape": "Pass a list of fields, { constraint: name } or a fragment as the target.",
  "query.onConflictUpdate": 'Pass update: "all", a list of fields, or { except: [fields] }.',
  "query.onConflictUpdateOption": 'To ignore a conflict, use onConflict: "nothing".',
  "query.onReplaceError":
    'Say what happens to {{them}}, for example with {{fix}}; the options are "invalid", "delete"{{assocModes}}{{oneModes}}.',
  "query.onReplaceSetNull": 'Make it .nullable(), or use onReplace "delete".',
  "query.onReplaceUpdateNull": 'Use onReplace "delete", "deleteIfExists" or "setNull" to allow null.',
  "query.orderExpected":
    "Return an expression, an order item (u.createdAt.desc()) or an array of them from the callback.",
  "query.outerJoinAfterSelect": "Add the {{clause}}() before {{this}}.",
  "query.outerRefAlias": 'Pass the alias of the outer binding first: outerRef("u", User).',
  "query.outerRefEmbedded":
    "Pass the schema class of a table: an embedded schema has no table, so no query binds it.",
  "query.outerRefSchema": 'Pass the schema class of that binding second: outerRef("{{alias}}", User).',
  "query.outerRefShadowed": "Give one of them another alias.",
  "query.outerRefWrongSchema":
    'Pass the schema class of the outer binding: outerRef("{{alias}}", {{found}}).',
  "query.overArgument":
    "Pass the name of a window declared with windows(), or { partitionBy, orderBy, frame }.",
  "query.overFrame": "Pass a fragment, such as fragment`ROWS BETWEEN 1 PRECEDING AND CURRENT ROW`.",
  "query.overName":
    'Declare the window with windows({ w: ({ p }) => ({ partitionBy: [p.authorId] }) }) and pass its name, over("w"), or pass the window itself.',
  "query.overTwice": "Call over() once per aggregate; declare the window with all its parts in that call.",
  "query.paramArguments": 'Pass a name and a field type, as in param("minAge", t.integer()).',
  "query.paramName": "Choose another name: the values are passed as one object keyed by name.",
  "query.paramNotWholeNumber": "Give a fraction a float type, val(2.5, t.float()), or round it.",
  "query.paramsMissing": "Pass a value for every named parameter, as in repo.all(q, { {{name}}: … }).",
  "query.paramsUnknown": "Pass only the named parameters the query declares with param().",
  "query.paramTwoTypes": "A named parameter has one type: give the other use its own name.",
  "query.pathEmpty": 'Pass at least one key, as in path("address", "city").',
  "query.pathKey": 'Pass keys as strings, or whole numbers for array positions, as in path("tags", 0).',
  "query.pathNotJson": "Use it on a t.json() or embedded field, or on a fragment.",
  "query.pgCursorMissing": "Add it with: pnpm add pg-cursor",
  "query.pipeFunction": "Pass a function from query to query: q.pipe(published).",
  "query.placeholdersMissing":
    "Give their values in the placeholders option: repo.insertAll(Schema, rows, { placeholders: { {{name}}: … } }).",
  "query.placeholdersUnused": 'Use one in a row as param("{{unknown}}", type).',
  "query.preloadBelowSelected": "Load it again with { force: true }.",
  "query.preloadBindingNotJoined":
    'Join it with joinAssoc("{{parent}}", "{{key}}", "{{value1}}"), or name a nested association of {{name}}.',
  "query.preloadCallbackArgument":
    'Pass a function that takes the query and returns it with clauses added: preload("{{name}}", (q) => q.limit(3)).',
  "query.preloadCallbackName": 'Pass one association name first: preload("posts", (q) => q.limit(3)).',
  "query.preloadCallbackOtherQuery":
    "Return the query the callback receives, with clauses added, not a new query.",
  "query.preloadCallbackResult": "Return the query the callback receives, with clauses added.",
  "query.preloadCallbackTwice": "Put everything in one callback.",
  "query.preloadFrom":
    'Join the binding through that association first: joinAssoc("{{parent}}", "{{key}}", "{{source}}").',
  "query.preloadLimitKey": "Give {{target}} a primary key, or preload without limit and offset.",
  "query.preloadLimitOrder":
    "Add orderBy(({ {{name}} }) => …) to the callback, or an orderBy option to the association.",
  "query.preloadMixedRows": "Rows of different schemas are preloaded in separate calls.",
  "query.preloadNamedParams": "Write the values into the query.",
  "query.preloadNoAssociations": "Preload from a query whose root binding is a schema with associations.",
  "query.preloadOptionalRoot": "Preload in a query without that join.",
  "query.preloadOptionalRows": "Use an inner or left join.",
  "query.preloadSelect": "Select the whole root binding, or preload in a separate query.",
  "query.preloadSelectedShape":
    "Preload before selecting a shape, or select the root binding: select(({ {{alias}} }) => {{alias}}).",
  "query.preloadSelectKey": "Add `{{key}}: {{name}}.{{key}}` to the select.",
  "query.preloadSpec":
    'Pass an association name, an array, an object of nested preloads, or a name and a callback, as in preload("posts", (q) => q.limit(3)).',
  "query.preloadTwice": "Load it one way.",
  "query.preloadUnknown": "Name an association the schema declares as a static member.",
  "query.preloadUnknownAssoc": "Preload an association the schema declares.",
  "query.prepareFunction":
    'Pass a function from changeset to changeset, as in prepareChanges((cs) => cs.putChange("slug", slugify(cs.getField("title")))).',
  "query.prepareQuery": 'Pass a query: prepare(from(User, "u").where(…)).',
  "query.putChangeEmbed": "Change it with putEmbed.",
  "query.putChangeUndefined": 'Use null for no value, or deleteChange("{{name}}") to remove the change.',
  "query.rawArgument":
    "Pass a fragment: repo.raw(fragment`select …`). Values go into the template as interpolations, where they are bound.",
  "query.readEmbedded": "Read the parent schema, and the embedded values from its rows.",
  "query.readOnlyUnsupported": "Leave readOnly out on {{dialect}}.",
  "query.readQueryWhere": "Pass a query built with from(), or a schema class.",
  "query.reloadNoKeyValue": "Reload rows read from the database, which have their keys.",
  "query.reloadNoPrimaryKey": "Read the rows again with a query.",
  "query.removesNamedParam": "Build the query without that clause instead.",
  "query.requiredFields": 'Pass a field name or a list of them, as in validateRequired(["email", "name"]).',
  "query.returningOption":
    'Pass returning: true for every field, or a list of field names, as in returning: ["id", "createdAt"].',
  "query.returningTwice": 'A query returns one shape: exclude("select") first.',
  "query.returningWithPreloads": 'An update or delete cannot preload: exclude("preload") first.',
  "query.reverseOrderNone": "Add an orderBy() first.",
  "query.rollbackOutside": "Call it on the tx that repo.transaction(async (tx) => …) gives the callback.",
  "query.rollbackSandbox": "Roll the sandbox back with sandbox.rollback(), in afterEach.",
  "query.rootInSandboxTransaction":
    "Only calls on the tx the callback was given are inside the transaction; outside the sandbox this call would run on another connection, outside it, and in the sandbox's one connection it cannot. Pass tx to the code you call (or, if the call is meant to commit on its own, test it without the sandbox).",
  "query.sandboxOpen": "Call sandbox.rollback() after each test (afterEach) before the next begin().",
  "query.sandboxRolledBack": "Await every call inside the test.",
  "query.savepointOptions": "Give isolation, readOnly and retries to the outermost transaction.",
  "query.savepointRollbackFailed":
    "Let the error propagate so that the whole transaction is rolled back, then run it again.",
  "query.scalarArgument":
    'Pass a query that selects one value: scalar(from(Post, "p").select(() => count())).',
  "query.scalarShape": "Select one expression, such as select(() => count()).",
  "query.schemalessData": "Pass the current values as a plain object, or {} when there are none.",
  "query.schemalessFieldName":
    'Rename the field: "constructor", "__proto__", "toJSON" and names that start with "$" are reserved.',
  "query.schemalessFieldType": "Give each field a type made with t, as in {{name}}: t.string().",
  "query.schemalessGenerated": "Use .default() for a value it should start with.",
  "query.schemalessShape":
    "Pass { data, types }, as in { data: {}, types: { q: t.string(), page: t.integer() } }.",
  "query.schemaName": 'Pass the name of a database schema: schema("tenant_1").',
  "query.selectBinding": "Select its columns one by one.",
  "query.selectBindingSchema": "Select the binding as the rows its source yields.",
  "query.selectDuplicateColumn": "Give one of them another name.",
  "query.selectedAsExpression": "Pass an expression to name first, such as sum(p.views).",
  "query.selectedAsInClause": "Use the expression itself; names are for orderBy() and groupBy().",
  "query.selectedAsName": 'Pass a name, a non-empty string: selectedAs(sum(p.views), "total").',
  "query.selectedAsSelected": 'Select the expression itself, and name it: selectedAs(expr, "{{name}}").',
  "query.selectedAsUnknown": 'Name one in the select: selectedAs(expr, "{{String}}").',
  "query.selectMergeResult":
    "Return an object of keys to add, as in selectMerge(({ p }) => ({ title: p.title })).",
  "query.selectMergeShape": "Select an object first: select(({ u }) => ({ id: u.id })).",
  "query.selectMissing": "Add a select.",
  "query.selectOnUpdate": "Declare what the update returns with returning(): returning(({ p }) => p.id).",
  "query.selectOrderItem": "Order items belong in orderBy(); select the expression itself.",
  "query.selectQuery": "A query is not a value: select an expression, or use a subquery expression.",
  "query.selectTuple": "A row value is compared, not selected: select its items.",
  "query.selectTwice": 'A query has one: use selectMerge() to add keys, or exclude("select") first.',
  "query.selectUnknownBinding": "Select a binding the query has.",
  "query.selectValue": "Select expressions, bindings and plain values.",
  "query.selectWithPreloads":
    "Preloaded associations are attached to whole rows: select ({ {{this}} }) => {{this}}, or preload in a separate query.",
  "query.setArgument":
    "Pass an object of field values, or a callback that returns one: set({ published: true }), set(({ p }) => ({ views: p.views.add(1) })).",
  "query.setEmpty": "Set at least one field: set({ published: true }).",
  "query.setNotTable": 'Update a query rooted at a schema class: from(Post, "p").set({ published: true }).',
  "query.setNullNotNullable":
    "Set the field to a value, or make it .nullable() in the schema (and the column nullable in the database).",
  "query.setOperationArgument": 'Pass another query: q.{{method}}(from(Post, "p").select(…)).',
  "query.setOperationClause":
    'On a combined query those apply to the combined rows, not to this side: add them after {{method}}(), or, to order or limit this side alone, wrap it: from(subquery(q), "s").',
  "query.setOperationLock": "Lock the rows in a separate query, or remove lock() from the side.",
  "query.setOperationPlainValue": "Select it as a value with a type: val(value, t.string()).",
  "query.setOperationPreloads": 'Preload in a query over the combined rows, or exclude("preload") first.',
  "query.setOperationShapes":
    "Columns are combined by position, so both must select the same shape, with keys in the same order.",
  "query.setOperationUpdate": "An update cannot be combined with a query: run it on its own.",
  "query.setUndefined": "Leave the key out, or pass null to store NULL.",
  "query.setUnknownField": "Set only stored fields of the schema; a virtual field has no column to update.",
  "query.setWithPreloads": 'An update cannot preload: exclude("preload") first.',
  "query.setWithSelect":
    'An update says what it returns with returning(), not select(): exclude("select"), then returning(({ p }) => p.id).',
  "query.sourceEmbedded":
    "Query the parent schema, and read the embedded values from its rows (or with field() and path() in a query).",
  "query.sourceInvalid":
    'Pass a schema class, as in {{clause}}(User, "{{alias}}"), or a source such as subquery(q) or cte(name, Schema).',
  "query.sourceIsQuery":
    'To continue a query, call more methods on it; to use it as a source, wrap it: {{clause}}(subquery(q), "{{alias}}").',
  "query.sourceIsUpdate": "Only a query that reads can be a source; run the update on its own.",
  "query.sourceSchemaMismatch": "Declare the source with the schema its query selects.",
  "query.sourceShape":
    "Select an object of expressions, as in select(({ p }) => ({ id: p.id, title: p.title })), or whole rows of a schema.",
  "query.sourceWithPreloads": 'Exclude them first: exclude("preload").',
  "query.streamOpen":
    "Finish it, or leave its for-await loop (break or return), before running another statement or stream on the same connection.",
  "query.streamPreload":
    "Stream the parents without preload, or read them in batches with repo.all(query.limit(n).offset(…)) and preload each batch.",
  "query.subqueryArgument": 'Pass a query: subquery(from(Post, "p").select(…)).',
  "query.subqueryExpected": "Pass a query built with from(), with a select() of one expression.",
  "query.subqueryIsUpdate":
    "Only a query that reads can be a subquery: leave out set(…), or run the update on its own with repo.updateAll().",
  "query.subqueryWithPreloads":
    'A subquery returns values to its enclosing query, and cannot run preloads: exclude("preload") first.',
  "query.subsetValues": 'Pass the values as an array, as in validateSubset("tags", ["a", "b"]).',
  "query.sumType": "Pass an expression of a numeric type (integer, bigint, float or decimal).",
  "query.throughKey":
    "Give the target schema a single-field primary key, or preload the chain one association at a time.",
  "query.throughLimitAmbiguous": "Preload without limit, or preload the chain's associations themselves.",
  "query.tooManyParams": "Split it into smaller statements.",
  "query.transactionEnded": "Await every call on tx inside the callback.",
  "query.transactionFailed":
    "Roll back (throw, or tx.rollback(reason)), or run the statement that may fail in a nested transaction, tx.transaction(async (inner) => …), whose failure undoes only its own work.",
  "query.transactionRollingBack":
    "Return from the callback after tx.rollback(); run further statements in a new transaction.",
  "query.transactionStreamLeftOpen": "Finish the stream, or leave its for-await loop, inside the callback.",
  "query.transactionStreamOpen":
    "Finish it, or leave its for-await loop (break or return), before running another statement or stream.",
  "query.tupleCompare": "Pass another tuple: tuple(a, b).{{op}}(tuple(x, y)).",
  "query.tupleEmpty": "Pass at least one item, as in tuple(u.lastName, u.firstName).",
  "query.tupleLength": "Rows compare position by position, so give both as many items.",
  "query.tupleNull":
    "A comparison with null is never true: compare the other items, and test this one with isNull().",
  "query.tupleUndefined":
    "Pass a value or an expression for every item; undefined is usually a missing property or variable.",
  "query.tupleUntyped": "Put a column there, or give one value a type: val(value, t.integer()).",
  "query.undefinedOperand": "Pass a value; undefined is usually a missing property or variable.",
  "query.undefinedOperandNullable":
    "Pass null for SQL NULL; undefined is usually a missing property or variable.",
  "query.uniqueAsyncFields":
    'Pass a field name or a non-empty list of them, as in validateUniqueAsync("email", repo).',
  "query.uniqueAsyncSchemaless":
    "Make the changeset from a schema class or a row to check uniqueness in its table.",
  "query.uniqueAsyncUnavailable":
    "Import validateUniqueAsync's support with the repo: it is set when egon-orm's repo module is loaded.",
  "query.uniqueFields": 'Pass a field name or a non-empty list of them, as in uniqueConstraint(["email"]).',
  "query.unknownBinding":
    "Use a binding of this query, or outerRef(alias, Schema) for one of an enclosing query.",
  "query.unsupportedFeature":
    "See Dialect support for what {{dialect}} supports; a fragment can write SQL the builder has no method for.",
  "query.untypedArithmetic": "Give a value a type: val(value, t.integer()) or val(value, t.float()).",
  "query.untypedValue":
    "Give the value a type with val(value, t.integer()) (or the type it has), or compare it with a column, which gives it the column's type.",
  "query.updateAllArgument":
    'Pass a query with .set(...): repo.updateAll(from(Post, "p").where(…).set({ published: true })).',
  "query.updateAllNoSet":
    'Say what to write with .set(...): repo.updateAll(from(Post, "p").where(…).set({ published: true })).',
  "query.updateAllWithoutSet":
    'Say what to update with set(…): repo.updateAll(from(Post, "p").set({ published: true })).',
  "query.updateNoKey": "The update plan is malformed: the repo always finds the row by its primary key.",
  "query.updateNoSet":
    "The update plan is malformed: the repo runs no statement for a changeset without changes.",
  "query.updateWithAll": "Run it with repo.updateAll(q), or leave out set(…) to read.",
  "query.upsertUnreadable":
    "Nothing was written. Upsert by the key, or read the row by the conflicting field and update it.",
  "query.validateApply": "Pass apply: true or false, or leave it out.",
  "query.validateApplyCombined":
    "A schema that reports an issue has no output to apply, even when that issue is then left out. Validate with a schema of just the fields to transform instead.",
  "query.validateApplyFunction": "A validator function returns issues only; change values with putChange.",
  "query.validateChangeFunction":
    'Pass a function of the field\'s change, as in validateChange("email", (value) => …).',
  "query.validateChangeResult":
    "Return a message, an error ({ message, meta? }), a list of either, or nothing from the function.",
  "query.validateOnly": 'Pass only as a list of field names, as in { only: ["email"] }.',
  "query.validateOptions": 'Pass the options as an object, such as { scope: "changed" }.',
  "query.validateScope": 'Pass scope: "all" (the default) or "changed".',
  "query.validateUnknownField": "Name one of the changeset's fields; a typo is the usual cause.",
  "query.validatorPromise": "An async validator runs with validateAsync(); validate() is synchronous.",
  "query.validatorValueType":
    "Use the validator on a field of the matching type, or validate the value with validateChange().",
  "query.valuesEmpty": "Give the values source at least one row.",
  "query.valuesRowLength": "Give every row one value per column.",
  "query.valUndefined": "Pass a value, or null.",
  "query.windowArgument": "Pass an expression, such as p.views.",
  "query.windowCallback":
    "Pass a callback that receives the bindings and returns the window: {{name}}: ({ p }) => ({ partitionBy: [p.authorId] }).",
  "query.windowCount": "Pass {{what}} as a whole number of at least 1, or an integer expression.",
  "query.windowFrame": "Pass a fragment, such as fragment`rows between unbounded preceding and current row`.",
  "query.windowFunctionFilter":
    "filter() is for aggregates such as count() and sum(); remove it from the window function.",
  "query.windowFunctionOver": "Add .over(…), such as {{name}}().over({ orderBy: [p.createdAt] }).",
  "query.windowInClause": "Window functions are allowed only in select() and orderBy().",
  "query.windowInFilter":
    'Window functions are computed after the rows are filtered and grouped. Select it, then filter on it from a query over this one: from(subquery(q), "s").where(…).',
  "query.windowMemberArray": "Pass an array: {{member}}: [p.authorId].",
  "query.windowName":
    "Give each window a name that is an identifier: a letter or underscore, then letters, digits, underscores or $.",
  "query.windowOrder": "Put expressions or order items in orderBy, as in orderBy: [p.createdAt.desc()].",
  "query.windowPartition": "Put expressions in partitionBy, as in partitionBy: [p.authorId].",
  "query.windowsEmpty":
    "Name at least one window: windows({ w: ({ p }) => ({ partitionBy: [p.authorId] }) }).",
  "query.windowShape": "Return a window from the callback: { partitionBy, orderBy, frame }.",
  "query.windowsObject":
    "Pass an object of named windows: windows({ w: ({ p }) => ({ partitionBy: [p.authorId] }) }).",
  "query.windowTwice": "Give each window its own name.",
  "query.windowUndeclared": "Declare it first: windows({ {{over}}: ({ p }) => ({ … }) }).",
  "query.windowUnknownKey": "A window takes partitionBy, orderBy and frame.",
  "query.withCteQuery":
    'Pass a query built with from() as the second argument: withCte("tree", from(Category, "c")).',
  "query.writeEmbedded": "Write the parent row, whose column holds the embedded value.",
  "query.writeEmbeddedSchema": "Write the parent row, whose column holds the embedded value.",
  "query.writeJoinKind": "Join with join() (an inner join) or crossJoin() in an update or a delete.",
  "query.writeNestedNotEmbed": "Only embed fields and associations hold nested changesets.",
  "query.writeNewRecord": "Insert it with repo.insert(), or use repo.insertOrUpdate().",
  "query.writeNoKeyValue": "Pass a changeset of a row read from the database, which has its key.",
  "query.writeNoPrimaryKey": "Use repo.{{method}}() with a query.",
  "query.writeNotLoaded": "Pass a changeset of a row returned by a query or a write that was not deleted.",
  "query.writeNotWholeNumber":
    "Give it a whole number, or declare the field t.float() or t.decimal() if it holds fractions.",
  "query.writeOptionField": "Name stored fields of the schema.",
  "query.writeOptionFields": 'Pass a non-empty list of field names, as in ["email"].',
  "query.writeSchemaless": "Use applyAction() to validate such data.",
  "query.writeUnknownChange":
    "Change only the fields and associations the schema declares; a changeset built with cast() or change() never holds others.",
  "query.writeUnknownField": "The write plan is malformed: the repo passes only the schema's own fields.",
  "query.writeVirtualField": "The write plan is malformed: the repo never writes a virtual field.",
  "query.writeWithClause": "Remove {{clause}} from the query before {{verb}}: exclude() removes a clause.",
  "query.zodFieldList": 'Pass a list of field names, as in { pick: ["email", "name"] }.',
  "query.zodHint":
    "Give the type a zod hint that is a Zod schema, or a function of the field that returns one.",
  "query.zodMode": 'Pass mode: "row" (the default), "insert" or "update".',
  "query.zodUnknownField": "Name only fields of the schema.",

  // --- rollback ---
  "rollback.batchFailed":
    "Call repo.transaction(batch) instead of transactionOrThrow() to get it back as a failed Result.",
  "rollback.called":
    "Call repo.transaction() instead of transactionOrThrow() to get the reason back as a failed Result.",
  "rollback.statementFailed":
    "Let the error propagate, or run the statement that may fail in a nested tx.transaction().",

  // --- schema ---
  "schema.arrayElement": "Put the modifiers on the array: t.array(t.string()).nullable().",
  "schema.assocFieldClash":
    'A preloaded association is a property of the row, so rename one of them (the foreign-key field is usually "{{name}}Id").',
  "schema.assocFieldVirtual":
    "Point the association at a stored field: remove .virtual() from it, or use another field.",
  "schema.assocKeyCount": "Give one foreign-key field per referenced field, in the same order.",
  "schema.assocKeyOption":
    'Pass a field name, as in { foreignKey: "authorId" }, or an array of them for a composite key.',
  "schema.assocKeyType": "Declare both with the same type.",
  "schema.assocNoPrimaryKey": "Pass { {{option}} }.",
  "schema.assocOnEmbedded": "Move the association to the parent schema.",
  "schema.assocOnReplace":
    'Pick one of the listed modes; "error" (the default) refuses to replace existing associated rows.',
  "schema.assocOptionsNotObject":
    'Pass the options as an object, as in hasMany(() => Post, { foreignKey: "authorId" }).',
  "schema.assocOrderBy":
    'Pass field names, as in ["createdAt"], or objects of a field and a direction, as in [{ createdAt: "desc" }].',
  "schema.assocOrderByFieldMissing": "An order is written with the target's field names.",
  "schema.assocReservedName": "Rename the static member.",
  "schema.assocShadowedByMember":
    "A preloaded association is a property of the row, so the class member would hide it or make it impossible to set. Rename one of them.",
  "schema.assocTargetEmbedded": "Declare it as a field: t.embedOne(() => {{name}}).",
  "schema.assocTargetNotSchema":
    "The function must return a class declared with Schema(...), such as () => Post.",
  "schema.assocTargetThrew":
    "It is called when associations are first used, by which time every schema module must have been loaded.",
  "schema.assocTargetThunk":
    "Pass a function that returns the class, so that classes can refer to each other: {{example}}.",
  "schema.assocUnknownOption": "Remove the option, or check its spelling against the ones listed.",
  "schema.assocWhereFieldMissing": "A where condition is written with the target's field names.",
  "schema.assocWhereOption": "Pass an object from field name to value, such as { published: true }.",
  "schema.assocWhereUndefined": "Use null to match NULL, or leave the key out.",
  "schema.autogenerateFunction":
    "Pass a function that makes the value, such as autogenerate(() => crypto.randomUUID()).",
  "schema.autogenerateType":
    "autogenerate() without a function works for t.uuid() (a UUID v7) and for timestamps (the current time). For other types, pass the function: autogenerate(() => value).",
  "schema.belongsToKeyMissing":
    "Declare the field (as in authorId: t.integer()), or pass { foreignKey } with the field that holds the key.",
  "schema.bigintMode": 'Pass { mode: "bigint" } (the default) or { mode: "number" }.',
  "schema.columnName": 'Pass the column name, as in column("pw_hash").',
  "schema.columnTaken": 'Give one of them another column with .column("…").',
  "schema.createWithTwice": "List each association once.",
  "schema.createWithUnknown": "Preload only associations the schema declares.",
  "schema.dateAsOption": 'Pass { as: "string" } (the default) or { as: "date" }.',
  "schema.decimalPrecision": "Pass a precision from 1 to 1000, as in t.decimal({ precision: 10, scale: 2 }).",
  "schema.decimalScale":
    "Pass a scale from 0 to the precision, as in t.decimal({ precision: 10, scale: 2 }).",
  "schema.defaultValue": "To allow a missing value, use nullable().",
  "schema.embedModifier":
    "Remove .primaryKey() or .virtual() from the embed field. An embed is stored in its parent's JSON column; give the embedded schema its own key field if its items need one.",
  "schema.embedSchemaThunk":
    "Pass a function that returns the class, as in t.embedOne(() => Address) or t.embedMany(() => Address), so that the class may be declared after the field.",
  "schema.enumDuplicate": "List each member once.",
  "schema.enumEmpty": 'Give t.enum at least one member, as in t.enum(["admin", "member"]).',
  "schema.enumMappingAmbiguous": "Choose stored values that are not also member names.",
  "schema.enumMappingDuplicate": "Give every member its own stored value.",
  "schema.enumMappingValues":
    "Map every member to a string, or every member to a whole number, as in t.enum({ low: 1, high: 2 }).",
  "schema.enumMembers":
    'Pass a list of strings, t.enum(["admin", "member"]), or a mapping, t.enum({ low: 1, high: 2 }).',
  "schema.enumMemberType": "For other stored values use a mapping: t.enum({ low: 1, high: 2 }).",
  "schema.fieldsNotObject":
    "Pass the fields as the second argument of Schema() (or the first of EmbeddedSchema()), an object whose values are field types made with t.",
  "schema.foreignKeyRequired":
    'Pass the field, as in {{kind}}(() => {{target}}, { foreignKey: "authorId" }).',
  "schema.generatedTwice": "Only one side can produce the value: remove .dbGenerated() or .autogenerate().",
  "schema.hasKeyMissing":
    "Declare the field on {{target}} (as in authorId: t.integer()), or correct { foreignKey }.",
  "schema.joinKeyFieldMissing": "Pass { joinKeys } with fields of {{join}}.",
  "schema.joinKeysAmbiguous": "Pass { joinKeys: { owner, target } } with the fields of {{name}}.",
  "schema.joinKeysOption":
    'Pass joinKeys: { owner: "...", target: "..." }, each naming a {{unit}} of the join table.',
  "schema.joinKeysRequired":
    'Pass joinKeys, as in { joinThrough: "{{through}}", joinKeys: { owner: "post_id", target: "tag_id" } }: owner is the column that points at {{owner}}, target the one that points at {{target}}.',
  "schema.joinKeysSame": "They are two different {{unit}}s.",
  "schema.joinKeysSelf": "Pass { joinKeys: { owner, target } } with the fields of {{name}}.",
  "schema.joinKeyType": "Declare both with the same type.",
  "schema.joinThroughEmpty": "Give the join table's name.",
  "schema.joinThroughRequired":
    'Pass { joinThrough: "posts_tags", joinKeys: { owner, target } } with the join table\'s name, or { joinThrough: () => PostTag } with its schema class.',
  "schema.joinWhereFieldMissing": "A joinWhere condition is written with the field names of {{join}}.",
  "schema.keylessRow":
    "The schema is declared with { primaryKey: false }, or is an embedded schema without a key field.",
  "schema.keylessWithKey": "Remove one of the two.",
  "schema.manyToManyCompositeKey":
    "Give the schema a single-field key, or declare the join as a schema class with belongsTo associations and use hasMany with through.",
  "schema.memberShadowsField":
    "A row holds each field as its own property, so the class member would hide it or make it impossible to set. Rename the member.",
  "schema.namingOption":
    'Pass naming: "snake_case" (the default for tables), naming: "camelCase", or a function such as (field) => field.toLowerCase().',
  "schema.namingResult": "It must return the column name.",
  "schema.noConstructor":
    "Describe a new record with a changeset instead: cast({{name}}, params, [...]) or change({{name}}, values).",
  "schema.noPrimaryKey":
    "Add .primaryKey() to the key field, as in id: t.integer().primaryKey(), or pass { primaryKey: false } as the third argument for a table without one.",
  "schema.notFieldType":
    "Declare it with t, as in {{name}}: t.string(). Associations are static members of the class, not fields.",
  "schema.notFieldTypeValue":
    "Use a field type from t, such as t.integer() or t.string(), or a type made with defineType() and wrapped as t.type(MyType).",
  "schema.notRow": "Pass a row returned by a query or a write, not a plain object or a changeset.",
  "schema.notSchemaClass":
    'Pass the class you declared with class User extends Schema("users", { ... }) {}, not an instance, a row or a plain object.',
  "schema.nullableKey": "A key always has a value: remove .nullable().",
  "schema.nullDefault": "Add .nullable().",
  "schema.onReplaceOption":
    'Pick one of the listed modes; "error" (the default) refuses to replace an existing embed.',
  "schema.optionsNotObject":
    'Pass the options as an object, such as { schema: "tenant_1" }, or leave them out.',
  "schema.precisionOption": 'Pass precision "s", "ms" or "us", or leave it out for the type\'s default.',
  "schema.primaryKeyOption": "A key is declared on its field: id: t.integer().primaryKey().",
  "schema.referencedFieldMissing": "Pass { references } with the field the key points at.",
  "schema.reservedName":
    'A field cannot be named "constructor", "__proto__" or "toJSON", or start with "$". Rename it, and keep the column with .column("{{name}}").',
  "schema.schemaOption":
    "Pass the database schema's name, as in { schema: \"tenant_1\" }, or leave the option out for the connection's default.",
  "schema.stateNotRow":
    "Pass a row returned by a query or a write: a plain object or a changeset has no state.",
  "schema.tableName": 'Pass the table name as a non-empty string: Schema("users", { ... }).',
  "schema.throughCombined":
    "Remove the other options: the associations through follows already say how the rows are found.",
  "schema.throughPath":
    'Pass the names of the associations to follow, as in {{kind}}(() => Comment, { through: ["posts", "comments"] }).',
  "schema.throughUnknownStep": "Follow associations the schema declares, in the order the path takes them.",
  "schema.throughWrongTarget":
    "Make the last association of the path point at the declared target, or change the target to the class the path ends at.",
  "schema.timestampsField":
    'Pass the field name as a string, as in timestamps({ createdAt: "insertedAt" }), or false to leave that field out.',
  "schema.timestampsSameName": "Give them different names, or pass false for one.",
  "schema.timestampsType":
    "Pass a timestamp type such as t.timestamp() or t.localTimestamp(), without modifiers: timestamps() adds its own.",
  "schema.typeCast":
    "Pass cast: (value) => ({ success: true, data: value }), returning { success: false } for a value it rejects.",
  "schema.typeCustomSql":
    "It is written into the SQL text, so it must be a constant and can never come from user data.",
  "schema.typeDbKind":
    'Give db a column type, such as { kind: "text" }, { kind: "array", of: { kind: "integer" } } or { kind: "custom", sql: "citext" }.',
  "schema.typeMember": "Pass a function, or leave the member out to use the identity.",
  "schema.typeName": 'Pass a name, as in defineType({ name: "money", ... }); it appears in error messages.',
  "schema.typeNotDefined": "For a built-in type use its own function, such as t.string().",
  "schema.typeOptionsDepth": "They probably contain themselves; options must be plain data.",
  "schema.typeUnknownKind":
    'Use one of the listed kinds; { kind: "array", of } for an array, or { kind: "custom", sql } for any other SQL type.',
  "schema.uniqueOption": "Pass unique: true or unique: false, or leave it out.",
  "schema.virtualJsonOption":
    "Pass { json: true } to keep the field in the row's JSON, or leave the options out: a virtual field is left out by default.",
  "schema.virtualOptions":
    "Pass { json: true } to keep the field in the row's JSON, or leave the options out.",
  "schema.virtualStored": "Remove .virtual() or the other modifier.",
  "schema.virtualUnknownOption": "Remove the option, or check its spelling: the one option is json.",
  "schema.writableOption":
    'Pass "always" (the default), "insert" for a field set only when the row is inserted, or "never" for a field only the database writes.',

  // --- general ---
  staleEntry:
    "It was deleted or changed since it was loaded. Reload it and try again, or pass allowStale: true to ignore this.",
};
