import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import net from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, loadProjects } from "../server";

// A fake in-process bridge: answers the wire protocol so tool handlers can be
// tested end to end without Defold, a build, or a real game.
let bridgePort = 0;
let bridgeServer: net.Server;
const received: any[] = [];

function fakeBridgeResponse(req: any): any {
  switch (req.cmd) {
    case "ping":
      return { ok: true };
    case "screen":
      return { frame: "day 1  hp 10/10\n@ . . ." };
    case "state":
      return { location: "start", hp: 10 };
    case "input":
      if (req.trigger === "key_broken") return { error: "no such trigger" };
      return { ok: true, trigger: req.trigger };
    case "start":
      return { ok: true, got: req };
    case "log":
      return { lines: ["INFO boot", "DEBUG tick"] };
    case "quit":
      return { ok: true };
    default:
      return { echo: req };
  }
}

beforeAll(async () => {
  bridgeServer = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const req = JSON.parse(buf.slice(0, nl));
        received.push(req);
        sock.write(JSON.stringify(fakeBridgeResponse(req)) + "\n");
        sock.end();
      }
    });
  });
  await new Promise<void>((r) => bridgeServer.listen(0, "127.0.0.1", () => r()));
  bridgePort = (bridgeServer.address() as net.AddressInfo).port;
});

afterAll(() => bridgeServer.close());

async function connect(): Promise<Client> {
  const server = createServer({
    testgame: { root: ".", port: bridgePort, runScript: "run.ps1" },
  });
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(res: any): string {
  return res.content[0].text;
}

describe("mcp-defold server", () => {
  it("exposes all nine tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "defold_bridge",
      "defold_input",
      "defold_log",
      "defold_run",
      "defold_screen",
      "defold_start",
      "defold_state",
      "defold_stop",
      "defold_test",
    ]);
  });

  it("defold_screen returns the composed frame as plain text", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "defold_screen", arguments: {} });
    expect(textOf(res)).toContain("@ . . .");
  });

  it("defold_state returns the state JSON", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "defold_state", arguments: {} });
    expect(JSON.parse(textOf(res))).toEqual({ location: "start", hp: 10 });
  });

  it("defold_input presses triggers in order, then returns the screen", async () => {
    const client = await connect();
    const before = received.length;
    const res = await client.callTool({
      name: "defold_input",
      arguments: { triggers: ["key_w", "key_e"] },
    });
    const mine = received.slice(before);
    expect(mine.map((r) => r.cmd)).toEqual(["input", "input", "screen"]);
    expect(mine[0].trigger).toBe("key_w");
    expect(mine[1].trigger).toBe("key_e");
    expect(textOf(res)).toContain("day 1");
  });

  it("defold_input names the failing trigger and what was already applied", async () => {
    const client = await connect();
    await expect(
      client.callTool({
        name: "defold_input",
        arguments: { triggers: ["key_w", "key_broken", "key_e"] },
      }),
    ).rejects.toThrow(/input 'key_broken' failed.*already applied: key_w/);
  });

  it("defold_input rejects an empty trigger list", async () => {
    const client = await connect();
    await expect(
      client.callTool({ name: "defold_input", arguments: { triggers: [] } }),
    ).rejects.toThrow(/non-empty/);
  });

  it("defold_start merges options into the bridge start request", async () => {
    const client = await connect();
    const res = await client.callTool({
      name: "defold_start",
      arguments: { options: { seed: 42, mode: "casual" } },
    });
    const body = JSON.parse(textOf(res));
    expect(body.got.seed).toBe(42);
    expect(body.got.mode).toBe("casual");
  });

  it("defold_start options cannot override the start command", async () => {
    const client = await connect();
    const res = await client.callTool({
      name: "defold_start",
      arguments: { options: { cmd: "evil", seed: 1 } },
    });
    // the declared command wins over a colliding options key
    expect(JSON.parse(textOf(res)).got.cmd).toBe("start");
  });

  it("defold_bridge passes through arbitrary commands", async () => {
    const client = await connect();
    const res = await client.callTool({
      name: "defold_bridge",
      arguments: { cmd: "advance", args: { seconds: 30 } },
    });
    const body = JSON.parse(textOf(res));
    expect(body.echo.cmd).toBe("advance");
    expect(body.echo.seconds).toBe(30);
  });

  it("defold_log joins the returned lines", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "defold_log", arguments: {} });
    expect(textOf(res)).toBe("INFO boot\nDEBUG tick");
  });

  it("rejects an unknown project", async () => {
    const client = await connect();
    await expect(
      client.callTool({ name: "defold_screen", arguments: { project: "nope" } }),
    ).rejects.toThrow(/unknown project/);
  });

  it("defold_test errors when the project has no testScript", async () => {
    const client = await connect();
    await expect(
      client.callTool({ name: "defold_test", arguments: {} }),
    ).rejects.toThrow(/no testScript/);
  });
});

describe("loadProjects", () => {
  it("loads and validates a registry file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpdefold-"));
    const file = join(dir, "projects.json");
    writeFileSync(file, JSON.stringify({ g: { root: ".", port: 1, runScript: "r.ps1" } }));
    expect(Object.keys(loadProjects(file))).toEqual(["g"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws a copy-the-example hint when the registry is missing", () => {
    expect(() => loadProjects(join(tmpdir(), "mcpdefold-definitely-missing.json"))).toThrow(/projects\.example\.json/);
  });

  it("rejects duplicate ports across projects", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpdefold-"));
    const file = join(dir, "projects.json");
    writeFileSync(file, JSON.stringify({
      a: { root: ".", port: 17890, runScript: "r.ps1" },
      b: { root: ".", port: 17890, runScript: "r.ps1" },
    }));
    expect(() => loadProjects(file)).toThrow(/reuses port/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an entry missing required fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpdefold-"));
    const file = join(dir, "projects.json");
    writeFileSync(file, JSON.stringify({ bad: { root: "." } }));
    expect(() => loadProjects(file)).toThrow(/needs root, port, and runScript/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a non-string testScript", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpdefold-"));
    const file = join(dir, "projects.json");
    writeFileSync(file, JSON.stringify({ g: { root: ".", port: 1, runScript: "r.ps1", testScript: 5 } }));
    expect(() => loadProjects(file)).toThrow(/testScript/);
    rmSync(dir, { recursive: true, force: true });
  });
});
