// Type tests of Json<T> and JsonReturn<F>: what a client receives for a row, a loaded row,
// a plain value, and what a function resolves to.
import { type Comment, Post, type Profile, type Tag, User, type UserSettings } from "@egon-orm/test-support";
import { describe, expectTypeOf, test } from "vitest";
import type { Changeset } from "./changeset/changeset.js";
import { cast } from "./changeset/changeset.js";
import type { ErrorMessages } from "./changeset/types.js";
import type { Result } from "./contracts/result.js";
import type { Loaded, LoadedAs, PreloadSpec, Row } from "./contracts/schema.js";
import { from } from "./query/builder.js";
import type { Repo } from "./repo/repo.js";
import { belongsTo, EmbeddedSchema, hasMany, Schema, t } from "./schema/index.js";
import type { Json, JsonReturn } from "./schema/json-types.js";
import { defineType } from "./types/index.js";

declare const repo: Repo;

class Money {
  constructor(readonly cents: number) {}
  toJSON(): { cents: number } {
    return { cents: this.cents };
  }
}
const MoneyType = defineType<Money, number>({
  name: "money",
  db: { kind: "integer" },
  cast: (input) =>
    typeof input === "number" ? { success: true, data: new Money(input) } : { success: false },
  fromDb: (cents) => new Money(cents),
  toDb: (money) => money.cents,
});

class Point extends EmbeddedSchema({
  lat: t.float(),
  lng: t.float(),
  seenAt: t.timestamp().nullable(),
}) {
  get label(): string {
    return `${this.lat},${this.lng}`;
  }
}

class Every extends Schema("every", {
  id: t.integer().primaryKey().dbGenerated(),
  text: t.string(),
  maybeText: t.string().nullable(),
  big: t.bigint(),
  bigAsNumber: t.bigint({ mode: "number" }),
  ratio: t.float(),
  price: t.decimal(),
  flag: t.boolean(),
  key: t.uuid(),
  bytes: t.binary().nullable(),
  day: t.date(),
  dayAsDate: t.date({ as: "date" }),
  at: t.time(),
  stamp: t.timestamp(),
  wall: t.localTimestamp().nullable(),
  doc: t.json<{ when: Date; tags: string[]; skip?: undefined; fn?: () => void }>(),
  numbers: t.array(t.bigint()),
  stamps: t.array(t.timestamp()).nullable(),
  role: t.enum(["admin", "member"]),
  money: t.type(MoneyType),
  point: t.embedOne(() => Point).nullable(),
  points: t.embedMany(() => Point),
  password: t.string().virtual(),
  shown: t.string().virtual({ json: true }),
  secret: t.string().redact(),
  hiddenShown: t.string().virtual({ json: true }).redact(),
  shownHidden: t.string().redact().virtual({ json: true }),
}) {
  get upper(): string {
    return this.text.toUpperCase();
  }
  greet(): string {
    return "hi";
  }
}

type EveryJson = {
  id: number;
  text: string;
  maybeText: string | null;
  big: string;
  bigAsNumber: number;
  ratio: number;
  price: string;
  flag: boolean;
  key: string;
  bytes: string | null;
  day: string;
  dayAsDate: string;
  at: string;
  stamp: string;
  wall: string | null;
  doc: { when: string; tags: string[] };
  numbers: string[];
  stamps: string[] | null;
  role: "admin" | "member";
  money: { cents: number };
  point: { lat: number; lng: number; seenAt: string | null } | null;
  points: { lat: number; lng: number; seenAt: string | null }[];
  shown?: string;
};

describe("Json of a row", () => {
  test("maps every field type, leaves out redacted, virtual, getters and methods", () => {
    expectTypeOf<Json<Every>>().toEqualTypeOf<EveryJson>();
    expectTypeOf<Json<Every>>().not.toBeAny();
    expectTypeOf<Json<Row<typeof Every>>>().toEqualTypeOf<EveryJson>();
  });

  test("the blog user: no password, no passwordHash, dates as strings", () => {
    expectTypeOf<Json<User>>().toEqualTypeOf<{
      id: number;
      email: string;
      name: string | null;
      age: number | null;
      role: "admin" | "member";
      settings: { theme: "light" | "dark"; emailNotifications: boolean } | null;
      lockVersion: number;
      createdAt: string;
      updatedAt: string;
    }>();
    // @ts-expect-error a redacted field is not in JSON
    type _Hash = Json<User>["passwordHash"];
    // @ts-expect-error a virtual field is not in JSON
    type _Password = Json<User>["password"];
    // @ts-expect-error a getter is not in JSON
    type _Display = Json<User>["displayName"];
    expectTypeOf<Json<UserSettings>>().toEqualTypeOf<{
      theme: "light" | "dark";
      emailNotifications: boolean;
    }>();
  });

  test("a row without preloads has no associations", () => {
    // @ts-expect-error not preloaded
    type _Author = Json<Post>["author"];
  });

  test("a class with its own toJSON is Json of what it returns", () => {
    class Custom extends Schema("custom", { id: t.integer().primaryKey(), secret: t.string() }) {
      toJSON(): { custom: number; at: Date } {
        return { custom: this.id, at: new Date() };
      }
    }
    expectTypeOf<Json<Custom>>().toEqualTypeOf<{ custom: number; at: string }>();
  });

  test("a getter that returns a row is not included", () => {
    class Holder extends Schema("holders", { id: t.integer().primaryKey() }) {
      get featured(): Post {
        return undefined as unknown as Post;
      }
    }
    expectTypeOf<Json<Holder>>().toEqualTypeOf<{ id: number }>();
  });
});

