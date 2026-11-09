// The release workflow (.github/workflows/release.yml), end to end, against a local
// registry (verdaccio) instead of npm. Run by `pnpm release:dry-run` and by CI.
//
// 1. Clone this repository's HEAD (or `--ref <ref>`) into a temporary directory, install
//    with the frozen lockfile, build.
// 2. Version: `pnpm version-packages`, what the release workflow's version job runs to open
//    the version pull request. Every published package must move to one new version (the
//    fixed group), get a CHANGELOG.md entry and its VERSION constant; no private package
//    may change; the pending changesets are consumed. The result is committed, as merging
//    the version pull request would. A tree with no pending changeset (the version pull
//    request itself, or main after a release) is not versioned: its published packages must
//    share one version, with a non-empty `## <version>` section in each CHANGELOG.md and
//    VERSION at that version, and the steps below publish that tree as it stands.
// 3. Publish, as the release workflow does it, with the registry pointed at verdaccio:
//    `changeset publish-plan` (what select-mode runs to choose "publish") must list every
//    package at the new version; `changeset pack --from-publish-plan` (the pack job) packs
//    them; `changeset publish --from-pack-dir` (the publish job) publishes the tarballs.
//    First each tarball alone (`pnpm publish <tarball> --json`) with provenance on
//    (PNPM_CONFIG_PROVENANCE, as release.yml sets it): with no OIDC token to sign it, pnpm
//    must refuse each one with a provenance or id-token error, and nothing may reach the
//    registry. Then `changeset publish --from-pack-dir` with
//    provenance off, since it needs the OIDC token of a GitHub Actions run (as trusted
//    publishing does, which verdaccio cannot exercise). Every package must then be in the
//    registry at the new version, with no `workspace:` range left in its manifest and its
//    README as the readme; a git tag `<name>@<version>` must exist for each; and the publish
//    plan must be empty (select-mode's "none").
// 4. Release notes: each package's CHANGELOG section for the version, which the publish job
//    posts as the GitHub release of its tag, is written out (and the core one printed).
// 5. Install: a fresh project installs every package from the registry with npm, then
//    imports each entry point from an ES module, require()s each from CommonJS, and runs
//    `egon --version`.
// 6. The next release: a patch changeset for one package versions all of them together.
//
// Options: `--ref <ref>` (default HEAD; uncommitted changes are not in the clone), `--keep`
// (leave the temporary directory). Needs network access for the dependencies verdaccio
// proxies from npm.
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const refIndex = args.indexOf("--ref");
const ref = refIndex === -1 ? "HEAD" : args[refIndex + 1];
const PORT = Number(process.env.EGON_VERDACCIO_PORT ?? 4873);
const REGISTRY = `http://127.0.0.1:${PORT}/`;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const step = (text) => console.log(`\n== ${text}`);
const ok = (text) => console.log(`ok: ${text}`);
function check(condition, message) {
  if (!condition) throw new Error(`release dry run: ${message}`);
}
function run(command, argv, cwd, env = {}) {
  return execFileSync(command, argv, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
}
// pnpm, as the script that started this one ran it (`pnpm release:dry-run` sets npm_execpath).
function pnpm(argv, cwd, env) {
  const execPath = process.env.npm_execpath;
  return execPath !== undefined && /\.c?js$/.test(execPath)
    ? run(process.execPath, [execPath, ...argv], cwd, env)
    : run("pnpm", argv, cwd, env);
}
const git = (argv, cwd) =>
  run(
    "git",
    ["-c", "user.name=Egon release dry run", "-c", "user.email=release@example.invalid", ...argv],
    cwd,
  );

/** The packages of a checkout: directory, manifest, and whether it is published. */
function workspacePackages(dir) {
  const roots = ["packages", "examples", "benchmarks", "docs/site"];
  const found = [];
  for (const base of roots) {
    const full = join(dir, base);
    if (existsSync(join(full, "package.json"))) found.push(base);
    else if (existsSync(full))
      for (const entry of readdirSync(full, { withFileTypes: true }))
        if (entry.isDirectory() && existsSync(join(full, entry.name, "package.json")))
          found.push(`${base}/${entry.name}`);
  }
  return found.map((path) => {
    const manifest = readJson(join(dir, path, "package.json"));
    return { path, manifest, published: manifest.private !== true };
  });
}

/** The section of a CHANGELOG.md for one version: what the GitHub release of its tag says. */
function changelogSection(markdown, version) {
  const lines = markdown.split("\n");
  const start = lines.indexOf(`## ${version}`);
  if (start === -1) return undefined;
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
}

/** The entries of a publish plan written by `changeset publish-plan --output`. */
function publishPlanEntries(file) {
  const { version, plan } = readJson(file);
  check(version === 1 && Array.isArray(plan), `unexpected publish plan format in ${file}`);
  return plan.flat().map(({ kind, name, version: v }) => ({ kind, name, version: v }));
}

async function waitForRegistry(child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`verdaccio exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${REGISTRY}-/ping`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`verdaccio did not answer on ${REGISTRY}`);
}

