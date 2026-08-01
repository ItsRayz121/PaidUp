// E2E for "connect wallet" — proving a payout address belongs to the person
// asking to be paid (2026-08-01).
//
// This is the address we send REAL MONEY to, and a payout cannot be undone, so
// the checks below are about exactly one question: can anybody get an address
// marked as proved without holding its private key? Every path that would let
// them is a test here.
//
//   1. THE ADDRESS COMES FROM THE SIGNATURE, NEVER FROM THE REQUEST. A user can
//      claim any address they like when asking for a challenge; what gets saved
//      is what the signature recovers to. If the claim were trusted, the whole
//      feature would be a longer way of pasting a string.
//
//   2. ONE CHALLENGE, ONE USE, ONE OWNER. A signature is a public string — it
//      travels in logs, screenshots and support tickets. So a used challenge is
//      dead, an expired one is dead, and one minted for user A is dead in user
//      B's hands.
//
//   3. SIGNATURE MALLEABILITY IS REPLAY. Every ECDSA signature has a second
//      valid encoding (s -> n-s). Accepting both means "single-use" is a lie:
//      the same approval submits twice in two different forms.
//
//   4. A PROOF IS ABOUT ONE ADDRESS. Typing a new address in must drop the
//      badge — otherwise the app shows "checked" over an address nobody
//      checked, which is worse than showing nothing, because users and staff
//      would both believe it.
//
//   npm run test:wallet
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes, concatBytes } from "@noble/hashes/utils.js";
import { initDb, sql, now, newId, postLedger } from "../db.ts";
import { config } from "../config.ts";
import { withdrawalRoutes } from "../routes/withdrawals.ts";
import { toChecksumAddress, recoverSigner, buildWalletMessage } from "../wallet.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();
const app = Fastify();
await app.register(withdrawalRoutes);

const mkUser = async (label: string) => {
  const id = newId();
  await sql.run(
    "INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at) VALUES (?,?,1,'Pakistan',?,'active',?)",
    id, `${label}-${id}@t.test`, id.slice(0, 8).toUpperCase(), now(),
  );
  return id;
};
const tok = (userId: string) => ({
  authorization: `Bearer ${jwt.sign({ sub: userId }, config.jwtSecret)}`,
});

// ---- A wallet, in about ten lines -------------------------------------------
// The test has to BE the wallet app: hold a key, derive its address, and sign
// what the server asks for the way `personal_sign` does. Doing that here rather
// than importing a helper from src/ is the point — if the server's idea of the
// message and a real wallet's ever drift apart, this is what notices.
type Wallet = { address: string; sign: (message: string, opts?: { v?: number; highS?: boolean }) => string };

function makeWallet(): Wallet {
  const { secretKey, publicKey } = secp256k1.keygen();
  const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false);
  const address = toChecksumAddress("0x" + bytesToHex(keccak_256(uncompressed.slice(1))).slice(-40));

  return {
    address,
    sign(message, opts = {}) {
      const body = utf8ToBytes(message);
      const hash = keccak_256(concatBytes(
        utf8ToBytes(`\x19Ethereum Signed Message:\n${body.length}`), body,
      ));
      const raw = secp256k1.sign(hash, secretKey, { prehash: false });
      const parsed = secp256k1.Signature.fromBytes(raw, "compact");
      // Find the recovery bit by trying both — which is what a signer does.
      let recovery = 0;
      for (const v of [0, 1]) {
        const p = new secp256k1.Signature(parsed.r, parsed.s, v).recoverPublicKey(hash);
        const a = toChecksumAddress("0x" + bytesToHex(keccak_256(p.toBytes(false).slice(1))).slice(-40));
        if (a === address) { recovery = v; break; }
      }
      let { r, s } = parsed;
      if (opts.highS) {
        // The other, equally valid encoding of this exact signature. A wallet
        // never produces it; an attacker replaying a captured one does.
        const N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
        s = N - s;
        recovery ^= 1;
      }
      const v = opts.v ?? (recovery + 27);
      return "0x" + r.toString(16).padStart(64, "0") + s.toString(16).padStart(64, "0")
        + v.toString(16).padStart(2, "0");
    },
  };
}

const challenge = async (userId: string, address: string, chain = "bep20") =>
  app.inject({
    method: "POST", url: "/withdrawals/addresses/challenge",
    headers: tok(userId), payload: { chain, address },
  });
const verify = async (userId: string, nonce: string, signature: string) =>
  app.inject({
    method: "POST", url: "/withdrawals/addresses/verify",
    headers: tok(userId), payload: { nonce, signature },
  });
const savedFor = async (userId: string) =>
  sql.get<{ address: string; verified_at: string | null; verify_method: string | null }>(
    "SELECT address, verified_at, verify_method FROM payout_addresses WHERE user_id = ? AND chain = 'bep20'",
    userId,
  );

