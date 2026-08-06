// E2E for the deposit crediting path (CUSTODY_SPEC.md § 5 step 2) —
// deposits/credit.ts's recordObservedDeposit(), which both the poller
// (deposits/scanner.ts) and any future webhook are meant to call exclusively.
//
// This does NOT exercise the real chain listener (deposits/scanner.ts) or the
// sweeper (deposits/sweep.ts) — those need a real or test-net RPC endpoint
// and a broadcastable signer, exactly the kind of thing autoWithdraw.e2e.ts's
// own header explains is deliberately out of scope for an offline suite. What
// IS testable offline, and is tested here, is the part that actually decides
// whether money moves: idempotency (a duplicate event must never double-pay)
// and the reorg re-check (a block that changed underneath a deposit must
// never be credited). global.fetch is stubbed to answer the one RPC call
// credit.ts makes (eth_getBlockByNumber) with a canned, deterministic
// response — no real network, no flakiness.
//
//   npm run test:deposits
import { initDb, sql, now, newId, usdtBalanceMicroOf } from "../db.ts";
import { recordObservedDeposit } from "../deposits/credit.ts";
import type { ObservedDeposit } from "../deposits/types.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();

// The block hash the stub reports for a given block number — set per test so
// the "reorg happened underneath this deposit" scenario can change the
// answer between when a deposit is first observed and when it's re-checked.
let blockHashByNumber = new Map<number, string>();

const realFetch = globalThis.fetch;
// @ts-expect-error test stub — narrower signature than the real fetch
globalThis.fetch = async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body as string);
  if (body.method === "eth_getBlockByNumber") {
    const blockNumber = parseInt(body.params[0], 16);
    const hash = blockHashByNumber.get(blockNumber);
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: hash ? { hash } : null }),
    };
  }
  throw new Error(`Unexpected RPC method in test stub: ${body.method}`);
};

// A fresh, collision-free address each call — this test's PGlite data
// persists to disk across runs (api/data/pg), so anything hardcoded (a
// literal address, a fixed index) collides with a PREVIOUS run's rows the
// second time this file executes. newId()-derived values are unique forever.
function testAddress(): string {
  return "0x" + newId().replace(/-/g, "").padEnd(40, "0").slice(0, 40);
}

async function mkUserWithDeposit(chain: string, address: string): Promise<string> {
  const id = newId();
  await sql.run(
    "INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at) VALUES (?,?,1,'Pakistan',?,'active',?)",
    id, `dep-${id}@t.test`, id.slice(0, 8).toUpperCase(), now(),
  );
  const idxRow = await sql.get<{ nextval: string }>("SELECT nextval('deposit_wallet_index_seq') AS nextval");
  await sql.run(
    "INSERT INTO deposit_wallets (user_id, chain, addr_index, address, created_at) VALUES (?,?,?,?,?)",
    id, chain, Number(idxRow!.nextval), address, now(),
  );
  return id;
}

function mkDeposit(overrides: Partial<ObservedDeposit> & { userId: string; address: string }): ObservedDeposit {
  return {
    chain: "bep20",
    txHash: `0x${newId().replace(/-/g, "")}`.padEnd(66, "0").slice(0, 66),
    logIndex: 0,
    amountMicro: 5_000_000n, // 5 USDT
    token: "usdt",
    blockNumber: 1000,
    blockHash: "0xaaaa",
    ...overrides,
  };
}

console.log("\n-- a brand-new deposit, block hash unchanged: credits exactly once --");

{
  const address = testAddress();
  const userId = await mkUserWithDeposit("bep20", address);
  const before = await usdtBalanceMicroOf(userId);

  const dep = mkDeposit({ userId, address, blockNumber: 2000, blockHash: "0xbeef" });
  blockHashByNumber.set(2000, "0xbeef"); // the chain still agrees this block's hash is what we saw

  const result = await recordObservedDeposit(dep, 15);
  check("status is 'credited'", result.status === "credited", JSON.stringify(result));

  const after = await usdtBalanceMicroOf(userId);
  check("the ledger credited exactly the observed amount", after - before === 5_000_000, `${before} -> ${after}`);

  const row = await sql.get<{ status: string; credited_ledger_id: string | null }>(
    "SELECT status, credited_ledger_id FROM chain_deposits WHERE id = ?", result.id,
  );
  check("the chain_deposits row is 'credited' with a ledger id attached",
    row?.status === "credited" && !!row?.credited_ledger_id, JSON.stringify(row));
}

