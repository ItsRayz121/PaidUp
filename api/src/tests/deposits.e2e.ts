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
import { recordObservedNativeDeposit } from "../deposits/creditNative.ts";
import { scanEvmChain } from "../deposits/adapters/evm.ts";
import { scanEvmNativeChain } from "../deposits/adapters/evmNative.ts";
import type { ObservedDeposit, ObservedNativeDeposit } from "../deposits/types.ts";

// Several fixtures here carry bigints (amountWei) — plain JSON.stringify
// throws on those, and it is evaluated eagerly as a check() argument even on
// a passing check, so every diagnostic string in this file must go through
// this instead of the raw global.
function safeJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val));
}

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
// Full block bodies, for eth_getBlockByNumber(..., true) — only the native
// scanner (evmNative.ts) asks for these; the reorg re-check (credit.ts,
// creditNative.ts) always asks with `false` and only wants the hash above.
let fullBlockByNumber = new Map<number, { number: string; hash: string; transactions: unknown[] }>();
// eth_getLogs fixtures — a provider "range too wide" limit (blocks) and the
// logs to hand back once a request's window is within it, so the adaptive
// range-shrinking in evm.ts's scanEvmChain has something real to recover.
let logsProviderLimit = 1_000_000; // effectively unlimited unless a test lowers it
let logsFixture: { transactionHash: string; logIndex: string; data: string; topics: string[]; blockNumber: string; blockHash: string }[] = [];

const realFetch = globalThis.fetch;
// @ts-expect-error test stub — narrower signature than the real fetch
globalThis.fetch = async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body as string);
  if (body.method === "eth_getBlockByNumber") {
    const blockNumber = parseInt(body.params[0], 16);
    if (body.params[1] === true) {
      const block = fullBlockByNumber.get(blockNumber);
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: block ?? null }) };
    }
    const hash = blockHashByNumber.get(blockNumber);
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: hash ? { hash } : null }),
    };
  }
  if (body.method === "eth_getLogs") {
    const [{ fromBlock, toBlock, topics }] = body.params;
    const from = parseInt(fromBlock, 16), to = parseInt(toBlock, 16);
    if (to - from + 1 > logsProviderLimit) {
      return {
        ok: true, status: 200,
        json: async () => ({
          jsonrpc: "2.0", id: 1,
          error: { code: -32005, message: `eth_getLogs is limited to a ${logsProviderLimit} range` },
        }),
      };
    }
    const addrTopics: string[] = topics[2] ?? [];
    const matches = logsFixture.filter((l) => {
      const bn = parseInt(l.blockNumber, 16);
      return addrTopics.includes(l.topics[2]) && bn >= from && bn <= to;
    });
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: matches }) };
  }
  throw new Error(`Unexpected RPC method in test stub: ${body.method}`);
};

