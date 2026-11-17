// Offline tests: global fetch is stubbed, no Gateway key or network needed.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runTool } from "../src/tools.js";
import { issueReceipt, verifyReceipt } from "../src/receipts.js";
import { canaryQuery, CANARY_MAX_LAG_SECONDS } from "../src/graph-client.js";

const POOL = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
const META = { block: { number: "100", timestamp: "1700000000" }, hasIndexingErrors: false };

let nextData;
function stubGateway(data) {
  nextData = data;
}

beforeEach(() => {
  process.env.THEGRAPH_API_KEY = "test-key";
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: nextData }) });
});

const swaps = (amount0s) =>
  amount0s.map((a, i) => ({ amountUSD: "100", amount0: String(a), amount1: "0", timestamp: String(i) }));
const pool = { token0: { symbol: "USDC" }, token1: { symbol: "WETH" }, liquidity: "1" };

test("snapshot returns the net directional flow it advertises", async () => {
  stubGateway({ swaps: swaps([5, -2, -1]), pool });
  const out = await runTool("graph_pool_risk_snapshot", { poolId: POOL });
  assert.equal(out.netAmount0, 2);
});

test("directionalBiasPct is the dominant-side share: 90% one-way reads 90, not 10", async () => {
  stubGateway({ swaps: swaps([1, -1, -1, -1, -1, -1, -1, -1, -1, -1]), pool });
  const out = await runTool("graph_pool_risk_snapshot", { poolId: POOL });
  assert.equal(out.directionalBiasPct, 90);
  assert.equal(out.dominantDirection, "token0-out");
});

const claimData = {
  swaps: [
    { amountUSD: "900", timestamp: "2" },
    { amountUSD: "100", timestamp: "1" },
  ],
  pool: { token0: { symbol: "USDC" }, token1: { symbol: "WETH" } },
  _meta: META,
};

test("an untouched receipt verifies and the verdict is recomputed", async () => {
  stubGateway(claimData);
  const receipt = await runTool("graph_claim_pool_concentration", { poolId: POOL });
  assert.equal(receipt.verdict, "supported");
  assert.equal(receipt.evidence.block, 100);
  const replay = await runTool("graph_verify_receipt", { receipt });
  assert.equal(replay.status, "verified");
  assert.equal(replay.verdictChecked, true);
});

for (const [field, edit] of [
  ["verdict", (r) => (r.verdict = "unsupported")],
  ["reason", (r) => (r.reason = "trust me")],
  ["observed", (r) => (r.observed.concentrationRatio = 0.01)],
  ["claim", (r) => (r.claim = r.claim.replace("30%", "95%"))],
  ["verdict", (r) => (r.evaluator.params.threshold = 0.95)],
]) {
  test(`editing ${field} with the data hash intact is reported as tampered`, async () => {
    stubGateway(claimData);
    const receipt = await runTool("graph_claim_pool_concentration", { poolId: POOL });
    edit(receipt);
    const replay = await runTool("graph_verify_receipt", { receipt });
    assert.equal(replay.status, "tampered");
    assert.ok(replay.mismatched.includes(field));
  });
}

test("changed data is drifted, a forged hash never verifies", async () => {
  stubGateway(claimData);
  const receipt = await runTool("graph_claim_pool_concentration", { poolId: POOL });
  stubGateway({ ...claimData, swaps: [{ amountUSD: "5", timestamp: "3" }] });
  assert.equal((await verifyReceipt(receipt)).status, "drifted");
  stubGateway(claimData);
  receipt.evidence.resultHash = "sha256:" + "0".repeat(64);
  assert.notEqual((await verifyReceipt(receipt)).status, "verified");
});

test("a receipt with an ad-hoc evaluate() says its verdict is unbound", async () => {
  stubGateway(claimData);
  const receipt = await issueReceipt({
    claim: "x",
    subgraphId: "s",
    query: "{ swaps { amountUSD } }",
    evaluate: () => ({ verdict: "supported" }),
  });
  assert.ok(receipt.caveats.some((c) => c.includes("cannot recompute the verdict")));
  const replay = await verifyReceipt(receipt);
  assert.equal(replay.status, "verified");
  assert.equal(replay.verdictChecked, false);
});

test("the replay command printed in every receipt exists in package.json", async () => {
  stubGateway(claimData);
  const receipt = await runTool("graph_claim_pool_concentration", { poolId: POOL });
  const script = /^npm run (\S+)/.exec(receipt.replay)[1];
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.scripts[script], `package.json has no "${script}" script`);
});

test("canary rejects a stale subgraph head and accepts a fresh one", async () => {
  const now = 1700000000 * 1000;
  const factories = [{ id: "f", poolCount: "10", txCount: "1" }];
  stubGateway({ factories, _meta: { block: { number: "1", timestamp: "1700000000" } } });
  assert.equal((await canaryQuery(now)).lagSeconds, 0);
  await assert.rejects(canaryQuery(now + (CANARY_MAX_LAG_SECONDS + 1) * 1000), /stale/);
  stubGateway({ factories });
  await assert.rejects(canaryQuery(now), /freshness unproven/);
});

test("server has no canary bypass switch", () => {
  const src = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.ok(!src.includes("SKIP_BOOT_CANARY"));
});

test("skill doc names only fields the snapshot returns", async () => {
  stubGateway({ swaps: swaps([1, -1]), pool });
  const out = await runTool("graph_pool_risk_snapshot", { poolId: POOL });
  const doc = readFileSync(new URL("../skill/SKILL.md", import.meta.url), "utf8");
  assert.ok(!doc.includes("largestSwapFraction"));
  assert.ok("concentrationRatio" in out);
});
