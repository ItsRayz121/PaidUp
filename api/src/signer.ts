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
//
// The AES machinery itself lives in crypto/aesSecret.ts (extracted 2026-08-06
// so custodySeeds.ts can back further secret classes with the SAME pattern
// but their OWN keys — see that file's header for why they must not share one).
import { encryptSecret as encrypt, decryptSecret as decrypt, parseAesKeyHex } from "./crypto/aesSecret.ts";
import { config } from "./config.ts";

function encryptionKey(): Buffer {
  if (!config.treasuryKeySecret) throw new Error("TREASURY_KEY_SECRET is not set.");
  return parseAesKeyHex(config.treasuryKeySecret, "TREASURY_KEY_SECRET");
}

export function encryptSecret(plaintext: string): string {
  return encrypt(plaintext, encryptionKey());
}

export function decryptSecret(stored: string): string {
  return decrypt(stored, encryptionKey());
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
