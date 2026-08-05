// Encrypted-at-rest storage for the treasury's on-chain signing key.
//
// ⚠️ THIS KEY CAN MOVE REAL MONEY. It is the one private key this system now
// holds (founder decision 2026-08-05, after being told the alternative — a
// cloud KMS/HSM — costs a small monthly fee and this one doesn't). Same
// AES-256-GCM pattern as kyc.ts, applied to a signing key instead of a photo.
//
// ⚠️ WHAT THIS DOES AND DOES NOT PROTECT AGAINST. Two SEPARATE env vars —
// TREASURY_KEY_ENCRYPTED (the ciphertext) and TREASURY_KEY_SECRET (the AES
// key that unlocks it) — so a leak of ONE alone (a database backup, a single
// leaked variable) is not enough to reconstruct the key. It does NOT protect
// against someone with real Railway dashboard access to THIS service, who can
// read both variables the same way the running process does. That is the gap
// a real KMS closes and this does not — recorded here, not hidden, per
// CUSTODY_SPEC.md § 3. Upgrading to a KMS later means changing this one file.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.ts";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function encryptionKey(): Buffer {
  const raw = config.treasuryKeySecret;
  if (!raw) throw new Error("TREASURY_KEY_SECRET is not set.");
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== 32) {
    throw new Error(
      "TREASURY_KEY_SECRET must be 64 hex characters (32 bytes). Generate one with:\n" +
      `  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return buf;
}

// Encrypt a secret string (a private key, hex). Layout matches kyc.ts exactly:
// base64( iv[12] || tag[16] || ciphertext ) — one well-understood format for
// every encrypted-at-rest secret in this codebase, not a new one per use.
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]).toString("base64");
}

export function decryptSecret(stored: string): string {
  const raw = Buffer.from(stored, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("Encrypted secret is corrupt.");
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, encryptionKey(), iv);
  decipher.setAuthTag(tag);
  // Throws if the tag does not verify — a tampered or wrong-key ciphertext
  // fails loudly instead of silently handing back garbage bytes we would then
  // try to sign a transaction with.
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

let cached: `0x${string}` | null | undefined;

// The treasury's raw private key (0x + 64 hex), decrypted once and held in
// memory for the life of the process. Never logged, never returned by any
// route — the only consumer is payout.ts's onchain send path.
export function treasurySignerKey(): `0x${string}` | null {
  if (cached !== undefined) return cached;
  if (!config.treasuryKeyEncrypted || !config.treasuryKeySecret) {
    cached = null;
    return null;
  }
  const plain = decryptSecret(config.treasuryKeyEncrypted).trim();
  const withPrefix = (plain.startsWith("0x") ? plain : `0x${plain}`) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    throw new Error("Decrypted treasury key is not a valid 32-byte private key.");
  }
  cached = withPrefix;
  return cached;
}
