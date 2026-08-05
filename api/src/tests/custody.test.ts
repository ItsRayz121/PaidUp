// Unit tests for per-user deposit address derivation (CUSTODY_SPEC.md § 5
// step 1). custody.ts is pure — no db, no network — so this is node:test, not
// an e2e suite.
//
//   npm run test:custody
import { strict as assert } from "node:assert";
import test from "node:test";
import { config } from "../config.ts";
import { custodyEnabled, deriveAddress } from "../custody.ts";

// The account-level xpub for the PUBLIC BIP39 test mnemonic
// "abandon abandon abandon abandon abandon abandon abandon abandon abandon
// abandon abandon about" at m/44'/60'/0'. Not a real wallet — this exact
// mnemonic is the standard test vector used across the industry (Trezor,
// ethers.js, Hardhat's docs, etc.) specifically because it holds no funds.
const TEST_XPUB =
  "xpub6DCoCpSuQZB2jawqnGMEPS63ePKWkwWPH4TU45Q7LPXWuNd8TMtVxRrgjtEshuqpK3mdhaWHPFsBngh5GFZaM6si3yZdUsT8ddYM3PwnATt";

test("no xpub configured => custody reports disabled", () => {
  config.custodyXpub.bep20 = "";
  assert.equal(custodyEnabled("bep20"), false);
});

test("deriveAddress refuses to run without an xpub", () => {
  config.custodyXpub.bep20 = "";
  assert.throws(() => deriveAddress("bep20" as never, 0));
});

test("with an xpub configured, custody reports enabled", () => {
  config.custodyXpub.bep20 = TEST_XPUB;
  assert.equal(custodyEnabled("bep20"), true);
});

// ⚠️ THIS IS THE TEST THAT WOULD HAVE CAUGHT THE PATH BUG. An earlier version
// of deriveAddress derived only ONE level below the account xpub instead of
// two ("external chain" + "address index"), which is silently a DIFFERENT,
// non-standard address — one no wallet, explorer, or hardware device would
// ever compute from the same seed at "address index 0". Pinning against the
// address every standard tool agrees on is what makes that class of bug loud
// instead of silent.
test("address(0) matches the standard m/44'/60'/0'/0/0 path every wallet uses", () => {
  config.custodyXpub.bep20 = TEST_XPUB;
  assert.equal(
    deriveAddress("bep20" as never, 0).toLowerCase(),
    "0x9858effd232b4033e47d90003d41ec34ecaeda94",
  );
});

test("addresses are deterministic — same index, same address, every call", () => {
  config.custodyXpub.bep20 = TEST_XPUB;
  assert.equal(deriveAddress("bep20" as never, 5), deriveAddress("bep20" as never, 5));
});

test("addresses are distinct per index", () => {
  config.custodyXpub.bep20 = TEST_XPUB;
  const seen = new Set(Array.from({ length: 20 }, (_, i) => deriveAddress("bep20" as never, i)));
  assert.equal(seen.size, 20);
});

test("the derived address carries a valid EIP-55 checksum (mixed case, not all-lower)", () => {
  config.custodyXpub.bep20 = TEST_XPUB;
  const addr = deriveAddress("bep20" as never, 1);
  assert.notEqual(addr, addr.toLowerCase());
  assert.match(addr, /^0x[0-9a-fA-F]{40}$/);
});

test("out-of-range indexes are refused, not silently wrapped", () => {
  config.custodyXpub.bep20 = TEST_XPUB;
  assert.throws(() => deriveAddress("bep20" as never, -1));
  assert.throws(() => deriveAddress("bep20" as never, 0x80000000));
  assert.throws(() => deriveAddress("bep20" as never, 1.5));
});

// Leave the gate as we found it for any other suite that runs after this one.
config.custodyXpub.bep20 = "";
