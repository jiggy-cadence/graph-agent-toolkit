# graph-agent-toolkit

An MCP server that gives AI agents **live, reasoned** access to on-chain data via
[The Graph](https://thegraph.com)'s decentralized network — built for **ETHOnline 2026**,
targeting The Graph's "Best AI Tooling or AI Use Case" prize track.

## Why this exists

Agents that reason about on-chain activity (risk, MEV, liquidity, fraud detection) need
data that is (a) live, (b) indexed and queryable, and (c) verifiable against a known-good
source before the agent trusts it. Raw GraphQL passthroughs don't do reasoning — they just
hand an LLM a JSON blob and hope. This toolkit does the reasoning *before* the agent sees
the result, and it refuses to start if the Gateway is unreachable or the subgraph head
is more than an hour behind wall clock.

## What it does differently

- **Boot canary, not a config flag.** The server queries a known-live subgraph
  (Uniswap V3 mainnet) at startup and refuses to serve any tool if that canary fails.
  A "0 pools" or unreachable Gateway is treated as *broken*, not *empty*, and so is a
  subgraph whose latest indexed block is more than an hour old. There is no environment
  switch to skip it. The canary runs once at boot; it does not re-check freshness per call.
- **Tools reason over the data, they don't dump it.** `graph_pool_risk_snapshot` returns
  swap count, net directional flow (`netAmount0`), and largest-single-swap concentration —
  computed, not queried-and-forwarded.
- **Claims come with receipts.** `graph_claim_pool_concentration` returns a receipt that
  pins the claim to the query, the block and a hash of the response;
  `graph_verify_receipt` replays it and recomputes the verdict.
- **No API key baked in, ever.** `THEGRAPH_API_KEY` is read from the environment only;
  the client throws (loudly) if it's missing, rather than silently degrading.

## Architecture

```
src/graph-client.js   thin Gateway client + canaryQuery() — proves the key is live
src/tools.js          tool definitions: schema + real computation over the query result
src/receipts.js       issue and replay receipts for checkable claims
scripts/              smoke test, receipt demo, `npm run verify` CLI (all need a live key)
test/                 offline unit tests (`npm test`, fetch is stubbed)
src/server.js         MCP server wiring (stdio transport); runs the canary before serving
skill/                AgentSkill wrapper so any OpenClaw-style agent can call this toolkit
```

## Setup

```bash
npm install
export THEGRAPH_API_KEY=<your Subgraph Studio API key>   # thegraph.com/studio
npm start
```

On boot the server runs `canaryQuery()` against Uniswap V3 mainnet. If your key works,
and the subgraph head is recent, the server starts. If not, it exits with a clear
error — it will never silently fall back to fake data.

## Tools exposed

### `graph_pool_risk_snapshot`

Input: `{ poolId: "0x...", swapLimit?: number }` (default 50, max 500)

Pulls the most recent N swaps for a Uniswap V3 pool and computes:
- `swapCount`, `totalVolumeUSD`, `largestSingleSwapUSD`
- `concentrationRatio` — largest single swap as a fraction of total window volume, plus a
  `concentrationFlag` ("HIGH" above 0.3 — possible whale/manipulation signal, else "normal")
- `directionalBiasPct` — share of swaps on the dominant side (50 = balanced, 100 = all one
  way), with `dominantDirection` (`token0-in`, `token0-out` or `balanced`)
- `netAmount0` — signed sum of token0 amounts over the window (positive = the pool took in
  token0 on net)

This is meant as a building block: an agent asking "is this pool being manipulated right
now?" gets a computed answer, not a page of raw swap rows to parse itself.

### `graph_factory_health`

No input required. Returns live protocol-wide Uniswap V3 stats (`poolCount`, `txCount`,
`totalVolumeUSD`, `totalValueLockedUSD`) — useful as a cheap sanity check that the data
source is live and current before trusting a pool-level result.

### `graph_claim_pool_concentration`

Input: `{ poolId: "0x...", threshold?: number, swapLimit?: number }` (default 0.3, 50)

Makes the claim "a single swap is more than `threshold` of the volume in the last N swaps"
and returns a receipt: `claim`, `verdict` (`supported`, `unsupported` or `indeterminate`),
`reason`, `observed`, the `evaluator` id and params that produced the verdict, and
`evidence` (subgraph id, query, variables, `resultHash`, `block`, `blockTimestamp`).

### `graph_verify_receipt`

Input: `{ receipt }`. Also available as `npm run verify -- <path-to-receipt.json>`.

Replays the stored query and returns one of:
- `verified` — the data hash matches and the claim, verdict, reason and observed values
  recompute from that data.
- `tampered` — the data hash matches but one of those fields was edited.
- `drifted` — the query resolves but returns different data.
- `broken` — the query no longer runs, or the receipt is missing fields.

Limits, stated plainly:
- Replay runs against the **current** chain head, not `evidence.block`. The claim tool's
  query is "most recent N swaps", so on an active pool a receipt drifts within minutes and
  can no longer be re-checked. `block` records when the claim was true; it does not make
  the replay historical.
- Receipts are not signed. Verification shows a receipt is consistent with the chain data;
  it does not show who issued it or when.

## Tests

```bash
npm test          # offline, stubbed fetch
```

## Spec / AI-use disclosure

Built with Claude Code (Anthropic) acting as the primary developer, directed by Jiggy
(project owner) and Cadence (agent). All prompts and planning notes for this project are
tracked in this repo's commit history — no separate spec files were used beyond normal
commit messages, which describe intent and rationale for each change.

## License

MIT
