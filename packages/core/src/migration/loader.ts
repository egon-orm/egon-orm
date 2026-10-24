/**
 * Where migrations come from: the files of a directory, loaded with dynamic `import()`,
 * or a list given in memory (for bundlers and edge deployments). Either way the result is
 * the same sorted list of {@link MigrationSource}s.
 *
 * @module
 */
import { isEgonError, MigrationError, shortMessageOf } from "../errors.js";
import { own } from "../internal/own.js";
import { isMigration, type Migration, missingSteps, missingStepsError } from "./define.js";

/**
 * One migration with its version and name: what a file `20261012093000_create_users.ts`
 * holds, or an entry of an in-memory list.
 *
 * @example
 * ```ts
 * declare const createUsers: Migration;
 * const source: MigrationSource = { version: 20261012093000, name: "create_users", migration: createUsers };
 * ```
 */
export interface MigrationSource {
  /** The 14-digit timestamp `YYYYMMDDHHMMSS`, as a number. */
  readonly version: number;
  /** Letters, digits and underscores: `create_users`. */
  readonly name: string;
  readonly migration: Migration;
}

/** `<14 digits>_<name>.<ext>`: the file name of a migration. */
const FILE = /^(\d+)_([A-Za-z0-9_]+)\.(ts|mts|js|mjs)$/;
const NAME = /^[A-Za-z0-9_]+$/;

/**
 * Parses a migration file name: `20261012093000_create_users.ts` is version
 * `20261012093000`, name `create_users`. `undefined` for a file that is not a migration
 * (`README.md`, `helpers.ts`, `x.d.ts`).
 *
 * @example
 * ```ts
 * parseMigrationFileName("20261012093000_create_users.ts"); // { version: 20261012093000, name: "create_users" }
 * ```
 *
 * @throws MigrationError when the name starts with digits and an underscore but the
 * digits are not a 14-digit version.
 */
export function parseMigrationFileName(file: string): { version: number; name: string } | undefined {
  const match = FILE.exec(file);
  if (match === null) return undefined;
  const digits = match[1] as string;
  if (digits.length !== 14) {
    throw new MigrationError(
      "migration.fileName",
      `The migration file "${file}" does not start with a 14-digit version (YYYYMMDDHHMMSS).`,
      { params: { match: match[2] as string, match1: match[3] as string } },
    );
  }
  return { version: Number(digits), name: match[2] as string };
}

/**
 * Checks a version given by a caller: a positive safe integer.
 *
 * @example
 * ```ts
 * checkVersion("migrator.up({ to })", 20261012093000);
 * ```
 *
 * @throws TypeError when it is not one.
 */
export function checkVersion(where: string, version: unknown): number {
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    throw new TypeError(`${where}: a version is a positive whole number (YYYYMMDDHHMMSS).`);
  }
  return version;
}

/** Sorts sources by version and refuses duplicates. */
function sorted(sources: MigrationSource[]): readonly MigrationSource[] {
  sources.sort((a, b) => a.version - b.version);
  for (let i = 1; i < sources.length; i++) {
    const previous = sources[i - 1] as MigrationSource;
    const current = sources[i] as MigrationSource;
    if (previous.version === current.version) {
      throw new MigrationError(
        "migration.versionTwice",
        `Two migrations have the version ${current.version}: "${previous.name}" and "${current.name}".`,
        { version: current.version },
      );
    }
  }
  return sources;
}

/**
 * Checks an in-memory list of migrations and sorts it by version.
 *
 * @example
 * ```ts
 * declare const createUsers: Migration;
 * const list = migrationList([{ version: 20261012093000, name: "create_users", migration: createUsers }]);
 * ```
 *
 * @throws TypeError when an entry is not a {@link MigrationSource}.
 * @throws MigrationError when two entries have the same version, or a migration has no
 * `up` or no `down`.
 */
export function migrationList(list: readonly unknown[]): readonly MigrationSource[] {
  if (!Array.isArray(list))
    throw new TypeError("migrations must be an array of { version, name, migration }.");
  const sources: MigrationSource[] = [];
  for (const entry of list) {
    // An entry is read like options: own properties only.
    const given = (typeof entry === "object" && entry !== null ? entry : undefined) as
      | Partial<Record<keyof MigrationSource, unknown>>
      | undefined;
    const version = own(given, "version");
    const name = own(given, "name");
    const migration = own(given, "migration");
    checkVersion("migrations[]", version);
    if (typeof name !== "string" || !NAME.test(name)) {
      throw new TypeError("migrations[]: a name is letters, digits and underscores.");
    }
    if (!isMigration(migration)) {
      throw new TypeError(`migrations[]: "${name}" has no migration made by defineMigration().`);
    }
    checkSteps(`The migration "${name}" has`, migration, { version: version as number, migration: name });
    sources.push({ version: version as number, name, migration });
  }
  return sorted(sources);
}

