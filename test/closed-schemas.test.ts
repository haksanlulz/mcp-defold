// App standard MCP-3 (docs/app-standard.md): every input schema a client sees is closed
// (additionalProperties: false), so the schema says what validateArgs already enforces.
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";

describe("closed input schemas (MCP-3)", () => {
  it("every tool's inputSchema says additionalProperties: false", async () => {
    const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.filter((t) => (t.inputSchema as { additionalProperties?: unknown }).additionalProperties !== false).map((t) => t.name)).toEqual([]);
    await client.close();
  });
});
