---
name: graph-agent-toolkit
description: Query live on-chain data from The Graph's decentralized network and get reasoned risk signals (not raw dumps) for Uniswap V3 pools. Use when an agent needs to assess whether a pool's recent activity looks concentrated/manipulated, or needs any live indexed blockchain data as a reasoning input rather than a display value.
---

# graph-agent-toolkit

Gives an agent a tool-callable way to pull **live** indexed blockchain data via The Graph
and get back a computed signal, not a page of raw rows.

## When to use this

- The agent is reasoning about on-chain risk, liquidity, or trading activity and needs a
  live data point to reason over (not a static/cached figure).
- The agent needs to distinguish "quiet pool" from "one whale just moved the market" —
  that's what `largestSwapFraction` is for.

## Setup

Requires `THEGRAPH_API_KEY` in the environment (see repo README for how to get one from
Subgraph Studio — thegraph.com/studio). The server refuses to start without it; this is
intentional, not a bug — it means every result this skill returns came from a live,
canary-proven Graph Gateway call.

Run the MCP server: `npm start` from the repo root, then connect it as an MCP tool source.

## Tools

- `graph_pool_risk_snapshot(poolId, swapLimit?)` → `{ swapCount, totalVolumeUSD,
  largestSingleSwapUSD, concentrationRatio, concentrationFlag, directionalBiasPct }` for a
  Uniswap V3 pool's recent swap window.
- `graph_factory_health()` → `{ poolCount, txCount, totalVolumeUSD, totalValueLockedUSD }` —
  protocol-wide live sanity check, no input needed.

## What this does NOT do

- Does not execute trades or hold keys. Read-only, query-and-reason only.
- Does not fall back to cached/mocked data if the live Gateway call fails — it errors
  instead, so the agent (and the human) know the signal is untrusted, not silently stale.
