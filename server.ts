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

// One in-flight call per port. The documented bridge accepts at most one
// client per frame behind listen(1), while MCP clients issue tool calls in
// parallel: two concurrent calls survive on the backlog, a third is refused
// and surfaces as "bridge unreachable ... Launch with defold_run", an error
// naming exactly the wrong fix.
//
// What this does NOT buy is atomicity per TOOL. The mutex is per CALL, and
// defold_input makes one call per trigger plus one for the screen, so a
// defold_screen issued alongside it can still land between two presses. That
// is not fixable by holding the mutex across a tool: the tool's own bridgeCalls
// would queue behind their own holder and deadlock.
const inFlight = new Map<number, Promise<void>>();

// A call that spent its whole budget waiting for the slot and never dialed.
// Its own type, not merely its own wording: a caller that has to tell "the
// port is empty" from "the port is busy" should not be matching message text.
export class BridgeQueueTimeout extends Error {}

// The dial COMPLETED and something accepted it, then went quiet -- a wedged
// engine still holding the socket. Its own type for the same reason as the one
// above: whether the port is occupied is a control-flow question, not a
// string-matching one.
export class BridgeSocketTimeout extends Error {}

export function bridgeCall(req: BridgeReq, port: number, timeoutMs = 8000): Promise<any> {
  const queuedAt = Date.now();
  const prev = inFlight.get(port) ?? Promise.resolve();

  // The next caller waits for MY socket work to finish, not merely for my
  // promise to settle -- a call that gave up on the queue must not leave the
  // one behind it free to dial while this one is still tearing down.
  let release!: () => void;
  const tail = prev.then(() => new Promise<void>((r) => (release = r)));
  inFlight.set(port, tail);
  void tail.then(() => {
    if (inFlight.get(port) === tail) inFlight.delete(port); // don't grow per port
  });

  return new Promise((resolve, reject) => {
    // The deadline starts HERE, not at connect, and fires while still queued:
    // a caller told 8000ms must not wait 8000ms behind a wedged call and only
    // then begin its own 8000ms. It gets the answer at the time it asked for.
    let expired = false;
    const deadline = setTimeout(() => {
      expired = true;
      reject(new BridgeQueueTimeout(
        `bridge timeout after ${timeoutMs}ms on ${BRIDGE_HOST}:${port} (still queued behind an earlier call)`,
      ));
    }, timeoutMs);
    const run = () => {
      if (expired) return release(); // caller is gone; never dial on its behalf
      // The wait is over, so this deadline has done its job -- clear it before
      // dialing. It and the socket timer expire at the same instant and this
      // one was armed first, so leaving it armed hands "still queued behind an
      // earlier call" to a call that never queued: the ordinary case, and the
      // wrong cause. The socket gets what is LEFT of the budget but reports
      // the budget the caller asked for, which is the only number a caller can
      // recognise.
      clearTimeout(deadline);
      const left = Math.max(timeoutMs - (Date.now() - queuedAt), 1);
      bridgeSocketCall(req, port, left, timeoutMs).then(
        (v) => { release(); resolve(v); },
        (e) => { release(); reject(e); },
      );
    };
    void prev.then(run, run);
  });
}

