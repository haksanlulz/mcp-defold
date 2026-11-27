// Rug-pull guard (app standard MCP-7, docs/app-standard.md): the whole tools/list a client sees
// (names, descriptions, input schemas, annotations) is held in test/tools-list.snapshot.json. Any
// change to it fails here until it is reviewed and re-snapshotted, so a tool cannot quietly change
// what it tells the model. To accept a reviewed change:
//   UPDATE_TOOLS_SNAPSHOT=1 npx vitest run test/tools-list-snapshot.test.ts
// then commit the snapshot with the change. The server is built with an empty project registry, so
// no local project name or path (the untracked projects.json) reaches the committed snapshot.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";

const SNAPSHOT = fileURLToPath(new URL("./tools-list.snapshot.json", import.meta.url));

/** JSON with object keys sorted at every depth, so the file only changes when the content does. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable((value as Record<string, unknown>)[k])]));
  }
  return value;
}

describe("tools/list snapshot (MCP-7)", () => {
  it("matches the reviewed snapshot exactly", async () => {
    const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer({}).connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();
    const current = JSON.stringify(stable([...tools].sort((a, b) => a.name.localeCompare(b.name))), null, 2) + "\n";
    if (process.env.UPDATE_TOOLS_SNAPSHOT === "1") {
      writeFileSync(SNAPSHOT, current);
      return;
    }
    expect(existsSync(SNAPSHOT), "no test/tools-list.snapshot.json: create it with UPDATE_TOOLS_SNAPSHOT=1 and review it").toBe(true);
    const held = readFileSync(SNAPSHOT, "utf8").replace(/\r\n/g, "\n");
    const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
    expect(
      current,
      `tools/list changed (snapshot ${sha(held)}, now ${sha(current)}). Review the diff, then accept it with UPDATE_TOOLS_SNAPSHOT=1`,
    ).toBe(held);
  });
});