describe("Json of a loaded row", () => {
  type PostFields = Json<Post>;
  type UserFields = Json<User>;
  type CommentFields = Json<Comment>;

  test("a string spec", () => {
    expectTypeOf<Json<Loaded<typeof Post, "author">>>().branded.toEqualTypeOf<
      PostFields & { author: UserFields }
    >();
  });

  test("an array spec", () => {
    expectTypeOf<Json<Loaded<typeof Post, ["author", "tags"]>>>().branded.toEqualTypeOf<
      PostFields & { author: UserFields; tags: Json<Tag>[] }
    >();
  });

  test("a nested object spec and true", () => {
    type Deep = Loaded<typeof User, { posts: { comments: "author" }; profile: true }>;
    type DeepJson = Json<Deep>;
    expectTypeOf<DeepJson["profile"]>().toEqualTypeOf<Json<Profile> | null>();
    expectTypeOf<DeepJson["posts"][number]["comments"][number]>().branded.toEqualTypeOf<
      CommentFields & { author: UserFields | null }
    >();
    // @ts-expect-error not preloaded at this level
    type _Tags = DeepJson["posts"][number]["tags"];
  });

  test("a nullable belongsTo stays | null", () => {
    expectTypeOf<Json<Loaded<typeof Comment, "author">>["author"]>().toEqualTypeOf<UserFields | null>();
    expectTypeOf<Json<Loaded<typeof Comment, "post">>["post"]>().toEqualTypeOf<PostFields>();
  });

  test("a row with more preloads is assignable where fewer are expected", () => {
    const render = (_post: Loaded<typeof Post, "author">): void => {};
    const more = {} as Loaded<typeof Post, ["author", "comments"]>;
    render(more);
    const fewer = {} as Loaded<typeof Post, "comments">;
    // @ts-expect-error author is not preloaded
    render(fewer);
  });

  test("what a query with preloads returns", async () => {
    const posts = await repo.all(from(Post, "p").preload({ author: true, comments: "author" }));
    type PostJson = Json<(typeof posts)[number]>;
    expectTypeOf<PostJson["author"]>().toEqualTypeOf<UserFields>();
    expectTypeOf<PostJson["comments"][number]["author"]>().toEqualTypeOf<UserFields | null>();
    expectTypeOf<PostJson>().not.toBeAny();
  });

  test("a preload with a select is a plain object of the selected shape", () => {
    type Selected = LoadedAs<typeof User, "posts", { authorId: number; title: string; at: Date }>;
    expectTypeOf<Json<Selected>["posts"]>().toEqualTypeOf<
      { authorId: number; title: string; at: string }[]
    >();
  });

  test("one spec, shared by the query and the type", async () => {
    const spec = { author: true, comments: "author" } as const satisfies PreloadSpec<typeof Post>;
    const posts = await repo.all(from(Post, "p").preload(spec));
    type FromSpec = Json<Loaded<typeof Post, typeof spec>>;
    expectTypeOf<FromSpec>().toEqualTypeOf<Json<(typeof posts)[number]>>();
  });

  test("repo.preload keeps what the rows already had", async () => {
    const withAuthor = await repo.preload(Post, [] as Post[], "author");
    const both = await repo.preload(Post, withAuthor, "comments");
    expectTypeOf<Json<(typeof both)[number]>>().branded.toEqualTypeOf<
      PostFields & { author: UserFields; comments: CommentFields[] }
    >();
  });
});

describe("Json of a copy of a row", () => {
  // A copy has no toJSON: JSON.stringify writes every own property, secrets included.
  test("a spread copy is a plain object: its JSON has every field", () => {
    const copy = { ...({} as User) };
    type CopyJson = Json<typeof copy>;
    expectTypeOf<CopyJson["passwordHash"]>().toEqualTypeOf<string | null>();
    expectTypeOf<CopyJson["password"]>().toEqualTypeOf<string>();
    expectTypeOf<CopyJson["createdAt"]>().toEqualTypeOf<string>();
    // @ts-expect-error the marker is not on a copy
    type _Marker = (typeof copy)["~fields"];
  });

  test("a rest copy is a plain object too", () => {
    const { email: _email, ...rest } = {} as User;
    expectTypeOf<Json<typeof rest>["password"]>().toEqualTypeOf<string>();
    // @ts-expect-error email was taken out
    type _Email = Json<typeof rest>["email"];
  });

  test("a bigint field of a copy is never: JSON.stringify throws on it", () => {
    const copy = { ...({} as Every) };
    expectTypeOf<Json<typeof copy>["big"]>().toEqualTypeOf<never>();
  });

  test("Omit of a row type keeps the marker, so Json still describes the row (send rows, not mapped types)", () => {
    type WithoutEmail = Omit<User, "email">;
    expectTypeOf<Json<WithoutEmail>>().toEqualTypeOf<Json<User>>();
  });
});