// `timeoutMs` is what is left of the caller's budget; `budgetMs` is what the
// caller asked for. They differ once a call has waited in the queue, and the
// message quotes the budget: a caller who set 1000ms cannot match a timeout
// reported as 890ms against anything it knows.
function bridgeSocketCall(req: BridgeReq, port: number, timeoutMs: number, budgetMs = timeoutMs): Promise<any> {
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
      finish(() => reject(new BridgeSocketTimeout(`bridge timeout after ${budgetMs}ms on ${BRIDGE_HOST}:${port} (is the game running? use defold_run)`)));
    }, timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
    sock.on("data", (d) => {
      // A socket emits Buffers unless setEncoding() was called, which this one
      // never does -- so `d` is a Buffer at runtime. @types/node 26 types the
      // union honestly rather than assuming, so narrow instead of asserting:
      // a cast would be a lie the day someone adds an encoding.
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(d, "utf-8");
      chunks.push(buf);
      if (!buf.includes(0x0a)) return; // wait for the newline byte; decode once, chunk-split-safe
      const line = Buffer.concat(chunks).toString("utf-8").split("\n", 1)[0];
      finish(() => {
        let reply: unknown;
        try {
          reply = JSON.parse(line);
        } catch {
          reject(new Error(`bridge sent non-JSON: ${line.slice(0, 200)}`));
          return;
        }
        // A reply is one JSON OBJECT per line (PROTOCOL.md). `null`, a number,
        // a string and an array all parse, and every consumer indexes what it
        // gets -- r.frame, r.lines -- so a bridge answering `null` handed the
        // caller Node's "Cannot read properties of null (reading 'frame')",
        // blaming nothing. Checked here rather than at the four call sites,
        // where only defold_bridge's `r?.frame` ever guarded it.
        if (reply === null || typeof reply !== "object" || Array.isArray(reply)) {
          reject(new Error(`bridge sent a non-object reply: ${line.slice(0, 200)}`));
          return;
        }
        resolve(reply);
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

// The outcome of a marker scan. `code` is null while the process is still
// running (a marker decided it) and the exit code when nothing matched.
type MarkerRun = { ok: boolean; out: string; code: number | null };

export type MarkerVerdict = "ok" | "fail" | "none";

// The whole decision runPwshUntilMarker makes, as a pure function of the
// output so far. Success outranks failure: a script that printed FAIL for one
// step and then got the bridge up has launched the game. "none" means neither
// marker has appeared yet -- and at exit, that the script died saying neither.
export function markerVerdict(out: string, success: RegExp, failure: RegExp): MarkerVerdict {
  if (success.test(out)) return "ok";
  if (failure.test(out)) return "fail";
  return "none";
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
): Promise<MarkerRun> {
  return new Promise((resolve, reject) => {
    ensureRoot(cwd);
    const child = spawn("pwsh", ["-NoProfile", ...args], { cwd });
    let out = "";
    let settled = false;
    const finish = (result: MarkerRun | Error) => {
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
    const verdict = () => markerVerdict(out, opts.success, opts.failure);
    const scan = (d: Buffer) => {
      out += d.toString();
      // Still running, so there is no exit code to report yet.
      const v = verdict();
      if (v !== "none") finish({ ok: v === "ok", out, code: null });
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
    // Exited without either marker. bob and java exit codes say what went
    // wrong on a build failure, so carry the code out rather than dropping it.
    child.on("exit", (code) =>
      setTimeout(() => finish({ ok: verdict() === "ok", out, code: code ?? -1 }), 50));
    child.on("error", (e) => finish(translateSpawnError(e)));
  });
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

// A `frame` that is not a string is not a frame. `r.frame ?? JSON.stringify(r)`
// fell back only on null and undefined, so a bridge answering {"frame": 42}
// put a number into the result's `text` -- and the CLIENT's schema check then
// rejected the whole call with "Invalid tools/call result", an error naming
// neither the bridge, nor the field, nor the game. Falling back to the JSON is
// what the caller can actually read. One helper for all three frame-reading
// tools, so defold_screen and defold_bridge cannot drift apart on it again.
function frameOrJson(r: any): string {
  return typeof r?.frame === "string" ? r.frame : JSON.stringify(r, null, 2);
}

// Shared by defold_log and defold_test: a caller-supplied line count, or the
// tool's own default when nothing was passed.
//
// Coercing was the same defect as coercing a trigger or a cmd, one argument
// over: Number(true) is 1, Number([5]) is 5 and Number(" 7 ") is 7, so a
// wrong-shaped argument silently chose a window instead of erroring -- and a
// one-line window on defold_test is the harm its `tail` exists to prevent,
// the failing assertion scrolled out of the tail. A number that is merely
// useless (0, -1, NaN) still falls back; a wrong TYPE does not.
function tailLines(v: unknown, fallback: number): number {
  if (typeof v !== "number") {
    if (v === undefined || v === null) return fallback;
    throw new Error(`tail must be a number, got ${Array.isArray(v) ? "an array" : typeof v}`);
  }
  return Number.isFinite(v) && v > 0 ? Math.trunc(v) : fallback;
}

// --- argument validation -------------------------------------------------------
// The low-level Server hands a handler whatever the client sent; it does not
// check it against the declared inputSchema. These are that check. None of it
// is reachable from a well-behaved client, which is exactly why the failure
// would otherwise be blamed on the game.

// A field that is merged into a bridge request. `typeof [] === "object"`, and
// spreading an array turns it into {"0": ...}, so exclude arrays explicitly.
function objectArg(v: unknown, label: string): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`${label} must be an object, got ${Array.isArray(v) ? "an array" : typeof v}`);
  }
  return v as Record<string, unknown>;
}

// The bridge command goes to the game verbatim, exactly as trigger ids do, and
// this tool has the widest input surface of the nine. Coercing it sent the
// command '[object Object]' (or '7') and the game's "unknown command" came
// back blaming the bridge for a mistake the client made.
function commandArg(v: unknown): string {
  if (typeof v !== "string" || !v) {
    const got = Array.isArray(v) ? "an array" : v === "" ? "an empty string" : typeof v;
    throw new Error(`defold_bridge needs a 'cmd' string, got ${got}`);
  }
  return v;
}

// A flag that changes WHAT gets launched, so reading it for truthiness is not
// a cosmetic laxity: the string "false" is truthy, and a skip_build read that
// way relaunches the last build, leaving an agent to drive a game that does
// not contain the change it just made -- with nothing in the output saying so.
function boolArg(v: unknown, label: string): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") {
    throw new Error(`${label} must be true or false, got ${Array.isArray(v) ? "an array" : typeof v}`);
  }
  return v;
}

// The argument that decides WHICH game gets driven, and the last one left
// unchecked. `(args.project as string) || DEFAULT` is not a coercion but it is
// not a check either: every falsy non-string -- 0, false, "" -- fell through to
// the default project, so a client that named a game wrong drove a different
// one with nothing in the output saying so. A wrong TYPE is an error; absent
// is still the default.
//
// The empty string is a NAMED project, not an absent one: a caller that built
// the name from a variable and got "" asked for a game, and answering it with
// the default is the same silent substitution by another route. Its two
// sibling validators, commandArg and triggerList, both reject it; this one now
// matches them.
function projectArg(v: unknown, fallback: string): string {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "string") {
    throw new Error(`project must be a string, got ${Array.isArray(v) ? "an array" : typeof v}`);
  }
  if (!v) {
    throw new Error("project must be a non-empty string");
  }
  return v;
}

// Trigger ids go to the game verbatim. Coercing them meant a client mistake
// arrived as the trigger '[object Object]' and came back as a bridge error.
function triggerList(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error("triggers must be a non-empty array of trigger id strings");
  }
  v.forEach((t, i) => {
    if (typeof t !== "string" || !t) {
      throw new Error(`triggers[${i}] must be a non-empty string, got ${typeof t}`);
    }
  });
  return v as string[];
}

