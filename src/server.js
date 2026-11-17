#!/usr/bin/env node
// graph-agent-toolkit: an MCP server exposing live The Graph subgraph data as agent tools.
// Built for ETHOnline 2026 — The Graph "Best AI Tooling or AI Use Case" track.
//
// Why this exists: agents doing on-chain reasoning need live, verifiable, indexed blockchain
// data rather than scraped/mocked snapshots. The Graph's decentralized network indexes it;
// this server is the bridge that lets any MCP-speaking agent (Claude, etc.) query it, reason
// over it, and act — without hand-rolling GraphQL each time.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { canaryQuery } from "./graph-client.js";
import { TOOLS, runTool } from "./tools.js";

const server = new Server(
  { name: "graph-agent-toolkit", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const result = await runTool(name, args ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

async function main() {
  // Fail loud at boot if we're not actually wired to live data — never let this server
  // silently serve mocked results (the ETHOnline live-data gate is pass/fail).
  // There is deliberately no environment switch to skip this.
  try {
    const c = await canaryQuery();
    console.error(
      `[graph-agent-toolkit] boot canary OK — Gateway key is live, head ${c.lagSeconds}s behind.`
    );
  } catch (err) {
    console.error("[graph-agent-toolkit] BOOT CANARY FAILED:", err.message);
    console.error("[graph-agent-toolkit] refusing to start against unproven data access.");
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[graph-agent-toolkit] MCP server running on stdio.");
}

main().catch((err) => {
  console.error("[graph-agent-toolkit] fatal:", err);
  process.exit(1);
});