function addrTopic(addr: string): string {
  return "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

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

console.log("\n-- native (BNB) deposit: recorded and confirmed, NO ledger touched --");

{
  const address = testAddress();
  const userId = await mkUserWithDeposit("bep20", address);
  const blockNumber = 7000 + Math.floor(Math.random() * 1_000_000);
  blockHashByNumber.set(blockNumber, "0xnative1");
  const dep: ObservedNativeDeposit = {
    userId, chain: "bep20", address,
    txHash: `0x${newId().replace(/-/g, "")}`.padEnd(66, "0").slice(0, 66),
    fromAddress: testAddress(), amountWei: 250_000_000_000_000_000n, // 0.25 BNB
    blockNumber, blockHash: "0xnative1",
  };

  const result = await recordObservedNativeDeposit(dep);
  check("status is 'confirmed'", result.status === "confirmed", safeJson(result));

  const row = await sql.get<{ status: string; amount_wei: string }>(
    "SELECT status, amount_wei FROM native_deposits WHERE id = ?", result.id,
  );
  check("native_deposits row is 'confirmed' with the observed amount",
    row?.status === "confirmed" && row?.amount_wei === "250000000000000000", safeJson(row));

  // The whole point of this table: it NEVER touches a balance. usdt_ledger
  // must be untouched by a BNB deposit — mixing the two would be exactly the
  // guardrail #7-shaped bug this file's header warns against.
  check("the USDT ledger balance is untouched by a BNB deposit", (await usdtBalanceMicroOf(userId)) === 0);
}

console.log("\n-- native (BNB) deposit: same tx observed twice is a no-op, not two rows --");

{
  const address = testAddress();
  const userId = await mkUserWithDeposit("bep20", address);
  const blockNumber = 8000 + Math.floor(Math.random() * 1_000_000);
  blockHashByNumber.set(blockNumber, "0xnative2");
  const dep: ObservedNativeDeposit = {
    userId, chain: "bep20", address,
    txHash: `0x${newId().replace(/-/g, "")}`.padEnd(66, "0").slice(0, 66),
    fromAddress: testAddress(), amountWei: 10_000_000_000_000_000n,
    blockNumber, blockHash: "0xnative2",
  };

  const first = await recordObservedNativeDeposit(dep);
  const second = await recordObservedNativeDeposit(dep);
  check("first call confirms", first.status === "confirmed");
  check("second call is a no-op", second.status === "already_confirmed");
  check("same native_deposits row both times", first.id === second.id);

  const rows = await sql.all("SELECT id FROM native_deposits WHERE tx_hash = ?", dep.txHash);
  check("exactly one row for this tx, not two", rows.length === 1, String(rows.length));
}

console.log("\n-- native (BNB) deposit: a reorg underneath it is never shown as confirmed --");

{
  const address = testAddress();
  const userId = await mkUserWithDeposit("bep20", address);
  const blockNumber = 9000 + Math.floor(Math.random() * 1_000_000);
  blockHashByNumber.set(blockNumber, "0xactual");
  const dep: ObservedNativeDeposit = {
    userId, chain: "bep20", address,
    txHash: `0x${newId().replace(/-/g, "")}`.padEnd(66, "0").slice(0, 66),
    fromAddress: testAddress(), amountWei: 1_000_000_000_000_000n,
    blockNumber, blockHash: "0xstale", // stale — the chain's real hash for this block is 0xactual
  };

  const result = await recordObservedNativeDeposit(dep);
  check("status is 'reorged_out'", result.status === "reorged_out", safeJson(result));
  const again = await recordObservedNativeDeposit(dep);
  check("stays reorged_out on re-processing", again.status === "reorged_out");
}

console.log("\n-- scanEvmNativeChain: only a nonzero top-level transfer to a KNOWN address counts --");

{
  const knownAddr = testAddress();
  const userId = await mkUserWithDeposit("bep20", knownAddr);
  const blockNum = 100_000 + Math.floor(Math.random() * 1_000_000);
  fullBlockByNumber.set(blockNum, {
    number: "0x" + blockNum.toString(16), hash: "0xblockA",
    transactions: [
      // A real deposit: value > 0, `to` is a known deposit address.
      { hash: "0xtx1", from: "0xsender1", to: knownAddr, value: "0x38d7ea4c68000", blockHash: "0xblockA" }, // 0.001 BNB
      // A plain contract call with no value attached — not a deposit.
      { hash: "0xtx2", from: "0xsender2", to: knownAddr, value: "0x0", blockHash: "0xblockA" },
      // Value sent, but to an address we never handed anyone — not ours.
      { hash: "0xtx3", from: "0xsender3", to: testAddress(), value: "0x38d7ea4c68000", blockHash: "0xblockA" },
      // Contract creation — no `to` at all.
      { hash: "0xtx4", from: "0xsender4", to: null, value: "0x38d7ea4c68000", blockHash: "0xblockA" },
    ],
  });

  const { deposits, scannedTo } = await scanEvmNativeChain("bep20", blockNum, blockNum);
  check("exactly one deposit found", deposits.length === 1, String(deposits.length));
  check("it is tx1, for the right user and amount",
    deposits[0]?.txHash === "0xtx1" && deposits[0]?.userId === userId && deposits[0]?.amountWei === 1_000_000_000_000_000n,
    safeJson(deposits[0]));
  check("scannedTo is the block requested", scannedTo === blockNum);
}

console.log("\n-- scanEvmChain: a provider's block-range limit is survived by shrinking, not by failing --");

{
  const address = testAddress();
  const userId = await mkUserWithDeposit("bep20", address);
  const depositBlock = 500; // must land inside whatever window the shrink settles on
  const amountMicro = 7_000_000n; // 7 USDT
  const rawOnChain = amountMicro * 10n ** 12n; // BSC USDT is 18 decimals, we store 6
  const txHash = `0x${newId().replace(/-/g, "")}`.padEnd(66, "0").slice(0, 66);
  logsFixture = [{
    transactionHash: txHash, logIndex: "0x0", data: "0x" + rawOnChain.toString(16),
    topics: ["0xtransfer", "0x" + "1".padStart(64, "0"), addrTopic(address)],
    blockNumber: "0x" + depositBlock.toString(16), blockHash: "0xshrunk",
  }];
  // A provider that rejects any eth_getLogs window wider than 1,000 blocks —
  // narrower than evm.ts's own starting MAX_BLOCK_RANGE (5,000), so the first
  // attempt or two are guaranteed to fail before the adaptive shrink recovers.
  logsProviderLimit = 1_000;

  const { deposits, scannedTo } = await scanEvmChain("bep20", 1, 10_000);
  check("the deposit was found despite the provider's tighter limit",
    deposits.some((d) => d.txHash === txHash && d.amountMicro === amountMicro),
    safeJson(deposits.filter((d) => d.txHash === txHash)));
  check("the scanned window shrank well under the original 10,000-block request",
    scannedTo < 10_000, String(scannedTo));

  // Feed it through the real crediting path too, proving the two new pieces
  // (adaptive scan + existing credit path) actually compose end to end.
  blockHashByNumber.set(depositBlock, "0xshrunk");
  const found = deposits.find((d) => d.txHash === txHash)!;
  const credited = await recordObservedDeposit(found, 15);
  check("the recovered deposit credits normally", credited.status === "credited", safeJson(credited));
  check("the user's balance reflects it", (await usdtBalanceMicroOf(userId)) === Number(amountMicro));

  logsProviderLimit = 1_000_000; // restore, so later suites/reruns in this process are unaffected
}

console.log("\n-- a deposit ALREADY credited via a manual usdt_topups claim: scanner must NOT double-pay --");

{
  // This is the exact shape of the 2026-08-12 production incident: a user
  // pastes a tx hash into /mine/topup, staff confirm it (usdt_ledger gets a
  // 'topup' credit keyed to the usdt_topups row), and later the deposit
  // scanner walks the same block and sees the same transfer.
  const address = testAddress();
  const userId = await mkUserWithDeposit("bep20", address);
  const blockNumber = 4000 + Math.floor(Math.random() * 1_000_000);
  const dep = mkDeposit({ userId, address, blockNumber, blockHash: "0xd00d", amountMicro: 1_000_000n });
  blockHashByNumber.set(blockNumber, "0xd00d");

  // The manual claim, exactly as staffMining.ts's confirm handler writes it —
  // note the tx hash is stored WITHOUT the "0x" prefix, which is what broke
  // the naive cross-table comparison in production.
  const topupId = newId();
  await sql.run(
    "INSERT INTO usdt_topups (id, user_id, chain, tx_hash, amount, status, reviewed_at, created_at) VALUES (?,?,?,?,?, 'confirmed', ?, ?)",
    topupId, userId, "bep20", dep.txHash.replace(/^0x/, ""), 1_000_000, now(), now(),
  );
  const manualLedgerId = newId();
  await sql.run(
    "INSERT INTO usdt_ledger (id, user_id, amount, direction, source_type, source_ref_id, note, created_at) VALUES (?,?,?, 'credit', 'topup', ?, ?, ?)",
    manualLedgerId, userId, 1_000_000, topupId, "Deposit (manual claim)", now(),
  );

  const before = await usdtBalanceMicroOf(userId);
  const result = await recordObservedDeposit(dep, 15);

  check("scanner reports 'already_credited', not a fresh credit", result.status === "already_credited", JSON.stringify(result));
  check("the balance did NOT move — no second payment",
    (await usdtBalanceMicroOf(userId)) === before, `${before} -> ${await usdtBalanceMicroOf(userId)}`);

  const ledgerCount = await sql.all("SELECT id FROM usdt_ledger WHERE user_id = ? AND source_type = 'topup'", userId);
  check("exactly ONE topup ledger row exists for this user (the manual one)", ledgerCount.length === 1, String(ledgerCount.length));

  const row = await sql.get<{ status: string; credited_ledger_id: string | null }>(
    "SELECT status, credited_ledger_id FROM chain_deposits WHERE id = ?", result.id,
  );
  check("the chain_deposits row is closed as 'credited', pointed at the MANUAL ledger entry",
    row?.status === "credited" && row?.credited_ledger_id === manualLedgerId, JSON.stringify(row));
}

globalThis.fetch = realFetch;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