const user = await mkUser("walletuser");
const other = await mkUser("walletother");

console.log("\n-- the message the user is asked to approve --");

const alice = makeWallet();
let res = await challenge(user, alice.address);
check("a challenge is issued for a valid address", res.statusCode === 200, res.body);
const first = res.json() as { nonce: string; message: string; expiresAt: string };

check("it names us, so a signature farmed by another site cannot be used here",
  first.message.includes(new URL(config.webOrigins[0]).host), first.message);
check("it shows the wallet being connected, in the form the wallet app displays",
  first.message.includes(alice.address), first.message);
check("it carries a one-time code", first.message.includes(first.nonce), first.message);
check("it says signing moves no money — the one thing every new user fears",
  /does not move any money/i.test(first.message), first.message);

console.log("\n-- the happy path --");

res = await verify(user, first.nonce, alice.sign(first.message));
check("a correct signature is accepted", res.statusCode === 200, res.body);
check("and the response says the wallet is proved", res.json().verified === true, res.body);

let row = await savedFor(user);
check("the address is saved", row?.address === alice.address, JSON.stringify(row));
check("stored in the mixed-case form the user's wallet app shows them",
  row?.address === toChecksumAddress(alice.address), JSON.stringify(row));
check("and marked as proved by signature",
  row?.verified_at != null && row?.verify_method === "signature", JSON.stringify(row));

res = await app.inject({ method: "GET", url: "/withdrawals/addresses", headers: tok(user) });
check("GET /withdrawals/addresses reports it as checked",
  res.json().verified?.bep20 === true, res.body);

console.log("\n-- the address comes from the signature, not from the request --");

// The attack this whole design exists to stop: ask for a challenge naming the
// VICTIM's address, then sign with your own key. If the claim were trusted, the
// victim's address would be marked proved by a stranger — or, run the other way,
// a scammer's address would be marked proved for a victim who signed nothing.
const mallory = makeWallet();
res = await challenge(user, alice.address);
const claimed = res.json() as { nonce: string; message: string };
res = await verify(user, claimed.nonce, mallory.sign(claimed.message));
check("a signature from a different wallet than the one claimed is refused",
  res.statusCode === 400, `${res.statusCode} ${res.body}`);

// The same message, but signed and submitted under Mallory's own claim, works —
// proving the refusal above was about WHICH key signed, not about the message.
res = await challenge(user, mallory.address);
const own = res.json() as { nonce: string; message: string };
res = await verify(user, own.nonce, mallory.sign(own.message));
check("the same wallet succeeds when it is the one being claimed",
  res.statusCode === 200, res.body);
row = await savedFor(user);
check("and connecting a second wallet replaces the first",
  row?.address === mallory.address, JSON.stringify(row));

// Signing something OTHER than what we issued is worthless: the server verifies
// against the message it stored, never against anything the client sends.
res = await challenge(user, alice.address);
const stored = res.json() as { nonce: string; message: string };
const forged = buildWalletMessage({
  host: "evil.example", address: alice.address, chainLabel: "BEP20 (BNB Chain)",
  nonce: stored.nonce, expiresAt: "2099-01-01T00:00:00.000Z",
});
res = await verify(user, stored.nonce, alice.sign(forged));
check("a signature over a message we did not issue is refused",
  res.statusCode === 400, `${res.statusCode} ${res.body}`);

console.log("\n-- one challenge, one use, one owner --");

res = await challenge(user, alice.address);
const single = res.json() as { nonce: string; message: string };
const goodSig = alice.sign(single.message);
res = await verify(user, single.nonce, goodSig);
check("first use of a challenge works", res.statusCode === 200, res.body);
res = await verify(user, single.nonce, goodSig);
check("replaying the SAME signature is refused", res.statusCode === 400, `${res.statusCode} ${res.body}`);

res = await challenge(user, alice.address);
const mine = res.json() as { nonce: string; message: string };
res = await verify(other, mine.nonce, alice.sign(mine.message));
check("another user cannot spend a challenge minted for someone else",
  res.statusCode === 400, `${res.statusCode} ${res.body}`);
check("and nothing was written to their account", (await savedFor(other)) == null);

// Expiry is enforced on read AND on the claim, so a row that ages out between
// the two cannot slip through.
res = await challenge(user, alice.address);
const stale = res.json() as { nonce: string; message: string };
await sql.run("UPDATE wallet_link_nonces SET expires_at = ? WHERE nonce = ?",
  new Date(Date.now() - 60_000).toISOString(), stale.nonce);
