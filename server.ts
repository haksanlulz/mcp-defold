/**
 * mcp-defold server — drives Defold games through an in-game debug bridge,
 * so an MCP client can build, launch, play, and read a running game.
 * index.ts is the stdio entry point.
 *
 * Register projects in projects.json (copy projects.example.json). Each
 * project ships two things on its side:
 *   - an in-game bridge: newline-delimited JSON over localhost TCP that
 *     answers ping/screen/state/input/start/log/quit (see PROTOCOL.md and
 *     example/bridge.lua)
 *   - a run script that builds with the bridge enabled, launches the engine
 *     detached, and prints "bridge LIVE on <port>" to stdout
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BRIDGE_HOST = "127.0.0.1";

// --- project registry -------------------------------------------------------
// projects.json maps a name to { root, port, runScript, testScript? }.
// Ports must be distinct so two projects can be bridged at once.
export type Project = {
  root: string;
  port: number;
  runScript: string;
  testScript?: string;
};

export function loadProjects(regPath?: string): Record<string, Project> {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = regPath ?? process.env.MCP_DEFOLD_PROJECTS ?? join(here, "projects.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new Error(
      `no project registry at ${path}: copy projects.example.json to projects.json and register your game`,
    );
  }
  let parsed: Record<string, Project>;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`project registry ${path} is not valid JSON: ${e.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    throw new Error(`project registry ${path} is empty`);
  }
  const ports = new Set<number>();
  for (const [name, p] of Object.entries(parsed)) {
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      throw new Error(`project '${name}' must be an object with root, port, and runScript`);
    }
    if (typeof p.root !== "string" || !p.root || typeof p.runScript !== "string" || !p.runScript ||
        !Number.isInteger(p.port) || p.port < 1 || p.port > 65535) {
      throw new Error(`project '${name}' needs root, port, and runScript (port must be 1-65535)`);
    }
    if (p.testScript !== undefined && (typeof p.testScript !== "string" || !p.testScript)) {
      throw new Error(`project '${name}' testScript must be a non-empty string if set`);
    }
    if (ports.has(p.port)) {
      throw new Error(`project '${name}' reuses port ${p.port}; each project needs its own`);
    }
    ports.add(p.port);
  }
  return parsed;
}

// --- bridge TCP ---------------------------------------------------------------

type BridgeReq = Record<string, unknown> & { cmd: string };

export function bridgeCall(req: BridgeReq, port: number, timeoutMs = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: BRIDGE_HOST, port });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`bridge timeout after ${timeoutMs}ms on ${BRIDGE_HOST}:${port} (is the game running? use defold_run)`)));
    }, timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
    sock.on("data", (d) => {
      chunks.push(d);
      if (!d.includes(0x0a)) return; // wait for the newline byte; decode once, chunk-split-safe
      const line = Buffer.concat(chunks).toString("utf-8").split("\n", 1)[0];
      finish(() => {
        try {
          resolve(JSON.parse(line));
        } catch {
          reject(new Error(`bridge sent non-JSON: ${line.slice(0, 200)}`));
        }
      });
    });
    sock.on("close", () => {
      const got = Buffer.concat(chunks).toString("utf-8");
      finish(() => reject(new Error(`bridge closed before completing a reply (got: ${got.slice(0, 200)})`)));
    });
    sock.on("error", (e) => {
      finish(() => reject(new Error(`bridge unreachable on ${BRIDGE_HOST}:${port} (${e.message}). Launch with defold_run.`)));
    });
  });
}

// --- script runner ------------------------------------------------------------

// Kill the whole process tree: on Windows child.kill() stops only the pwsh
// wrapper and orphans whatever it spawned (bob/java, a headless engine).
function killTree(child: ReturnType<typeof spawn>) {
  if (process.platform === "win32" && child.pid) {
    const tk = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    tk.on("error", () => child.kill()); // taskkill missing/failed -> fall back
    tk.unref();
  } else {
    child.kill();
  }
}

// A missing cwd makes spawn fail with the SAME `spawn pwsh ENOENT` as a
// missing pwsh binary. Check the project root on disk first so the two cases
// get distinct, actionable messages instead of one opaque ENOENT.
function ensureRoot(cwd: string) {
  if (!existsSync(cwd)) {
    throw new Error(
      `Defold project root ${cwd} not found: check the path in projects.json`,
    );
  }
}

// Turn a spawn 'error' into something a caller can act on. With the root
// verified by ensureRoot, an ENOENT here means pwsh itself is not on PATH.
export function translateSpawnError(e: NodeJS.ErrnoException): Error {
  if (e.code === "ENOENT") {
    return new Error(
      "PowerShell 7 (pwsh) not found on PATH: install it or check PATH",
    );
  }
  return new Error(`failed to launch pwsh: ${e.message}`);
}

function runPwsh(args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    ensureRoot(cwd);
    const child = spawn("pwsh", ["-NoProfile", ...args], { cwd });
    let out = "";
    const timer = setTimeout(() => {
      killTree(child);
      reject(new Error(`pwsh timed out after ${timeoutMs}ms; partial output:\n${out.slice(-2000)}`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(translateSpawnError(e));
    });
  });
}

// Run a script that launches a LONG-LIVED detached process and reports its
// result on stdout, then exits. Can't wait for "close": the windowed engine
// the script backgrounds inherits the stdout pipe handle on Windows, so the
// pipe never closes. Resolve on the stdout marker instead, and unref the
// child so the still-open pipe can't pin the event loop.
function runPwshUntilMarker(
  args: string[],
  cwd: string,
  opts: { success: RegExp; failure: RegExp; timeoutMs: number },
): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve, reject) => {
    ensureRoot(cwd);
    const child = spawn("pwsh", ["-NoProfile", ...args], { cwd });
    let out = "";
    let settled = false;
    const finish = (result: { ok: boolean; out: string } | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.unref();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      killTree(child); // timeout means a wedged build, not a launched game
      finish(new Error(`script timed out after ${opts.timeoutMs}ms; partial output:\n${out.slice(-2000)}`));
    }, opts.timeoutMs);
    const scan = (d: Buffer) => {
      out += d.toString();
      if (opts.success.test(out)) finish({ ok: true, out });
      else if (opts.failure.test(out)) finish({ ok: false, out });
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
    child.on("exit", () => setTimeout(() => finish({ ok: opts.success.test(out), out }), 50));
    child.on("error", (e) => finish(translateSpawnError(e)));
  });
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

// --- server ---------------------------------------------------------------------

export function createServer(projects: Record<string, Project> = loadProjects()) {
  const DEFAULT_PROJECT = process.env.MCP_DEFOLD_DEFAULT ?? Object.keys(projects)[0];

  function resolveProject(args: Record<string, unknown>): Project {
    const name = (args.project as string) || DEFAULT_PROJECT;
    const p = projects[name];
    if (!p) {
      throw new Error(
        `unknown project '${name}'. Registered: ${Object.keys(projects).join(", ")}`,
      );
    }
    return p;
  }

  const server = new Server(
    { name: "mcp-defold", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  const PROJECT_PROP = {
    project: {
      type: "string",
      description: `Registered project to target (default '${DEFAULT_PROJECT}').`,
    },
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "defold_run",
        description:
          "Build the target project with the debug bridge enabled and launch it (windowed, detached). Returns when the bridge answers (~30-90s with a build). Pass skip_build=true to relaunch the last build fast. If a bridged game is already running, stop it first with defold_stop.",
        inputSchema: {
          type: "object",
          properties: {
            ...PROJECT_PROP,
            skip_build: { type: "boolean", description: "Skip the build; launch the existing build output (default false)" },
          },
        },
      },
      {
        name: "defold_stop",
        description: "Quit the running bridged game cleanly (sends the bridge quit command).",
        inputSchema: { type: "object", properties: { ...PROJECT_PROP } },
      },
      {
        name: "defold_start",
        description:
          "Begin a run, skipping the game's front-end (title menu / character creation) via the bridge `start` command, which GUI input can't reach. `options` is passed through to the game's bridge; what it accepts is per-game (a new-game seed, a character build, a scenario id).",
        inputSchema: {
          type: "object",
          properties: {
            ...PROJECT_PROP,
            options: { type: "object", description: "Game-defined start options, merged into the bridge start request" },
          },
        },
      },
      {
        name: "defold_input",
        description:
          "Press one or more input triggers in the running game, in order, then return the screen. Trigger ids are the game's action ids from its input bindings (e.g. key_w, key_e, key_space). NOTE: bridge input drives the in-game controller, not the GUI front-end; use defold_start to get past menus first.",
        inputSchema: {
          type: "object",
          properties: {
            ...PROJECT_PROP,
            triggers: {
              type: "array",
              items: { type: "string" },
              description: 'Trigger ids pressed in order, e.g. ["key_w","key_w","key_e"]',
            },
          },
          required: ["triggers"],
        },
      },
      {
        name: "defold_screen",
        description:
          "The running game's current screen as a composed text frame: whatever view the game's bridge composes (an ASCII map + HUD for a glyph game, a score readout for an arcade game).",
        inputSchema: { type: "object", properties: { ...PROJECT_PROP } },
      },
      {
        name: "defold_state",
        description: "Compact state of the running game as JSON. Fields are game-defined (position, health, score, flags, whatever the bridge reports).",
        inputSchema: { type: "object", properties: { ...PROJECT_PROP } },
      },
      {
        name: "defold_log",
        description: "Tail of the running game's mirrored debug log.",
        inputSchema: {
          type: "object",
          properties: {
            ...PROJECT_PROP,
            tail: { type: "number", description: "Lines from the end (default 40)" },
          },
        },
      },
      {
        name: "defold_bridge",
        description:
          "Raw bridge command passthrough for anything the named tools don't cover. cmd = the bridge command string; args = an object merged into the request. Returns the frame (if any) or the JSON response.",
        inputSchema: {
          type: "object",
          properties: {
            ...PROJECT_PROP,
            cmd: { type: "string", description: "Bridge command (e.g. 'ping', 'screen', 'advance')" },
            args: { type: "object", description: "Extra fields merged into the request" },
          },
          required: ["cmd"],
        },
      },
      {
        name: "defold_test",
        description: "Run the project's headless test suite (if a testScript is registered). Returns the tail of the output. Can take minutes.",
        inputSchema: { type: "object", properties: { ...PROJECT_PROP } },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const p = resolveProject(args);
    switch (name) {
      case "defold_run": {
        // Preflight: if a bridged game already answers on this port, refuse.
        // Launching a second instance would leave us silently driving the
        // stale one (the new engine can't bind the port the old one holds).
        let alreadyLive = false;
        try {
          await bridgeCall({ cmd: "ping" }, p.port, 2000);
          alreadyLive = true;
        } catch {
          // nothing answered (connection refused / timeout): safe to launch
        }
        if (alreadyLive) {
          throw new Error(
            `a bridged game is already running on port ${p.port}; stop it with defold_stop first`,
          );
        }
        const a = [p.runScript];
        if (args.skip_build) a.push("-SkipBuild");
        const r = await runPwshUntilMarker(a, p.root, {
          success: /bridge LIVE on /,
          failure: /^FAIL:/m,
          timeoutMs: 180_000,
        });
        if (!r.ok) throw new Error(`run failed:\n${r.out.slice(-2000)}`);
        return text(r.out.trim());
      }
      case "defold_stop": {
        const r = await bridgeCall({ cmd: "quit" }, p.port);
        return text(JSON.stringify(r));
      }
      case "defold_start": {
        const extra = (args.options && typeof args.options === "object") ? (args.options as Record<string, unknown>) : {};
        const r = await bridgeCall({ ...extra, cmd: "start" }, p.port);
        return text(JSON.stringify(r));
      }
      case "defold_input": {
        const triggers = Array.isArray(args.triggers) ? args.triggers : [];
        if (triggers.length === 0) throw new Error("triggers must be a non-empty array");
        const applied: string[] = [];
        for (const t of triggers) {
          const r = await bridgeCall({ cmd: "input", trigger: String(t) }, p.port);
          if (r?.error || r?.ok === false) {
            throw new Error(
              `input '${t}' failed (${r.error ?? "ok=false"})` +
              (applied.length ? `; already applied: ${applied.join(", ")}` : ""),
            );
          }
          applied.push(String(t));
        }
        const screen = await bridgeCall({ cmd: "screen" }, p.port);
        return text(screen.frame ?? JSON.stringify(screen));
      }
      case "defold_screen": {
        const r = await bridgeCall({ cmd: "screen" }, p.port);
        return text(r.frame ?? JSON.stringify(r));
      }
      case "defold_state": {
        const r = await bridgeCall({ cmd: "state" }, p.port);
        return text(JSON.stringify(r, null, 2));
      }
      case "defold_log": {
        const tail = Number.isFinite(Number(args.tail)) && Number(args.tail) > 0 ? Math.trunc(Number(args.tail)) : 40;
        const r = await bridgeCall({ cmd: "log", tail }, p.port);
        return text(Array.isArray(r.lines) ? r.lines.join("\n") : JSON.stringify(r));
      }
      case "defold_bridge": {
        const cmd = String(args.cmd || "");
        if (!cmd) throw new Error("defold_bridge needs a 'cmd' string");
        const extra = (args.args && typeof args.args === "object") ? args.args as Record<string, unknown> : {};
        const r = await bridgeCall({ ...extra, cmd }, p.port);
        return text(typeof r?.frame === "string" ? r.frame : JSON.stringify(r, null, 2));
      }
      case "defold_test": {
        if (!p.testScript) throw new Error(`project has no testScript configured`);
        const r = await runPwsh([p.testScript], p.root, 360_000);
        const tail = r.out.split(/\r?\n/).filter((l) => l.trim()).slice(-12).join("\n");
        return text(`exit ${r.code}\n${tail}`);
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  return server;
}
