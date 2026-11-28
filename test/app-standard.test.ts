import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import net from "node:net";
import * as fs from "node:fs";
import * as cp from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, loadProjects } from "../server.js";

// Keep the suite's MCP in-memory transport and fake bridge protocol; replace
// the OS boundaries so no test can launch Defold or read a local registry.
vi.mock("node:fs", async (original) => ({ ...await original<typeof fs>(),
  readFileSync: vi.fn(), existsSync: vi.fn(() => true),
}));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof cp>(), spawn: vi.fn() }));

const SECRET = "sk-PLANTED-0000-not-a-real-key";
const project = { root: ".", port: 17891, runScript: "fake-run.ps1", testScript: "fake-test.ps1" };
let requests: Record<string, unknown>[];
let stderr: string[];
let fail: boolean;
let emptyPort: boolean;
let client: Client | undefined;
let server: ReturnType<typeof createServer> | undefined;

beforeEach(() => {
  requests = [];
  stderr = [];
  fail = false;
  emptyPort = false;
  vi.stubEnv("PLANTED_SECRET", SECRET); // Defold reads no credential variable.
  vi.stubEnv("MCP_DEFOLD_DEFAULT", "game");
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk)); return true;
  }) as typeof process.stderr.write);
  vi.mocked(fs.readFileSync).mockImplementation((() => JSON.stringify({ game: project })) as unknown as typeof fs.readFileSync);
  vi.spyOn(net, "createConnection").mockImplementation((() => {
    const socket = new EventEmitter() as net.Socket;
    socket.destroy = vi.fn(() => socket);
    socket.write = vi.fn((wire: any) => {
      const req = JSON.parse(String(wire));
      requests.push(req);
      queueMicrotask(() => socket.emit("data", Buffer.from(fail ? "broken reply\n" :
        JSON.stringify({ ok: true, frame: "fake frame", lines: ["fake log"], echo: req }) + "\n")));
      return true;
    }) as typeof socket.write;
    queueMicrotask(() => {
      if (emptyPort) { emptyPort = false; socket.emit("error", new Error("ECONNREFUSED")); }
      else socket.emit("connect");
    });
    return socket;
  }) as typeof net.createConnection);
  vi.spyOn(net, "connect").mockImplementation((() => {
    const socket = new EventEmitter();
    queueMicrotask(() => socket.emit("error", new Error("ECONNREFUSED")));
    return socket;
  }) as unknown as typeof net.connect);
  vi.mocked(cp.spawn).mockImplementation(((_exe: unknown, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), unref: vi.fn(), kill: vi.fn(),
    });
    queueMicrotask(() => {
      const screenshot = args.some((a) => a.endsWith("screenshot.ps1"));
      const output = fail ? "FAIL: fake script failure\n" : screenshot ? "SHOT fake.png 1x1\n" :
        args.includes("fake-run.ps1") ? "bridge LIVE on 17891\n" : "fake suite passed\n";
      if (screenshot && !fail) vi.mocked(fs.readFileSync).mockReturnValueOnce(Buffer.from("fake PNG"));
      child.stdout.emit("data", Buffer.from(output));
      child.emit("close", fail ? 1 : 0);
    });
    return child;
  }) as unknown as typeof cp.spawn);
});

afterEach(async () => {
  await client?.close();
  await server?.close();
  client = undefined;
  server = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

async function connect(fromDisk = false) {
  server = fromDisk ? createServer() : createServer({ game: project });
  client = new Client({ name: "app-standard", version: "1" }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

function noSecret(value: unknown) {
  // Error.message is non-enumerable. Include it and all protocol error data,
  // as well as the complete result (including any future structuredContent).
  const serialized = value instanceof Error ? value.message + JSON.stringify(value) : JSON.stringify(value);
  expect(serialized).not.toContain(SECRET);
  expect(stderr.join("")).not.toContain(SECRET);
}

describe("ALL-2 planted environment secret", () => {
  it.each([
    ["defold_run", {}], ["defold_stop", {}], ["defold_start", {}],
    ["defold_input", { triggers: ["key_w"] }], ["defold_screen", {}],
    ["defold_screenshot", {}], ["defold_state", {}], ["defold_log", {}],
    ["defold_bridge", { cmd: "ping" }], ["defold_test", {}],
  ] as const)("%s keeps successful results and failures secret-free", async (name, args) => {
    // Screenshot is Windows-only in production; force that branch with fake OS I/O.
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const c = await connect();
    emptyPort = name === "defold_run";
    const result = await c.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
    expect(result.content).toBeDefined();
    noSecret(result);
    fail = true;
    emptyPort = name === "defold_run";
    const error = await c.callTool({ name, arguments: args }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    noSecret(error);
    const invalid = await c.callTool({ name, arguments: { ...args, unexpected: true } }).catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(Error);
    noSecret(invalid);
    const unknown = await c.callTool({ name: "unknown", arguments: {} }).catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(Error);
    noSecret(unknown);
  });
});

describe("ALL-3 external input ceilings", () => {
  it.each([
    ["trigger count 100", Array(100).fill("key_w"), Array(101).fill("key_w"), /at most 100 triggers/],
    // Put the long id LAST: no valid prefix may be applied before rejection.
    ["trigger length 64", ["key_w", "x".repeat(64)], ["key_w", "x".repeat(65)], /at most 64 characters/],
  ] as const)("%s accepts cap and refuses cap+1 before I/O", async (_name, at, over, reason) => {
    const c = await connect(true);
    const result = await c.callTool({ name: "defold_input", arguments: { triggers: at } });
    expect(result.isError).not.toBe(true);
    expect(requests.slice(0, -1).map((r) => r.trigger)).toEqual(at);
    expect(requests.at(-1)?.cmd).toBe("screen");
    vi.mocked(fs.readFileSync).mockClear();
    vi.mocked(net.createConnection).mockClear();
    vi.mocked(cp.spawn).mockClear();
    await expect(c.callTool({ name: "defold_input", arguments: { triggers: over } })).rejects.toThrow(reason);
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(net.createConnection).not.toHaveBeenCalled();
    expect(cp.spawn).not.toHaveBeenCalled();
  });

  it("registry port 65535 accepts cap and refuses 65536 before socket/script work", () => {
    // Loading the external registry necessarily reads it; validation must
    // refuse before a socket or script starts, not before reading its input.
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ game: { ...project, port: 65535 } }));
    expect(loadProjects("fake-registry.json").game.port).toBe(65535);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ game: { ...project, port: 65536 } }));
    expect(() => loadProjects("fake-registry.json")).toThrow(/port must be 1-65535/);
    expect(net.createConnection).not.toHaveBeenCalled();
    expect(cp.spawn).not.toHaveBeenCalled();
  });
});
