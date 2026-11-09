// Fails when the release configuration and the published packages drift apart. Run by
// `pnpm lint`.
//
// - Every package under packages/ that is not private is in the one `fixed` group of
//   .changeset/config.json, and the group names nothing else: the packages ship together,
//   at one version.
// - Private packages are never versioned (`privatePackages.version: false`), so a release
//   does not bump the examples, the docs site or the benchmarks.
// - Each published package has the same version, a README.md and a LICENSE (both packed:
//   npm adds them whatever `files` says), public access, `engines.node` `>=22.12`
//   (decision D14), `"type": "module"`, and repository fields that point at its directory.
// - Each code block of a package README (the package's npm page) in TypeScript or
//   JavaScript is a copy of a checked region: the line above it is
//   `<!-- example: docs/site/examples/<file>#<region> -->`, and the block is that region,
//   dedented and without trailing blank lines (as the docs site shows it). The region's
//   file is type-checked with the site.
// - The release workflow publishes as trusted publishing needs: pnpm 12 or later pinned,
//   provenance asked for with PNPM_CONFIG_PROVENANCE (pnpm ignores NPM_CONFIG_PROVENANCE),
//   `id-token: write`, and the environment `npm`.
// - No tracked file outside docs/plan names the project's former name.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKED_LANGUAGES, fencedBlocks, regionText } from "./check-docs.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Spelled in two parts so that this file does not match itself.
export const FORMER_NAME = new RegExp(["ec", "type"].join(""), "i");
const REPOSITORY = "git+https://github.com/egon-orm/egon-orm.git";

/**
 * Returns one message per problem with the changesets `config` given the workspace's
 * `packages` (`{ dir, manifest, files }`, where `files` lists the names in the package's
 * directory).
 */
export function findReleaseProblems(config, packages) {
  const problems = [];
  const published = packages.filter(({ manifest }) => manifest.private !== true);
  const names = published.map(({ manifest }) => manifest.name).sort();

  if (!Array.isArray(config.fixed) || config.fixed.length !== 1) {
    problems.push(".changeset/config.json: `fixed` must hold exactly one group, every published package.");
  } else {
    const group = [...config.fixed[0]].sort();
    for (const name of names)
      if (!group.includes(name)) problems.push(`.changeset/config.json: ${name} is not in the fixed group.`);
    for (const name of group)
      if (!names.includes(name))
        problems.push(
          `.changeset/config.json: the fixed group names ${name}, which is not a published package.`,
        );
  }
  if (config.access !== "public") problems.push('.changeset/config.json: `access` must be "public".');
  if (config.privatePackages?.version !== false || config.privatePackages?.tag !== false)
    problems.push(".changeset/config.json: `privatePackages` must be { version: false, tag: false }.");

  const versions = new Set(published.map(({ manifest }) => manifest.version));
  if (versions.size > 1)
    problems.push(`the published packages have different versions: ${[...versions].join(", ")}.`);

  for (const { dir, manifest, files } of published) {
    const at = `${dir}/package.json (${manifest.name})`;
    for (const file of ["README.md", "LICENSE"])
      if (!files.includes(file)) problems.push(`${dir}: no ${file}.`);
    if (manifest.publishConfig?.access !== "public")
      problems.push(`${at}: publishConfig.access must be "public".`);
    if (manifest.engines?.node !== ">=22.12") problems.push(`${at}: engines.node must be ">=22.12".`);
    if (manifest.type !== "module") problems.push(`${at}: "type" must be "module".`);
    if (manifest.repository?.url !== REPOSITORY || manifest.repository?.directory !== dir)
      problems.push(`${at}: repository must be { url: "${REPOSITORY}", directory: "${dir}" }.`);
  }
  return problems;
}

/**
 * Returns one message per problem with how the release workflow (`workflow`, the text of
 * .github/workflows/release.yml) publishes, given the root manifest's `packageManager`.
 * `changeset publish` runs `pnpm publish`, and pnpm 12 does the trusted publishing and the
 * provenance itself and reads only `PNPM_CONFIG_*` variables: an `NPM_CONFIG_PROVENANCE`
 * key would be ignored.
 */
