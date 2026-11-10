// What the editor pays for a completion inside a query callback after an edit. After each
// edit the language service builds a new checker, which resolves only what the request needs.
// Inferring a callback's type arguments used to walk from the callback's bindings into the
// schema class (`Binding<typeof S>`), through every static member of it, and on through
// each association's target: the cost grew with every schema reachable through
// associations (docs/plan/status/21-gate-completions.md). The callback parameters are
// `NoInfer<…>` now, so the cost is the same whether the model has ten schemas or a hundred.
// Not covered: a callback inside a callback that returns the query, as in
// `preload("posts", (q) => q.where(…))` or `pipe((q) => q.where(…))`. There the walk
// starts from the outer callback's return type, and it still grows with the model.
//
// The measure is the checker's instantiation count, which is deterministic, not a time.
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const CORE = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
/** A directory that does not exist: every project file is in memory. */
const DIR = fileURLToPath(new URL("./virtual/", import.meta.url));

const name = (k: number): string => `S${String(k).padStart(3, "0")}`;

/** `count` schemas in a chain: each belongs to the one before and has many of the next. */
function schemas(count: number): string {
  const lines = ['import { belongsTo, cast, hasMany, Schema, t, timestamps } from "egon-orm";', ""];
  for (let k = 0; k < count; k++) {
    lines.push(`export class ${name(k)} extends Schema("t_${k}", {
  id: t.integer().primaryKey().dbGenerated(),
  name: t.string(),
  age: t.integer().nullable(),
  active: t.boolean().default(true),
  parentId: t.integer().nullable(),
  ...timestamps(),
}) {`);
    if (k > 0) lines.push(`  static parent = belongsTo(() => ${name(k - 1)}, { foreignKey: "parentId" });`);
    if (k < count - 1)
      lines.push(`  static children = hasMany(() => ${name(k + 1)}, { foreignKey: "parentId" });`);
    lines.push(`  static changeset(row: ${name(k)} | typeof ${name(k)}, params: unknown) {
    return cast(row, params, ["name", "age"]).validateRequired(["name"]).validateNumber("age", { greaterThan: 0 });
  }
}
`);
  }
  return lines.join("\n");
}

/** Each probe is a file with a completion request at the cursor, inside a callback. */
const PROBES: Readonly<Record<string, string>> = {
  where: `from(S001, "s").where(({ s }) => s./*cursor*/name.eq("x"))`,
  "where after joinAssoc": `from(S001, "s").joinAssoc("s", "parent", "p").where(({ s, p }) => s./*cursor*/name.eq(p.name))`,
  orWhere: `from(S001, "s").where(({ s }) => s.active).orWhere(({ s }) => s./*cursor*/active)`,
  having: `from(S001, "s").groupBy(({ s }) => s.name).having(({ s }) => s./*cursor*/active)`,
  groupBy: `from(S001, "s").groupBy(({ s }) => s./*cursor*/name)`,
  distinct: `from(S001, "s").distinct(({ s }) => s./*cursor*/name)`,
  orderBy: `from(S001, "s").orderBy(({ s }) => s./*cursor*/name)`,
  "join on": `from(S001, "s").join(S000, "p", ({ s, p }) => s./*cursor*/parentId.eq(p.id))`,
  "leftJoin on": `from(S001, "s").leftJoin(S000, "p", ({ s, p }) => s./*cursor*/parentId.eq(p.id))`,
  "joinAssoc on": `from(S001, "s").joinAssoc("s", "parent", "p", ({ s, p }) => s./*cursor*/name.eq(p.name))`,
  "leftJoinAssoc on": `from(S001, "s").leftJoinAssoc("s", "children", "c", ({ s, c }) => s./*cursor*/id.eq(c.parentId))`,
  "changeset pipe": `S001.changeset(S001, {}).pipe((c) => c./*cursor*/validateRequired(["age"]))`,
};

/** A language service over the chain of `count` schemas and one probe file. */
function editor(count: number) {
  const files = new Map<string, { text: string; version: number }>([
    [`${DIR}schemas.ts`, { text: schemas(count), version: 0 }],
    [`${DIR}probe.ts`, { text: "export {};\n", version: 0 }],
  ]);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    skipLibCheck: true,
    noEmit: true,
    paths: { "egon-orm": [CORE] },
  };
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: (file) => String(files.get(file)?.version ?? 0),
    getScriptSnapshot: (file) => {
      const text = files.get(file)?.text ?? ts.sys.readFile(file);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => DIR,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (file) => files.has(file) || ts.sys.fileExists(file),
    readFile: (file) => files.get(file)?.text ?? ts.sys.readFile(file),
    readDirectory: ts.sys.readDirectory,
    directoryExists: (dir) =>
      DIR.startsWith(dir.endsWith("/") ? dir : `${dir}/`) || ts.sys.directoryExists(dir),
    getDirectories: ts.sys.getDirectories,
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  /** Opens the probe as an edit, asks for completions, and reports what the new checker did. */
  return (probe: string) => {
    const text = `import { from } from "egon-orm";\nimport { S000, S001 } from "./schemas.js";\n\nexport const q = ${probe};\n`;
    const file = `${DIR}probe.ts`;
    const previous = files.get(file);
    files.set(file, { text, version: (previous?.version ?? 0) + 1 });
    const completions = service.getCompletionsAtPosition(file, text.indexOf("/*cursor*/"), {
      triggerCharacter: ".",
    });
    const instantiations = service.getProgram()?.getInstantiationCount() ?? Number.NaN;
    const errors = [...service.getSyntacticDiagnostics(file), ...service.getSemanticDiagnostics(file)].map(
      (d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    );
    return { names: (completions?.entries ?? []).map((entry) => entry.name), instantiations, errors };
  };
}

describe("a completion in a query callback after an edit", () => {
  // Both models give S001 the same neighbours (S000 and S002); only the schemas reachable
  // beyond them differ: 6 more in the small one, 38 more in the large one.
  const small = editor(8);
  const large = editor(40);
  // The first request loads the library's types; the probes then each measure an edit.
  small(PROBES.where ?? "");
  large(PROBES.where ?? "");

  for (const [label, probe] of Object.entries(PROBES)) {
    test(`${label}: costs no more with 40 schemas than with 8`, () => {
      const few = small(probe);
      const many = large(probe);
      expect(few.errors).toEqual([]);
      expect(few.names.length).toBeGreaterThan(0);
      expect(many.names).toEqual(few.names);
      // Walking the model cost about 500 instantiations per reachable schema, so 32 more
      // schemas would add about 16,000. The allowance is for nothing of that kind.
      expect(many.instantiations - few.instantiations).toBeLessThan(200);
    });
  }
});
