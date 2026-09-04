// E2E for one-time email codes: single use, the attempts cap, and both of those
// under GENUINE concurrency.
//
// WHY THIS FILE EXISTS
// --------------------
// The audit of 2026-09-04 fired twelve simultaneous confirmations of ONE valid code
// at a running API backed by real PostgreSQL. FOUR were accepted. `consumeCode`
// (auth.ts) was a read-check-blind-write: every caller read the same `consumed = 0`
// row, every one matched the hash, and every one wrote `consumed = 1` over the
// others. Finding A-14; raw output in `audit/results/race-tests.txt`.
//
// THE REASON NO EXISTING SUITE CAUGHT IT, AND THE REASON THIS FILE IS SHAPED THE
// WAY IT IS: run this sequence one request at a time and the OLD code is correct —
// the first call flips `consumed`, the second's `WHERE consumed = 0` finds nothing.
// PGlite is a single-connection embedded Postgres, so it serialises every
// concurrent call and makes the broken version look right. A test that only ran on
// PGlite could never fail, no matter how it was written.
//
// So this file does three separate things:
//   1. Functional checks that run on ANY driver (normal single use, wrong code,
//      expiry, the cap) — these guard against the fix breaking ordinary behaviour.
//   2. The real races, run ONLY when DATABASE_URL points at real Postgres, where
//      each call gets its own pooled connection.
//   3. A STRUCTURAL TRIPWIRE that reads auth.ts's own source and asserts the two
//      atomic predicates are still there. This is the part that has teeth on
//      PGlite: it cannot prove the fix works, but it can prove the fix has not
//      been deleted by someone "simplifying" a read-then-write back into place
//      under a driver that cannot punish them for it. Same idea as
//      mining.e2e.ts's LOCKED_PATHS list.
//
//   npm run test:otprace                               # functional + tripwire
//   DATABASE_URL=postgres://... npm run test:otprace    # the above PLUS the races
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { initDb, sql, now, newId, usingRealPostgres } from "../db.ts";
import { config } from "../config.ts";
import { consumeCode } from "../auth.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();

const hashCode = (c: string) => createHash("sha256").update(`${c}:${config.otpPepper}`).digest("hex");
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
let seq = 0;

// Plant a code directly. Deliberately NOT via issueCode(), which sends email.
async function plant(opts: {
  code: string;
  purpose?: "verify" | "reset" | "link" | "withdraw";
  ttlMs?: number;
  attempts?: number;
  pendingPasswordHash?: string | null;
}) {
  const email = `otprace-${Date.now()}-${++seq}@audit.local`;
  await sql.run(
    "INSERT INTO email_codes (id, email, code_hash, purpose, pending_password_hash, expires_at, attempts, consumed, created_at) VALUES (?,?,?,?,?,?,?,0,?)",
    newId(), email, hashCode(opts.code), opts.purpose ?? "verify",
    opts.pendingPasswordHash ?? "scrypt$test$hash",
    iso(opts.ttlMs ?? 10 * 60_000), opts.attempts ?? 0, now(),
  );
  return email;
}
const rowOf = (email: string) => sql.get<{ attempts: number; consumed: number }>(
  "SELECT attempts, consumed FROM email_codes WHERE email = ?", email);

