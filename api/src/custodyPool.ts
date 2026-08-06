// Pre-generated ed25519 address inventory decryption — CUSTODY_SPEC.md § 5,
// steps 2-4 (Solana, Aptos). Split out of custodySeeds.ts on purpose: this is
// the one piece of that file that genuinely needs the database (the pool
// inventory lives in deposit_address_pool), and importing db.ts at module
// scope opens a live connection that never closes — fine for a running
// server, fatal for a pure unit test's process ever exiting (see
// mining.test.ts's header comment for the exact hang this avoids). Keeping
// custodySeeds.ts db-free means its derivation logic can be unit-tested with
// no database at all.
import { decryptSecret, parseAesKeyHex } from "./crypto/aesSecret.ts";
import { config } from "./config.ts";
import { sql } from "./db.ts";

// Decrypt one ed25519 pool row's private key. No caching at module scope —
// unlike the HD seeds, there's no reuse: a given pool address is swept once,
// ever, in the steady state, so there's no benefit to holding it beyond the
// one call that needs it.
export async function poolAddressPrivateKey(poolRowId: string): Promise<string> {
  if (!config.poolKeyEncryptedSecret) {
    throw new Error("POOL_KEY_ENCRYPTED_SECRET is not set.");
  }
  const row = await sql.get<{ private_key_encrypted: string }>(
    "SELECT private_key_encrypted FROM deposit_address_pool WHERE id = ?", poolRowId,
  );
  if (!row) throw new Error(`No pool row ${poolRowId}.`);
  const key = parseAesKeyHex(config.poolKeyEncryptedSecret, "POOL_KEY_ENCRYPTED_SECRET");
  return decryptSecret(row.private_key_encrypted, key).trim();
}
