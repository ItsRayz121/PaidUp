// Generic AES-256-GCM encrypt/decrypt for "one secret, one env-var-held key"
// storage. Extracted from signer.ts (2026-08-05) so it can back MULTIPLE
// independent secret classes — the treasury key, chain sweep-signing seeds,
// pool-address private keys — each with its OWN key, not a shared one.
//
// ⚠️ WHY NOT ONE SHARED AES KEY FOR EVERYTHING: a single leaked "master AES
// secret" would unlock the treasury key AND every deposit address's spending
// key AND the whole ed25519 pool at once. Callers each pass their own
// `keyHex` (from their own pair of env vars) precisely so a leak of one
// secret's unlocking key does not also open the others.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

// Parse and validate a 32-byte AES key given as 64 hex chars. `label` names
// the offending env var in the error so a misconfigured deploy points
// straight at the fix instead of a bare "invalid key length".
export function parseAesKeyHex(raw: string, label: string): Buffer {
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== 32) {
    throw new Error(
      `${label} must be 64 hex characters (32 bytes). Generate one with:\n` +
      `  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return buf;
}

// Layout: base64( iv[12] || tag[16] || ciphertext ). One well-understood
// format for every encrypted-at-rest secret in this codebase (kyc.ts,
// signer.ts, and now everything in custodySeeds.ts), not a new one per use.
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]).toString("base64");
}

export function decryptSecret(stored: string, key: Buffer): string {
  const raw = Buffer.from(stored, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("Encrypted secret is corrupt.");
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  // Throws if the tag does not verify — a tampered or wrong-key ciphertext
  // fails loudly instead of silently handing back garbage bytes we would then
  // try to sign a transaction with.
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}
