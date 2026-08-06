// Unit tests for sweep-signing key derivation (CUSTODY_SPEC.md § 5 steps 2-4).
// Pure — no db, no network — same shape as custody.test.ts and signer.test.ts.
//
// The one property that actually matters here: a child key derived by THIS
// file must be the PRIVATE half of the exact address custody.ts's public-only
// derivation already shows the user. If those two ever disagreed, sweeping
// would move funds using a key that does not control the address the user
// was told to pay — the worst possible failure mode for this feature.
//
//   npm run test:custodyseeds
import { strict as assert } from "node:assert";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { HDKey } from "@scure/bip32";
import { config } from "../config.ts";
import { encryptSecret as encryptWith, parseAesKeyHex } from "../crypto/aesSecret.ts";
import { deriveAddress } from "../custody.ts";
import { deriveChildPrivateKey, sweepSigningEnabled } from "../custodySeeds.ts";

const TEST_AES_KEY = "d".repeat(64); // 32 bytes hex — test-only, not used anywhere real.
// custodySeeds.ts's own AES key, not signer.ts's treasury-specific one — the
// whole point of aesSecret.ts's split is that each secret class has its own
// key, so the test must encrypt with the SAME one deriveChildPrivateKey will
// decrypt with (CUSTODY_SEED_EVM_SECRET), not the treasury's.
const encryptSecret = (plaintext: string) => encryptWith(plaintext, parseAesKeyHex(TEST_AES_KEY, "test key"));

// An arbitrary deterministic seed (does not need to be a recognized BIP39
// vector — what's checked below is INTERNAL consistency between the public
// and private halves of the SAME account key, cross-checked against viem, an
// independent implementation, not against this file's own arithmetic).
const SEED = Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddee", "hex");
const ACCOUNT = HDKey.fromMasterSeed(SEED).derive("m/44'/60'/0'");
const TEST_XPUB = ACCOUNT.publicExtendedKey;
const TEST_XPRV = ACCOUNT.privateExtendedKey;

function reset() {
  config.custodySweepSeedEncrypted.evm = "";
  config.custodySweepSeedSecret.evm = "";
  config.custodyXpub.bep20 = "";
}

test("no seed configured => sweep signing reports disabled", () => {
  reset();
  assert.equal(sweepSigningEnabled("evm"), false);
});

test("deriveChildPrivateKey refuses to run without a configured seed", () => {
  reset();
  assert.throws(() => deriveChildPrivateKey("evm", 0));
});

test("with a seed configured, sweep signing reports enabled", () => {
  reset();
  config.custodySweepSeedSecret.evm = TEST_AES_KEY;
  config.custodySweepSeedEncrypted.evm = encryptSecret(TEST_XPRV);
  assert.equal(sweepSigningEnabled("evm"), true);
});

// ⚠️ THE LOAD-BEARING CHECK. custody.ts derives an ADDRESS from the public
// xpub; custodySeeds.ts derives a PRIVATE KEY from the private xprv of the
// SAME account. For every index, the private key's own address (computed by
// viem — an independent implementation, not this codebase's own arithmetic)
// must equal what custody.ts already showed the user.
test("a child's private key controls the EXACT address custody.ts derives for it", () => {
  reset();
  config.custodySweepSeedSecret.evm = TEST_AES_KEY;
  config.custodySweepSeedEncrypted.evm = encryptSecret(TEST_XPRV);
  config.custodyXpub.bep20 = TEST_XPUB;

  for (const index of [0, 1, 5, 1000]) {
    const publicAddress = deriveAddress("bep20" as never, index);
    const privateKeyHex = deriveChildPrivateKey("evm", index);
    const signerAddress = privateKeyToAccount(`0x${privateKeyHex}`).address;
    assert.equal(signerAddress.toLowerCase(), publicAddress.toLowerCase());
  }
});

test("derivation is deterministic — same index, same key, every call", () => {
  reset();
  config.custodySweepSeedSecret.evm = TEST_AES_KEY;
  config.custodySweepSeedEncrypted.evm = encryptSecret(TEST_XPRV);
  assert.equal(deriveChildPrivateKey("evm", 3), deriveChildPrivateKey("evm", 3));
});

test("out-of-range indexes are refused, not silently wrapped", () => {
  reset();
  config.custodySweepSeedSecret.evm = TEST_AES_KEY;
  config.custodySweepSeedEncrypted.evm = encryptSecret(TEST_XPRV);
  assert.throws(() => deriveChildPrivateKey("evm", -1));
  assert.throws(() => deriveChildPrivateKey("evm", 0x80000000));
  assert.throws(() => deriveChildPrivateKey("evm", 1.5));
});

// ⚠️ Uses the "tron" family, deliberately never configured successfully
// elsewhere in this file. sweepHd() caches a successfully-loaded key at
// module scope for the process lifetime (same reason signer.test.ts orders
// its own tests around treasurySignerKey()'s cache) — reusing "evm" here
// would silently hit the cache from an earlier test instead of exercising
// this decrypt path at all.
test("a decrypted value with no private key (an xpub, not an xprv) is refused loudly", () => {
  reset();
  config.custodySweepSeedSecret.tron = TEST_AES_KEY;
  // A plausible misconfiguration: someone encrypts the PUBLIC xpub by mistake
  // instead of the private xprv. It decrypts fine — the AES layer has no
  // opinion about what it protects — but must never silently produce garbage.
  config.custodySweepSeedEncrypted.tron = encryptSecret(TEST_XPUB);
  assert.throws(() => deriveChildPrivateKey("tron", 0), /private extended key/);
  config.custodySweepSeedSecret.tron = "";
  config.custodySweepSeedEncrypted.tron = "";
});

test("EVM and TRON each need their own seed — one family configured does not enable another", () => {
  reset();
  config.custodySweepSeedSecret.evm = TEST_AES_KEY;
  config.custodySweepSeedEncrypted.evm = encryptSecret(TEST_XPRV);
  assert.equal(sweepSigningEnabled("evm"), true);
  assert.equal(sweepSigningEnabled("tron"), false);
  assert.equal(sweepSigningEnabled("utxo"), false);
});

// Leave the gate as we found it for any other suite that runs after this one.
reset();
