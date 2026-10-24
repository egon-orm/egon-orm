// A TypeDoc plugin for the API reference (docs/site/typedoc.json):
//
// - names each module after the import specifier users write, instead of its path in the
//   repository;
// - fails the run when an exported symbol has no `@example` (TypeDoc's own `notDocumented`
//   validation, an error through `treatWarningsAsErrors`, covers the summary);
// - leaves out the members of the `messages` catalog (`egon-orm/messages`), one entry per
//   error identifier, which the error reference (reference/errors/, generated from the same
//   catalog) already lists with the short message of each. Listed here too, they made a page
//   whose script was over Vite's 500 kB chunk-size warning.
import { Converter, IntrinsicType, ReflectionKind, ReflectionType } from "typedoc";

/** Entry file (relative to the repository's `packages/`) -> the import specifier. */
const MODULES = {
  "core/src/index.ts": "egon-orm",
  "core/src/testing.ts": "egon-orm/testing",
  "core/src/migration/index.ts": "egon-orm/migration",
  "core/src/messages/index.ts": "egon-orm/messages",
  "postgres/src/index.ts": "@egon-orm/postgres",
  "sqlite/src/index.ts": "@egon-orm/sqlite",
  "mysql/src/index.ts": "@egon-orm/mysql",
  "zod/src/index.ts": "@egon-orm/zod",
  "cli/src/index.ts": "@egon-orm/cli",
};

/** Whether a reflection, or one of its signatures, carries an `@example` block. */
function hasExample(reflection) {
  const comments = [reflection.comment, ...(reflection.signatures ?? []).map((s) => s.comment)];
  if (reflection.type?.declaration?.signatures) {
    comments.push(...reflection.type.declaration.signatures.map((s) => s.comment));
  }
  return comments.some((comment) => comment?.blockTags.some((tag) => tag.tag === "@example"));
}

/**
 * Replaces the type of the `messages` catalog, an object literal with one member per error
 * identifier, by `object`, and says where the entries are listed.
 */
function summariseCatalog(context) {
  const module = context.project
    .getChildrenByKind(ReflectionKind.Module)
    .find((each) => each.name === "egon-orm/messages");
  const catalog = module?.getChildByName("messages");
  if (catalog === undefined || !(catalog.type instanceof ReflectionType)) {
    throw new Error("typedoc-plugin: egon-orm/messages no longer exports the messages catalog as an object");
  }
  context.project.removeReflection(catalog.type.declaration);
  catalog.type = new IntrinsicType("object");
  catalog.comment?.summary.push({
    kind: "text",
    text: "\n\nOne entry per error identifier (`ErrorId`); the [error reference](/reference/errors) lists each one with its short message and this text.",
  });
}

/** @param {import("typedoc").Application} app */
export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    for (const module of context.project.getChildrenByKind(ReflectionKind.Module)) {
      const file = module.sources?.[0]?.fullFileName ?? "";
      const entry = Object.keys(MODULES).find((suffix) => file.endsWith(`/packages/${suffix}`));
      if (entry === undefined) throw new Error(`typedoc-plugin: no module name for ${file}`);
      module.name = MODULES[entry];
    }
  });

  app.converter.on(Converter.EVENT_RESOLVE_END, (context) => {
    summariseCatalog(context);
    for (const module of context.project.getChildrenByKind(ReflectionKind.Module)) {
      for (const exported of module.children ?? []) {
        if (exported.kindOf(ReflectionKind.Reference)) continue; // documented where it is declared
        if (!hasExample(exported)) {
          app.logger.error(
            `${module.name}: the exported ${ReflectionKind.singularString(exported.kind).toLowerCase()} ${exported.name} has no @example in its TSDoc.`,
          );
        }
      }
    }
  });
}