res = await verify(user, stale.nonce, alice.sign(stale.message));
check("an expired challenge is refused", res.statusCode === 400, `${res.statusCode} ${res.body}`);

res = await verify(user, "0".repeat(32), "0x" + "11".repeat(65));
check("a challenge that never existed is refused", res.statusCode === 400, `${res.statusCode} ${res.body}`);

console.log("\n-- signatures that are not signatures --");

res = await challenge(user, alice.address);
const junkTarget = res.json() as { nonce: string; message: string };
for (const [label, sig] of [
  ["empty", "0x"],
  ["too short", "0x1234"],
  ["not hex", "0x" + "z".repeat(130)],
  ["all zeroes", "0x" + "00".repeat(65)],
  ["a valid-length signature of nothing", "0x" + "ab".repeat(65)],
] as const) {
  const r = await verify(user, junkTarget.nonce, sig);
  check(`${label} is refused with a 400, not a crash`, r.statusCode === 400, `${r.statusCode} ${r.body}`);
}
// The challenge survived all of that — a wrong signature must not burn it, or
// one fat-fingered wallet choice would send the user back to the start.
res = await verify(user, junkTarget.nonce, alice.sign(junkTarget.message));
check("the challenge still works after failed attempts (a wrong wallet is not an attack)",
  res.statusCode === 200, res.body);

console.log("\n-- signature malleability is replay --");

res = await challenge(user, alice.address);
const mal = res.json() as { nonce: string; message: string };
res = await verify(user, mal.nonce, alice.sign(mal.message, { highS: true }));
check("the flipped (high-S) form of a valid signature is refused",
  res.statusCode === 400, `${res.statusCode} ${res.body}`);
res = await verify(user, mal.nonce, alice.sign(mal.message));
check("while the normal form of the same signature is accepted",
  res.statusCode === 200, res.body);

console.log("\n-- wallets encode v differently, and all of them are real --");

// Most wallets send v as 27/28; a few send 0/1. Both must be read the same way.
//
// ⚠️ THE OUTCOME HERE MUST NOT DEPEND ON THE SIGNATURE. An earlier version of
// this block looped over the four v values against a freshly-signed message
// each time, so which of them was "correct" changed on every run — the suite
// passed either way and told us nothing. The recovery bit is read off the
// signature and the substitution is derived from it, so each case is fixed.
//
// `swap` submits the OTHER recovery bit, which recovers a different address
// entirely and must be refused: half of reading v correctly is rejecting the v
// that does not belong to this signature.
for (const [label, swap, encode] of [
  ["27/28, the common form", false, (bit: number) => bit + 27],
  ["0/1, which some wallets send", false, (bit: number) => bit],
  ["27/28 with the other bit", true, (bit: number) => bit + 27],
  ["0/1 with the other bit", true, (bit: number) => bit],
] as const) {
  const c = await challenge(user, alice.address);
  const { nonce, message } = c.json() as { nonce: string; message: string };
  const sig = alice.sign(message);
  const bit = parseInt(sig.slice(-2), 16) - 27;   // the wallet signed with 27/28
  const v = encode(swap ? bit ^ 1 : bit);
  const r = await verify(user, nonce, sig.slice(0, -2) + v.toString(16).padStart(2, "0"));
  check(
    swap ? `${label} points at another key and is refused` : `${label} is accepted`,
    r.statusCode === (swap ? 400 : 200), `${r.statusCode} ${r.body}`,
  );
}

console.log("\n-- a proof is about ONE address --");

// Re-prove alice, then confirm what does and does not keep the badge.
res = await challenge(user, alice.address);
const reproof = res.json() as { nonce: string; message: string };
await verify(user, reproof.nonce, alice.sign(reproof.message));
check("re-connected", (await savedFor(user))?.verified_at != null);

// Typing a DIFFERENT address in must drop it.
res = await app.inject({
  method: "PUT", url: "/withdrawals/addresses", headers: tok(user),
  payload: { chain: "bep20", address: mallory.address },
});
check("a typed-in address saves", res.statusCode === 200, res.body);
row = await savedFor(user);
check("and it is NOT marked as checked — nobody checked it",
  row?.address === mallory.address && row?.verified_at == null, JSON.stringify(row));

// Re-saving the SAME address (which the auto-save after a withdrawal does on
// every payout) must not throw the proof away.
res = await challenge(user, alice.address);
const keep = res.json() as { nonce: string; message: string };
await verify(user, keep.nonce, alice.sign(keep.message));
res = await app.inject({
  method: "PUT", url: "/withdrawals/addresses", headers: tok(user),
  payload: { chain: "bep20", address: alice.address.toLowerCase() },
});
row = await savedFor(user);
check("saving the same address again keeps the proof (differing only in case)",
  row?.verified_at != null, JSON.stringify(row));

