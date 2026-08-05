// Per-user deposit addresses — CUSTODY_SPEC.md § 5, STEP 1 ONLY.
//
// This file derives addresses. It never sends anything, never watches the
// chain, and never touches a private key — read-only address generation from
// a PUBLIC extended key (xpub), which is the whole point: an xpub can produce
// an unlimited number of valid child addresses, but there is no key here that
// could ever sign a transaction on any of them.
//
// ⚠️ IF A FUNCTION IN THIS FILE EVER NEEDS A PRIVATE KEY, STOP. That is stage
// 3/4 of CUSTODY_SPEC.md (sweeping, auto-withdrawal) and needs its own founder
// decisions on custody (KMS/HSM, hot/cold split, approval limits) BEFORE any
// code — see CUSTODY_SPEC.md § 3. Do not casually extend this module into that.
import { HDKey } from "@scure/bip32";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { config } from "./config.ts";

// Chains we can derive an EVM-style (keccak/checksum) address for. BEP20 is
// the only one wired up today (config.custodyXpub.bep20); the type is wider
// than the config so adding TRC20 later is "add a key to config + this map",
// not a rewrite — TRON also derives from secp256k1, just a different address
// encoding (base58, not implemented here yet).
type Chain = "bep20";

const hdCache = new Map<string, HDKey>();

function hdFor(chain: Chain): HDKey | null {
  const xpub = config.custodyXpub[chain];
  if (!xpub) return null;
  let hd = hdCache.get(xpub);
  if (!hd) {
    hd = HDKey.fromExtendedKey(xpub);
    hdCache.set(xpub, hd);
  }
  return hd;
}

// True when an xpub is configured for this chain — i.e. per-user addresses are
// available. False means callers should fall back to the shared treasury
// address, exactly as before this feature existed.
export function custodyEnabled(chain: string): chain is Chain {
  return chain === "bep20" && hdFor(chain as Chain) != null;
}

// EIP-55 mixed-case checksum, applied to a lowercase 0x address. Mirrors the
// validator in chains.ts (isEip55Valid) but in the encode direction.
function toChecksumAddress(lower: string): string {
  const body = lower.slice(2);
  const hash = bytesToHex(keccak_256(utf8ToBytes(body)));
  let out = "0x";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    out += /[a-f]/.test(c) && parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

// Derive the deposit address at `index` for `chain`. Non-hardened derivation
// from a PUBLIC key only (CKDpub) — deriveChild() on an xpub-sourced HDKey
// never needs, and @scure/bip32 never exposes, a private key here.
//
// ⚠️ TWO LEVELS BELOW THE ACCOUNT XPUB, NOT ONE. config.custodyXpub is at
// m/44'/60'/0' (the account branch); the address a standard EVM wallet shows
// for "index N" lives at m/44'/60'/0'/0/N — an extra "external chain = 0"
// level in between. Deriving `index` directly off the account key silently
// computes a DIFFERENT, non-standard address that no wallet, block explorer,
// or hardware device would ever show you if you browsed to "address N" from
// the same seed — which means nobody could ever independently verify a
// deposit address against the seed itself. Verified against the public BIP39
// test vector (mnemonic "abandon ×11 about" → m/44'/60'/0'/0/0 =
// 0x9858EfFD232B4033E47d90003D41EC34EcaEda94) before this was trusted.
export function deriveAddress(chain: Chain, index: number): string {
  const hd = hdFor(chain);
  if (!hd) throw new Error(`No custody xpub configured for chain "${chain}".`);
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
    throw new Error("Derivation index out of range.");
  }
  const external = hd.deriveChild(0); // "change" = 0, external addresses
  const child = external.deriveChild(index);
  if (!child.publicKey) throw new Error("Derived key has no public key — this should be unreachable.");
  const point = secp256k1.Point.fromHex(bytesToHex(child.publicKey));
  const uncompressed = point.toBytes(false).slice(1); // drop the 0x04 prefix
  const hash = keccak_256(uncompressed);
  const lower = "0x" + bytesToHex(hash.slice(-20));
  return toChecksumAddress(lower);
}
