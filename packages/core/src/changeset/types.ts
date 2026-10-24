/**
 * The types a changeset is written against: what a changeset can be made from, the names
 * and value types of its fields, and the options of its methods.
 *
 * @module
 */
import type { ChangesetError } from "../contracts/changeset.js";
import type {
  AnySchema,
  AssocKeys,
  FieldBuilder,
  FieldFlagsOf,
  FieldsOf,
  FieldsShape,
  Row,
  RowOf,
  SchemaStatic,
} from "../contracts/schema.js";
import type { Changeset } from "./changeset.js";
import type {
  AssocChange,
  AssocChanges,
  AssocKindOf,
  AssocTarget,
  EmbedMany,
  EmbedTarget,
  FieldChange,
} from "./nested/types.js";

/**
 * A changeset without a schema class: the data it starts from and the type of each
 * field, given with the field builder `t`. Used for input that has no table, such as a
 * search form.
 *
 * @example
 * ```ts
 * const search: SchemalessTarget<{ q: FieldBuilder<string>; page: FieldBuilder<number> }, {}> = {
 *   data: {},
 *   types: { q: t.string(), page: t.integer() },
 * };
 * ```
 */
export interface SchemalessTarget<F extends FieldsShape = FieldsShape, D extends object = object> {
  readonly data: D;
  readonly types: F;
}

/**
 * What a changeset describes: a schema class, or a {@link SchemalessTarget}.
 *
 * @example
 * ```ts
 * type Sources = ChangesetSource; // AnySchema | SchemalessTarget
 * ```
 */
export type ChangesetSource = AnySchema | SchemalessTarget;

/** The field builders of a changeset source. */
type SourceFields<S> = S extends SchemalessTarget<infer F, infer _D> ? F : FieldsOf<S>;

/**
 * The value of every field of `S`, virtual fields included: the row type without its
 * getters and methods.
 *
 * @example
 * ```ts
 * type UserValues = FieldValues<typeof User>; // { id: number; email: string; name: string | null; … }
 * ```
 */
export type FieldValues<S> = RowOf<SourceFields<S>>;

/**
 * The field names of `S`.
 *
 * @example
 * ```ts
 * type Names = FieldName<typeof User>; // "id" | "email" | "name" | …
 * ```
 */
export type FieldName<S> = keyof SourceFields<S> & string;

/**
 * The fields of `S` whose value (without `null`) is a `T`. A changeset of an unknown
 * schema (`Changeset<AnySchema>`) accepts any name.
 *
 * @example
 * ```ts
 * type Text = FieldOfType<typeof User, string>; // "email" | "name" | "role" | …
 * ```
 */
export type FieldOfType<S, T> =
  string extends FieldName<S>
    ? string
    : { [K in FieldName<S>]: NonNullable<FieldValues<S>[K]> extends T ? K : never }[FieldName<S>];

/**
 * The `changes` of a changeset: the changed fields and their new values. A field that is
 * not nullable never has a `null` change (a `null` is refused with `can't be blank`).
 * An embed field and an association changed through `castEmbed` / `castAssoc` /
 * `putEmbed` / `putAssoc` hold child changesets ({@link FieldChange}, {@link AssocChange}).
 *
 * @example
 * ```ts
 * type UserChanges = Changes<typeof User>; // { email?: string; name?: string | null; … }
 * ```
 */
export type Changes<S> = { readonly [K in FieldName<S>]?: FieldChange<S, K> } & AssocChanges<S>;

/**
 * The association names of `S`: none for a changeset without a schema class, and any
 * string for a changeset made from a row alone (its class, and so its associations, is
 * not known to the types; the name is checked when the method runs).
 *
 * @example
 * ```ts
 * type Names = AssocName<typeof Post>; // "author" | "comments" | "tags"
 * ```
 */
export type AssocName<S> =
  string extends FieldName<S>
    ? string
    : S extends FromRow
      ? string
      : S extends AnySchema
        ? AssocKeys<S>
        : never;

/** The mark of a {@link RowSchema}: the class, and so its associations, is not known. */
interface FromRow {
  readonly "~fromRow": true;
}

/**
 * The existing record of a changeset whose target has one: the row for a schema class,
 * the data object for a changeset without a schema class.
 *
 * @example
 * ```ts
 * type Existing = ChangesetData<typeof User>; // User
 * ```
 */
