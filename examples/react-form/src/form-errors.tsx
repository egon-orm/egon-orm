// The checked source of docs/site/recipes/form-errors.md: a sign-up form in React 19 whose
// server action returns the changeset's errors. Type-checked; it is not run. It stands for two
// files of a Next.js app, so their directives are comments here: a file holds one or the other.
// (A package of its own, so that the React types stay out of the docs site's dependencies.)
// #region setup
import { postgres } from "@egon-orm/postgres";
import { cast, createRepo, type ErrorMessages, Schema, t } from "egon-orm";
import { useActionState } from "react";

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string(),
}) {
  static changeset(user: User | typeof User, params: unknown) {
    return cast(user, params, ["email", "name"])
      .validateRequired(["email", "name"])
      .validateFormat("email", /^[^@\s]+@[^@\s]+$/)
      .uniqueConstraint("email");
  }
}
// #endregion setup

// #region action
// actions.ts
// "use server";
// Runs on the server. The state it returns is plain data, so it crosses to the client as it is.
// The errors of User.changeset, typed by field: { email?: string[]; name?: string[]; … }.
export type SignUpErrors = ErrorMessages<ReturnType<typeof User.changeset>>;

export type SignUpState = {
  values: Record<string, string>;
  errors: SignUpErrors;
  saved: boolean;
};

export async function signUp(_previous: SignUpState, form: FormData): Promise<SignUpState> {
  const values = { email: String(form.get("email") ?? ""), name: String(form.get("name") ?? "") };
  const result = await repo.insert(User.changeset(User, values));
  return result.success
    ? { values: {}, errors: {}, saved: true }
    : { values, errors: result.error.errorMessages(), saved: false }; // { email: ["has already been taken"] }
}
// #endregion action

// #region form
// SignUpForm.tsx
// "use client";
// A client component: it imports the server action, which Next.js turns into a request.
const initial: SignUpState = { values: {}, errors: {}, saved: false };

export function SignUpForm() {
  const [state, action, pending] = useActionState(signUp, initial);
  if (state.saved) return <p>Welcome!</p>;

  return (
    <form action={action} noValidate>
      <Field name="email" label="Email" state={state} />
      <Field name="name" label="Name" state={state} />
      <button type="submit" disabled={pending}>
        Sign up
      </button>
    </form>
  );
}

// The messages of one field. (A nested form, with castAssoc, has a tree under its key instead.)
function messagesOf(errors: SignUpErrors, field: FieldName): readonly string[] {
  const entry = errors[field];
  return Array.isArray(entry) ? entry.filter((e): e is string => typeof e === "string") : [];
}

/** The fields the form shows; a misspelt name is a compile error. */
type FieldName = ("email" | "name") & keyof SignUpErrors;

function Field({ name, label, state }: { name: FieldName; label: string; state: SignUpState }) {
  const errors = messagesOf(state.errors, name);
  const errorId = `${name}-errors`;
  return (
    <p>
      <label htmlFor={name}>{label}</label>
      <input
        id={name}
        name={name}
        defaultValue={state.values[name] ?? ""}
        aria-invalid={errors.length > 0}
        aria-describedby={errors.length > 0 ? errorId : undefined}
      />
      {errors.length > 0 && (
        <span id={errorId} role="alert">
          {label} {errors.join(", ")}
        </span>
      )}
    </p>
  );
}
// #endregion form
