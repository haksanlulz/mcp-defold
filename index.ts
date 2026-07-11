#!/usr/bin/env -S npx tsx
// stdio entry point. See server.ts for the tools, PROTOCOL.md for the bridge.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
