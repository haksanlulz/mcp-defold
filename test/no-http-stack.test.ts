import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * This server speaks MCP over stdio and never starts a web server. That is not a
 * style preference -- it is the reason a whole class of Dependabot alerts against
 * this repo is not exploitable here.
 *
 * @modelcontextprotocol/sdk depends on hono, @hono/node-server and express to
 * support its HTTP transports. Those ship in the dependency tree, so advisories
 * against them are reported against this repo -- hono alone drew 3-9 per month
 * through 2026. None reach this server, because nothing here imports a transport
 * that uses them.
 *
 * ⚠️ WHAT THIS TEST DOES AND DOES NOT PROVE.
 *
 * It asserts a property of OUR source: we import the stdio transport and nothing
 * else. That is the thing under our control and the thing that would change if
 * someone added an HTTP surface, so it is the thing worth pinning.
 *
 * It does NOT prove the SDK never loads hono internally. An earlier version of
 * this test tried to prove exactly that by hooking Module._resolveFilename, and
 * it was a FALSE GREEN: that hook is the CommonJS resolver, these are ESM
 * modules, and a planted `await import("hono")` sailed straight through it. The
 * lesson is kept here because the failure mode -- a guard that cannot go red --
 * is worse than no guard.
 *
 * ⚠️ If this fails, do NOT relax it. It means an HTTP transport entered the
 * executed path and every hono/express advisory against this repo just became
 * live.
 */
const TRANSPORT_IMPORT = /@modelcontextprotocol\/sdk\/server\/(\w+)\.js/g;
const ALLOWED_TRANSPORTS = new Set(["stdio", "index"]);

describe("dependency surface", () => {
  it("imports only the stdio transport, never an HTTP one", () => {
    const offenders: string[] = [];
    for (const f of ["index.ts", "server.ts"]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      for (const m of src.matchAll(TRANSPORT_IMPORT)) {
        if (!ALLOWED_TRANSPORTS.has(m[1])) offenders.push(`${f}: ${m[0]}`);
      }
      // The HTTP transports are also reachable by these names.
      for (const bad of ["streamableHttp", "sse", "express", "hono"]) {
        if (new RegExp(`from ["'][^"']*${bad}`, "i").test(src)) {
          offenders.push(`${f}: imports ${bad}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares exactly one runtime dependency", () => {
    // The tarball ships dist/ plus whatever `dependencies` resolves to, so
    // keeping that list at one entry is what bounds the shipped surface. A
    // second runtime dep should be a deliberate decision, not a surprise.
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["@modelcontextprotocol/sdk"]);
  });
});