/**
 * Refuses a migration without `up` or `down`. `defineMigration` refuses one already; this
 * catches a migration made by another copy of the package, or forged.
 */
function checkSteps(
  subject: string,
  migration: Migration,
  details: { readonly version: number; readonly migration: string },
): void {
  const missing = missingSteps(migration);
  if (missing.length > 0) {
    throw missingStepsError(subject, missing, Object.hasOwn(migration, "change"), details);
  }
}

/**
 * How a module is imported; replaced in tests.
 *
 * @example
 * ```ts
 * const load: ImportModule = (url) => import(url);
 * ```
 */
export type ImportModule = (url: string) => Promise<Record<string, unknown>>;

const importModule: ImportModule = (url) => import(url) as Promise<Record<string, unknown>>;

const TS_EXTENSION = /\.m?ts$/;

/** The explanation for a TypeScript file that the process cannot load. */
function typescriptHelp(file: string, cause: unknown): MigrationError {
  return new MigrationError(
    "migration.typescriptLoader",
    `Cannot load the TypeScript migration "${file}": this process has no TypeScript loader.`,
    { cause },
  );
}

/**
 * Loads every migration file of `directory` (not its subdirectories) and sorts them by
 * version. A file is a migration when its name is `<14-digit version>_<name>.<ts|mts|js|mjs>`;
 * other files are ignored. Its migration is the module's export named `migration`, or else its
 * default export (a file that exports both runs `migration`).
 *
 * @example
 * ```ts
 * const sources = await loadMigrations("./migrations");
 * ```
 *
 * @throws MigrationError when the directory cannot be read, a file cannot be loaded (a
 * TypeScript file without a TypeScript loader gets an explanation of what to install), a
 * file exports no migration or a migration without `up` or `down` (the message names the
 * file and the missing function), or two files have the same version.
 */
export async function loadMigrations(
  directory: string,
  load: ImportModule = importModule,
): Promise<readonly MigrationSource[]> {
  if (typeof directory !== "string" || directory.length === 0) {
    throw new TypeError("The migrations directory must be a non-empty path.");
  }
  // Imported here, not at the top: an in-memory list must work where there is no file system.
  const [{ readdir }, { join, resolve }, { pathToFileURL }] = await Promise.all([
    import("node:fs/promises"),
    import("node:path"),
    import("node:url"),
  ]);
  const root = resolve(directory);
  let files: string[];
  try {
    files = await readdir(root);
  } catch (cause) {
    throw new MigrationError("migration.readDirectory", `Cannot read the migrations directory "${root}".`, {
      cause,
    });
  }
  const sources: MigrationSource[] = [];
  for (const file of files.sort()) {
    const parsed = parseMigrationFileName(file);
    if (parsed === undefined) continue;
    const path = join(root, file);
    let module: Record<string, unknown>;
    try {
      module = await load(pathToFileURL(path).href);
    } catch (cause) {
      const code = (cause as { readonly code?: unknown } | null)?.code;
      if (TS_EXTENSION.test(file) && code === "ERR_UNKNOWN_FILE_EXTENSION") throw typescriptHelp(path, cause);
      // defineMigration's own refusal (a missing up or down): say which file it is in.
      const reason = isEgonError(cause, "migration") ? `: ${shortMessageOf(cause)}` : ".";
      throw new MigrationError("migration.loadFailed", `Cannot load the migration file "${path}"${reason}`, {
        version: parsed.version,
        migration: parsed.name,
        cause,
      });
    }
    // The export named `migration` (what `egon migrate create` writes) wins over a default export.
    const migration = isMigration(module.migration) ? module.migration : module.default;
    if (!isMigration(migration)) {
      throw new MigrationError("migration.noExport", `The migration file "${path}" exports no migration.`, {
        version: parsed.version,
        migration: parsed.name,
      });
    }
    checkSteps(`The migration file "${path}" has`, migration, {
      version: parsed.version,
      migration: parsed.name,
    });
    sources.push({ version: parsed.version, name: parsed.name, migration });
  }
  return sorted(sources);
}
