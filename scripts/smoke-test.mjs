#!/usr/bin/env node
// Standalone smoke test — proves the whole chain works against LIVE data, no MCP transport
// needed. Run this the moment THEGRAPH_API_KEY is set to confirm end-to-end before recording
// the demo video.
//
// Usage: THEGRAPH_API_KEY=*** node scripts/smoke-test.mjs

import { canaryQuery } from "../src/graph-client.js";
import { runTool } from "../src/tools.js";

// A real, high-volume Uniswap V3 pool (USDC/WETH 0.05%) — guaranteed recent swap activity.
const USDC_WETH_POOL = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";

async function main() {
  console.log("1) boot canary — proving the key is live against Uniswap V3 mainnet...");
  const factory = await canaryQuery();
  console.log("   OK:", factory);

  console.log("\n2) graph_pool_risk_snapshot on USDC/WETH 0.05% pool...");
  const snapshot = await runTool("graph_pool_risk_snapshot", {
    poolId: USDC_WETH_POOL,
    swapLimit: 50,
  });
  console.log("   OK:", JSON.stringify(snapshot, null, 2));

  console.log("\n3) graph_factory_health (protocol-wide sanity check)...");
  const health = await runTool("graph_factory_health", {});
  console.log("   OK:", JSON.stringify(health, null, 2));

  console.log("\n✅ ALL LIVE — smoke test passed. Safe to record the demo.");
}

main().catch((err) => {
  console.error("\n❌ SMOKE TEST FAILED:", err.message);
  process.exit(1);
});