describe("Json of other values follows JSON.stringify", () => {
  test("primitives, dates and values with toJSON", () => {
    expectTypeOf<Json<string>>().toEqualTypeOf<string>();
    expectTypeOf<Json<42>>().toEqualTypeOf<42>();
    expectTypeOf<Json<boolean>>().toEqualTypeOf<boolean>();
    expectTypeOf<Json<null>>().toEqualTypeOf<null>();
    expectTypeOf<Json<Date>>().toEqualTypeOf<string>();
    expectTypeOf<Json<Money>>().toEqualTypeOf<{ cents: number }>();
    expectTypeOf<Json<bigint>>().toEqualTypeOf<never>();
    expectTypeOf<Json<unknown>>().toEqualTypeOf<unknown>();
  });

  test("undefined, functions and symbols: dropped from objects, null in arrays", () => {
    expectTypeOf<
      Json<{ a: string; b: undefined; c: () => void; d: symbol; e?: number; f: number | undefined }>
    >().toEqualTypeOf<{ a: string; e?: number; f?: number }>();
    expectTypeOf<Json<(string | undefined | (() => void))[]>>().toEqualTypeOf<(string | null)[]>();
    expectTypeOf<Json<readonly [Date, undefined]>>().toEqualTypeOf<[string, null]>();
  });

  test("objects and arrays of rows are mapped recursively", () => {
    type Page = { post: Loaded<typeof Post, "author">; related: Post[]; total: number };
    expectTypeOf<Json<Page>>().branded.toEqualTypeOf<{
      post: Json<Post> & { author: Json<User> };
      related: Json<Post>[];
      total: number;
    }>();
  });

  test("a plain bigint inside an object is never: JSON.stringify throws on it", () => {
    expectTypeOf<Json<{ n: bigint }>>().toEqualTypeOf<{ n: never }>();
  });
});

describe("JsonReturn", () => {
  test("of a function returning a row, an array, or | null", () => {
    const one = async (id: number) => repo.getOrThrow(User, id);
    const many = async () => repo.all(from(Post, "p").preload("author"));
    const maybe = async (id: number) => repo.get(User, id);
    expectTypeOf<JsonReturn<typeof one>>().toEqualTypeOf<Json<User>>();
    expectTypeOf<JsonReturn<typeof many>>().branded.toEqualTypeOf<(Json<Post> & { author: Json<User> })[]>();
    expectTypeOf<JsonReturn<typeof maybe>>().toEqualTypeOf<Json<User> | null>();
    expectTypeOf<NonNullable<JsonReturn<typeof maybe>>>().toEqualTypeOf<Json<User>>();
  });

  test("of a function returning an object of rows, and of a synchronous one", () => {
    const page = async () => ({ user: await repo.getOrThrow(User, 1), posts: await repo.all(Post) });
    expectTypeOf<JsonReturn<typeof page>>().toEqualTypeOf<{ user: Json<User>; posts: Json<Post>[] }>();
    const sync = () => new Date();
    expectTypeOf<JsonReturn<typeof sync>>().toEqualTypeOf<string>();
  });

  test("of a write's Result", () => {
    const signUp = async (params: unknown) => repo.insert(cast(User, params, ["email", "password"]));
    type Response = JsonReturn<typeof signUp>;
    type Expected = Json<Result<User, Changeset<typeof User, true>>>;
    expectTypeOf<Response>().toEqualTypeOf<Expected>();
    expectTypeOf<Extract<Response, { success: true }>["data"]>().toEqualTypeOf<Json<User>>();
  });

  test("of a server action returning errorMessages() is ErrorMessages", () => {
    const action = (params: unknown) =>
      cast(User, params, ["email"]).validateRequired(["email"]).errorMessages();
    expectTypeOf<JsonReturn<typeof action>>().branded.toEqualTypeOf<ErrorMessages<typeof User>>();
    expectTypeOf<JsonReturn<typeof action>["posts"]>().not.toBeAny();
  });

  test("takes functions only", () => {
    // @ts-expect-error not a function
    type _Bad = JsonReturn<User>;
  });
});

class Author extends Schema("authors", { id: t.integer().primaryKey() }) {
  static books = hasMany(() => Book, { foreignKey: "authorId" });
}
class Book extends Schema("books", { id: t.integer().primaryKey(), authorId: t.integer().nullable() }) {
  static author = belongsTo(() => Author);
}

describe("nullable foreign key", () => {
  test("a belongsTo with a nullable key is | null in JSON", () => {
    expectTypeOf<Json<Loaded<typeof Book, "author">>>().toEqualTypeOf<{
      id: number;
      authorId: number | null;
      author: { id: number } | null;
    }>();
    expectTypeOf<Json<Loaded<typeof Author, "books">>>().toEqualTypeOf<{
      id: number;
      books: { id: number; authorId: number | null }[];
    }>();
  });
});
