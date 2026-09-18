#!/usr/bin/env node
/**
 * Check that the plugin INSTALLED in Claude Code is actually this fork.
 *
 * check-plugin-manifest.mjs guards what the repo commits. It cannot see the
 * client, and the client is where the fork silently stopped running:
 *
 *   Claude Code caches a plugin at <marketplace>/<plugin>/<version>. The fork
 *   shared both the marketplace name "cognigy-plugin" and, after merging
 *   upstream, the version number 1.19.0. A stale upstream entry left in that
 *   cache was served under the fork's install — right marketplace, right
 *   version, plugin enabled, no error, and the STOCK engine running with none
 *   of the fork's behaviour.
 *
 * The marketplace is now named apart from upstream so that exact collision
 * cannot recur, but a manual `/plugin marketplace add Cognigy/cognigy-plugin`
 * or a half-finished dev switch can still leave the wrong thing installed.
 * This reports what is really there.
 *
 * Run: npm run doctor
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FORK_MARKETPLACE = "cognigy-plugin-pb";
const FORK_REPO = "pb-crackers/cognigy-plugin";
const ENGINE_SPEC = `github:${FORK_REPO}`;
const UPSTREAM_REPO = "Cognigy/cognigy-plugin";

const claudeDir = join(homedir(), ".claude");
const pluginsDir = join(claudeDir, "plugins");

const problems = [];
const notes = [];
const ok = [];

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
};

// --- 1. Registered marketplaces ------------------------------------------
const marketplaces =
  readJson(join(pluginsDir, "known_marketplaces.json")) ?? {};
const entries = Object.entries(marketplaces);

const forkEntry = entries.find(
  ([, v]) => (v?.source?.repo ?? "").toLowerCase() === FORK_REPO.toLowerCase(),
);
const upstreamEntry = entries.find(
  ([, v]) =>
    (v?.source?.repo ?? "").toLowerCase() === UPSTREAM_REPO.toLowerCase(),
);

if (!forkEntry) {
  problems.push(
    `The fork's marketplace (${FORK_REPO}) is not registered. Run: claude plugin marketplace add ${FORK_REPO}`,
  );
} else {
  const [name] = forkEntry;
  ok.push(`marketplace "${name}" -> ${FORK_REPO}`);
  if (name !== FORK_MARKETPLACE) {
    problems.push(
      `The fork is registered as "${name}" but should be "${FORK_MARKETPLACE}". An old registration under upstream's name can collide in the plugin cache. Remove and re-add it.`,
    );
  }
}

if (upstreamEntry) {
  problems.push(
    `Upstream's marketplace (${UPSTREAM_REPO}) is registered as "${upstreamEntry[0]}". It ships the stock engine; having it alongside the fork is how the wrong plugin gets installed. Remove it: claude plugin marketplace remove ${upstreamEntry[0]}`,
  );
}

// --- 2. Enabled plugin ----------------------------------------------------
const settings = readJson(join(claudeDir, "settings.json")) ?? {};
const enabled = Object.entries(settings.enabledPlugins ?? {})
  .filter(([, on]) => on)
  .map(([id]) => id);

const forkPluginId = `cognigy@${FORK_MARKETPLACE}`;
if (!enabled.includes(forkPluginId)) {
  problems.push(
    `"${forkPluginId}" is not enabled (enabled: ${enabled.join(", ") || "none"}). Run: claude plugin install ${forkPluginId}`,
  );
} else {
  ok.push(`plugin "${forkPluginId}" enabled`);
}

// --- 3. Every cached manifest must point at the fork's engine -------------
const cacheRoot = join(pluginsDir, "cache");
let checkedManifests = 0;
if (existsSync(cacheRoot)) {
  for (const marketplace of readdirSync(cacheRoot)) {
    const pluginRoot = join(cacheRoot, marketplace);
    for (const plugin of safeReaddir(pluginRoot)) {
      for (const version of safeReaddir(join(pluginRoot, plugin))) {
        const manifestPath = join(
          pluginRoot,
          plugin,
          version,
          ".claude-plugin",
          "plugin.json",
        );
        const manifest = readJson(manifestPath);
        if (!manifest) continue;
        checkedManifests += 1;

        const args = manifest.mcpServers?.platform?.args ?? [];
        const spec = args.find((a) => typeof a === "string" && a.includes(":"));
        const isForkMarketplace = marketplace === FORK_MARKETPLACE;
        const usesNpmEngine = args.some(
          (a) => typeof a === "string" && a.includes("@cognigy/plugin-engine@"),
        );

        if (isForkMarketplace && usesNpmEngine) {
          problems.push(
            `Cached ${marketplace}/${plugin}/${version} pins the npm engine (${spec}) instead of ${ENGINE_SPEC}. This is the stale-cache failure: purge it with rm -rf ${cacheRoot}/${marketplace} then re-add the marketplace.`,
          );
        } else if (isForkMarketplace) {
          ok.push(`cached ${marketplace}/${plugin}/${version} -> ${spec}`);
        } else if (usesNpmEngine) {
          notes.push(
            `Leftover cache from another marketplace: ${marketplace}/${plugin}/${version} (stock engine). Harmless while unused; delete it to be sure.`,
          );
        }
      }
    }
  }
}
if (checkedManifests === 0) {
  notes.push("No cached plugin manifests found — nothing is installed yet.");
}

// --- 4. Credentials -------------------------------------------------------
const credsFile = join(homedir(), ".cognigy-plugin", "config.json");
const creds = readJson(credsFile);
const hasEnv = process.env.COGNIGY_API_KEY && process.env.COGNIGY_API_BASE_URL;
const pluginConfigured =
  settings.pluginConfigs?.[forkPluginId]?.options?.cognigy_api_base_url;

if (!hasEnv && !creds?.COGNIGY_API_KEY && !pluginConfigured) {
  problems.push(
    `No credentials found. Set them with /plugin configure ${forkPluginId}, or write ${credsFile} with COGNIGY_API_BASE_URL and COGNIGY_API_KEY.`,
  );
} else if (creds?.COGNIGY_API_KEY) {
  ok.push(`credentials via ${credsFile} (${creds.COGNIGY_API_BASE_URL})`);
} else {
  ok.push("credentials via plugin config or environment");
}

function safeReaddir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

// --- Report ---------------------------------------------------------------
for (const line of ok) console.log(`  ✓ ${line}`);
for (const line of notes) console.log(`  · ${line}`);
for (const line of problems) console.error(`  ✗ ${line}`);

if (problems.length > 0) {
  console.error(
    `\n${problems.length} problem${problems.length === 1 ? "" : "s"}. The plugin may be running the stock engine rather than this fork.`,
  );
  process.exit(1);
}
console.log("\n✓ Claude Code is running this fork.");