export function findWorkflowProblems(workflow, packageManager) {
  const problems = [];
  const at = ".github/workflows/release.yml";
  const pnpm = /^pnpm@(\d+)\.\d+\.\d+$/.exec(packageManager ?? "");
  if (pnpm === null || Number(pnpm[1]) < 12)
    problems.push(
      `package.json: packageManager must pin pnpm 12 or later (it publishes, with trusted publishing), not ${packageManager}.`,
    );
  if (/^\s*NPM_CONFIG_PROVENANCE\s*:/m.test(workflow))
    problems.push(`${at}: NPM_CONFIG_PROVENANCE is ignored by pnpm; set PNPM_CONFIG_PROVENANCE.`);
  if (!/^\s*PNPM_CONFIG_PROVENANCE\s*:\s*"true"\s*$/m.test(workflow))
    problems.push(`${at}: the publish step must set PNPM_CONFIG_PROVENANCE: "true".`);
  if (!/^\s*id-token\s*:\s*write\b/m.test(workflow))
    problems.push(`${at}: the publish job needs \`id-token: write\` (trusted publishing and provenance).`);
  if (!/^\s*environment\s*:\s*npm\s*$/m.test(workflow))
    problems.push(
      `${at}: the publish job must use the environment \`npm\`, which its trusted publishers name.`,
    );
  return problems;
}

/** `text` without the indentation its lines share. */
export function dedent(text) {
  const lines = text.split("\n");
  const indent = Math.min(
    ...lines.filter((line) => line.trim() !== "").map((line) => /^ */.exec(line)[0].length),
  );
  return lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0)).join("\n");
}

/**
 * Returns one message per code block of a package README (`markdown`, at `file`) that is
 * not a copy of the checked region its marker names; `readSource` reads a file by its path
 * from the repository root, or returns undefined.
 */
export function findReadmeProblems(file, markdown, readSource) {
  const problems = [];
  for (const block of fencedBlocks(markdown).filter(({ language }) => CHECKED_LANGUAGES.has(language))) {
    const marker = /^<!-- example: (\S+)#([\w-]+) -->$/.exec(block.previous);
    if (marker === null) {
      problems.push(
        `${file}:${block.line}: a hand-written \`${block.language}\` block. Copy a region of a checked file under docs/site/examples, with <!-- example: path#region --> on the line above.`,
      );
      continue;
    }
    const source = readSource(marker[1]);
    const region = source === undefined ? undefined : regionText(source, marker[2]);
    if (region === undefined) {
      problems.push(`${file}:${block.line}: ${marker[1]} has no region ${marker[2]}.`);
      continue;
    }
    if (block.end === undefined) {
      problems.push(`${file}:${block.line}: the block is never closed.`);
      continue;
    }
    if (block.body !== dedent(region).replace(/\n\s*$/, ""))
      problems.push(
        `${file}:${block.line}: the block is not ${marker[1]}#${marker[2]} as it is (copy it again).`,
      );
  }
  return problems;
}

/** Returns one message per tracked file outside docs/plan that names the former name. */
export function findFormerName(files, read) {
  return files
    .filter((file) => !file.startsWith("docs/plan/"))
    .filter((file) => FORMER_NAME.test(file) || FORMER_NAME.test(read(file)))
    .map((file) => `${file}: names the project's former name; the packages are egon-orm and @egon-orm/*.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync(join(ROOT, ".changeset/config.json"), "utf8"));
  const packages = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(ROOT, "packages", entry.name, "package.json")))
    .map((entry) => {
      const dir = `packages/${entry.name}`;
      return {
        dir,
        manifest: JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")),
        files: readdirSync(join(ROOT, dir)),
      };
    });
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((file) => file !== "" && existsSync(join(ROOT, file)));
  const readSource = (path) =>
    existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), "utf8") : undefined;
  const readmes = packages
    .filter(({ manifest, files }) => manifest.private !== true && files.includes("README.md"))
    .flatMap(({ dir }) =>
      findReadmeProblems(`${dir}/README.md`, readFileSync(join(ROOT, dir, "README.md"), "utf8"), readSource),
    );
  const problems = [
    ...findReleaseProblems(config, packages),
    ...findWorkflowProblems(
      readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8"),
      JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).packageManager,
    ),
    ...readmes,
    ...findFormerName(tracked, (file) => readFileSync(join(ROOT, file), "latin1")),
  ];
  if (problems.length > 0) {
    console.error(`release configuration:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    process.exit(1);
  }
  console.log(
    `ok: ${packages.filter(({ manifest }) => manifest.private !== true).length} published packages, one fixed group, no former name outside docs/plan`,
  );
}
