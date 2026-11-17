// Thin client for The Graph's decentralized network Gateway.
// Docs: https://thegraph.com/docs/en/subgraphs/querying/querying-the-graph/
//
// Requires THEGRAPH_API_KEY in the environment. Never hardcode it, never log it.

const GATEWAY_BASE = "https://gateway.thegraph.com/api";

/**
 * Run a GraphQL query against a deployed subgraph via The Graph's Gateway.
 * @param {string} subgraphId - the deployment/subgraph ID (Qm... or numeric ID from Graph Explorer)
 * @param {string} query - GraphQL query string
 * @param {object} [variables] - GraphQL variables
 * @returns {Promise<object>} the `data` field of the GraphQL response
 */
export async function queryGraphSubgraph(subgraphId, query, variables = {}) {
  const apiKey = process.env.THEGRAPH_API_KEY;
  if (!apiKey) {
    throw new Error(
      "THEGRAPH_API_KEY is not set. This tool refuses to run against mocked/static data " +
        "per the ETHOnline live-data requirement — set a real Subgraph Studio key."
    );
  }

  const url = `${GATEWAY_BASE}/${apiKey}/subgraphs/id/${subgraphId}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Graph Gateway HTTP ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = await res.json();
  if (json.errors && json.errors.length) {
    throw new Error(`Graph Gateway GraphQL error: ${JSON.stringify(json.errors).slice(0, 500)}`);
  }
  return json.data;
}

// The canary rejects a subgraph whose latest indexed block is older than this.
// Mainnet produces a block every ~12s; an hour behind means the indexer is stuck.
export const CANARY_MAX_LAG_SECONDS = 3600;

/**
 * Canary: prove the key is live against a known-present, well-indexed subgraph
 * (Uniswap V3 mainnet) AND that the subgraph head is recent, before trusting any
 * other result from this client.
 */
export async function canaryQuery(nowMs = Date.now()) {
  // Uniswap V3 mainnet subgraph deployment ID (public, well-known).
  const UNISWAP_V3_MAINNET = "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV";
  const data = await queryGraphSubgraph(
    UNISWAP_V3_MAINNET,
    `{ factories(first: 1) { id poolCount txCount } _meta { block { number timestamp } } }`
  );
  const factory = data?.factories?.[0];
  if (!factory || Number(factory.poolCount) <= 0) {
    throw new Error(
      "CANARY FAILED: expected a live factory with poolCount > 0, got: " +
        JSON.stringify(data)
    );
  }
  const headTs = Number(data?._meta?.block?.timestamp);
  if (!Number.isFinite(headTs) || headTs <= 0) {
    throw new Error("CANARY FAILED: subgraph returned no head block timestamp; freshness unproven");
  }
  const lagSeconds = Math.floor(nowMs / 1000) - headTs;
  if (lagSeconds > CANARY_MAX_LAG_SECONDS) {
    throw new Error(
      `CANARY FAILED: subgraph head is ${lagSeconds}s behind wall clock ` +
        `(limit ${CANARY_MAX_LAG_SECONDS}s) -- data is stale`
    );
  }
  return { ...factory, headBlock: Number(data._meta.block.number), lagSeconds };
}