export type ChangesetData<S> =
  S extends SchemalessTarget<infer _F, infer D> ? D : S extends AnySchema ? Row<S> : never;

/**
 * What `applyChanges()` returns: a row for a schema class; for a changeset without one,
 * the data object with every field. A field the data lacks takes its default, or `null`
 * when nullable; only a field with neither may be `undefined`.
 *
 * @example
 * ```ts
 * type Applied = AppliedData<typeof User>; // User
 * ```
 */
export type AppliedData<S> =
  S extends SchemalessTarget<infer F, infer D>
    ? Simplify<
        Omit<D, keyof F> & {
          -readonly [K in keyof F]: RowOf<F>[K] | (K extends keyof D ? never : MissingValue<F[K]>);
        }
      >
    : S extends AnySchema
      ? Row<S>
      : never;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** What a schemaless field the data lacks holds after `applyChanges`: its default, `null`, or `undefined`. */
type MissingValue<B> =
  FieldFlagsOf<B> extends { readonly defaulted: false; readonly nullable: false } ? undefined : never;

/**
 * The class of a changeset's records, typed by its rows: a schema class whose instances
 * are `Row<S>`, or `null` without one. (It is not typed as `S` itself, so that a
 * changeset made from a row alone, typed {@link RowSchema}, fits where a changeset of the
 * class is expected.)
 *
 * @example
 * ```ts
 * type Model = ChangesetModel<typeof User>; // a schema class whose rows are User
 * ```
 */
export type ChangesetModel<S> = S extends SchemalessTarget
  ? null
  : S extends AnySchema
    ? AnySchema & (abstract new (...args: never[]) => Row<S>)
    : never;

type IsMutable<R, K extends keyof R> =
  (<G>() => G extends { [Q in K]: R[K] } ? 1 : 2) extends <G>() => G extends { -readonly [Q in K]: R[K] }
    ? 1
    : 2
    ? true
    : false;

/** The keys of a row type that are fields: writable and not functions (getters without a setter are read-only). */
type RowFieldKeys<R> = {
  [K in keyof R]-?: K extends `~${string}`
    ? never // a type-only marker (`RowMarker`), not a field
    : R[K] extends (...args: never[]) => unknown
      ? never
      : IsMutable<R, K> extends true
        ? K
        : never;
}[keyof R] &
  string;

/**
 * The schema a changeset is typed with when it is made from a row alone: the row's type
 * does not lead back to its class, so the fields are read from the row type (its
 * writable, non-function properties). A changeset made from the class, or from
 * `User | typeof User`, is typed with the class itself.
 *
 * @example
 * ```ts
 * declare const user: User;
 * const cs = change(user, { name: "Ada" }); // Changeset<RowSchema<User>, false>
 * ```
 */
export type RowSchema<R extends object> = SchemaStatic<{ [K in RowFieldKeys<R>]: FieldBuilder<R[K]> }> &
  FromRow &
  (abstract new (
    ...args: never[]
  ) => R);

/**
 * A message given to a validation in place of its default: text (which may contain
 * `{placeholders}`), or a function that receives the error's metadata and returns it.
 *
 * @example
 * ```ts
 * const message: MessageOption = (meta) => `needs ${String(meta.count)} or more`;
 * ```
 */
export type MessageOption = string | ((meta: Readonly<Record<string, unknown>>) => string);

/**
 * The `message` option every validation takes.
 *
 * @example
 * ```ts
 * cs.validateFormat("email", /@/, { message: "is not an email address" });
 * ```
 */
export interface MessageOptions {
  readonly message?: MessageOption;
}

/**
 * Options of `cast`.
 *
 * @example
 * ```ts
 * cast(User, params, ["name"], { emptyValues: ["", "n/a"] });
 * ```
 */
export interface CastOptions {
  /** Values that mean "no value" and become `null`. Defaults to `[""]`. */
  readonly emptyValues?: readonly unknown[];
  /** Record every permitted value as a change, even one equal to the current value. */
  readonly forceChanges?: boolean;
}

/**
 * Options of `validateRequired`.
 *
 * @example
 * ```ts
 * cs.validateRequired(["name"], { trim: false });
 * ```
 */
export interface RequiredOptions extends MessageOptions {
  /** Whether a string of only whitespace counts as missing. Defaults to `true`. */
  readonly trim?: boolean;
}

