// Type tests of the error tree: errorMessages() and traverseErrors() typed by the schema.
import { Comment, Post, User } from "@egon-orm/test-support";
import { describe, expectTypeOf, test } from "vitest";
import { createBatch } from "./batch/index.js";
import { type Changeset, cast, change, traverseErrors } from "./changeset/changeset.js";
import type { ErrorMessages, ErrorTree, TypedErrorTree } from "./changeset/types.js";
import type { Repo } from "./repo/repo.js";
import { hasMany, Schema, t } from "./schema/index.js";

declare const repo: Repo;
declare const params: Record<string, unknown>;
declare const post: Post;
declare const account: Account;

class Account extends Schema("accounts", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  password: t.string().virtual(),
}) {
  static notes = hasMany(() => Note, { foreignKey: "accountId" });

  static changeset(account: Account | typeof Account, input: unknown) {
    return cast(account, input, ["email", "password"])
      .validateRequired(["email"])
      .validateConfirmation("password")
      .validateAcceptance("terms");
  }
}

/** A schema whose changeset function adds "other" in one branch only. */
class Branchy extends Schema("branchy", {
  id: t.integer().primaryKey().dbGenerated(),
  password: t.string().virtual(),
}) {
  static changeset(row: Branchy | typeof Branchy, input: unknown, strict: boolean) {
    const cs = cast(row, input, ["password"]).validateConfirmation("password");
    if (strict) return cs.addError("other", "is not allowed");
    return cs;
  }
}

class Note extends Schema("notes", {
  id: t.integer().primaryKey().dbGenerated(),
  accountId: t.integer(),
  body: t.string(),
}) {}

