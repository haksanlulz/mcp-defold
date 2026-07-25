#!/usr/bin/env -S npx tsx
/**
 * Smoke test for mcp-defold — fully offline. No Defold install, no running
 * game, no network. Safe to run on a fresh clone.
 *
 * Phase 1 drives the server the way a real MCP client does: spawn index.ts as
 * a child process and speak newline-delimited JSON-RPC over its stdio. The
 * vitest suite exercises the handlers in-process; only this catches a missing
 * tsx, an import that breaks under the real entry point, or a server that dies
 * before the handshake. It runs against a throwaway registry written to the
 * temp dir, so it needs no projects.json of your own and never touches one.
 *
 * The two error paths a real session hits get explicit coverage: an unknown
 * project name, and a bridge tool called with no game running — which must
 * fail fast naming the port and the fix, never hang, never fabricate a frame.
 *
 * Phase 2 checks your real projects.json if you have one: it loads and
 * validates, and for every project whose root is on disk, the run script emits
 * the literals the server scans stdout for ("bridge LIVE on ", line-start
 * "FAIL:"). That is a contract across two repos — if a run script stops
 * printing the marker, defold_run hangs for its full 180 s timeout and then
 * reports something misleading.
 *
 * Phase 3 checks the docs against the server: the README tool table lists
 * exactly the served tools, and package.json's version matches the one the
 * server declares.
 *
 * Driving a live game (run -> start -> input -> screen) cannot be covered
 * here and this file does not pretend to: that stays a manual check.
 *
 * Run: npm run smoke.  Exit 0 = all passed, 1 = any failed.
 * SMOKE_SERVER_PATH overrides the entry point served in phase 1 — a copy must
 * live in this directory so its SDK imports still resolve.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjects } from "./server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = process.env.SMOKE_SERVER_PATH?.trim() || join(HERE, "index.ts");
const TSX_CLI = join(HERE, "node_modules", "tsx", "dist", "cli.mjs");
const TIMEOUT_MS = 30_000;

const EXPECTED_TOOLS = [
  "defold_run", "defold_stop", "defold_start", "defold_input", "defold_screen",
  "defold_state", "defold_log", "defold_bridge", "defold_test",
];

// A registry pointing at a project that does not exist, on ports nothing is
// expected to hold. Both facts are deliberate: the tools under test here are
// the ones that must fail cleanly.
const FIXTURE_PROJECT = "smoke_fixture";
const FIXTURE_PORT = 45771;
const FIXTURE_ROOT = join(tmpdir(), "mcp-defold-smoke-no-such-project");

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}
function skip(label: string, why: string): void {
  console.log(`SKIP  ${label} — ${why}`);
}

/* ------------------------------------------------- stdio JSON-RPC harness */

class StdioSession {
  child: ChildProcess;
  private pending = new Map<number, (msg: any) => void>();
  private nextId = 1;
  stderr = "";

  constructor(serverPath: string, env: Record<string, string> = {}) {
    // Spawn through the bundled tsx cli, the way an MCP client config does. A
    // missing cli.mjs (npm install never ran) is itself a real-channel failure.
    this.child = spawn("node", [TSX_CLI, serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    this.child.stderr!.on("data", (d) => { this.stderr += String(d); });
    let buf = "";
    this.child.stdout!.on("data", (d) => {
      buf += String(d);
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && this.pending.has(msg.id)) {
            this.pending.get(msg.id)!(msg);
            this.pending.delete(msg.id);
          }
        } catch { /* non-JSON stdout line — ignore */ }
      }
    });
  }

  rpc(method: string, params: unknown = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), TIMEOUT_MS);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result);
      });
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  kill(): void { this.child.kill(); }
}

/** A tool call that must fail, carrying every needle in its message. */
async function callExpectError(
  session: StdioSession,
  name: string,
  args: Record<string, unknown>,
  needles: string[],
): Promise<{ ok: boolean; detail: string }> {
  try {
    const result = await session.rpc("tools/call", { name, arguments: args });
    const txt = JSON.stringify(result);
    if (result?.isError) return { ok: needles.every((n) => txt.includes(n)), detail: txt.slice(0, 220) };
    return { ok: false, detail: `unexpected success: ${txt.slice(0, 220)}` };
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    return { ok: needles.every((n) => msg.includes(n)), detail: msg.slice(0, 220) };
  }
}

/* ------------------------------------------- phase 1: stdio (real channel) */

check("tsx cli.mjs present (npm install ran)", existsSync(TSX_CLI), TSX_CLI);

const fixtureDir = mkdtempSync(join(tmpdir(), "mcp-defold-smoke-"));
const fixturePath = join(fixtureDir, "projects.json");
writeFileSync(
  fixturePath,
  JSON.stringify({
    [FIXTURE_PROJECT]: {
      root: FIXTURE_ROOT,
      port: FIXTURE_PORT,
      runScript: "tools/run-bridged.ps1",
    },
  }),
);

