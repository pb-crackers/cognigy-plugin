#!/usr/bin/env node
/**
 * Resolve the boilerplate half of an upstream merge.
 *
 * Every upstream release conflicts on the same seven files, always the same
 * way: take upstream's version number, keep this fork's `github:` engine spec.
 * Doing that by hand each time is tedious and — more to the point — one slip
 * restores the npm engine and the fork silently stops running.
 *
 * This resolves ONLY those manifest/version conflicts and re-stamps the fork
 * version. Conflicts in source files are left alone: they need judgement, and
 * quietly picking a side there is how a merge loses a feature.
 *
 * Usage, after `git merge upstream/main` reports conflicts:
 *   npm run merge:resolve
 *   # then resolve any remaining source conflicts by hand
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_SPEC = "github:pb-crackers/cognigy-plugin";

/** Conflicts this script is allowed to decide on its own. */
const MANIFEST_FILES = new Set([
  "package.json",
  "package-lock.json",
  "plugin/.claude-plugin/plugin.json",
  "plugin/.codex-plugin/plugin.json",
  "plugin/.codex-plugin/mcp.json",
  "plugin/plugin.json",
  "plugin/mcp.json",
  "plugin/.cursor-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
]);

const git = (args) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8" });

const conflicted = git(["diff", "--name-only", "--diff-filter=U"])
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);

if (conflicted.length === 0) {
  console.log("No conflicts to resolve.");
  process.exit(0);
}

const handled = [];
const remaining = [];

for (const file of conflicted) {
  if (!MANIFEST_FILES.has(file)) {
    remaining.push(file);
    continue;
  }

  const path = join(repoRoot, file);
  let src = readFileSync(path, "utf-8");

  // Take upstream's side of every hunk — it carries the new version — then
  // put the fork's engine spec back over the top. Resolving in that order
  // means a new upstream field is picked up rather than dropped.
  src = src.replace(
    /<<<<<<<[^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>>[^\n]*\n/g,
    (_match, _ours, theirs) => theirs,
  );

  // Restore the fork's engine spec wherever upstream's npm pin came through.
  src = src.replace(
    /"cognigy-engine@npm:@cognigy\/plugin-engine@[^"]*"/g,
    `"${ENGINE_SPEC}"`,
  );
  // Upstream's pin is an alias spec split across array entries in some
  // manifests; collapse any leftover duplicate of our spec.
  src = src.replace(
    new RegExp(`("${ENGINE_SPEC}",\\s*)+"${ENGINE_SPEC}"`, "g"),
    `"${ENGINE_SPEC}"`,
  );

  if (file === ".claude-plugin/marketplace.json") {
    src = src.replace(
      /"name":\s*"cognigy-plugin"/,
      '"name": "cognigy-plugin-pb"',
    );
  }

  writeFileSync(path, src);
  git(["add", file]);
  handled.push(file);
}

for (const file of handled) console.log(`  resolved  ${file}`);

// Re-stamp the fork version onto whatever base upstream just moved to.
const base = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf-8"),
).version.replace(/-pb\.\d+$/, "");
console.log(`\nRe-stamping fork version on upstream base ${base}:`);
execFileSync(
  "node",
  [join(repoRoot, "scripts", "fork-version.mjs"), base, "1"],
  {
    cwd: repoRoot,
    stdio: "inherit",
  },
);
for (const file of handled) git(["add", file]);

if (remaining.length > 0) {
  console.log(`\n${remaining.length} conflict(s) need you:`);
  for (const file of remaining) console.log(`  ${file}`);
  console.log(
    "\nThese are source files — decide each one. MAINTAINING.md lists what the fork changes in each.",
  );
} else {
  console.log(
    "\nAll conflicts were manifest boilerplate. Nothing left by hand.",
  );
}

console.log(
  "\nThen: npm run check:manifest && npm test && npm run build, and commit the merge.",
);
