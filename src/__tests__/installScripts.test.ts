import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf-8");
const pkg = JSON.parse(read("package.json"));

/**
 * This fork is installed straight from git:
 *
 *   npx -y -p github:pb-crackers/cognigy-plugin cognigy-mcp
 *
 * npm therefore runs `prepare` — and anything it calls — INSIDE an npx
 * install. A nested `npx`/`npm exec` in that position deadlocks: the inner
 * process sits at 0% CPU forever, the build never finishes, the MCP server
 * never starts, and the client sees nothing but a dead connection. No error,
 * no log, and it only reproduces on a cold cache, so it is easy to mistake
 * for the install merely being slow.
 */
describe("install-time scripts must not nest npx", () => {
  /** Scripts reachable from `prepare` during a git install. */
  const INSTALL_TIME_SCRIPTS = ["prepare", "build"];

  it.each(INSTALL_TIME_SCRIPTS)("package.json script %s avoids npx", (name) => {
    const script: string = pkg.scripts[name] ?? "";
    expect(script).not.toMatch(/\bnpx\b/);
    expect(script).not.toMatch(/npm\s+exec\b/);
  });

  it("prepare.mjs does not spawn npx", () => {
    const src = read("scripts/prepare.mjs");
    // Comments explain the hazard, so only look at actual run() calls.
    const calls = src.match(/run\(\s*"[^"]+"/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).not.toContain('"npx"');
    }
  });

  it("prepare builds when dist is missing, which a git install always is", () => {
    const src = read("scripts/prepare.mjs");
    expect(src).toContain("dist");
    expect(src).toContain("build");
  });

  it("the engine bin points at the built output", () => {
    // If prepare fails to build, this path does not exist and the server
    // cannot start — which is why the build must be reliable.
    expect(pkg.bin["cognigy-mcp"]).toBe("dist/index.js");
  });
});
