# graph-agent-toolkit

An MCP server that gives AI agents **live, reasoned** access to on-chain data via
[The Graph](https://thegraph.com)'s decentralized network — built for **ETHOnline 2026**,
targeting The Graph's "Best AI Tooling or AI Use Case" prize track.

## Why this exists

Agents that reason about on-chain activity (risk, MEV, liquidity, fraud detection) need
data that is (a) live, (b) indexed and queryable, and (c) verifiable against a known-good
source before the agent trusts it. Raw GraphQL passthroughs don't do reasoning — they just
hand an LLM a JSON blob and hope. This toolkit does the reasoning *before* the agent sees
the result, and it refuses to run at all against mocked or stale data.

## What it does differently

- **Boot canary, not a config flag.** The server queries a known-live subgraph
  (Uniswap V3 mainnet) at startup and refuses to serve any tool if that canary fails.
  A "0 pools" or unreachable Gateway is treated as *broken*, not *empty*.
- **Tools reason over the data, they don't dump it.** `graph_pool_risk_snapshot` returns
  swap count, net directional flow, and largest-single-swap concentration — computed,
  not queried-and-forwarded.
- **No API key baked in, ever.** `THEGRAPH_API_KEY` is read from the environment only;
  the client throws (loudly) if it's missing, rather than silently degrading.

## Architecture

```
src/graph-client.js   thin Gateway client + canaryQuery() — proves the key is live
src/tools.js          tool definitions: schema + real computation over the query result
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
you'll see a factory poolCount > 0 and the server starts. If not, it exits with a clear
error — it will never silently fall back to fake data.

## Tools exposed

### `graph_pool_risk_snapshot`

Input: `{ poolId: "0x...", swapLimit?: number }` (default 50, max 500)

Pulls the most recent N swaps for a Uniswap V3 pool and computes:
- `swapCount` — how many swaps in the window
- `netDirectionalFlow` — signed sum of swap amounts (which way the pool is being pushed)
- `largestSwapFraction` — the single biggest swap as a fraction of total window volume
  (a simple concentration/whale-risk signal)

This is meant as a building block: an agent asking "is this pool being manipulated right
now?" gets a computed answer, not a page of raw swap rows to parse itself.

## Spec / AI-use disclosure

Built with Claude Code (Anthropic) acting as the primary developer, directed by Jiggy
(project owner) and Cadence (agent). All prompts and planning notes for this project are
tracked in this repo's commit history — no separate spec files were used beyond normal
commit messages, which describe intent and rationale for each change.

## License

MIT
