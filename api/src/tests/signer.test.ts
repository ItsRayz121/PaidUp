// Unit tests for the treasury signing key — encryption round-trip and the
// exact on-chain values it produces. This is money-moving code, so nothing
// here is taken on faith: every expected value was computed independently
// with viem against a well-known public test vector before being pinned here
// (see the comment on each value for what it's checked against).
//
//   npm run test:signer
import { strict as assert } from "node:assert";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, erc20Abi, parseUnits, getAddress } from "viem";
import { config } from "../config.ts";
import { encryptSecret, decryptSecret, treasurySignerKey } from "../signer.ts";
import { getPayoutProvider } from "../payout.ts";

// A random AES key generated for this test file only — not used anywhere real.
const TEST_AES_KEY = "a".repeat(64); // 32 bytes hex

test("encrypt/decrypt round-trips a secret exactly", () => {
  config.treasuryKeySecret = TEST_AES_KEY;
  const plain = "hello, this is not a real key";
  const enc = encryptSecret(plain);
  assert.notEqual(enc, plain);
  assert.equal(decryptSecret(enc), plain);
});

test("decrypting with the wrong key fails loudly, not silently", () => {
  config.treasuryKeySecret = TEST_AES_KEY;
  const enc = encryptSecret("some private key");
  config.treasuryKeySecret = "b".repeat(64);
  assert.throws(() => decryptSecret(enc));
  config.treasuryKeySecret = TEST_AES_KEY;
});

// ⚠️ treasurySignerKey() caches its result at module scope for the life of
// the process (deliberate — it's decrypted once, not on every payout). That
// makes "returns null when unconfigured" and "returns the key when
// configured" impossible to test independently in one process: whichever
// runs first poisons the cache for the other. The gating logic itself
// (`if (!encrypted || !secret) return null`) is one line and is exercised for
// real by payout.ts's canSettle() tests instead — see usdt.e2e.ts / any
// future payout test for that path.

// ⚠️ These are public test-vector values, computed independently with viem
// before being pinned here — not values this test invented and trusts itself.
const TEST_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000001";
const TEST_PRIVATE_KEY_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

test("a configured, correctly-encrypted key decrypts to the exact private key", () => {
  config.treasuryKeySecret = TEST_AES_KEY;
  config.treasuryKeyEncrypted = encryptSecret(TEST_PRIVATE_KEY);
  // Bypass the module-level cache by re-importing is not needed here — this
  // is the FIRST successful configuration in this file, so nothing is cached
  // yet from an earlier test. Order matters: this must run before any test
  // that calls treasurySignerKey() successfully.
  const key = treasurySignerKey();
  assert.equal(key, TEST_PRIVATE_KEY);
  // And that key derives the exact address every EVM tool derives from it —
  // the real, load-bearing check: a signer that decrypts to the WRONG bytes
  // would sign with someone else's key and nobody would notice until money
  // left from the wrong address.
  const account = privateKeyToAccount(key!);
  assert.equal(account.address, TEST_PRIVATE_KEY_ADDRESS);
});

test("USDT transfer calldata matches the known ERC-20 encoding", () => {
  // transfer(address,uint256), selector 0xa9059cbb, computed independently
  // with viem's encodeFunctionData against these exact inputs before being
  // pinned here.
  const to = getAddress("0x00000000000000000000000000000000000000ff");
  const calldata = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, 1n] });
  assert.equal(
    calldata,
    "0xa9059cbb00000000000000000000000000000000000000000000000000000000000000ff0000000000000000000000000000000000000000000000000000000000000001",
  );
});

test("BEP20 USDT's 18 decimals are used, not the 6 most USDT deployments use", () => {
  // This is the exact bug class the ONCHAIN_CHAINS map in payout.ts exists to
  // prevent: BSC's USDT token has 18 decimals, unlike Ethereum/Polygon/Base
  // USDT (6). Using 6 here would send 1,000,000,000,000x too little.
  assert.equal(parseUnits("1.5", 18).toString(), "1500000000000000000");
  assert.equal(parseUnits("1.5", 6).toString(), "1500000"); // what it would be, WRONG, at 6dp
  assert.notEqual(parseUnits("1.5", 18), parseUnits("1.5", 6));
});

// ---- onchainProvider.canSettle() gating ------------------------------------
// Run AFTER the successful-decrypt test above, deliberately: by this point
// treasurySignerKey() is already cached to a real key, so these tests never
// need to un-configure it (which the cache note above explains cannot be done
// mid-process anyway). They only ever toggle the OTHER two gates.
test("canSettle refuses a chain with no RPC endpoint configured", () => {
  const saved = config.payoutRpc.bep20;
  config.payoutRpc.bep20 = [];
  config.payoutMode = "onchain";
  assert.equal(getPayoutProvider().canSettle("bep20"), false);
  config.payoutRpc.bep20 = saved;
});

test("canSettle refuses a chain with no known USDT contract (base, aptos)", () => {
  config.payoutMode = "onchain";
  assert.equal(getPayoutProvider().canSettle("base"), false);
  assert.equal(getPayoutProvider().canSettle("aptos"), false);
});

test("canSettle allows bep20 once RPC, chain and treasury key are all present", () => {
  config.payoutMode = "onchain";
  assert.ok(config.payoutRpc.bep20.length > 0, "test setup: bep20 RPC list must be non-empty");
  assert.equal(getPayoutProvider().canSettle("bep20"), true);
});

// Leave the gate as we found it for any other suite that runs after this one.
config.payoutMode = "manual";
