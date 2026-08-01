// Proving a payout address belongs to the person asking to be paid.
//
// WHY THIS EXISTS, and it is not autofill. Until now a payout address was a
// string somebody typed into a box. Every check we had was a check on the
// STRING: 42 characters, valid hex, and an EIP-55 checksum that only exists
// when the address happens to be mixed-case. None of that can tell the
// difference between a user's own wallet and an address a "support agent" sent
// them on WhatsApp — which is the single most common way money is stolen from
// users in our launch markets, and it is unrecoverable once we send.
//
// A signature is different in kind: it proves whoever asked for the payout holds
// the private key of the address we are about to send real money to. The scam
// above stops working, because the scammer's address cannot be signed for by the
// victim's wallet.
//
// ⚠️ NO PRIVATE KEY ENTERS THIS SYSTEM, and that is the whole point of doing it
// this way. The user's wallet app signs; we only ever see a public signature and
// recover a public address from it. This file adds ZERO custody
// (docs/CUSTODY_SPEC.md § 2c is untouched by it).
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes, concatBytes } from "@noble/hashes/utils.js";

// EIP-55: the mixed-case form of an address, where the capitalisation is itself
// a checksum. We store and display this form so a user comparing what we show
// against their wallet app sees the identical string.
export function toChecksumAddress(addressRaw: string): string {
  const body = addressRaw.trim().replace(/^0x/i, "").toLowerCase();
  const hash = bytesToHex(keccak_256(utf8ToBytes(body)));
  let out = "0x";
  for (let i = 0; i < body.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? body[i].toUpperCase() : body[i];
  }
  return out;
}

// The address of a public key point, EVM-style: last 20 bytes of the keccak of
// the uncompressed key with its 0x04 prefix removed.
function addressFromPublicKey(uncompressed: Uint8Array): string {
  return "0x" + bytesToHex(keccak_256(uncompressed.slice(1))).slice(-40);
}

// EIP-191 "personal sign": what every wallet's `personal_sign` actually hashes.
// The prefix is what stops a signed login message from ever being a valid
// TRANSACTION — a wallet will not sign raw bytes that could be one.
//
// ⚠️ The length is the BYTE length, not the character count. They differ the
// moment the message contains anything outside ASCII, and a mismatch does not
// error — it silently recovers a DIFFERENT address, so every signature is
// rejected and nobody can work out why.
function personalSignHash(message: string): Uint8Array {
  const body = utf8ToBytes(message);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${body.length}`);
  return keccak_256(concatBytes(prefix, body));
}

// Recover the address that signed `message`, or null if the signature is not
// well-formed. Never throws: this runs on user-supplied input.
//
// Returns the address in lowercase — callers compare addresses, and comparing
// mixed-case EIP-55 strings is a bug waiting to be written.
export function recoverSigner(message: string, signatureRaw: string): string | null {
  try {
    const hex = signatureRaw.trim().replace(/^0x/i, "");
    // r (32) + s (32) + v (1). Exactly 65 bytes; anything else is not a
    // personal_sign result.
    if (!/^[0-9a-fA-F]{130}$/.test(hex)) return null;

    const r = BigInt("0x" + hex.slice(0, 64));
    const s = BigInt("0x" + hex.slice(64, 128));
    let v = parseInt(hex.slice(128, 130), 16);
    // v arrives as 27/28 from most wallets, 0/1 from a few, and 35+chainId*2
    // under EIP-155 from wallets that reuse their transaction signer. Normalise
    // to the 0/1 recovery bit; anything else is not a signature we can read.
    if (v >= 35) v = (v - 35) % 2;
    else if (v >= 27) v -= 27;
    if (v !== 0 && v !== 1) return null;

    // Reject the high-S half of the curve. Every signature has a second, equally
    // valid form with s' = n - s, so accepting both means one signature has two
    // encodings — and a single-use challenge that can be replayed in its other
    // form is not single-use. Wallets emit low-S; nothing legitimate is lost.
    const sig = new secp256k1.Signature(r, s, v);
    if (sig.hasHighS()) return null;

    const point = sig.recoverPublicKey(personalSignHash(message));
    return addressFromPublicKey(point.toBytes(false)).toLowerCase();
  } catch {
    // Malformed r/s, a point not on the curve — all of it is just "no".
    return null;
  }
}

// The exact words the user sees inside their wallet before they tap Sign, and
// the only defence against the oldest trick in this space: a hostile site
// showing "sign in" and collecting a signature that means something else.
//
// Three things are load-bearing here and none of them are decoration:
//   1. IT SAYS WHAT IT DOES, in the app's plain English. A user who cannot read
//      what they are approving is not approving anything.
//   2. IT NAMES US. A signature harvested by another site cannot be replayed
//      here, because the message it produced does not carry our host — and the
//      host in the string is ours, from config, never anything the client sent.
//   3. IT CARRIES A ONE-TIME CODE. Even our own message, signed once, cannot be
//      submitted twice (see the used_at claim in routes/withdrawals.ts).
export function buildWalletMessage(opts: {
  host: string;
  address: string;
  chainLabel: string;
  nonce: string;
  expiresAt: string;
}): string {
  return [
    `${opts.host} — check this wallet is yours`,
    "",
    "Signing is free. It does not move any money, and it does not",
    `let ${opts.host} spend anything from your wallet.`,
    "",
    "It sets this wallet as the place we send your USDT.",
    "",
    `Wallet: ${toChecksumAddress(opts.address)}`,
    `Network: ${opts.chainLabel}`,
    `One-time code: ${opts.nonce}`,
    `Good until: ${opts.expiresAt}`,
  ].join("\n");
}