const dir = mkdtempSync(join(tmpdir(), "egon-release-"));
const clone = join(dir, "clone");
let verdaccio;
try {
  step(`clone ${ref} of ${ROOT}`);
  const sha = run("git", ["rev-parse", ref], ROOT).trim();
  // `changeset version` looks up the commit that added each changeset; in a shallow clone
  // it fails with a bare "Error" (CI checks out with fetch-depth: 0 for this).
  check(
    run("git", ["rev-parse", "--is-shallow-repository"], ROOT).trim() === "false",
    "this repository is a shallow clone; fetch its full history first (git fetch --unshallow)",
  );
  run("git", ["clone", "--quiet", "--no-hardlinks", ROOT, clone], dir);
  git(["checkout", "--quiet", "-B", "main", sha], clone);
  // `changeset publish` makes annotated tags, which need a committer identity; without one
  // (a CI runner) git refuses and changesets still reports "Created git tags". release.yml
  // sets one before publishing.
  run("git", ["config", "user.name", "Egon release dry run"], clone);
  run("git", ["config", "user.email", "release@example.invalid"], clone);
  check(git(["status", "--porcelain"], clone).trim() === "", "the clone is not clean");
  ok(`clean clone at ${sha}`);
  pnpm(["install", "--frozen-lockfile", "--prefer-offline"], clone);
  pnpm(["build"], clone);
  ok("installed with the frozen lockfile and built");

  const before = workspacePackages(clone);
  const published = before.filter((pkg) => pkg.published);
  const config = readJson(join(clone, ".changeset/config.json"));
  check(
    JSON.stringify([...config.fixed[0]].sort()) ===
      JSON.stringify(published.map((pkg) => pkg.manifest.name).sort()),
    "the fixed group is not the set of published packages",
  );
  const pending = readdirSync(join(clone, ".changeset")).filter(
    (file) => file.endsWith(".md") && file !== "README.md",
  );
  let after;
  let version;
  if (pending.length > 0) {
    ok(
      `${published.length} published packages in one fixed group; pending changesets: ${pending.join(", ")}`,
    );
    step("version (the version pull request)");
    console.log(pnpm(["version-packages"], clone).trim());
    after = workspacePackages(clone);
    const versions = new Set(after.filter((pkg) => pkg.published).map((pkg) => pkg.manifest.version));
    check(versions.size === 1, `the published packages have several versions: ${[...versions].join(", ")}`);
    [version] = versions;
    check(version !== published[0].manifest.version, "the version did not change");
    for (const pkg of after) {
      const old = before.find((other) => other.path === pkg.path);
      if (!pkg.published)
        check(pkg.manifest.version === old.manifest.version, `private ${pkg.path} was versioned`);
    }
  } else {
    // The "Version packages" pull request (and main after a release): nothing to version.
    // Merging it publishes the tree as it stands, so the rest checks exactly that tree.
    after = before;
    const versions = new Set(published.map((pkg) => pkg.manifest.version));
    check(versions.size === 1, `the published packages have several versions: ${[...versions].join(", ")}`);
    [version] = versions;
    ok(
      `${published.length} published packages in one fixed group; no pending changeset (a version pull request, or main after a release): the tree as it stands, at ${version}`,
    );
  }
  const notes = {};
  for (const pkg of after.filter((p) => p.published)) {
    const changelog = join(clone, pkg.path, "CHANGELOG.md");
    check(existsSync(changelog), `${pkg.path} has no CHANGELOG.md`);
    const section = changelogSection(readFileSync(changelog, "utf8"), version);
    check(
      section !== undefined && section !== "",
      `${pkg.path}/CHANGELOG.md has no non-empty "## ${version}" section (the GitHub release body)`,
    );
    notes[pkg.manifest.name] = section;
    const sources = ["index.ts", "version.ts"].map((file) => join(clone, pkg.path, "src", file));
    check(
      sources.some(
        (file) =>
          existsSync(file) &&
          readFileSync(file, "utf8").includes(`export const VERSION: string = "${version}";`),
      ),
      `${pkg.path}: VERSION is not ${version}`,
    );
  }
  if (pending.length > 0) {
    const left = readdirSync(join(clone, ".changeset")).filter(
      (file) => file.endsWith(".md") && file !== "README.md",
    );
    check(left.length === 0, `changesets left after versioning: ${left.join(", ")}`);
    git(["add", "--all"], clone);
    git(["commit", "--quiet", "-m", "Version packages"], clone);
    ok(
      `every published package is at ${version}, with a CHANGELOG entry and VERSION; no private package changed; committed`,
    );
    pnpm(["build"], clone);
  } else ok(`every published package is at ${version}, with a "## ${version}" CHANGELOG section and VERSION`);

  step(`publish to verdaccio at ${REGISTRY}`);
  const storage = join(dir, "registry");
  mkdirSync(storage);
  writeFileSync(
    join(dir, "verdaccio.yaml"),
    [
      `storage: ${JSON.stringify(join(storage, "storage"))}`,
      "auth:",
      "  htpasswd:",
      `    file: ${JSON.stringify(join(storage, "htpasswd"))}`,
      "uplinks:",
      "  npmjs:",
      "    url: https://registry.npmjs.org/",
      "packages:",
      // Ours exist only here: never looked up on npm.
      "  'egon-orm':",
      "    access: $all",
      "    publish: $authenticated",
      "  '@egon-orm/*':",
      "    access: $all",
      "    publish: $authenticated",
      "  '**':",
      "    access: $all",
      "    proxy: npmjs",
      "log: { type: stdout, format: pretty, level: warn }",
      "",
    ].join("\n"),
  );
  verdaccio = spawn(
    process.execPath,
    [
      join(clone, "node_modules/verdaccio/bin/verdaccio"),
      "--config",
      join(dir, "verdaccio.yaml"),
      "--listen",
      `127.0.0.1:${PORT}`,
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  await waitForRegistry(verdaccio);
  const user = await fetch(`${REGISTRY}-/user/org.couchdb.user:egon`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "egon", password: "dry-run-only", type: "user", roles: [] }),
  });
  const { token } = await user.json();
  check(typeof token === "string", `verdaccio gave no token (${user.status})`);
  const npmrc = `registry=${REGISTRY}\n//127.0.0.1:${PORT}/:_authToken=${token}\n`;
  writeFileSync(join(clone, ".npmrc"), npmrc);
  const plan = join(dir, "publish-plan.json");
  pnpm(["exec", "changeset", "publish-plan", "--output", plan], clone);
  const planned = publishPlanEntries(plan);
  check(
    JSON.stringify(planned.map((entry) => `${entry.kind} ${entry.name}@${entry.version}`).sort()) ===
      JSON.stringify(
        after
          .filter((p) => p.published)
          .map((p) => `publish ${p.manifest.name}@${version}`)
          .sort(),
      ),
    `the publish plan is not the six packages at ${version}: ${JSON.stringify(planned)}`,
  );
  ok(
    `publish plan (select-mode "publish"): ${planned.map((entry) => `${entry.name}@${entry.version}`).join(", ")}`,
  );
  const packDir = join(dir, "pack");
  console.log(
    pnpm(["exec", "changeset", "pack", "--from-publish-plan", plan, "--out-dir", packDir], clone).trim(),
  );
  // release.yml asks for provenance with PNPM_CONFIG_PROVENANCE (pnpm ignores
  // NPM_CONFIG_PROVENANCE). With it on and no OIDC token to sign with, pnpm must refuse each
  // package before any upload; a pnpm that stopped reading the variable would publish here
  // instead. Each tarball is tried on its own, as `changeset publish` runs it (`pnpm publish
  // <tarball> --json` in the package's directory): `changeset publish` itself stops at the
  // first chunk that fails, which is egon-orm alone.
  const packedPlan = readJson(join(packDir, "publish-plan.json")).plan.flat();
  check(
    packedPlan.length === published.length,
    `the pack directory's plan has ${packedPlan.length} packages`,
  );
  const refusals = [];
  for (const release of packedPlan) {
    const pkg = after.find((p) => p.manifest.name === release.name);
    check(pkg !== undefined && release.tarball?.path !== undefined, `no tarball for ${release.name}`);
    let refused;
    try {
      pnpm(
        ["publish", join(packDir, release.tarball.path), "--json", "--access", "public", "--no-git-checks"],
        join(clone, pkg.path),
        { PNPM_CONFIG_PROVENANCE: "true" },
      );
    } catch (error) {
      refused = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    check(
      refused !== undefined,
      `${release.name}: with PNPM_CONFIG_PROVENANCE=true and no OIDC token, it was published`,
    );
    const code = /"code":\s*"([^"]+)"/.exec(refused)?.[1];
    check(
      code !== undefined && /^ERR_PNPM_(?:PROVENANCE|ID_TOKEN)_\w+$/.test(code),
      `${release.name}: with PNPM_CONFIG_PROVENANCE=true, the publish failed for another reason:\n${refused}`,
    );
    refusals.push(`${release.name} ${code}`);
  }
  for (const pkg of after.filter((p) => p.published)) {
    const response = await fetch(`${REGISTRY}${pkg.manifest.name.replace("/", "%2f")}`);
    check(response.status === 404, `${pkg.manifest.name} reached the registry without provenance`);
  }
  ok(
    `with PNPM_CONFIG_PROVENANCE=true and no OIDC token, pnpm refused each of the ${refusals.length} packages and nothing reached the registry: ${refusals.join(", ")}`,
  );
  const publishOutput = pnpm(["exec", "changeset", "publish", "--from-pack-dir", packDir], clone, {
    PNPM_CONFIG_PROVENANCE: "false",
  });
  console.log(publishOutput.trim());

  for (const pkg of after.filter((p) => p.published)) {
    const name = pkg.manifest.name;
    const response = await fetch(`${REGISTRY}${name.replace("/", "%2f")}`);
    check(response.ok, `${name} is not in the registry (${response.status})`);
    const packument = await response.json();
    check(packument["dist-tags"]?.latest === version, `${name}: latest is ${packument["dist-tags"]?.latest}`);
    const manifest = packument.versions[version];
    const ranges = JSON.stringify([
      manifest.dependencies,
      manifest.peerDependencies,
      manifest.optionalDependencies,
    ]);
    check(!ranges.includes("workspace:"), `${name}@${version} still has a workspace: range: ${ranges}`);
    if (manifest.peerDependencies?.["egon-orm"] !== undefined)
      check(
        manifest.peerDependencies["egon-orm"] === `^${version}`,
        `${name}: peer egon-orm is ${manifest.peerDependencies["egon-orm"]}`,
      );
    check(
      (packument.readme ?? "").startsWith(`# ${name}`),
      `${name}: the registry's readme is not the package README`,
    );
  }
  const tags = git(["tag", "--list"], clone).trim().split("\n");
  for (const pkg of after.filter((p) => p.published))
    check(tags.includes(`${pkg.manifest.name}@${version}`), `no git tag ${pkg.manifest.name}@${version}`);
  ok(
    `${published.length} packages at ${version} in the registry, no workspace: ranges, READMEs shown, git tags ${tags.join(" ")}`,
  );
  const afterPlan = join(dir, "publish-plan-after.json");
  pnpm(["exec", "changeset", "publish-plan", "--output", afterPlan], clone);
  const remaining = publishPlanEntries(afterPlan);
  check(
    remaining.length === 0,
    `after publishing, the publish plan is not empty: ${JSON.stringify(remaining)}`,
  );
  ok('after publishing, the publish plan is empty (select-mode "none")');

  step("GitHub release notes (one release per tag, from its CHANGELOG section)");
  mkdirSync(join(dir, "release-notes"));
  for (const [name, section] of Object.entries(notes))
    writeFileSync(join(dir, "release-notes", `${name.replace("/", "__")}@${version}.md`), `${section}\n`);
  console.log(`egon-orm@${version}:\n${notes["egon-orm"].replace(/^/gm, "  ")}`);
  ok(`${Object.keys(notes).length} release notes written`);

  step("install from the registry (npm), import, require, run egon");
  const consumer = join(dir, "consumer");
  mkdirSync(consumer);
  const dependencies = Object.fromEntries(
    after.filter((p) => p.published).map((p) => [p.manifest.name, version]),
  );
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "egon-release-consumer", private: true, type: "module", dependencies }, null, 2)}\n`,
  );
  writeFileSync(join(consumer, ".npmrc"), `registry=${REGISTRY}\n`);
  // No install scripts: nothing below opens a SQLite database, so better-sqlite3's native
  // module is not needed; npm installs the peers by itself.
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], consumer);
  const entries = ["egon-orm", "egon-orm/migration", "egon-orm/testing", "egon-orm/messages"].concat(
    after.filter((p) => p.published && p.manifest.name !== "egon-orm").map((p) => p.manifest.name),
  );
  writeFileSync(
    join(consumer, "check.mjs"),
    `${entries.map((entry, index) => `import * as m${index} from ${JSON.stringify(entry)};`).join("\n")}\n` +
      `const versions = [m0.VERSION, ${entries
        .map((_, index) => index)
        .filter((index) => index >= 4)
        .map((index) => `m${index}.VERSION`)
        .join(", ")}];\n` +
      `if (versions.some((v) => v !== ${JSON.stringify(version)})) throw new Error("VERSION: " + versions);\n` +
      `for (const m of [m1, m2, m3]) if (Object.keys(m).length === 0) throw new Error("an empty entry point");\n` +
      `console.log("esm: " + ${entries.length} + " entry points, VERSION " + m0.VERSION);\n`,
  );
  writeFileSync(
    join(consumer, "check.cjs"),
    `const entries = ${JSON.stringify(entries)};\n` +
      `const loaded = entries.map((entry) => require(entry));\n` +
      `if (loaded[0].VERSION !== ${JSON.stringify(version)}) throw new Error("VERSION " + loaded[0].VERSION);\n` +
      `if (!(new (require("egon-orm/migration").MigrationError)("migration.failed", "x") instanceof loaded[0].EgonError)) throw new Error("two copies");\n` +
      `console.log("cjs: require() of " + entries.length + " entry points on Node " + process.version);\n`,
  );
  console.log(run(process.execPath, ["check.mjs"], consumer).trim());
  console.log(run(process.execPath, ["check.cjs"], consumer).trim());
  const egon = run(join(consumer, "node_modules/.bin/egon"), ["--version"], consumer).trim();
  check(egon === version, `egon --version printed ${egon}`);
  ok(`npm installed ${entries.length} entry points from the registry; egon --version is ${egon}`);

  step("the next release: a patch changeset for one package versions every package");
  const nextChangeset = '---\n"@egon-orm/zod": patch\n---\n\nA patch to one package.\n';
  writeFileSync(join(clone, ".changeset/dry-run-next.md"), nextChangeset);
  pnpm(["version-packages"], clone);
  const next = workspacePackages(clone);
  const nextVersions = new Set(next.filter((p) => p.published).map((p) => p.manifest.version));
  check(nextVersions.size === 1, `the next release splits the versions: ${[...nextVersions].join(", ")}`);
  const [nextVersion] = nextVersions;
  const [major, minor, patch] = version.split(".").map(Number);
  check(
    nextVersion === `${major}.${minor}.${patch + 1}`,
    `a patch gave ${nextVersion}, not ${major}.${minor}.${patch + 1}`,
  );
  for (const pkg of next.filter((p) => !p.published))
    check(
      pkg.manifest.version === before.find((other) => other.path === pkg.path).manifest.version,
      `private ${pkg.path} was versioned`,
    );
  ok(
    `a patch to @egon-orm/zod alone moves all ${published.length} packages to ${nextVersion} (not published)`,
  );

  console.log(`\nrelease dry run: passed (${sha.slice(0, 7)}, ${version})`);
} catch (error) {
  console.error(error.stdout ?? "", error.stderr ?? "");
  console.error(error);
  process.exitCode = 1;
} finally {
  verdaccio?.kill();
  if (keep) console.log(`kept ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}