/**
 * Options of `validateLength`. At least one of `is`, `min` and `max`.
 *
 * @example
 * ```ts
 * cs.validateLength("name", { min: 2, max: 80 });
 * cs.validateLength("passwordHash", { max: 72, count: "bytes" });
 * ```
 */
export interface LengthOptions extends MessageOptions {
  readonly is?: number;
  readonly min?: number;
  readonly max?: number;
  /** How a string is measured. Defaults to `"graphemes"` (what a reader sees as one character). */
  readonly count?: "graphemes" | "codepoints" | "bytes";
}

/**
 * Options of `validateNumber`. They are checked in the order given; the first that fails
 * is reported.
 *
 * @example
 * ```ts
 * cs.validateNumber("age", { greaterThanOrEqualTo: 13, lessThan: 130 });
 * ```
 */
export interface NumberOptions extends MessageOptions {
  readonly lessThan?: number | bigint;
  readonly greaterThan?: number | bigint;
  readonly lessThanOrEqualTo?: number | bigint;
  readonly greaterThanOrEqualTo?: number | bigint;
  readonly equalTo?: number | bigint;
  readonly notEqualTo?: number | bigint;
}

/**
 * Options of `validateConfirmation`.
 *
 * @example
 * ```ts
 * cs.validateConfirmation("password", { required: true });
 * ```
 */
export interface ConfirmationOptions extends MessageOptions {
  /** Whether a missing confirmation is an error (`can't be blank`). Defaults to `false`. */
  readonly required?: boolean;
}

/**
 * Options of the constraint declarations.
 *
 * @example
 * ```ts
 * cs.uniqueConstraint("email", { name: "uq_users_email", message: "is already registered" });
 * ```
 */
export interface ConstraintOptions {
  /** The constraint's name in the database. Defaults to the name Postgres gives an unnamed one. */
  readonly name?: string;
  /** How `name` is compared with the name the database reports. Defaults to `"exact"`. */
  readonly match?: "exact" | "suffix" | "prefix";
  readonly message?: string;
  /** The key of `errors` that receives the error. Defaults to the (first) field. */
  readonly errorKey?: string;
}

/**
 * Options of `checkConstraint`: like {@link ConstraintOptions}, but the name is required
 * (a check constraint's default name cannot be predicted).
 *
 * @example
 * ```ts
 * cs.checkConstraint("age", { name: "users_age_check", message: "must be positive" });
 * ```
 */
export interface CheckConstraintOptions extends ConstraintOptions {
  readonly name: string;
}

/**
 * Options of `validateUniqueAsync`.
 *
 * @example
 * ```ts
 * await cs.validateUniqueAsync("email", repo, { message: "is already registered" });
 * ```
 */
export interface UniqueAsyncOptions extends MessageOptions {
  /** The key of `errors` that receives the error. Defaults to the first field. */
  readonly errorKey?: string;
}

/**
 * What a `validateChange` function returns: a message, an error, a list of either, or
 * nothing when the value is fine.
 *
 * @example
 * ```ts
 * const noSpaces = (value: string): ChangeValidatorResult => (value.includes(" ") ? "has spaces" : undefined);
 * ```
 */
export type ChangeValidatorResult =
  | string
  | ChangeValidatorError
  | readonly (string | ChangeValidatorError)[]
  | undefined;

/**
 * An error returned by a `validateChange` function. `meta` may be left out.
 *
 * @example
 * ```ts
 * const error: ChangeValidatorError = { message: "must be even", validation: "even", meta: { kind: "even" } };
 * ```
 */
