// ═══════════════════════════════════════════════════════════════════════════
// RECEIPTS — the part that makes this an accountability layer, not a data tool.
//
// A pool-stats tool answers "what is happening right now?". Anyone can build
// that. The question nobody answers is: "you said that at 3pm — prove it, and
// prove you didn't revise it after the outcome."
//
// A receipt pins four things together so a claim cannot drift after the fact:
//   1. the exact claim, in words
//   2. the exact query that was run (subgraph id + GraphQL + variables)
//   3. the chain position it was true at (block number from _meta)
//   4. a hash of the raw response, so the data itself can't be quietly swapped
//
// Anyone holding the receipt can replay step 2 and check they get step 4. If a
// reorg or an index change moved the data, the replay says so instead of
// silently agreeing. That's the whole idea: a claim that can be checked by
// someone who does not trust you.
// ═══════════════════════════════════════════════════════════════════════════

import { createHash } from "node:crypto";
import { queryGraphSubgraph } from "./graph-client.js";

/** Stable stringify: key order must not change the hash, or replay is meaningless. */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

export function hashResult(data) {
  return "sha256:" + createHash("sha256").update(canonical(data)).digest("hex");
}

/**
 * Run a query AND capture the block height it was answered at, in one round trip.
 * `_meta` is a standard subgraph field — asking for it alongside the real query
 * is what lets the receipt say *when* on-chain the answer was true, rather than
 * just when our wall clock happened to be.
 */
export async function queryWithBlock(subgraphId, query, variables = {}) {
  const withMeta = query.replace(
    /^\s*(query[^{]*)?\{/,
    (m) => `${m} _meta { block { number timestamp } hasIndexingErrors }`
  );
  const data = await queryGraphSubgraph(subgraphId, withMeta, variables);
  const meta = data?._meta ?? null;
  const payload = { ...data };
  delete payload._meta;
  return { data: payload, meta };
}

/**
 * Issue a receipt for a claim.
 *
 * The verdict is computed by `evaluate(data)` -> { verdict, reason, observed }.
 * Note the asymmetry: we record `unsupported` and `indeterminate` just as
 * permanently as `supported`. A receipts system that only keeps its wins is a
 * highlight reel, and the whole point here is that it isn't one.
 */
export async function issueReceipt({ claim, subgraphId, query, variables = {}, evaluate }) {
  const issuedAt = new Date().toISOString();
  const { data, meta } = await queryWithBlock(subgraphId, query, variables);
  const resultHash = hashResult(data);

  let verdict = "indeterminate";
  let reason = "no evaluator supplied";
  let observed = null;
  if (typeof evaluate === "function") {
    const out = evaluate(data) ?? {};
    verdict = out.verdict ?? "indeterminate";
    reason = out.reason ?? "";
    observed = out.observed ?? null;
  }

  // An indexing-error flag doesn't invalidate the answer, but a receipt that
  // hides it would be lying by omission -- surface it and let the reader judge.
  const caveats = [];
  if (meta?.hasIndexingErrors) {
    caveats.push("subgraph reported indexing errors at query time");
  }
  if (!meta?.block?.number) {
    caveats.push("no block height returned; replay cannot be pinned to a block");
  }

  return {
    version: "agent-ledger/1",
    claim,
    verdict,
    reason,
    observed,
    evidence: {
      subgraphId,
      query,
      variables,
      resultHash,
      block: meta?.block?.number ? Number(meta.block.number) : null,
      blockTimestamp: meta?.block?.timestamp ? Number(meta.block.timestamp) : null,
    },
    caveats,
    issuedAt,
    replay: "npm run verify -- <path-to-receipt.json>",
  };
}

/**
 * Replay a receipt against live data.
 *
 * Three outcomes, and the middle one is the interesting one:
 *   verified   — same query, same hash. The claim's evidence is intact.
 *   drifted    — query still works, but the data changed (new swaps, reorg,
 *                re-index). NOT fraud: expected for time-windowed queries.
 *                Reported honestly instead of being called a failure.
 *   broken     — the query no longer runs at all.
 */
export async function verifyReceipt(receipt) {
  const { subgraphId, query, variables, resultHash, block } = receipt.evidence ?? {};
  if (!subgraphId || !query || !resultHash) {
    return { status: "broken", detail: "receipt is missing evidence fields" };
  }
  let now;
  try {
    now = await queryWithBlock(subgraphId, query, variables ?? {});
  } catch (err) {
    return { status: "broken", detail: `replay query failed: ${err.message}` };
  }
  const nowHash = hashResult(now.data);
  const nowBlock = now.meta?.block?.number ? Number(now.meta.block.number) : null;

  if (nowHash === resultHash) {
    return {
      status: "verified",
      detail: "replayed query returned byte-identical data",
      originalBlock: block ?? null,
      replayBlock: nowBlock,
      resultHash,
    };
  }
  return {
    status: "drifted",
    detail:
      "query still resolves but returned different data than when the receipt was issued. " +
      "For a time-windowed query (e.g. 'most recent N swaps') this is expected as new blocks " +
      "arrive -- it means the CLAIM must be read against its original block, not that the " +
      "receipt was falsified.",
    originalBlock: block ?? null,
    replayBlock: nowBlock,
    originalHash: resultHash,
    replayHash: nowHash,
    blocksElapsed: block && nowBlock ? nowBlock - block : null,
  };
}