// --- server ---------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Unknown-argument guard. The low-level SDK Server hands the arguments object
// to the handler without validating it against inputSchema, so every schema's
// additionalProperties:false is advisory: a caller who typed `found_afer` got
// a full-history answer they believed was date-limited, and nothing said so.
// Same helper, same wording, in every one of the operator's TypeScript servers.

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

/** The closest accepted argument name, if it is close enough to be a typo. */
function nearestArg(key: string, accepted: string[]): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of accepted) {
    const d = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  // Scale with the length of what was typed: one edit is a typo in a short name,
  // three is still a typo in a long one, and neither makes "bogus_param" a
  // misspelling of "limit".
  return bestDistance <= Math.max(1, Math.floor(key.length / 3)) ? best : null;
}

/** Reject arguments the tool does not declare, naming the likely intended one. */
function validateArgs(toolName: string, accepted: string[], args: Record<string, unknown>): void {
  const unknown = Object.keys(args).filter((k) => !accepted.includes(k));
  if (unknown.length === 0) return;
  const described = unknown.map((k) => {
    const near = nearestArg(k, accepted);
    return near ? `"${k}" (did you mean "${near}"?)` : `"${k}"`;
  });
  throw new Error(
    `${toolName} does not accept ${described.join(", ")}. ` +
      `Accepted arguments: ${accepted.join(", ")}. Nothing was queried.`,
  );
}

/** Declared argument names of a tool, from the same list ListTools serves. */
function acceptedArgsOf(tools: ReadonlyArray<{ name: string; inputSchema?: unknown }>, name: string): string[] | null {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return null;
  const props = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return Object.keys(props ?? {});
}

