// Unit test for the Etherscan/BscScan response classifier (2026-09-05).
// bscscan.ts is otherwise deliberately untested at the network level (see its
// own header) — proving a real API answer needs a real key, not a stub. This
// one function is pure and worth pinning directly: it is the exact line that
// let a real explorer error (an invalid/incompatible API key) masquerade as
// "this wallet has never had a transaction" while it visibly held a live
// balance and had just sent two real payouts.
//
//   npm run test:bscscan
import { strict as assert } from "node:assert";
import test from "node:test";
import { parseExplorerResult } from "../bscscan.ts";

test("a genuinely empty history (status 0, result: []) is NOT an error", () => {
  const r = parseExplorerResult({ status: "0", result: [] });
  assert.ok("rows" in r, JSON.stringify(r));
  assert.deepEqual(r.rows, []);
});

test("a normal successful answer (status 1, result: [...]) is not an error", () => {
  const r = parseExplorerResult({ status: "1", result: [{ hash: "0xabc" }] });
  assert.ok("rows" in r, JSON.stringify(r));
  assert.equal(r.rows.length, 1);
});

test("an invalid API key (result is a STRING, not an array) IS an error", () => {
  const r = parseExplorerResult({ status: "0", result: "Invalid API Key" });
  assert.ok("error" in r, JSON.stringify(r));
  assert.equal(r.error, "Invalid API Key");
});

test("a rate-limit refusal (also a string result) IS an error", () => {
  const r = parseExplorerResult({ status: "0", result: "Max rate limit reached" });
  assert.ok("error" in r, JSON.stringify(r));
  assert.equal(r.error, "Max rate limit reached");
});

test("a malformed body with neither an array nor a string result still reads as an error, not a crash", () => {
  const r = parseExplorerResult({ status: "0", result: undefined });
  assert.ok("error" in r, JSON.stringify(r));
});
