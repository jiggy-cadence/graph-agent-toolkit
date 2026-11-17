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

// Named evaluators. A receipt that only hashes the data proves the DATA was not
// swapped; it says nothing about the verdict written next to it. Recording which
// evaluator (and which params) produced the verdict lets a replay recompute the
// claim, verdict, reason and observed values from the data and catch an edit.
const EVALUATORS = new Map();

/**
 * Register an evaluator: { claim(params, variables) -> string,
 *                          evaluate(data, params) -> { verdict, reason, observed } }.
 * Both must be pure functions of their arguments, or replay cannot reproduce them.
 */
export function registerEvaluator(id, impl) {
  if (typeof impl?.evaluate !== "function" || typeof impl?.claim !== "function") {
    throw new Error(`evaluator ${id} needs claim() and evaluate()`);
  }
  EVALUATORS.set(id, impl);
}

function runEvaluator(evaluator, data, variables) {
  const impl = EVALUATORS.get(evaluator.id);
  const params = evaluator.params ?? {};
  const out = impl.evaluate(data, params) ?? {};
  return {
    claim: impl.claim(params, variables ?? {}),
    verdict: out.verdict ?? "indeterminate",
    reason: out.reason ?? "",
    observed: out.observed ?? null,
  };
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
 * Pass `evaluator: { id, params }` naming a registered evaluator: the claim text
 * and verdict are then derived from it and can be recomputed on replay. A bare
 * `evaluate(data)` function still works, but the receipt carries a caveat that
 * its verdict is not bound to the evidence.
 * Note the asymmetry: we record `unsupported` and `indeterminate` just as
 * permanently as `supported`. A receipts system that only keeps its wins is a
 * highlight reel, and the whole point here is that it isn't one.
 */
export async function issueReceipt({
  claim,
  subgraphId,
  query,
  variables = {},
  evaluate,
  evaluator,
}) {
  if (evaluator && !EVALUATORS.has(evaluator.id)) {
    throw new Error(`unknown evaluator: ${evaluator.id}`);
  }
  const issuedAt = new Date().toISOString();
  const { data, meta } = await queryWithBlock(subgraphId, query, variables);
  const resultHash = hashResult(data);

  let verdict = "indeterminate";
  let reason = "no evaluator supplied";
  let observed = null;
  if (evaluator) {
    ({ claim, verdict, reason, observed } = runEvaluator(evaluator, data, variables));
  } else if (typeof evaluate === "function") {
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
    caveats.push("no block height returned; the receipt cannot say when on-chain it was true");
  }
  if (!evaluator) {
    caveats.push(
      "no registered evaluator; replay checks the data hash only and cannot recompute the verdict"
    );
  }

  return {
    version: "agent-ledger/1",
    claim,
    verdict,
    reason,
    observed,
    evaluator: evaluator ? { id: evaluator.id, params: evaluator.params ?? {} } : null,
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
 * The replay runs the stored query against the CURRENT chain head; it is not
 * pinned to `evidence.block`. A windowed query ("most recent N swaps") therefore
 * drifts as soon as the window moves, and a drifted receipt cannot be re-checked.
 *
 * Outcomes:
 *   verified   — same query, same hash, and (when the receipt names a registered
 *                evaluator) the recomputed claim/verdict/reason/observed match.
 *   tampered   — the data hash matches but the claim, verdict, reason or
 *                observed values are not what the evaluator produces from it.
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
    const ev = receipt.evaluator;
    let verdictChecked = false;
    if (ev?.id) {
      if (!EVALUATORS.has(ev.id)) {
        return { status: "broken", detail: `receipt names unknown evaluator: ${ev.id}` };
      }
      const expected = runEvaluator(ev, now.data, variables);
      const mismatched = ["claim", "verdict", "reason", "observed"].filter(
        (k) => canonical(expected[k]) !== canonical(receipt[k] ?? null)
      );
      if (mismatched.length) {
        return {
          status: "tampered",
          detail:
            "data hash matches, but the receipt does not say what the evaluator computes " +
            `from that data. Mismatched fields: ${mismatched.join(", ")}`,
          mismatched,
          expected,
          originalBlock: block ?? null,
          replayBlock: nowBlock,
          resultHash,
        };
      }
      verdictChecked = true;
    }
    return {
      status: "verified",
      detail: verdictChecked
        ? "replayed query returned byte-identical data and the verdict recomputes from it"
        : "replayed query returned byte-identical data; the verdict was NOT recomputed " +
          "(receipt names no registered evaluator)",
      verdictChecked,
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