console.log("\n-- the SAME event observed twice (poller re-run, or a webhook racing it) --");

{
  const address = testAddress();
  const userId = await mkUserWithDeposit("bep20", address);
  const blockNumber = 3000 + Math.floor(Math.random() * 1_000_000);
  const dep = mkDeposit({ userId, address, blockNumber, blockHash: "0xc0de" });
  blockHashByNumber.set(blockNumber, "0xc0de");

  const first = await recordObservedDeposit(dep, 15);
  const second = await recordObservedDeposit(dep, 15); // identical tx hash + log index
  check("first call credits", first.status === "credited");
  check("second call is a no-op, not a second credit", second.status === "already_credited");
  check("same chain_deposits row both times", first.id === second.id);

  const balance = await usdtBalanceMicroOf(userId);
  check("the user was paid EXACTLY ONCE, not twice", balance === 5_000_000, String(balance));

  const ledgerRows = await sql.all(
    "SELECT id FROM usdt_ledger WHERE source_ref_id = ?", first.id,
  );
  check("exactly one ledger row exists for this deposit", ledgerRows.length === 1, String(ledgerRows.length));
}

console.log("\n-- a DIFFERENT log index in the SAME transaction is a SEPARATE deposit --");

{
  // One EVM tx can carry several Transfer events to different known
  // addresses (e.g. a router splitting a payment). log_index is part of the
  // idempotency key specifically so these do not collide into one credit.
  const addrA = testAddress();
  const addrB = testAddress();
  const userA = await mkUserWithDeposit("bep20", addrA);
  const userB = await mkUserWithDeposit("bep20", addrB);
  const sharedTx = `0x${newId().replace(/-/g, "")}`.padEnd(66, "0").slice(0, 66);
  const blockNumber = 4000 + Math.floor(Math.random() * 1_000_000);
  blockHashByNumber.set(blockNumber, "0xf00d");

  const depA = mkDeposit({ userId: userA, address: addrA, txHash: sharedTx, logIndex: 0, blockNumber, blockHash: "0xf00d" });
  const depB = mkDeposit({ userId: userB, address: addrB, txHash: sharedTx, logIndex: 1, blockNumber, blockHash: "0xf00d" });

  const rA = await recordObservedDeposit(depA, 15);
  const rB = await recordObservedDeposit(depB, 15);
  check("both credit, as two distinct rows", rA.status === "credited" && rB.status === "credited" && rA.id !== rB.id);
  check("user A was paid", (await usdtBalanceMicroOf(userA)) === 5_000_000);
  check("user B was paid too — the shared tx hash did not collide them", (await usdtBalanceMicroOf(userB)) === 5_000_000);
}

console.log("\n-- a reorg underneath an unconfirmed deposit: NEVER credited --");

{
  const address = testAddress();
  const userId = await mkUserWithDeposit("bep20", address);
  const blockNumber = 5000 + Math.floor(Math.random() * 1_000_000);
  const dep = mkDeposit({ userId, address, blockNumber, blockHash: "0xdead" });
  // The chain's CURRENT answer for this block no longer matches what we saw
  // when the deposit was first observed — a reorg happened.
  blockHashByNumber.set(blockNumber, "0xdifferent");

  const result = await recordObservedDeposit(dep, 15);
  check("status is 'reorged_out'", result.status === "reorged_out", JSON.stringify(result));
  check("NOTHING was credited", (await usdtBalanceMicroOf(userId)) === 0);

  // Re-processing the same (now reorged) event again must stay refused, not
  // flip-flop based on which check runs first.
  const again = await recordObservedDeposit(dep, 15);
  check("re-processing a reorged event stays reorged_out, forever", again.status === "reorged_out");
  check("still nothing credited", (await usdtBalanceMicroOf(userId)) === 0);
}

console.log("\n-- the block simply no longer exists at that height (deep reorg / stub gap) --");

{
  const address = testAddress();
  const userId = await mkUserWithDeposit("bep20", address);
  const blockNumber = 6000 + Math.floor(Math.random() * 1_000_000);
  const dep = mkDeposit({ userId, address, blockNumber, blockHash: "0xghost" });
  // Deliberately no entry in blockHashByNumber for this block => stub returns
  // null, same as an RPC node that has never heard of this block.
  const result = await recordObservedDeposit(dep, 15);
  check("a missing block is treated as reorged_out, not credited on a null",
    result.status === "reorged_out", JSON.stringify(result));
  check("nothing credited", (await usdtBalanceMicroOf(userId)) === 0);
}

globalThis.fetch = realFetch;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
