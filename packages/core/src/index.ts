/**
 * The version of the `egon-orm` package.
 *
 * @example
 * ```ts
 * import { VERSION } from "egon-orm";
 *
 * console.log(VERSION); // "0.0.0"
 * ```
 */
export const VERSION: string = "0.0.0";

// Step 11: the shared adapter. `createAdapter` and `AdapterDefinition` are internal to the
// Egon packages (owner decision, 2026-10-22): they are exported only so that the dialect
// packages can build their adapters, and the driver wrapper they take stays unnamed here.
// The contract types a developer names when running SQL or listening to events are public.
export type { AdapterDefinition, DatabaseAdapter, PoolStats } from "./adapter/adapter.js";
export { createAdapter } from "./adapter/adapter.js";
export type { DriverCodec, DriverCodecs } from "./adapter/codecs.js";
export type { QueryListenerOptions } from "./adapter/telemetry.js";
// Step 16: Batch, and the options of transactions.
export type { BatchFailure, BatchOperation, BatchStep } from "./batch/index.js";
export { Batch, createBatch } from "./batch/index.js";
// Step 05: changesets. The contract types a developer names when reading a changeset
// (its errors, its constraints, its action) are public with it.
export type {
  AppliedData,
  AssocName,
  CastOptions,
  Changes,
  ChangesetData,
  ChangesetModel,
  ChangesetSource,
  ChangeValidatorError,
  ChangeValidatorResult,
  CheckConstraintOptions,
  ConfirmationOptions,
  ConstraintOptions,
  ErrorFormatter,
  ErrorMessages,
  ErrorTree,
  ErrorTreeOf,
  FieldName,
  FieldOfType,
  FieldValues,
  LengthOptions,
  MessageOption,
  MessageOptions,
  NumberOptions,
  PrepareFunction,
  RequiredOptions,
  RowSchema,
  SchemalessTarget,
  TypedErrorTree,
  UniqueAsyncOptions,
  ValidationEntry,
} from "./changeset/index.js";
export {
  applyAction,
  applyActionOrThrow,
  Changeset,
  cast,
  change,
  traverseErrors,
} from "./changeset/index.js";
// Step 15: nested changesets. The methods are on `Changeset`; `buildAssoc` and the types
// of nested changes are public with them.
export { buildAssoc } from "./changeset/nested/index.js";
export type {
  AnyChildChangeset,
  AssocChange,
  AssocTarget,
  CastNestedArgs,
  CastNestedOptions,
  EmbedName,
  EmbedTarget,
  FieldChange,
  LooseNestedOptions,
  PutAssocValue,
  PutEmbedValue,
  PutItem,
  PutObject,
  WithFunction,
} from "./changeset/nested/types.js";
// Step 06: schema and function validators. The contract types a developer names when
// writing a validator are public with them.
export type { FieldValidator, FieldValidatorFn, ValidateOptions } from "./changeset/validators/index.js";
export { BASE } from "./changeset/validators/index.js";
// Step 12: the repo, its reads and their options. `Repo` is the type of every repo, the
// transaction-scoped one included; the plan-cache counters are public with `planCacheStats`.
export type { PlanCacheStats } from "./compiler/cache.js";
export type {
  Adapter,
  AdapterEvents,
  BeginOptions,
  Capabilities,
  Connection,
  Dialect,
  ExecuteOptions,
  Executor,
  IsolationLevel,
  PoolEvent,
  QueryEvent,
  RawResult,
  StreamOptions,
} from "./contracts/adapter.js";
export type {
  Action,
  ChangesetError,
  ChangesetLike,
  Constraint,
  ConstraintType,
  ValidationIssue,
  Validator,
  ValidatorContext,
  ValidatorFn,
  ValidatorResult,
} from "./contracts/changeset.js";
// Step 02: the two parts of the contracts that are public API by themselves. The contract
// types (Row, Loaded, FieldType, Adapter, ...) are exported by the step that implements them.
export type { Failure, Result, Success } from "./contracts/result.js";
export { failure, success } from "./contracts/result.js";
// Step 04: schemas. The contract types a developer names (`Row`, `InsertShape`, `Loaded`,
// the metadata that `meta()` returns) are public together with the functions.
export type {
  AnySchema,
  Assoc,
  AssocKeys,
  AssocKind,
  AssocMeta,
  AssocOrderMeta,
  DefaultFieldFlags,
  EmbedMeta,
  FieldBuilder,
  FieldFlags,
  FieldMeta,
  FieldNames,
  FieldsShape,
  InsertShape,
  JoinKeyMeta,
  JoinThroughMeta,
  Loaded,
  LoadedAs,
  LoadedUnchecked,
  OnReplace,
  PreloadMarker,
  PreloadSpec,
  PrimaryKeyOf,
  Row,
  RowMarker,
  RowMeta,
  RowState,
  SchemaClass,
  SchemaMeta,
  VirtualOptions,
  WithFlag,
  WithoutJson,
  Writable,
} from "./contracts/schema.js";
export type {
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1PathSegment,
  StandardSchemaV1Result,
} from "./contracts/standard-schema.js";
// Step 03: the type system. The built-in types are reached through the field builder `t`
// (step 04); what is public here is how to write your own.
export type {
  AnyFieldType,
  AppTypeOf,
  CastResult,
  Codec,
  DbType,
  DbTypeKind,
  DbTypeOf,
  FieldType,
} from "./contracts/type.js";
export type {
  ConstraintViolationType,
  DatabaseErrorCode,
  ErrorCatalog,
  ErrorCode,
  ErrorDetails,
  ErrorId,
  ErrorParams,
} from "./errors.js";
export {
  CastError,
  ConstraintError,
  DatabaseError,
  EgonError,
  InvalidChangesetError,
  isEgonError,
  MultipleResultsError,
  NoResultsError,
  NotLoadedError,
  QueryError,
  RollbackError,
  SchemaDefinitionError,
  StaleEntryError,
  useFullErrorMessages,
} from "./errors.js";
export { cte } from "./query/advanced/cte.js";
// Step 09: advanced queries. The classes are public as types only: they are made by these
// functions.
export type { Dynamic, DynamicBindings, DynamicFunction, DynamicMethods } from "./query/advanced/dynamic.js";
export { dynamic, field } from "./query/advanced/dynamic.js";
export type { PreparedQuery } from "./query/advanced/prepare.js";
export { prepare } from "./query/advanced/prepare.js";
export { selectedAs } from "./query/advanced/selected-as.js";
export type { Source, SourceBindingOf, SourceRowOf, SubqueryBinding } from "./query/advanced/sources.js";
export { outerRef, scalar, subquery } from "./query/advanced/subquery.js";
export type { Tuple } from "./query/advanced/tuple.js";
export { tuple } from "./query/advanced/tuple.js";
export type { NeedsWindow, WindowDefs, WindowFunction } from "./query/advanced/windows.js";
export {
  cumeDist,
  denseRank,
  firstValue,
  lag,
  lastValue,
  lead,
  nthValue,
  ntile,
  percentRank,
  rank,
  rowNumber,
} from "./query/advanced/windows.js";
export type { CteOptions } from "./query/advanced/with-cte.js";
// Step 14: associations: querying them and checking what is loaded.
export { assoc, isLoaded } from "./query/assoc.js";
// Step 08: the query builder. `Query` is public as a type only: a query starts with `from`.
export type { Binding } from "./query/bindings.js";
export type {
  ExcludableClause,
  LockMode,
  LockOptions,
  PreloadQuery,
  Query,
  Queryable,
  QueryLike,
  QueryParams,
  QueryResult,
  QueryWith,
  SetInput,
  WhereObject,
} from "./query/builder.js";
export { from, hasNamedBinding } from "./query/builder.js";
// Step 07: query expressions. The classes are public as types only: expressions come from
// columns, operators and these functions.
export type { Col, Expr, NoParams, Operand, OrderExpr, SomeParams } from "./query/expr.js";
export type { Aggregate, Case, FragmentFunction, UsesWindow, WindowSpec } from "./query/functions.js";
export {
  and,
  arrayAgg,
  avg,
  caseWhen,
  coalesce,
  count,
  countDistinct,
  exists,
  fragment,
  jsonAgg,
  lit,
  max,
  min,
  not,
  now,
  or,
  param,
  stringAgg,
  sum,
  val,
} from "./query/functions.js";
// Step 13: the options and results of the writes.
export type { BulkResult, InsertAllOptions, InsertAllRow } from "./repo/bulk.js";
export type {
  ExplainReadOptions,
  LogOption,
  ReadOptions,
  RepoOperation,
  RepoOptions,
  RepoQueryEvent,
  StreamReadOptions,
} from "./repo/options.js";
export type { PreloadOptions } from "./repo/preload.js";
export type { AggregateFunction, RawRows } from "./repo/read.js";
export type { ReadArgs, Repo, ResultOf, RootSchemaOf, SqlAndParams } from "./repo/repo.js";
export { createRepo } from "./repo/repo.js";
export type { TransactionOptions } from "./repo/transaction.js";
export type {
  ConflictTargetOption,
  ConflictUpdateOption,
  DeleteOptions,
  InsertOptions,
  InsertOrUpdateOptions,
  OnConflictOption,
  StaleErrorOption,
  UpdateOptions,
} from "./repo/write.js";
export type {
  AssocOrderBy,
  AssocWhere,
  BelongsToOptions,
  EmbeddedSchemaOptions,
  EmbedFieldBuilder,
  EmbedOnReplace,
  EmbedOptions,
  FieldTypes,
  HasManyOptions,
  HasOneOptions,
  JoinKeys,
  KeyFields,
  ManyToManySchemaOptions,
  ManyToManyTableOptions,
  Naming,
  SchemaOptions,
  ThroughOptions,
  TimestampFields,
  TimestampsOptions,
} from "./schema/index.js";
export {
  belongsTo,
  EmbeddedSchema,
  fieldNames,
  hasMany,
  hasOne,
  isRow,
  isSchema,
  manyToMany,
  meta,
  primaryKeyOf,
  Schema,
  stateOf,
  t,
  timestamps,
} from "./schema/index.js";
// Step 21b: the types of JSON responses. Type-only.
export type { Json, JsonReturn } from "./schema/json-types.js";
export type { EnumMapping } from "./types/composite.js";
export type { TypeDefinition } from "./types/define.js";
export { defineType, parameterized } from "./types/define.js";
// The options of the field builder's types, for code that passes them around.
export type { DecimalOptions } from "./types/scalars.js";
export type { TimestampOptions, TimestampPrecision } from "./types/temporal.js";
