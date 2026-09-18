# Maintaining this fork

`pb-crackers/cognigy-plugin` is a fork of [`Cognigy/cognigy-plugin`](https://github.com/Cognigy/cognigy-plugin) that adds automatic error tracing and guards to every Cognigy Code Node the plugin writes.

## How this fork is distributed

Upstream publishes its engine to npm as `@cognigy/plugin-engine` and every manifest pins it:

```
npx -y -p cognigy-engine@npm:@cognigy/plugin-engine@<version> cognigy-mcp
```

**This fork is not published to npm.** The manifests point at the repository itself:

```
npx -y -p github:pb-crackers/cognigy-plugin cognigy-mcp
```

npm clones this repo, installs its dependencies, runs the `prepare` hook (`scripts/prepare.mjs`), which compiles `src/` to `dist/`, and then runs the `cognigy-mcp` bin. So the engine that runs **is this repo's source**.

Two consequences worth knowing:

- **The first cold start is slower than an npm install** — a clone, a dependency install and a TypeScript build, measured at ~22s. npm caches the result per commit, so later starts are fast. Clearing the npm cache or moving to a new machine pays it again.
- **The spec tracks the default branch.** Whatever is on `main` is what runs. To freeze a known-good build, append a tag or commit: `github:pb-crackers/cognigy-plugin#v1.15.1`.

### Why this fork's marketplace is named apart from upstream's

`.claude-plugin/marketplace.json` names this marketplace **`cognigy-plugin-pb`**, not upstream's `cognigy-plugin`. That is load-bearing, not cosmetic.

Claude Code caches a plugin at `<marketplace>/<plugin>/<version>`. While both repos were named `cognigy-plugin` and the fork had merged upstream to the same version number, that path was identical for two different repositories. A stale upstream entry left in the cache was then served under the fork's install:

- right marketplace name
- right version number
- plugin enabled, no error anywhere
- and the **stock engine** running, with none of the fork's behaviour

Nothing in the repo could detect it, because nothing in the repo was wrong. `npm run check:manifest` enforces the name so an upstream merge cannot quietly restore the collision.

If the fork's version number ever needs to diverge further, a suffix (`1.19.0-pb.1`) would add a second layer — at the cost of breaking the version-lockstep design the release tooling assumes.

### Check what is actually installed

```bash
npm run doctor
```

Reports the registered marketplaces, which plugin is enabled, the engine spec in every cached manifest, and whether credentials resolve — and exits non-zero if Claude Code is running anything other than this fork. `npm run plugin:dev:off` runs it automatically, since switching back is when the wrong plugin tends to get left behind.

It flags, among other things:

- upstream's marketplace being registered alongside the fork's (that is how the wrong plugin gets installed)
- a cached manifest under the fork's marketplace pinning the npm engine (the stale-cache failure above)
- the fork registered under upstream's old name

To recover from a poisoned cache:

```bash
claude plugin uninstall cognigy@cognigy-plugin-pb
rm -rf ~/.claude/plugins/cache/cognigy-plugin-pb
claude plugin marketplace remove cognigy-plugin-pb
claude plugin marketplace add pb-crackers/cognigy-plugin
claude plugin install cognigy@cognigy-plugin-pb
```

Then `/reload-plugins` in Claude Code.

### The trap to watch for

If an upstream merge restores the npm pin in any manifest, the plugin silently runs **Cognigy's stock engine** instead of this fork — no error, the error tracing just quietly stops happening. `scripts/check-plugin-manifest.mjs` fails the build if that happens, and it runs in pre-commit and CI. Do not "fix" that failure by relaxing the check.

## Taking updates from upstream

Nothing arrives automatically. Pull when you want to:

**Do not use the GitHub Releases API to decide whether you are behind.** Upstream's
published releases lag their actual version: `releases/latest` reported v1.15.1
while upstream's `main` was already on 1.19.0. Compare the `version` field in
`package.json` on each repo's `main` instead. The upstream-watch routine does this.

```bash
git fetch upstream
git merge upstream/main
# resolve conflicts (see below), then:
npm test && npm run check:manifest && npm run build
git push origin main
```

Anyone using the plugin picks the change up on their next cold start — or immediately with `/reload-plugins` if npx has to refetch.

The `upstream` remote is already configured. If it is ever missing:

```bash
git remote add upstream https://github.com/Cognigy/cognigy-plugin.git
```

### Where conflicts will happen

| File                                                                   | Risk              | Notes                                                                                                                                                                                                |
| ---------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/utils/errorTrace.ts`                                              | None              | Fork-only file. Upstream will never touch it.                                                                                                                                                        |
| `src/tools/handlers.ts`                                                | **High**          | 6,500 lines and upstream's busiest file. The fork adds ~13 small hunks: the wrap-on-create/update hooks, `createErrorGuard`, `createWrappedCodeNode`, and the http-tool pre/post-process call sites. |
| `src/tools/definitions.ts`                                             | Medium            | `errorTrace` / `errorGuard` / `errorHandlerFlowId` in the `manage_flow_nodes` input schema.                                                                                                          |
| `src/tools/nodeRegistry.ts`                                            | Low               | The `executeFlow` entry.                                                                                                                                                                             |
| `src/schemas/tools.ts`                                                 | Low               | The three Zod fields.                                                                                                                                                                                |
| `plugin/*/plugin.json`, `plugin/*/mcp.json`                            | **Every release** | Upstream bumps the version and restores the npm pin. Keep their version, keep the fork's `github:` spec.                                                                                             |
| `scripts/check-plugin-manifest.mjs`, `scripts/sync-plugin-version.mjs` | Medium            | Both hardcode the expected engine spec.                                                                                                                                                              |
| `.releaserc.json`                                                      | Low               | The fork removed `npm publish` from `prepareCmd`.                                                                                                                                                    |
| `plugin/skills/flow-nodes/SKILL.md`                                    | Low               | The error-handling section under `### code`.                                                                                                                                                         |

Deliberately kept small: almost all the logic lives in `errorTrace.ts`, which cannot conflict. The call sites in `handlers.ts` are a few lines each.

### Resolutions from the 1.15.1 → 1.19.0 merge

Seven conflicts, all of them predicted by the table above:

| Conflict                | Resolution                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The four manifests      | Took upstream's `version` (1.19.0), kept the fork's `github:` engine spec.                                                                                    |
| `.releaserc.json`       | Upstream deleted `scripts/build-gemini-extension.mjs`, so the fork's `prepareCmd` referenced a missing file. Took upstream's shape minus `npm publish`.       |
| `src/schemas/tools.ts`  | Upstream reshaped `createToolSchema` (added `flowId`/`parentNodeId` plus refines). Took their structure and re-added `errorGuard` to both tool config blocks. |
| `src/tools/handlers.ts` | One conflict. Upstream added a code-node runtime-API hint that returns early; the fork's wrap + guard must run first. Both kept, fork's block first.          |

Upstream's new hint analyses `data.config.code` — the author's code, not the
wrapped form — so the envelope's own `api.*` calls are not flagged. Keep it that
way if that code moves.

Upstream's new hint test asserted `api.post` was called exactly once, which the
fork's guard node breaks. It now counts posts of `type: "code"` instead. Prefer
that shape over raw call counts: the node chain grows, and positional or
count-based assertions fail for the wrong reason when it does.

### After any merge, check these three things

1. `npm run check:manifest` — the engine spec still points at GitHub, not npm.
2. `npm test` — the `errorTrace` and `errorGuard` suites still pass.
3. A real code node still comes out wrapped. Fastest check:
   ```bash
   npm run plugin:dev     # then /reload-plugins
   ```
   Create a code node and confirm the saved code contains `/* cognigy-plugin:error-trace:v1 */` and that an `Error Guard:` node follows it.

## What the fork changes

See `plugin/skills/flow-nodes/SKILL.md` (the `### code` section) for the full contract. In short:

- Every code node written through `manage_flow_nodes`, and every http-tool pre/post-process node, is wrapped in a try/catch. An uncaught throw in a Code Node otherwise **stops flow execution** — the turn ends with an empty response and nothing is logged, and neither `hasError` (transpile only) nor `input.codeNodeError` (timeouts only) covers it.
- The trace lands in `context.errors`, `context.lastError`, `input.errorTrace` and the project logs, and sets `input.hasError`.
- `flowId` / `nodeId` are baked in as literals because a Code Node has no runtime accessor for them. That is why creating one is a two-pass operation: POST the node, then PATCH the code with the real id.
- An `if {{input.hasError}}` guard follows each code node as a branch point. Its then-branch is empty by design — the catch block already logged, and what the caller experiences belongs to the flow that failed.
- `executeFlow` is registered as a node type; upstream does not expose it.

## Local development

```bash
npm install
npm run plugin:dev      # Claude Code runs this working tree via tsx; /reload-plugins to iterate
npm run doctor          # confirm the INSTALLED plugin is this fork, not upstream
npm run plugin:dev:off  # restore the GitHub-installed plugin
```

Credentials come from `~/.cognigy-plugin/config.json` (`COGNIGY_API_BASE_URL`, `COGNIGY_API_KEY`, mode 0600) when the env vars are unset, so `plugin:dev` does not need the key re-entered each time it reinstalls the plugin.
