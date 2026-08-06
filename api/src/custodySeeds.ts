// Sweep-signing key material for secp256k1 chain families — CUSTODY_SPEC.md
// § 5, steps 2-4.
//
// ⚠️ THIS FILE, NOT custody.ts, IS WHERE PRIVATE KEYS FOR DEPOSIT ADDRESSES
// LIVE. custody.ts derives addresses from a PUBLIC xpub and its own header
// says "IF A FUNCTION IN THIS FILE EVER NEEDS A PRIVATE KEY, STOP" — this is
// that stop, kept in its own file on purpose so the boundary stays textual,
// not just a comment someone has to remember.
//
// One chain-family sweep seed per secp256k1 family (evm, tron, utxo), each
// with its own env-var pair (never one shared key — see aesSecret.ts's header
// for why). Each is the PRIVATE half of the exact account-branch key
// custody.ts's xpub is the public half of (m/44'/60'/0' for evm) — so a child
// derived here at (chain, index) is GUARANTEED to be the same address
// custody.ts already showed the user, because both walk the identical
// deriveChild(0) then deriveChild(index) path from the same account key.
//
// ⚠️ DELIBERATELY DB-FREE. Nothing in this file imports db.ts — importing
// this module (or its unit tests) must never open a live database connection
// just to derive a key (see the ed25519 counterpart, custodyPool.ts, which
// DOES need the db for its address inventory and pays that cost there, not
// here — and see mining.test.ts's header comment for the exact node:test
// hang this avoids).
//
// Where a decrypted key is allowed to live: deriveChildPrivateKey is the ONLY
// consumer of the raw secret material. Nothing else in this codebase may
// import decryptSecret and reach for CUSTODY_SEED_* directly — sweep.ts calls
// deriveChildPrivateKey and gets back exactly one child's key as a
// short-lived local, never the parent.
import { HDKey } from "@scure/bip32";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decryptSecret, parseAesKeyHex } from "./crypto/aesSecret.ts";
import { config } from "./config.ts";

export type SecpChainFamily = "evm" | "tron" | "utxo";

const hdCache = new Map<SecpChainFamily, HDKey>();

// The account-branch PRIVATE extended key for a chain family, decrypted once
// and cached for the process lifetime — same posture as signer.ts's cached
// treasury key. Returns null when unconfigured (sweeping off for that family).
function sweepHd(chainFamily: SecpChainFamily): HDKey | null {
  const cached = hdCache.get(chainFamily);
  if (cached) return cached;

  const encrypted = config.custodySweepSeedEncrypted[chainFamily];
  const secretHex = config.custodySweepSeedSecret[chainFamily];
  if (!encrypted || !secretHex) return null;

  const key = parseAesKeyHex(secretHex, `CUSTODY_SEED_${chainFamily.toUpperCase()}_SECRET`);
  const xprv = decryptSecret(encrypted, key).trim();
  const hd = HDKey.fromExtendedKey(xprv);
  if (!hd.privateKey) {
    throw new Error(
      `CUSTODY_SEED_${chainFamily.toUpperCase()}_ENCRYPTED did not decrypt to a private extended key (xprv). ` +
      "custody.ts's xpub and this seed must be the public/private halves of the SAME account key.",
    );
  }
  hdCache.set(chainFamily, hd);
  return hd;
}

// Whether sweeping is possible for this chain family right now.
export function sweepSigningEnabled(chainFamily: SecpChainFamily): boolean {
  try {
    return sweepHd(chainFamily) !== null;
  } catch {
    return false; // configured-but-undecryptable must read as "cannot sweep", not throw
  }
}

// The raw private key (32 bytes, hex, NO 0x prefix — callers add whatever
// their signing library expects) for the deposit address at `index` on
// `chainFamily`. The ONLY function in this codebase allowed to touch the
// decrypted parent seed's private material beyond deriving one child.
export function deriveChildPrivateKey(chainFamily: SecpChainFamily, index: number): string {
  const hd = sweepHd(chainFamily);
  if (!hd) throw new Error(`No sweep-signing seed configured for chain family "${chainFamily}".`);
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
    throw new Error("Derivation index out of range.");
  }
  // Same two-level path as custody.ts's deriveAddress: external chain (0),
  // then the address index — so this is guaranteed to be the private half of
  // the exact address custody.ts already computed and showed the user.
  const external = hd.deriveChild(0);
  const child = external.deriveChild(index);
  if (!child.privateKey) throw new Error("Derived key has no private key — this should be unreachable.");
  return bytesToHex(child.privateKey);
}
