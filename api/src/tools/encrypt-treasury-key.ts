// OFFLINE TOOL. Run this on your own machine — NEVER on Railway, never
// committed, never pasted into a chat (including this one). It takes the
// treasury wallet's raw private key and prints ONLY the two values that are
// safe to leave your machine: an encrypted blob and the key that unlocks it
// (as two SEPARATE Railway env vars — see signer.ts's header for why).
//
// This wallet must be a NEW one, generated separately from the seed phrase
// CUSTODY_XPUB_BEP20 / CUSTODY_SEED_EVM_* came from — not the same wallet.
// Its only job is holding and sending USDT + BNB.
//
// ⚠️ THE MOMENT THIS IS SET ON RAILWAY AND THE WALLET HOLDS EVEN A LITTLE
// BNB, SWEEPING GOES LIVE FOR REAL on the next scan tick (~20s later): it
// will send real BNB from this wallet to fund gas on deposit addresses, then
// real USDT from those addresses into this one. That is separate from
// PAYOUT_MODE, which stays "manual" and only gates WITHDRAWALS going back
// out — deposit sweeping is not gated behind it. Fund this wallet with a
// small amount first if you want to watch one sweep happen before trusting
// it with more.
//
// Usage (from api/):
//   npx tsx src/tools/encrypt-treasury-key.ts
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { encryptSecret } from "../crypto/aesSecret.ts";

async function promptSecret(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

async function main() {
  console.log("\nEncrypting the treasury wallet's private key.\n");
  const raw = await promptSecret("Treasury wallet private key (0x + 64 hex characters): ");
  const withPrefix = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;

  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    console.error("\nThat is not a 32-byte private key (should be 0x followed by 64 hex characters). Nothing was encrypted.");
    process.exit(1);
  }

  let address: string;
  try {
    address = privateKeyToAccount(withPrefix).address;
  } catch {
    console.error("\nThat key did not produce a valid address. Nothing was encrypted.");
    process.exit(1);
  }

  const aesKey = randomBytes(32);
  const encrypted = encryptSecret(withPrefix, aesKey);

  console.log("\n" + "=".repeat(78));
  console.log("STEP 1 — VERIFY THIS FIRST. Does this address match the wallet you generated");
  console.log("(check it in MetaMask / Trust Wallet / your hardware wallet)? If it does not");
  console.log("match, STOP — you pasted the wrong key.");
  console.log("-".repeat(78));
  console.log(address);
  console.log("=".repeat(78));
  console.log("\nSTEP 2 — Only once STEP 1 matches, set these TWO Railway env vars:");
  console.log("-".repeat(78));
  console.log(`TREASURY_KEY_ENCRYPTED=${encrypted}`);
  console.log(`TREASURY_KEY_SECRET=${aesKey.toString("hex")}`);
  console.log("=".repeat(78));
  console.log(
    "\nThat's the whole output. Close this terminal when you're done — nothing\n" +
    "above was written to disk, and this process holds none of it once it exits.\n",
  );
}

await main();