export interface ChangeValidatorError {
  readonly message: string;
  readonly validation?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * One entry of `cs.validations`: the field and a description of the validation, for
 * tools such as form generators. `validation` names it (`"length"`, `"format"`, …) and
 * the other keys are its options.
 *
 * @example
 * ```ts
 * const entry: ValidationEntry = ["name", { validation: "length", min: 2, max: 80 }];
 * ```
 */
export type ValidationEntry = readonly [field: string, descriptor: Readonly<Record<string, unknown>>];

/**
 * The errors of a changeset as `traverseErrors` returns them: for each key, the values
 * the callback made of its errors, or, for a nested changeset, its own tree (a list of
 * trees for a list of changesets). A key with errors of its own and children with errors
 * keeps both: a child's tree gets a `$errors` entry with the key's own errors, and a list
 * becomes `{ $errors, $items }`, `$items` being the list of children's trees.
 *
 * @example
 * ```ts
 * const tree: ErrorTree<string> = { title: ["can't be blank"], comments: [{}, { body: ["can't be blank"] }] };
 * const both: ErrorTree<string> = {
 *   comments: { $errors: ["is invalid"], $items: [{}, { body: ["can't be blank"] }] },
 *   author: { $errors: ["does not exist"], email: ["can't be blank"] },
 * };
 * ```
 */
export interface ErrorTree<T> {
  readonly [key: string]: readonly T[] | ErrorTree<T> | readonly ErrorTree<T>[];
}

/** The keys a changeset of `S` with the extra keys `E` may have errors under. */
type ErrorKeys<S, E extends string> =
  | FieldName<S>
  | (string extends AssocName<S> ? never : AssocName<S>)
  | E
  | "$base";

/** The errors of a nested changeset (or list of them) under one key, with the key's own errors. */
type NestedErrors<C, Many, T> = Many extends true
  ? T[] | TypedErrorTree<C, never, T>[] | { $errors: T[]; $items: TypedErrorTree<C, never, T>[] }
  : T[] | (TypedErrorTree<C, never, T> & { $errors?: T[] });

/** What the tree holds under key `K` of `S`: messages, or for an embed or association the nested tree. */
type ErrorNode<S, K, T> = [EmbedTarget<S, K>] extends [never]
  ? [AssocTarget<S, K>] extends [never]
    ? T[]
    : NestedErrors<AssocTarget<S, K>, AssocKindOf<S, K> extends "hasMany" | "manyToMany" ? true : false, T>
  : NestedErrors<EmbedTarget<S, K>, EmbedMany<S, K>, T>;

/** The mark of a changeset typed from a row alone, whose associations the types do not know. */
type FromRowMark = { readonly "~fromRow": true };

/**
 * The errors of a changeset of `S` with the extra error keys `E`, as `traverseErrors`
 * returns them: one optional key per field, association and extra key (and `$base`), each
 * holding the values the callback made; an embed or association holds the nested
 * changeset's tree (a list of trees for a list), with the key's own errors under `$errors`
 * when it has both (and the list under `$items`). Without a known schema it is
 * {@link ErrorTree}.
 *
 * @example
 * ```ts
 * type Tree = TypedErrorTree<typeof Post, never, string>;
 * const tree: Tree = { title: ["can't be blank"], comments: [{}, { body: ["can't be blank"] }] };
 * ```
 */
export type TypedErrorTree<S, E extends string, T> =
  string extends FieldName<S>
    ? ErrorTree<T>
    : { [K in ErrorKeys<S, E>]?: ErrorNode<S, K, T> } & (S extends FromRowMark ? ErrorTree<T> : unknown);

/**
 * The type of `errorMessages()`: the error messages of a changeset, typed by its schema.
 * Give it the changeset's type (which carries the keys its validations added, such as
 * `passwordConfirmation`), or a schema class (its fields, associations and `$base` only).
 * `JsonReturn` of a server action that returns `errorMessages()` is the same type, so a
 * client can use either.
 *
 * @example
 * ```ts
 * type SignUpErrors = ErrorMessages<ReturnType<typeof User.changeset>>; // { email?: string[]; passwordConfirmation?: string[]; … }
 * const errors: SignUpErrors = { email: ["has already been taken"] };
 * ```
 */
export type ErrorMessages<C> = C extends AnySchema
  ? TypedErrorTree<C, never, string>
  : ErrorTreeOf<C, string>;

/**
 * What `traverseErrors(changeset, fn)` returns, for a changeset of type `C` and a callback
 * returning `T`: {@link TypedErrorTree} for a changeset, {@link ErrorTree} for any other
 * {@link ChangesetLike}.
 *
 * @example
 * ```ts
 * declare const cs: Changeset<typeof Post, boolean>;
 * const tree: ErrorTreeOf<typeof cs, number> = traverseErrors(cs, () => 1);
 * ```
 */
export type ErrorTreeOf<C, T> =
  C extends Changeset<infer S, boolean, infer E> ? TypedErrorTree<S, E, T> : ErrorTree<T>;

/**
 * The callback of `traverseErrors`: turns one error into what the tree holds.
 *
 * @example
 * ```ts
 * const plain: ErrorFormatter<string> = (error) => error.message;
 * ```
 */
export type ErrorFormatter<T> = (error: ChangesetError, key: string) => T;
