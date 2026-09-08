// Tool definitions for graph-agent-toolkit.
// Each tool does real work with live Graph data — not a passthrough of raw GraphQL —
// per the ETHOnline requirement that AI-tooling submissions be "reusable infrastructure"
// doing "meaningful work with the data: reasoning, decisions, automation."

import { queryGraphSubgraph } from "./graph-client.js";
import { issueReceipt, verifyReceipt } from "./receipts.js";

// Well-known public subgraph deployment IDs (mainnet). Kept as named constants so the
// agent-facing tool surface stays in human terms ("uniswap-v3") rather than raw IDs.
const SUBGRAPHS = {
  "uniswap-v3": "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV",
};

export const TOOLS = [
  {
    name: "graph_pool_risk_snapshot",
    description:
      "Pull a live Uniswap V3 pool's recent swap activity and compute a simple concentration/" +
      "volatility risk read: swap count, net directional flow, and largest single swap as a " +
      "fraction of total volume in the window. Real reasoning over live indexed data, not a " +
      "raw query dump.",
    inputSchema: {
      type: "object",
      properties: {
        poolId: { type: "string", description: "Uniswap V3 pool address (lowercase, 0x...)" },
        swapLimit: {
          type: "number",
          description: "How many of the most recent swaps to analyze (default 50, max 500)",
        },
      },
      required: ["poolId"],
    },
  },
  {
    name: "graph_factory_health",
    description:
      "Report live protocol-wide health for Uniswap V3: total pools, total transactions, and " +
      "total value locked, as a sanity/canary check that the data source is live and current.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "graph_claim_pool_concentration",
    description:
      "Make a CHECKABLE claim about whether a pool's recent volume is concentrated in one " +
      "whale swap, and return a replayable receipt. Unlike a plain query, the receipt pins the " +
      "claim to the exact GraphQL query, the subgraph, the block height it was true at, and a " +
      "hash of the response -- so anyone can replay it later and prove the claim was not " +
      "revised after the outcome was known. Records 'unsupported' verdicts as permanently as " +
      "'supported' ones.",
    inputSchema: {
      type: "object",
      properties: {
        poolId: { type: "string", description: "Uniswap V3 pool address (lowercase, 0x...)" },
        threshold: {
          type: "number",
          description:
            "Concentration ratio above which the claim counts as supported (default 0.3 = one " +
            "swap is >30% of windowed volume)",
        },
        swapLimit: { type: "number", description: "Swaps in the window (default 50)" },
      },
      required: ["poolId"],
    },
  },
  {
    name: "graph_verify_receipt",
    description:
      "Replay a previously-issued receipt against live Graph data. Returns verified (same " +
      "data hash), drifted (query still resolves but data moved -- expected for time-windowed " +
      "claims, reported honestly rather than as failure), or broken (query no longer runs). " +
      "This is what makes a claim trustworthy to someone who does not trust the agent.",
    inputSchema: {
      type: "object",
      properties: {
        receipt: { type: "object", description: "A receipt object previously returned by a graph_claim_* tool" },
      },
      required: ["receipt"],
    },
  },
];

async function poolRiskSnapshot({ poolId, swapLimit }) {
  if (!poolId || typeof poolId !== "string") {
    throw new Error("poolId is required (a Uniswap V3 pool address).");
  }
  const limit = Math.min(Math.max(Number(swapLimit) || 50, 1), 500);

  const data = await queryGraphSubgraph(
    SUBGRAPHS["uniswap-v3"],
    `query PoolSwaps($pool: String!, $limit: Int!) {
      swaps(
        first: $limit
        orderBy: timestamp
        orderDirection: desc
        where: { pool: $pool }
      ) {
        amountUSD
        amount0
        amount1
        timestamp
      }
      pool(id: $pool) {
        token0 { symbol }
        token1 { symbol }
        liquidity
      }
    }`,
    { pool: poolId.toLowerCase(), limit }
  );

  const swaps = data?.swaps ?? [];
  if (swaps.length === 0) {
    return {
      poolId,
      swapCount: 0,
      note: "No recent swaps found for this pool ID — check the address or try a more active pool.",
    };
  }

  let totalVolumeUSD = 0;
  let netAmount0 = 0;
  let largestAbsUSD = 0;

  for (const s of swaps) {
    const usd = Math.abs(Number(s.amountUSD));
    totalVolumeUSD += usd;
    netAmount0 += Number(s.amount0);
    if (usd > largestAbsUSD) largestAbsUSD = usd;
  }

  const concentrationRatio = totalVolumeUSD > 0 ? largestAbsUSD / totalVolumeUSD : 0;
  const directionalBiasPct =
    swaps.length > 0
      ? (swaps.filter((s) => Number(s.amount0) > 0).length / swaps.length) * 100
      : 0;

  return {
    poolId,
    pair: data?.pool
      ? `${data.pool.token0.symbol}/${data.pool.token1.symbol}`
      : "unknown",
    swapCount: swaps.length,
    totalVolumeUSD: Number(totalVolumeUSD.toFixed(2)),
    largestSingleSwapUSD: Number(largestAbsUSD.toFixed(2)),
    concentrationRatio: Number(concentrationRatio.toFixed(4)),
    concentrationFlag:
      concentrationRatio > 0.3
        ? "HIGH — one swap dominates recent volume, possible whale/manipulation signal"
        : "normal",
    directionalBiasPct: Number(directionalBiasPct.toFixed(1)),
    windowNote: `most recent ${swaps.length} swaps as of query time (live)`,
  };
}

