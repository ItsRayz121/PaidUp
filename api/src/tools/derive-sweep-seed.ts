// OFFLINE TOOL. Run this on your own machine — NEVER on Railway, never
// committed, never pasted into a chat (including this one). It reads your
// seed phrase, derives the sweep-signing key CUSTODY_SEED_EVM_* needs, and
// prints ONLY the two values that are safe to leave your machine: an
// encrypted blob and the key that unlocks it (as two SEPARATE Railway env
// vars, on purpose — see signer.ts's header for why).
//
// Run it exactly like CUSTODY_SPEC.md § 5b-2 always said this step would
// work: derive the SAME account key CUSTODY_XPUB_BEP20 came from — this tool
// prints that xpub back to you so you can confirm it matches what is already
// in Railway BEFORE you use the encrypted key it also prints. If they don't
// match, stop — you used the wrong seed or the wrong path, and setting
// CUSTODY_SEED_EVM_* would derive a private key that does NOT control your
// users' deposit addresses.
//
// Usage (from api/):
//   npx tsx src/tools/derive-sweep-seed.ts
//   npx tsx src/tools/derive-sweep-seed.ts --family tron   (for later, TRC20)
//
// You will be prompted for your recovery phrase (BIP39, 12 or 24 words) at
// the terminal. Nothing you type is written to a file or logged anywhere by
// this script. Do this somewhere private — not over a recorded SSH session,
// not with terminal history/scrollback logging turned on — and close the
// terminal window afterward.
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import { encryptSecret } from "../crypto/aesSecret.ts";

const FAMILY_PATHS: Record<string, string> = {
  evm: "m/44'/60'/0'",   // BEP20 today; other EVM chains share this same key
  tron: "m/44'/195'/0'", // TRC20 — its own account branch, its own env var pair
};

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function promptSecret(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

async function main() {
  const family = argValue("--family") ?? "evm";
  const path = FAMILY_PATHS[family];
  if (!path) {
    console.error(`Unknown --family "${family}". Known: ${Object.keys(FAMILY_PATHS).join(", ")}`);
    process.exit(1);
  }

  console.log(`\nDeriving the ${family.toUpperCase()} sweep-signing key at ${path}.\n`);
  const mnemonic = await promptSecret("Recovery phrase (12 or 24 words, space-separated): ");

  if (!validateMnemonic(mnemonic, wordlist)) {
    console.error("\nThat is not a valid BIP39 recovery phrase (bad word or checksum). Nothing was derived.");
    process.exit(1);
  }

  const seed = mnemonicToSeedSync(mnemonic);
  const account = HDKey.fromMasterSeed(seed).derive(path);
  const xpub = account.publicExtendedKey;
  const xprv = account.privateExtendedKey;

  // A fresh key for THIS secret only — never reuse TREASURY_KEY_SECRET or any
  // other CUSTODY_SEED_*_SECRET (see aesSecret.ts's header for why one shared
  // key is a strictly worse blast radius than several separate ones).
  const aesKey = randomBytes(32);
  const encrypted = encryptSecret(xprv, aesKey);

  console.log("\n" + "=".repeat(78));
  console.log("STEP 1 — VERIFY THIS FIRST. Does this match the value already in Railway");
  console.log(`for CUSTODY_XPUB_${family.toUpperCase()}? If it does not match exactly, STOP —`);
  console.log("do not set the env vars below. You used the wrong phrase or the wrong");
  console.log("--family, and the key below would not control your real deposit addresses.");
  console.log("-".repeat(78));
  console.log(xpub);
  console.log("=".repeat(78));
  console.log("\nSTEP 2 — Only once STEP 1 matches, set these TWO Railway env vars:");
  console.log("-".repeat(78));
  console.log(`CUSTODY_SEED_${family.toUpperCase()}_ENCRYPTED=${encrypted}`);
  console.log(`CUSTODY_SEED_${family.toUpperCase()}_SECRET=${aesKey.toString("hex")}`);
  console.log("=".repeat(78));
  console.log(
    "\nThat's the whole output. Close this terminal when you're done — nothing\n" +
    "above was written to disk, and this process holds none of it once it exits.\n",
  );
}

await main();
