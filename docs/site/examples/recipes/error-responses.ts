// The checked source of recipes/error-responses.md. Each `#region` is included in the page
// by name; the rest makes it compile. Type-checked, not run: the handlers use the web
// standard `Request` and `Response`, as Hono, Next.js route handlers and Workers do.
// #region setup
import { postgres } from "@egon-orm/postgres";
import {
  ConstraintError,
  cast,
  createRepo,
  type ErrorMessages,
  isEgonError,
  type Json,
  NoResultsError,
  Schema,
  StaleEntryError,
  t,
  timestamps,
} from "egon-orm";

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  password: t.string().virtual(), // a real app would also hash it into a redacted field
  lockVersion: t.integer().default(1),
  ...timestamps(),
}) {
  static changeset(user: User | typeof User, params: unknown) {
    return cast(user, params, ["email", "password"])
      .validateRequired(["email", "password"])
      .validateConfirmation("password")
      .uniqueConstraint("email")
      .optimisticLock("lockVersion");
  }
}
// #endregion setup

// #region map
/** The response for an error a handler did not handle itself. */
export function errorResponse(error: unknown): Response {
  if (error instanceof NoResultsError) {
    return Response.json({ error: "Not Found" }, { status: 404 });
  }
  if (error instanceof StaleEntryError) {
    // Someone else changed or deleted the row since it was read.
    return Response.json({ error: "Conflict" }, { status: 409 });
  }
  if (error instanceof ConstraintError && error.type === "unique") {
    // A unique constraint the changeset did not declare: declare it to get a 422 instead.
    return Response.json({ error: "Conflict" }, { status: 409 });
  }
  console.error(error); // the full message, for your logs
  // An error of the library is written as { name, code, id }: no message, SQL or values.
  const body = isEgonError(error) ? error.toJSON() : { error: "Internal Server Error" };
  return Response.json(body, { status: 500 });
}
// #endregion map

// #region handlers
/** POST /users: 201 with the user, 400 for a body that is not JSON, 422 for an invalid changeset. */
export async function signUp(request: Request): Promise<Response> {
  let params: unknown;
  try {
    params = await request.json();
  } catch {
    return Response.json({ error: "Bad Request" }, { status: 400 });
  }
  try {
    const result = await repo.insert(User.changeset(User, params));
    if (!result.success) {
      return Response.json({ errors: result.error.errorMessages() }, { status: 422 });
    }
    return Response.json({ user: result.data }, { status: 201 }); // without the password
  } catch (error) {
    return errorResponse(error);
  }
}

/** GET /users/:id: 200 with the user, or 404. */
export async function showUser(id: number): Promise<Response> {
  try {
    return Response.json({ user: await repo.getOrThrow(User, id) });
  } catch (error) {
    return errorResponse(error);
  }
}
// #endregion handlers

// #region client
// What the client receives, typed from the schema: no class, no Date, no password.
export type SignUpResponse =
  | { readonly user: Json<User> } // 201
  | { readonly errors: ErrorMessages<ReturnType<typeof User.changeset>> }; // 422

export async function submit(form: FormData): Promise<SignUpResponse> {
  const response = await fetch("/users", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
  return (await response.json()) as SignUpResponse;
}

export function firstError(response: SignUpResponse): string | undefined {
  if (!("errors" in response)) return undefined;
  // Typed by field: a misspelt key does not compile. passwordConfirmation is there because
  // User.changeset calls validateConfirmation.
  return response.errors.email?.[0] ?? response.errors.passwordConfirmation?.[0];
}
// #endregion client