export function createServer(projects?: Record<string, Project>) {
  // A registry that will not load is the likeliest first-run failure, and the
  // error text already says how to fix it. Loading it eagerly sent that text
  // to the stderr of a process that died before `initialize`, so an MCP client
  // showed "server disconnected" and the fix lived in a log file. Hold the
  // error instead and raise it from the first tool call, where a client
  // renders it. Nothing half-built reaches a handler: loadProjects either
  // returns a whole registry or throws, so this stays empty on failure.
  let registry: Record<string, Project> = {};
  let registryError: Error | null = null;
  if (projects === undefined) {
    try {
      registry = loadProjects();
    } catch (e) {
      registryError = e instanceof Error ? e : new Error(String(e));
    }
  } else {
    registry = projects;
  }

  const DEFAULT_PROJECT = process.env.MCP_DEFOLD_DEFAULT ?? Object.keys(registry)[0] ?? "";

  function resolveProject(args: Record<string, unknown>): Project {
    // Re-raised on EVERY call: a registry that never loaded is not transient,
    // and a caller who fixes it restarts the server anyway.
    if (registryError) throw registryError;
    const name = projectArg(args.project, DEFAULT_PROJECT);
    // Object.prototype keys ('toString', 'constructor', 'hasOwnProperty',
    // '__proto__') are truthy on any plain object, and a registry is one --
    // JSON.parse'd, or a caller's literal. A bare index handed back an
    // inherited function, the guard below never fired, and the caller got
    // Node's 'The "options" or "port" or "path" argument must be specified'
    // out of net.createConnection instead of the message it is here to give.
    const p = Object.prototype.hasOwnProperty.call(registry, name) ? registry[name] : undefined;
    if (!p) {
      throw new Error(
        `unknown project '${name}'. Registered: ${Object.keys(registry).join(", ")}`,
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
      description: DEFAULT_PROJECT
        ? `Registered project to target (default '${DEFAULT_PROJECT}').`
        : "Registered project to target.",
    },
  };

  const TOOLS = [
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
        description:
          "Run the project's headless test suite (if a testScript is registered). Returns the tail of the output when the suite passes; a non-zero exit is a tool ERROR carrying the exit code and the same tail. Widen `tail` when the failing assertion is further up than the default window. Can take minutes.",
        inputSchema: {
          type: "object",
          properties: {
            ...PROJECT_PROP,
            tail: { type: "number", description: "Lines from the end of the output (default 12)" },
          },
        },
      },
  ];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const accepted = acceptedArgsOf(TOOLS, name);
    if (accepted) validateArgs(name, accepted, args as Record<string, unknown>);
    const p = resolveProject(args);
    switch (name) {
      case "defold_run": {
        // Before the preflight: a call that cannot run should not dial a port.
        const skipBuild = boolArg(args.skip_build, "skip_build");
        // Preflight: if a bridged game already answers on this port, refuse.
        // Launching a second instance would leave us silently driving the
        // stale one (the new engine can't bind the port the old one holds).
        let alreadyLive = false;
        try {
          await bridgeCall({ cmd: "ping" }, p.port, 2000);
          alreadyLive = true;
        } catch (e) {
          // A ping that never left the queue is not evidence of an empty port.
          // It means another bridge call is holding the slot, and a call only
          // holds the slot by having connected -- something is answering there.
          // Reading that as "safe to launch" put a second engine on top of a
          // running game, which is the one thing this preflight exists to stop.
          //
          // A socket timeout is the same evidence one step further along: the
          // dial COMPLETED, something on this port accepted it and then said
          // nothing -- a wedged engine still holding the socket. A port a
          // process is holding is not a port a second engine can bind, so this
          // has to refuse the launch rather than invite one that ends up
          // driving the old instance.
          //
          // Three completed-dial outcomes are still read as an empty port:
          // non-JSON, a reply that is not an object, and a hang-up before a
          // reply. Each of those also proves something accepted the connection,
          // so the honest reading is "occupied" -- but the four tests that
          // simulate "no game yet" do it by destroying the first socket on
          // accept, so folding them in is a fixture change rather than a guard
          // change and belongs in its own pass. Recorded here so it reads as a
          // decision rather than an oversight.
          if (e instanceof BridgeQueueTimeout || e instanceof BridgeSocketTimeout) alreadyLive = true;
        }
        if (alreadyLive) {
          throw new Error(
            `a bridged game is already running on port ${p.port}; stop it with defold_stop first`,
          );
        }
        const a = [p.runScript];
        if (skipBuild) a.push("-SkipBuild");
        const r = await runPwshUntilMarker(a, p.root, {
          success: /bridge LIVE on /,
          failure: /^FAIL:/m,
          timeoutMs: 180_000,
        });
        if (!r.ok) {
          throw new Error(
            `run failed${r.code === null ? "" : ` (exit ${r.code})`}:\n${r.out.slice(-2000)}`,
          );
        }
        // The marker is the run script's CLAIM that the bridge is up. Confirm
        // it here, so "returns when the bridge answers" is true of this server
        // rather than true of a script this server does not control. Without
        // it, a script that prints the marker early -- or an engine that binds
        // the port and dies -- reports a successful launch, and the failure
        // resurfaces later as a bridge error from whichever tool is called next.
        try {
          await bridgeCall({ cmd: "ping" }, p.port);
        } catch (e: any) {
          // A ping that never left the queue is the same observation the
          // preflight above reads as "a bridge is answering": the slot is only
          // held by a call that connected. Reporting it as "no bridge answered"
          // would make one observation mean opposite things thirty lines apart,
          // and would fail a launch that worked -- whose retry the preflight
          // then refuses with "already running".
          if (!(e instanceof BridgeQueueTimeout)) {
            throw new Error(
              `defold_run: the run script printed the bridge marker, but no bridge answered on port ${p.port}. ` +
              `Cause: ${e.message}\nScript output:\n${r.out.slice(-2000)}`,
            );
          }
        }
        return text(r.out.trim());
      }
      case "defold_stop": {
        const r = await bridgeCall({ cmd: "quit" }, p.port);
        return text(JSON.stringify(r));
      }
      case "defold_start": {
        const extra = objectArg(args.options, "options");
        const r = await bridgeCall({ ...extra, cmd: "start" }, p.port);
        return text(JSON.stringify(r));
      }
      case "defold_input": {
        const triggers = triggerList(args.triggers);
        const applied: string[] = [];
        for (const t of triggers) {
          const r = await bridgeCall({ cmd: "input", trigger: t }, p.port);
          if (r?.error || r?.ok === false) {
            throw new Error(
              `input '${t}' failed (${r.error ?? "ok=false"})` +
              (applied.length ? `; already applied: ${applied.join(", ")}` : ""),
            );
          }
          applied.push(t);
        }
        const screen = await bridgeCall({ cmd: "screen" }, p.port);
        return text(frameOrJson(screen));
      }
      case "defold_screen": {
        const r = await bridgeCall({ cmd: "screen" }, p.port);
        return text(frameOrJson(r));
      }
      case "defold_state": {
        const r = await bridgeCall({ cmd: "state" }, p.port);
        return text(JSON.stringify(r, null, 2));
      }
      case "defold_log": {
        const tail = tailLines(args.tail, 40);
        const r = await bridgeCall({ cmd: "log", tail }, p.port);
        return text(Array.isArray(r.lines) ? r.lines.join("\n") : JSON.stringify(r));
      }
      case "defold_bridge": {
        const cmd = commandArg(args.cmd);
        const extra = objectArg(args.args, "args");
        const r = await bridgeCall({ ...extra, cmd }, p.port);
        return text(frameOrJson(r));
      }
      case "defold_test": {
        if (!p.testScript) throw new Error(`project has no testScript configured`);
        const lines = tailLines(args.tail, 12);
        const r = await runPwsh([p.testScript], p.root, 360_000);
        const tail = r.out.split(/\r?\n/).filter((l) => l.trim()).slice(-lines).join("\n");
        // A failing suite is a failed tool call. Returning it as a normal result
        // made "the suite ran" and "the suite passed" the same answer, and the
        // one tool whose job is that distinction is the worst place to lose it.
        if (r.code !== 0) throw new Error(`test suite failed: exit ${r.code}\n${tail}`);
        return text(`exit ${r.code}\n${tail}`);
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  return server;
}