console.log("\n-- ordinary behaviour (every driver) --");
{
  const email = await plant({ code: "111111", pendingPasswordHash: "scrypt$bound$pw" });
  const first = await consumeCode(email, "111111", "verify");
  check("a correct code is accepted", first.ok === true);
  check("the bound password rides back on it",
    first.ok === true && first.pendingPasswordHash === "scrypt$bound$pw");
  check("the row is marked consumed", Number((await rowOf(email))?.consumed) === 1);

  // The same code again. This is the sequential case the old code also got right;
  // it is here so a future change cannot break it while fixing something else.
  const second = await consumeCode(email, "111111", "verify");
  check("the SAME code a second time is refused", second.ok === false);
  check("...and is refused with 400, not a server error",
    second.ok === false && second.statusCode === 400);
}
{
  const email = await plant({ code: "222222" });
  const wrong = await consumeCode(email, "999999", "verify");
  check("a wrong code is refused", wrong.ok === false && wrong.statusCode === 400);
  check("a wrong code increments attempts", Number((await rowOf(email))?.attempts) === 1);
  check("a wrong code does NOT consume the code", Number((await rowOf(email))?.consumed) === 0);
  const right = await consumeCode(email, "222222", "verify");
  check("the correct code still works after a wrong guess", right.ok === true);
}
{
  const email = await plant({ code: "333333", ttlMs: -1000 });
  const expired = await consumeCode(email, "333333", "verify");
  check("an expired code is refused even though it matches", expired.ok === false);
  check("an expired code is burned so it cannot be retried",
    Number((await rowOf(email))?.consumed) === 1);
}
{
  const email = await plant({ code: "444444", attempts: config.otpMaxAttempts });
  const capped = await consumeCode(email, "444444", "verify");
  check("a code already at the attempts cap is refused with 429",
    capped.ok === false && capped.statusCode === 429);
  check("...and is burned", Number((await rowOf(email))?.consumed) === 1);
}
{
  // Walk the cap one guess at a time: the guess that reaches the cap must burn it.
  const email = await plant({ code: "555555" });
  const seen: number[] = [];
  for (let i = 0; i < config.otpMaxAttempts; i++) {
    const r = await consumeCode(email, "000000", "verify");
    seen.push(r.ok === false ? r.statusCode : 200);
  }
  check(`${config.otpMaxAttempts} wrong guesses end in a 429`,
    seen[seen.length - 1] === 429, seen.join(","));
  check("the code is burned once the cap is reached",
    Number((await rowOf(email))?.consumed) === 1);
  const after = await consumeCode(email, "555555", "verify");
  check("the CORRECT code no longer works once the cap burned it", after.ok === false);
}
{
  // Every purpose shares this code path; a fix that only covered `verify` would
  // leave the money-adjacent one (`withdraw`) broken.
  for (const purpose of ["reset", "link", "withdraw"] as const) {
    const email = await plant({ code: "666666", purpose });
    const a = await consumeCode(email, "666666", purpose);
    const b = await consumeCode(email, "666666", purpose);
    check(`purpose "${purpose}": accepted once, refused twice`,
      a.ok === true && b.ok === false);
  }
}

console.log("\n-- the race (needs real Postgres) --");
if (usingRealPostgres) {
  {
    const N = 12;
    const email = await plant({ code: "777777" });
    const rs = await Promise.all(
      Array.from({ length: N }, () => consumeCode(email, "777777", "verify")));
    const accepted = rs.filter((r) => r.ok).length;
    check(`${N} SIMULTANEOUS confirmations of one code accept exactly ONE`,
      accepted === 1, `${accepted} accepted`);
    check("the row is consumed exactly once", Number((await rowOf(email))?.consumed) === 1);
    check("every loser gets a 400/429, never a 500",
      rs.every((r) => r.ok || r.statusCode === 400 || r.statusCode === 429));
  }
  {
    // The other half of A-14: `attempts` was compared against a value read BEFORE
    // the increment, so a burst of wrong guesses all saw 0 and walked past the cap.
    const N = 12;
    const email = await plant({ code: "888888" });
    await Promise.all(Array.from({ length: N }, () => consumeCode(email, "000000", "verify")));
    const row = await rowOf(email);
    check(`${N} simultaneous wrong guesses cannot leave the code alive past the ${config.otpMaxAttempts}-attempt cap`,
      Number(row?.consumed) === 1, `attempts=${row?.attempts} consumed=${row?.consumed}`);
    const after = await consumeCode(email, "888888", "verify");
    check("...and the code is dead afterwards, even for the correct value",
      after.ok === false, JSON.stringify(after));
  }
  {
    // A burst carrying the correct code mixed with wrong ones. Only the right one
    // may win, and it may win only once.
    const email = await plant({ code: "999999" });
    const codes = ["000000", "999999", "111111", "999999", "222222", "999999"];
    const rs = await Promise.all(codes.map((c) => consumeCode(email, c, "withdraw")));
    check("a mixed burst accepts at most one, and only for the right code",
      rs.filter((r) => r.ok).length <= 1, `${rs.filter((r) => r.ok).length} accepted`);
  }
} else {
  console.log("  skip the concurrency checks — PGlite is single-connection, so it");
  console.log("  serialises the very interleaving this race needs, and the BROKEN");
  console.log("  version would pass. Set DATABASE_URL to real Postgres to run them.");
}

console.log("\n-- structural tripwire (every driver) --");
{
  // Read the real source. This is what protects the fix on a driver that cannot
  // exercise it: if someone turns either write back into a blind one, this fails
  // here rather than silently in production under load.
  const src = readFileSync(new URL("../auth.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export async function consumeCode"));
  const body = fn.slice(0, fn.indexOf("\n}"));

  check("the claim is conditional on consumed = 0 and returns the row it claimed",
    /UPDATE email_codes SET consumed = 1 WHERE id = \? AND consumed = 0 RETURNING/.test(body));
  check("the attempts counter is read back from the increment, not from before it",
    /SET attempts = attempts \+ 1 WHERE id = \? AND consumed = 0 RETURNING attempts/.test(body));
  check("success never comes from the pre-read row's pending_password_hash",
    !/pendingPasswordHash:\s*row\.pending_password_hash/.test(body));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