async function factoryHealth() {
  const data = await queryGraphSubgraph(
    SUBGRAPHS["uniswap-v3"],
    `{ factories(first: 1) {
        poolCount
        txCount
        totalVolumeUSD
        totalValueLockedUSD
      } }`
  );
  const f = data?.factories?.[0];
  if (!f) throw new Error("No factory data returned — Gateway or subgraph issue.");
  return {
    poolCount: Number(f.poolCount),
    txCount: Number(f.txCount),
    totalVolumeUSD: Number(f.totalVolumeUSD),
    totalValueLockedUSD: Number(f.totalValueLockedUSD),
    source: "live Graph Gateway query, Uniswap V3 mainnet subgraph",
  };
}

// ── the claim tool: reasoning + a receipt, not just a number ────────────────
async function claimPoolConcentration({ poolId, threshold, swapLimit }) {
  if (!poolId || typeof poolId !== "string") {
    throw new Error("poolId is required (a Uniswap V3 pool address).");
  }
  const limit = Math.min(Math.max(Number(swapLimit) || 50, 1), 500);
  const cut = Number.isFinite(Number(threshold)) ? Number(threshold) : 0.3;
  const pool = poolId.toLowerCase();

  const query = `query PoolConcentration($pool: String!, $limit: Int!) {
      swaps(first: $limit, orderBy: timestamp, orderDirection: desc, where: { pool: $pool }) {
        amountUSD
        timestamp
      }
      pool(id: $pool) { token0 { symbol } token1 { symbol } }
    }`;

  return issueReceipt({
    claim:
      `In the most recent ${limit} swaps, a single swap accounts for more than ` +
      `${(cut * 100).toFixed(0)}% of total volume in Uniswap V3 pool ${pool}.`,
    subgraphId: SUBGRAPHS["uniswap-v3"],
    query,
    variables: { pool, limit },
    evaluate: (data) => {
      const swaps = data?.swaps ?? [];
      if (swaps.length === 0) {
        return {
          verdict: "indeterminate",
          reason: "no swaps returned for this pool in the queried window",
          observed: { swapCount: 0 },
        };
      }
      let total = 0;
      let largest = 0;
      for (const s of swaps) {
        const usd = Math.abs(Number(s.amountUSD));
        total += usd;
        if (usd > largest) largest = usd;
      }
      const ratio = total > 0 ? largest / total : 0;
      const pair = data?.pool
        ? `${data.pool.token0.symbol}/${data.pool.token1.symbol}`
        : "unknown";
      return {
        verdict: ratio > cut ? "supported" : "unsupported",
        reason:
          `largest single swap was $${largest.toFixed(2)} of $${total.toFixed(2)} total ` +
          `(${(ratio * 100).toFixed(2)}%), threshold ${(cut * 100).toFixed(0)}%`,
        observed: {
          pair,
          swapCount: swaps.length,
          totalVolumeUSD: Number(total.toFixed(2)),
          largestSingleSwapUSD: Number(largest.toFixed(2)),
          concentrationRatio: Number(ratio.toFixed(4)),
          threshold: cut,
        },
      };
    },
  });
}

export async function runTool(name, args) {
  switch (name) {
    case "graph_pool_risk_snapshot":
      return poolRiskSnapshot(args);
    case "graph_factory_health":
      return factoryHealth();
    case "graph_claim_pool_concentration":
      return claimPoolConcentration(args);
    case "graph_verify_receipt":
      return verifyReceipt(args?.receipt ?? {});
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
