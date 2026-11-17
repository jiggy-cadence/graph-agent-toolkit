#!/usr/bin/env node
// Replay a saved receipt:  npm run verify -- <path-to-receipt.json>
// Exit 0 only on "verified". drifted = 2, tampered = 3, broken = 4, usage = 64.

import { readFileSync } from "node:fs";
import { runTool } from "../src/tools.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: npm run verify -- <path-to-receipt.json>");
  process.exit(64);
}

let receipt;
try {
  receipt = JSON.parse(readFileSync(path, "utf8"));
} catch (err) {
  console.error(`cannot read receipt ${path}: ${err.message}`);
  process.exit(4);
}

const result = await runTool("graph_verify_receipt", { receipt });
console.log(JSON.stringify(result, null, 2));
process.exit({ verified: 0, drifted: 2, tampered: 3 }[result.status] ?? 4);
