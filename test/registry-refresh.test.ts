import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import net from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server.js";

// Exercise the public MCP handlers on ONE connected server while disk changes.
async function withRegistry(run: (c: Client, file: string, ports: number[], hits: number[]) => Promise<void>, initial = true) {
  const dir = mkdtempSync(join(tmpdir(), "mcpdefold-refresh-"));
  const file = join(dir, "projects.json");
  const hits = [0, 0];
  const bridges = [0, 1].map((i) => net.createServer((sock) => {
    sock.on("data", () => {
      hits[i]++;
      sock.end(JSON.stringify({ frame: `bridge-${i}` }) + "\n");
    });
  }));
  const ports: number[] = [];
  const previous = process.env.MCP_DEFOLD_PROJECTS;
  const previousDefault = process.env.MCP_DEFOLD_DEFAULT;
  const client = new Client({ name: "refresh-test", version: "1" }, { capabilities: {} });
  let server: ReturnType<typeof createServer> | undefined;
  try {
    for (const bridge of bridges) {
      await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", r));
      ports.push((bridge.address() as net.AddressInfo).port);
    }
    if (initial) writeFileSync(file, JSON.stringify({ old: project(ports[0]) }));
    process.env.MCP_DEFOLD_PROJECTS = file;
    delete process.env.MCP_DEFOLD_DEFAULT;
    server = createServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    await run(client, file, ports, hits);
  } finally {
    await client.close();
    await server?.close();
    await Promise.all(bridges.map((b) => new Promise<void>((r) => b.close(() => r()))));
    if (previous === undefined) delete process.env.MCP_DEFOLD_PROJECTS;
    else process.env.MCP_DEFOLD_PROJECTS = previous;
    if (previousDefault === undefined) delete process.env.MCP_DEFOLD_DEFAULT;
    else process.env.MCP_DEFOLD_DEFAULT = previousDefault;
    rmSync(dir, { recursive: true, force: true });
  }
}

const project = (port: number) => ({ root: ".", port, runScript: "run.ps1" });
const screen = (c: Client, name?: string) => c.callTool({ name: "defold_screen", arguments: name === undefined ? {} : { project: name } });
const text = (r: any) => r.content[0].text;

describe("registry refresh", () => {
  it("admits a new project and retains old routing without reconnecting", async () => {
    await withRegistry(async (c, file, ports, hits) => {
      expect(text(await screen(c, "old"))).toBe("bridge-0");
      writeFileSync(file, JSON.stringify({ old: project(ports[0]), added: project(ports[1]) }));
      expect(text(await screen(c, "added"))).toBe("bridge-1");
      expect(text(await screen(c, "old"))).toBe("bridge-0");
      expect(hits).toEqual([2, 1]);
      await expect(screen(c, "typo")).rejects.toThrow(/unknown project 'typo'. Registered: old, added/);
      expect(hits).toEqual([2, 1]);
    });
  });

  it("fails closed on invalid JSON, names the registry, and recovers after repair", async () => {
    await withRegistry(async (c, file, ports, hits) => {
      writeFileSync(file, "{");
      await expect(screen(c, "old")).rejects.toThrow(/project registry .*projects.json is not valid JSON/);
      expect(hits).toEqual([0, 0]);
      writeFileSync(file, JSON.stringify({ old: project(ports[0]) }));
      expect(text(await screen(c, "old"))).toBe("bridge-0");
    });
  });

  it("rejects invalid entries and duplicate ports without using stale routing", async () => {
    await withRegistry(async (c, file, ports, hits) => {
      writeFileSync(file, JSON.stringify({ old: project(ports[0]), added: { root: "." } }));
      await expect(screen(c, "old")).rejects.toThrow(/project 'added' needs root, port, and runScript/);
      writeFileSync(file, JSON.stringify({ old: project(ports[0]), added: project(ports[0]) }));
      await expect(screen(c, "added")).rejects.toThrow(/reuses port/);
      expect(hits).toEqual([0, 0]);
    });
  });

  it("recovers from an initially missing registry without restarting", async () => {
    await withRegistry(async (c, file, ports) => {
      expect((await c.listTools()).tools).toHaveLength(10);
      await expect(screen(c, "added")).rejects.toThrow(/no project registry/);
      writeFileSync(file, JSON.stringify({ added: project(ports[1]) }));
      expect(text(await screen(c, "added"))).toBe("bridge-1");
      expect(text(await screen(c))).toBe("bridge-1");
    }, false);
  });

  it("pins the default across reordering and refuses a removed default", async () => {
    await withRegistry(async (c, file, ports, hits) => {
      writeFileSync(file, JSON.stringify({ added: project(ports[1]), old: project(ports[0]) }));
      expect(text(await screen(c))).toBe("bridge-0");
      writeFileSync(file, JSON.stringify({ added: project(ports[1]) }));
      await expect(screen(c)).rejects.toThrow(/unknown project 'old'. Registered: added/);
      expect(hits).toEqual([1, 0]);
    });
  });
});