let serverVersion = "";
const session = new StdioSession(SERVER_PATH, { MCP_DEFOLD_PROJECTS: fixturePath });
try {
  const init = await session.rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-defold-smoke", version: "1.0.0" },
  });
  serverVersion = String(init?.serverInfo?.version ?? "");
  check("stdio: initialize handshake", init?.serverInfo?.name === "mcp-defold",
    `serverInfo.name=${init?.serverInfo?.name} version=${serverVersion}`);
  session.notify("notifications/initialized");

  const list = await session.rpc("tools/list");
  const tools: any[] = list?.tools ?? [];
  const names: string[] = tools.map((t) => t.name);
  check(`stdio: tools/list is exactly the ${EXPECTED_TOOLS.length} tools`,
    names.length === EXPECTED_TOOLS.length && EXPECTED_TOOLS.every((n) => names.includes(n)),
    names.join(", "));
  check("stdio: every tool declares an object inputSchema",
    tools.every((t) => t.inputSchema?.type === "object"));
  check("stdio: every tool schema carries the optional `project` prop",
    tools.every((t) => t.inputSchema?.properties?.project),
    tools.filter((t) => !t.inputSchema?.properties?.project).map((t) => t.name).join(", "));

  const unknown = await callExpectError(session, "defold_screen",
    { project: "__no_such_project__" }, ["unknown project", FIXTURE_PROJECT]);
  check("stdio: an unknown project errors and lists the registry", unknown.ok, unknown.detail);

  // No game on the fixture port: must fail fast, naming the port and the fix.
  const t0 = Date.now();
  const dead = await callExpectError(session, "defold_screen", {},
    ["bridge unreachable", String(FIXTURE_PORT), "defold_run"]);
  check("stdio: a dead bridge fails fast, naming port + fix",
    dead.ok && Date.now() - t0 < 10_000, `${Date.now() - t0}ms — ${dead.detail}`);

  // A root that isn't on disk must say so, rather than surfacing as the same
  // opaque ENOENT that a missing pwsh produces.
  const noRoot = await callExpectError(session, "defold_run", {},
    ["not found", "projects.json"]);
  check("stdio: a missing project root names the path and projects.json",
    noRoot.ok, noRoot.detail);
} catch (e) {
  check(`stdio harness error: ${(e as Error).message}`, false, session.stderr.slice(-400));
} finally {
  session.kill();
}

/* ------------------------------- phase 2: your registry + marker contract */

const realRegistry = process.env.MCP_DEFOLD_PROJECTS ?? join(HERE, "projects.json");
if (!existsSync(realRegistry)) {
  skip("registry: projects.json loads and validates",
    `no registry at ${realRegistry} (fresh clone — copy projects.example.json)`);
} else {
  let projects: Record<string, { root: string; port: number; runScript: string }> = {};
  try {
    projects = loadProjects(realRegistry);
    check("registry: projects.json loads and validates",
      Object.keys(projects).length > 0, Object.keys(projects).join(", "));
  } catch (e) {
    check("registry: projects.json loads and validates", false, String((e as Error).message));
  }

  // Side 1: the server still scans for the two literals.
  const src = readFileSync(SERVER_PATH === join(HERE, "index.ts") ? join(HERE, "server.ts") : SERVER_PATH, "utf8");
  check("marker: the server expects 'bridge LIVE on ' + line-start 'FAIL:'",
    src.includes("bridge LIVE on ") && src.includes("^FAIL:"));

  // Side 2: every registered run script that is on disk emits them.
  for (const [name, p] of Object.entries(projects)) {
    const script = join(p.root, p.runScript);
    const label = `marker: ${name} -> ${p.runScript}`;
    if (!existsSync(p.root)) {
      skip(label, `project root not on this machine (${p.root})`);
      continue;
    }
    if (!existsSync(script)) {
      check(`${label} exists`, false, script);
      continue;
    }
    const runScript = readFileSync(script, "utf8");
    check(`${label} emits both marker literals`,
      runScript.includes("bridge LIVE on ") && /FAIL: /.test(runScript),
      `LIVE=${runScript.includes("bridge LIVE on ")} FAIL=${/FAIL: /.test(runScript)}`);
  }
}

/* ------------------------------------------------- phase 3: doc sync */

const readme = readFileSync(join(HERE, "README.md"), "utf8");
const documented = [...readme.matchAll(/\|\s*`(defold_\w+)`\s*\|/g)].map((m) => m[1]);
check(`docs: README tool table == the ${EXPECTED_TOOLS.length} served tools`,
  documented.length === EXPECTED_TOOLS.length && EXPECTED_TOOLS.every((n) => documented.includes(n)),
  `README lists ${documented.length}: ${documented.join(", ") || "(none)"}`);

const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
check("docs: package.json version == the version the server declares",
  Boolean(serverVersion) && pkg.version === serverVersion,
  `package.json=${pkg.version} server=${serverVersion}`);

console.log(failures.length ? `\n${failures.length} check(s) FAILED: ${failures.join(", ")}` : "\nAll checks passed.");
process.exit(failures.length ? 1 : 0);
