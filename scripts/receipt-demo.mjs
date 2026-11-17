// Live end-to-end proof of the receipt layer.
//   1. issue a receipt for a claim that should be UNSUPPORTED (quiet blue-chip pool)
//   2. replay it immediately -> verified or drifted, both honest outcomes
//   3. tamper with the receipt -> replay must NOT say "verified"
//   4. edit the verdict but keep the hash -> replay must NOT say "verified"
//
// Steps 3 and 4 are the ones that matter. A verifier that says "verified" for everything
// is decoration. This proves it can actually fail.

import { runTool } from "../src/tools.js";

const USDC_WETH = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";

console.log("1) issuing claim receipt on USDC/WETH 0.05% pool...\n");
const receipt = await runTool("graph_claim_pool_concentration", {
  poolId: USDC_WETH,
  threshold: 0.3,
  swapLimit: 50,
});
console.log(JSON.stringify(receipt, null, 2));

console.log("\n2) replaying the receipt against live data...\n");
const replay = await runTool("graph_verify_receipt", { receipt });
console.log(JSON.stringify(replay, null, 2));

console.log("\n3) NEGATIVE CONTROL — tampering with the result hash...\n");
const forged = JSON.parse(JSON.stringify(receipt));
forged.evidence.resultHash = "sha256:" + "0".repeat(64);
const tampered = await runTool("graph_verify_receipt", { receipt: forged });
console.log(JSON.stringify(tampered, null, 2));

console.log("\n4) NEGATIVE CONTROL — flipping the verdict, leaving the hash alone...\n");
const flipped = JSON.parse(JSON.stringify(receipt));
flipped.verdict = receipt.verdict === "supported" ? "unsupported" : "supported";
const flippedReplay = await runTool("graph_verify_receipt", { receipt: flipped });
console.log(JSON.stringify(flippedReplay, null, 2));

const ok = tampered.status !== "verified" && flippedReplay.status !== "verified";
console.log(
  "\n" +
    (ok
      ? "PASS — neither a forged hash nor an edited verdict verifies. The check can fail, so passing means something."
      : "FAIL — forged receipt verified. The verifier is decoration; do not ship.")
);
process.exit(ok ? 0 : 1);