describe("errorMessages()", () => {
  test("is keyed by field, association and $base", () => {
    const tree = cast(Post, params, ["title"]).errorMessages();
    expectTypeOf(tree.title).toEqualTypeOf<string[] | undefined>();
    expectTypeOf(tree.$base).toEqualTypeOf<string[] | undefined>();
    expectTypeOf<keyof typeof tree>().toEqualTypeOf<
      | "id"
      | "authorId"
      | "title"
      | "body"
      | "published"
      | "views"
      | "tagList"
      | "publishedAt"
      | "createdAt"
      | "updatedAt"
      | "author"
      | "comments"
      | "tags"
      | "$base"
    >();
    // @ts-expect-error a typo is a compile error
    tree.titel;
  });

  test("nested trees: an object for a to-one association or embed, a list for a to-many one", () => {
    const tree = cast(Account, params, ["email"])
      .castAssoc("notes", { with: (note, input) => cast(note, input, ["body"]) })
      .errorMessages();
    type Notes = NonNullable<(typeof tree)["notes"]>;
    expectTypeOf<Notes>().toEqualTypeOf<
      string[] | ErrorMessages<typeof Note>[] | { $errors: string[]; $items: ErrorMessages<typeof Note>[] }
    >();
    const notes = tree.notes;
    if (notes !== undefined && !Array.isArray(notes)) {
      expectTypeOf(notes.$errors).toEqualTypeOf<string[]>();
      expectTypeOf(notes.$items[0]?.body).toEqualTypeOf<string[] | undefined>();
    }
    const userTree = cast(User, params, ["email"]).errorMessages();
    const settings = userTree.settings;
    if (settings !== undefined && !Array.isArray(settings)) {
      expectTypeOf(settings.theme).toEqualTypeOf<string[] | undefined>();
      expectTypeOf(settings.$errors).toEqualTypeOf<string[] | undefined>();
      // @ts-expect-error not a field of the embedded schema
      settings.colour;
    }
    const author = cast(Comment, params, ["body"]).errorMessages().author;
    if (author !== undefined && !Array.isArray(author)) {
      expectTypeOf(author.email).toEqualTypeOf<string[] | undefined>();
      expectTypeOf(author).not.toBeAny();
    }
  });

  test("collects the keys validations add", () => {
    const tree = cast(User, params, ["email", "password"])
      .validateConfirmation("password")
      .addError("captcha", "is wrong")
      .validateAcceptance("termsOfService")
      .errorMessages();
    expectTypeOf(tree.passwordConfirmation).toEqualTypeOf<string[] | undefined>();
    expectTypeOf(tree.captcha).toEqualTypeOf<string[] | undefined>();
    expectTypeOf(tree.termsOfService).toEqualTypeOf<string[] | undefined>();
    const plain = cast(User, params, ["email"]).errorMessages();
    // @ts-expect-error no validation added this key
    plain.passwordConfirmation;
  });

  test("field names still autocomplete in addError and validateAcceptance", () => {
    const cs = cast(User, params, ["email"]).addError("email", "is taken");
    expectTypeOf(cs.errorMessages().email).toEqualTypeOf<string[] | undefined>();
    expectTypeOf(cs).toEqualTypeOf<Changeset<typeof User, true>>();
  });

  test("the extra keys flow through a write: the error changeset is the one given", async () => {
    const inserted = await repo.insert(Account.changeset(Account, params));
    if (!inserted.success) {
      const tree = inserted.error.errorMessages();
      expectTypeOf(tree.passwordConfirmation).toEqualTypeOf<string[] | undefined>();
      expectTypeOf(tree.terms).toEqualTypeOf<string[] | undefined>();
      expectTypeOf(tree.notes).not.toBeAny();
      expectTypeOf(inserted.error).toEqualTypeOf<ReturnType<typeof Account.changeset>>();
    }
    const updated = await repo.update(cast(account, params, ["email"]).addError("captcha", "is wrong"));
    if (!updated.success)
      expectTypeOf(updated.error.errorMessages().captcha).toEqualTypeOf<string[] | undefined>();
    const upserted = await repo.insertOrUpdate(Account.changeset(account, params));
    if (!upserted.success) {
      expectTypeOf(upserted.error.errorMessages().passwordConfirmation).toEqualTypeOf<string[] | undefined>();
    }
  });

  test("only the changeset that adds a key has it: another changeset of the schema does not", async () => {
    const login = cast(Account, params, ["email"]);
    // @ts-expect-error nothing added passwordConfirmation to this changeset
    login.errorMessages().passwordConfirmation;
    const result = await repo.insert(login);
    // @ts-expect-error nor to the one the write gives back
    if (!result.success) result.error.errorMessages().passwordConfirmation;
    // @ts-expect-error a schema class has its fields, associations and $base only
    type _FromClass = ErrorMessages<typeof Account>["passwordConfirmation"];
  });

  test("keys are collected along a chain of calls: a reassigned or branched changeset needs them in its type", async () => {
    // Pinned as it is: the declared type of `let` stays the type of its first value.
    let reassigned = cast(User, params, ["email"]);
    reassigned = reassigned.addError("captcha", "is wrong");
    // @ts-expect-error the key added after the declaration is not in the type
    reassigned.errorMessages().captcha;

    const ok = params.ok === true;
    const plain = cast(User, params, ["email"]);
    const branched = ok ? plain : plain.addError("captcha", "is wrong");
    // @ts-expect-error a union keeps only the keys both branches have
    branched.errorMessages().captcha;

    // Declaring the keys in the type keeps them, through a write too.
    let declared: Changeset<typeof User, true, "captcha"> = cast(User, params, ["email"]);
    if (!ok) declared = declared.addError("captcha", "is wrong");
    expectTypeOf(declared.errorMessages().captcha).toEqualTypeOf<string[] | undefined>();
    const result = await repo.insert(declared);
    if (!result.success)
      expectTypeOf(result.error.errorMessages().captcha).toEqualTypeOf<string[] | undefined>();
    const picked: Changeset<typeof User, true, "captcha"> = ok
      ? plain
      : plain.addError("captcha", "is wrong");
    expectTypeOf(picked.errorMessages().captcha).toEqualTypeOf<string[] | undefined>();
  });

  test("a changeset function that returns from two branches keeps, through a write, only the keys both add", async () => {
    const result = await repo.insert(Branchy.changeset(Branchy, params, true));
    if (!result.success) {
      // The key both branches add is typed.
      expectTypeOf(result.error.errorMessages().passwordConfirmation).toEqualTypeOf<string[] | undefined>();
      // @ts-expect-error "other" is added in one branch only, so the write's error type does not have it
      result.error.errorMessages().other;
    }
  });

  test("the extra keys flow through a batch's failure", async () => {
    const batch = createBatch().insert("account", Account.changeset(Account, params));
    const outcome = await repo.transaction(batch);
    if (!outcome.success && outcome.error.step === "account") {
      expectTypeOf(outcome.error.error.errorMessages().passwordConfirmation).toEqualTypeOf<
        string[] | undefined
      >();
    }
  });

  test("a changeset with extra keys is still a changeset of its schema", async () => {
    const cs = cast(User, params, ["email"]).addError("captcha", "is wrong");
    await repo.insert(cs);
    const loaded = change(post).addError("$base", "is locked");
    await repo.update(loaded);
  });

  test("ErrorMessages takes a changeset type or a schema class", () => {
    const cs = cast(User, params, ["email", "password"]).validateConfirmation("password");
    expectTypeOf<ErrorMessages<typeof cs>>().toEqualTypeOf(cs.errorMessages());
    expectTypeOf<ErrorMessages<typeof cs>>().toEqualTypeOf<
      TypedErrorTree<typeof User, "passwordConfirmation", string>
    >();
    expectTypeOf<ErrorMessages<typeof User>>().toEqualTypeOf<TypedErrorTree<typeof User, never, string>>();
    const clientSide: ErrorMessages<typeof User> = { email: ["has already been taken"] };
    expectTypeOf(clientSide).not.toBeAny();
    // @ts-expect-error a typo is a compile error
    const typo: ErrorMessages<typeof User> = { emial: ["x"] };
    expectTypeOf(typo).not.toBeAny();
  });

  test("a changeset made from a row alone knows its fields, and takes any other key", () => {
    const tree = change(post).errorMessages();
    expectTypeOf(tree.title).toEqualTypeOf<string[] | undefined>();
    expectTypeOf(tree.anything).toEqualTypeOf<
      readonly string[] | ErrorTree<string> | readonly ErrorTree<string>[] | undefined
    >();
  });

  test("a schemaless changeset is keyed by its fields", () => {
    const tree = cast({ data: {}, types: { q: t.string(), page: t.integer() } }, params, [
      "q",
      "page",
    ]).errorMessages();
    expectTypeOf<keyof typeof tree>().toEqualTypeOf<"q" | "page" | "$base">();
  });
});

describe("traverseErrors", () => {
  test("is typed like errorMessages(), with the callback's values", () => {
    const cs = cast(Post, params, ["title"]);
    const tree = traverseErrors(cs, (error) => error.message.length);
    expectTypeOf(tree.title).toEqualTypeOf<number[] | undefined>();
    // @ts-expect-error a typo is a compile error
    tree.titel;
  });
});