console.log("\n-- the proof reaches whoever approves the payout --");

// Sending USDT on-chain cannot be undone, so the person approving it needs to
// know whether the destination was proved. That answer is SNAPSHOTTED onto the
// request, like the fee is: the saved address can change while a request sits
// in the queue, and a reviewer must see what was true when the user asked.
{
  const payer = await mkUser("walletpayer");
  const w = makeWallet();
  // Fund them through the real ledger helper, not a hand-written INSERT — the
  // balance is SUM(ledger) and this test has no business knowing that shape.
  await postLedger({
    userId: payer, points: 50_000, direction: "credit",
    sourceType: "admin_adjustment", sourceRefId: newId(), note: "e2e funding",
  });
  await sql.run("UPDATE users SET kyc_status = 'approved' WHERE id = ?", payer);

  // Withdrawing to an address that was only ever typed in.
  let r = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(payer),
    payload: { amountPoints: 6000, chain: "bep20", address: w.address },
  });
  check("a withdrawal to a typed-in address is allowed", r.statusCode === 200, r.body);
  let req = await sql.get<{ address_verified: number }>(
    "SELECT address_verified FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", payer);
  check("and it is recorded as NOT proved", req?.address_verified === 0, JSON.stringify(req));

  // Now prove that same wallet, and withdraw again.
  r = await challenge(payer, w.address);
  const c = r.json() as { nonce: string; message: string };
  await verify(payer, c.nonce, w.sign(c.message));
  r = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(payer),
    payload: { amountPoints: 6000, chain: "bep20", address: w.address },
  });
  check("a withdrawal to the proved address is allowed", r.statusCode === 200, r.body);
  req = await sql.get<{ address_verified: number }>(
    "SELECT address_verified FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", payer);
  check("and it IS recorded as proved", req?.address_verified === 1, JSON.stringify(req));

  // THE ATTACK THIS ANSWERS. A user proves their own wallet, then is talked
  // into withdrawing to a stranger's address. Having proved SOMETHING must not
  // make the new destination look checked — the match is on the address.
  const stranger = makeWallet();
  r = await app.inject({
    method: "POST", url: "/withdrawals", headers: tok(payer),
    payload: { amountPoints: 6000, chain: "bep20", address: stranger.address },
  });
  check("withdrawing to a DIFFERENT address is allowed (we never block)", r.statusCode === 200, r.body);
  req = await sql.get<{ address_verified: number }>(
    "SELECT address_verified FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", payer);
  check("but it is NOT proved — proving one wallet proves nothing about another",
    req?.address_verified === 0, JSON.stringify(req));

  // The earlier request must still read as proved: a snapshot that moves is not
  // a snapshot, and the reviewer would be looking at a different fact than the
  // one the user's request was filed under.
  const earlier = await sql.all<{ address_verified: number; payout_address: string }>(
    "SELECT address_verified, payout_address FROM withdrawal_requests WHERE user_id = ? ORDER BY created_at ASC", payer);
  check("the earlier proved request still reads as proved after the address changed",
    earlier[1]?.address_verified === 1, JSON.stringify(earlier));

  r = await app.inject({ method: "GET", url: "/withdrawals", headers: tok(payer) });
  const reqs = r.json().requests as { addressVerified: boolean }[];
  check("the user's own history carries the same flag",
    reqs.filter((x) => x.addressVerified).length === 1, r.body);
}

console.log("\n-- the same gates as the rest of the payout path --");

for (const chain of ["base", "aptos"] as const) {
  const r = await challenge(user, alice.address, chain);
  check(`a challenge on ${chain} is refused — we pay out on BEP20 only`,
    r.statusCode === 400, `${r.statusCode} ${r.body}`);
}
res = await challenge(user, "not-an-address");
check("a challenge for a malformed address is refused before any row is written",
  res.statusCode === 400, `${res.statusCode} ${res.body}`);

console.log("\n-- the recovery itself --");

// Direct unit checks on the verifier, below the HTTP layer.
const w = makeWallet();
const msg = "hello\nthere";
check("recoverSigner returns the signing address, lowercased",
  recoverSigner(msg, w.sign(msg)) === w.address.toLowerCase());
check("recoverSigner returns null on junk rather than throwing",
  recoverSigner(msg, "nonsense") === null);
// Non-ASCII is the classic way a personal_sign implementation breaks: the EIP
// prefix counts BYTES, and a character count silently recovers a stranger.
const utf8 = "PKR ₨ — سلام";
check("a message with non-ASCII characters still recovers correctly",
  recoverSigner(utf8, w.sign(utf8)) === w.address.toLowerCase());
check("EIP-55 checksumming round-trips",
  toChecksumAddress(w.address.toLowerCase()) === w.address);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
