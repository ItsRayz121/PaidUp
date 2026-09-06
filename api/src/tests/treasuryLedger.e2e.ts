// E2E for the treasury transaction ledger (Staff -> Money & payouts ->
// Treasury) — api/src/treasuryLedger.ts.
//
// Covers: classification (deposit / user payout / external), address
// normalization, USDT + native BNB amount handling, duplicate-event
// prevention (idempotent upsert), a pending -> confirmed transition, a
// failed/reverted transaction, checkpoint-based resume (a "worker restart"),
// reconciliation of a missed event, pagination + every filter, the
// largest-six-confirmed-payouts sort, empty states, and staff authorization.
//
// Does NOT exercise a real chain — same convention as deposits.e2e.ts: the
// scanner's own eth_getLogs/eth_blockNumber calls go through a stubbed
// global.fetch with deterministic fixtures, no real network.
//
//   npm run test:treasuryledger
import { initDb, sql, now, newId } from "../db.ts";
import {
  normalizeAddress, classifyCategory, registeredWalletUser, matchInternalRecord,
  purposeForWithdrawal, upsertTreasuryTx, recordPlatformTx, markTreasuryTxConfirmed,
  markTreasuryTxFailed, listTreasuryLedger, largestConfirmedTreasuryPayouts,
  treasuryMonitorStatus, recordObservedTx, treasuryAddresses,
} from "../treasuryLedger.ts";
import { scanTreasuryUsdt } from "../deposits/adapters/treasuryEvm.ts";
import { hasPermission } from "../permissions.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();

function testAddress(): string {
  return "0x" + newId().replace(/-/g, "").padEnd(40, "0").slice(0, 40);
}
function testTxHash(): string {
  return ("0x" + newId().replace(/-/g, "")).padEnd(66, "0").slice(0, 66);
}
function addrTopic(addr: string): string {
  return "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

async function mkUserWithDeposit(chain: string, address: string): Promise<string> {
  const id = newId();
  await sql.run(
    "INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at) VALUES (?,?,1,'Pakistan',?,'active',?)",
    id, `treas-${id}@t.test`, id.slice(0, 8).toUpperCase(), now(),
  );
  const idxRow = await sql.get<{ nextval: string }>("SELECT nextval('deposit_wallet_index_seq') AS nextval");
  await sql.run(
    "INSERT INTO deposit_wallets (user_id, chain, addr_index, address, created_at) VALUES (?,?,?,?,?)",
    id, chain, Number(idxRow!.nextval), address, now(),
  );
  return id;
}

// ---------------------------------------------------------------------------
console.log("\n-- address normalization --");
{
  check("lowercases and trims", normalizeAddress("  0xABCdef  ") === "0xabcdef");
}

console.log("\n-- classification rules (Part 5) --");
{
  check("incoming is always a treasury deposit", classifyCategory("in", null) === "treasury_deposit");
  check("incoming is a treasury deposit even from a registered user", classifyCategory("in", "some-user-id") === "treasury_deposit");
  check("outgoing to a registered user is a user payout", classifyCategory("out", "some-user-id") === "user_payout");
  check("outgoing to nobody we know is external money out", classifyCategory("out", null) === "external_transfer");
}

console.log("\n-- registeredWalletUser: only a real deposit_wallets row counts --");
{
  const address = testAddress();
  const userId = await mkUserWithDeposit("bep20", address);
  check("a known deposit address resolves to its owner", (await registeredWalletUser("bep20", address)) === userId);
  check("case-insensitive", (await registeredWalletUser("bep20", address.toUpperCase())) === userId);
  check("an unregistered address resolves to nobody", (await registeredWalletUser("bep20", testAddress())) === null);
}

console.log("\n-- matchInternalRecord + purposeForWithdrawal: withdrawal vs. admin reward --");
{
  const address = testAddress();
  const userId = await mkUserWithDeposit("bep20", address);
  const wId = newId();
  await sql.run(
    `INSERT INTO withdrawal_requests (id, user_id, amount, payout_rail, payout_address, status, tx_hash, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    wId, userId, 1000, "bep20", address, "paid", testTxHash(), now(),
  );
  const row = await sql.get<{ tx_hash: string }>("SELECT tx_hash FROM withdrawal_requests WHERE id = ?", wId);
  const plain = await matchInternalRecord("bep20", row!.tx_hash);
  check("a plain withdrawal matches with purpose 'withdrawal'", plain?.purpose === "withdrawal" && plain?.relatedId === wId, JSON.stringify(plain));
  check("purposeForWithdrawal agrees (no disbursement link)", (await purposeForWithdrawal(wId)) === "withdrawal");

  // Now link it to a disbursement batch — same withdrawal, now a reward payout.
  const batchId = newId();
  await sql.run(
    `INSERT INTO payout_batches (id, mode, status, created_by, created_at) VALUES (?,'onchain','processing',?,?)`,
    batchId, userId, now(),
  );
  await sql.run(
    `INSERT INTO payout_disbursements (id, batch_id, user_id, withdrawal_request_id, status, created_at)
     VALUES (?,?,?,?,'sending',?)`,
    newId(), batchId, userId, wId, now(),
  );
  const asReward = await matchInternalRecord("bep20", row!.tx_hash);
  check("the SAME withdrawal now matches with purpose 'reward'", asReward?.purpose === "reward", JSON.stringify(asReward));
  check("purposeForWithdrawal agrees", (await purposeForWithdrawal(wId)) === "reward");

  const unknown = await matchInternalRecord("bep20", testTxHash());
  check("an unrecognised hash matches nothing", unknown === null);
}

console.log("\n-- upsertTreasuryTx: duplicate-event prevention, first-writer-wins classification --");
{
  const txHash = testTxHash();
  const address = testAddress();
  const userId = await mkUserWithDeposit("bep20", address);

  // First writer: platform-initiated, KNOWS this is a withdrawal.
  await recordPlatformTx({
    chain: "bep20", txHash, fromAddress: testAddress(), toAddress: address,
    amountMicro: 2_500_000, purpose: "withdrawal", userId,
    relatedKind: "withdrawal_requests", relatedId: newId(), status: "submitted",
  });
  const afterFirst = await sql.get<{ id: string; category: string; purpose: string; status: string }>(
    "SELECT id, category, purpose, status FROM treasury_ledger_entries WHERE LOWER(tx_hash) = LOWER(?)", txHash,
  );
  check("exactly one row after the first write", !!afterFirst);
  check("classified user_payout / withdrawal / submitted", afterFirst?.category === "user_payout" && afterFirst?.purpose === "withdrawal" && afterFirst?.status === "submitted");

  // Second writer: the background scanner independently observes the SAME
  // transaction and would (if it won) classify it differently (no purpose,
  // since matchInternalRecord wouldn't apply to an unrelated fixture) — but
  // it must only ever advance STATUS, never reclassify.
  await upsertTreasuryTx({
    chain: "bep20", txHash, logIndex: null,
    fromAddress: testAddress(), toAddress: address,
    tokenAddress: null, tokenSymbol: "USDT", tokenDecimals: 18,
    amountRaw: "999", amountMicro: 999,
    direction: "in", category: "treasury_deposit", purpose: null, userId: null,
    relatedKind: null, relatedId: null, status: "confirmed",
  });
  const rows = await sql.all<{ id: string }>("SELECT id FROM treasury_ledger_entries WHERE LOWER(tx_hash) = LOWER(?)", txHash);
  check("STILL exactly one row (no duplicate)", rows.length === 1, String(rows.length));
  const afterSecond = await sql.get<{ category: string; purpose: string; status: string; amount_micro: number }>(
    "SELECT category, purpose, status, amount_micro FROM treasury_ledger_entries WHERE LOWER(tx_hash) = LOWER(?)", txHash,
  );
  check("classification is UNCHANGED (first-writer-wins)",
    afterSecond?.category === "user_payout" && afterSecond?.purpose === "withdrawal" && Number(afterSecond?.amount_micro) === 2_500_000,
    JSON.stringify(afterSecond));
  check("status DID advance to what the second writer reported", afterSecond?.status === "confirmed");
}

console.log("\n-- upsertTreasuryTx: a REAL log_index from the scanner must merge with the platform's NULL-log_index row, not duplicate it --");
{
  // recordPlatformTx always writes log_index: null (it broadcasts and records
  // immediately, before any receipt tells it the real log index). The
  // background scanner later observes the SAME transaction with the REAL,
  // non-null log index parsed off the chain. Found in review: matching only
  // on the exact (chain, tx, log) triple means -1 (NULL coalesced) never
  // equals a real index like 0, so the scanner's sighting used to insert a
  // SECOND row instead of confirming the first.
  const txHash = testTxHash();
  const address = testAddress();
  const userId = await mkUserWithDeposit("bep20", address);

  await recordPlatformTx({
    chain: "bep20", txHash, fromAddress: testAddress(), toAddress: address,
    amountMicro: 3_300_000, purpose: "withdrawal", userId,
    relatedKind: "withdrawal_requests", relatedId: newId(), status: "submitted",
  });
  const platformRow = await sql.get<{ id: string; log_index: number | null; status: string }>(
    "SELECT id, log_index, status FROM treasury_ledger_entries WHERE LOWER(tx_hash) = LOWER(?)", txHash);
  check("the platform write has log_index NULL", platformRow?.log_index == null, JSON.stringify(platformRow));

  // The scanner, exactly as scanTreasuryUsdt would hand it to recordObservedTx,
  // reports the REAL log index (0) for this exact transaction.
  await upsertTreasuryTx({
    chain: "bep20", txHash, logIndex: 0,
    fromAddress: testAddress(), toAddress: address,
    tokenAddress: "0x55d398326f99059fF775485246999027B3197955", tokenSymbol: "USDT", tokenDecimals: 18,
    amountRaw: "0", amountMicro: 3_300_000,
    direction: "out", category: "external_transfer", purpose: null, userId: null,
    relatedKind: null, relatedId: null, status: "confirmed",
  });

  const rows = await sql.all<{ id: string }>("SELECT id FROM treasury_ledger_entries WHERE LOWER(tx_hash) = LOWER(?)", txHash);
  check("still exactly ONE row for the same on-chain event", rows.length === 1, String(rows.length));
  const merged = await sql.get<{ log_index: number | null; status: string; category: string; purpose: string }>(
    "SELECT log_index, status, category, purpose FROM treasury_ledger_entries WHERE LOWER(tx_hash) = LOWER(?)", txHash);
  check("the real log index is backfilled onto the platform's row", merged?.log_index === 0, JSON.stringify(merged));
  check("status advanced to 'confirmed' via the scanner's sighting", merged?.status === "confirmed");
  check("classification is STILL the platform's (first-writer-wins), not the scanner's guess",
    merged?.category === "user_payout" && merged?.purpose === "withdrawal", JSON.stringify(merged));
}

console.log("\n-- pending -> confirmed transition --");
{
  const txHash = testTxHash();
  const address = testAddress();
  const userId = await mkUserWithDeposit("bep20", address);
  await recordPlatformTx({
    chain: "bep20", txHash, fromAddress: testAddress(), toAddress: address,
    amountMicro: 1_000_000, purpose: "refund", userId,
    relatedKind: "usdt_refund_requests", relatedId: newId(), status: "submitted",
  });
  let row = await sql.get<{ status: string; confirmed_at: string | null }>(
    "SELECT status, confirmed_at FROM treasury_ledger_entries WHERE LOWER(tx_hash) = LOWER(?)", txHash);
  check("starts 'submitted' with no confirmed_at", row?.status === "submitted" && !row?.confirmed_at);

  await markTreasuryTxConfirmed("bep20", txHash);
  row = await sql.get<{ status: string; confirmed_at: string | null }>(
    "SELECT status, confirmed_at FROM treasury_ledger_entries WHERE LOWER(tx_hash) = LOWER(?)", txHash);
  check("advances to 'confirmed' with a timestamp", row?.status === "confirmed" && !!row?.confirmed_at);
}

console.log("\n-- a failed/reverted transaction --");
{
  const txHash = testTxHash();
  const address = testAddress();
  const userId = await mkUserWithDeposit("bep20", address);
  await recordPlatformTx({
    chain: "bep20", txHash, fromAddress: testAddress(), toAddress: address,
    amountMicro: 500_000, purpose: "withdrawal", userId,
    relatedKind: "withdrawal_requests", relatedId: newId(), status: "submitted",
  });
  await markTreasuryTxFailed("bep20", txHash, "Prefund tx reverted.");
  const row = await sql.get<{ status: string; failure_reason: string | null }>(
    "SELECT status, failure_reason FROM treasury_ledger_entries WHERE LOWER(tx_hash) = LOWER(?)", txHash);
  check("status is 'reverted' with the reason recorded", row?.status === "reverted" && row?.failure_reason === "Prefund tx reverted.", JSON.stringify(row));
}

console.log("\n-- USDT and native BNB amount handling --");
{
  const usdtTx = testTxHash();
  const address = testAddress();
  const userId = await mkUserWithDeposit("bep20", address);
  await upsertTreasuryTx({
    chain: "bep20", txHash: usdtTx, logIndex: 3,
    fromAddress: testAddress(), toAddress: address,
    tokenAddress: "0x55d398326f99059fF775485246999027B3197955", tokenSymbol: "USDT", tokenDecimals: 18,
    amountRaw: (12_340_000n * 10n ** 12n).toString(), amountMicro: 12_340_000,
    direction: "out", category: "user_payout", purpose: "withdrawal", userId,
    relatedKind: "withdrawal_requests", relatedId: newId(), status: "confirmed",
  });
  const usdtRow = await sql.get<{ amount_micro: number; token_symbol: string }>(
    "SELECT amount_micro, token_symbol FROM treasury_ledger_entries WHERE LOWER(tx_hash) = LOWER(?)", usdtTx);
  check("USDT row stores the normalised micro amount", Number(usdtRow?.amount_micro) === 12_340_000 && usdtRow?.token_symbol === "USDT");

  const bnbTx = testTxHash();
  await upsertTreasuryTx({
    chain: "bep20", txHash: bnbTx, logIndex: null,
    fromAddress: testAddress(), toAddress: address,
    tokenAddress: null, tokenSymbol: "BNB", tokenDecimals: 18,
    amountRaw: "300000000000000", amountMicro: null,
    direction: "out", category: "user_payout", purpose: "other", userId,
    relatedKind: "bnb_withdrawal_requests", relatedId: newId(), status: "confirmed",
  });
  const bnbRow = await sql.get<{ amount_micro: number | null; amount_raw: string; token_symbol: string }>(
    "SELECT amount_micro, amount_raw, token_symbol FROM treasury_ledger_entries WHERE LOWER(tx_hash) = LOWER(?)", bnbTx);
  check("BNB row has NO micro amount (no fixed USD rate) but keeps the raw wei", bnbRow?.amount_micro == null && bnbRow?.amount_raw === "300000000000000" && bnbRow?.token_symbol === "BNB", JSON.stringify(bnbRow));
}

console.log("\n-- pagination + every filter --");
{
  const address = testAddress();
  const userId = await mkUserWithDeposit("bep20", address);
  const marker = newId().slice(0, 8);
  // Five confirmed USDT user-payout rows, amounts 1..5, so we can page + sort.
  for (let i = 1; i <= 5; i++) {
    await upsertTreasuryTx({
      chain: "bep20", txHash: `0x${marker}${i.toString().padStart(60, "0")}`, logIndex: i,
      fromAddress: testAddress(), toAddress: address,
      tokenAddress: "0x55d398326f99059fF775485246999027B3197955", tokenSymbol: "USDT", tokenDecimals: 18,
      amountRaw: "0", amountMicro: i * 1_000_000,
      direction: "out", category: "user_payout", purpose: "withdrawal", userId,
      relatedKind: "withdrawal_requests", relatedId: newId(), status: "confirmed",
    });
  }
  // One BNB row and one external-transfer row, so filters have something to exclude.
  await upsertTreasuryTx({
    chain: "bep20", txHash: `0x${marker}bnb`.padEnd(66, "0"), logIndex: null,
    fromAddress: testAddress(), toAddress: address,
    tokenAddress: null, tokenSymbol: "BNB", tokenDecimals: 18,
    amountRaw: "1", amountMicro: null,
    direction: "out", category: "user_payout", purpose: "other", userId,
    relatedKind: null, relatedId: null, status: "confirmed",
  });
  await upsertTreasuryTx({
    chain: "bep20", txHash: `0x${marker}ext`.padEnd(66, "0"), logIndex: null,
    fromAddress: address, toAddress: testAddress(),
    tokenAddress: "0x55d398326f99059fF775485246999027B3197955", tokenSymbol: "USDT", tokenDecimals: 18,
    amountRaw: "0", amountMicro: 9_000_000,
    direction: "out", category: "external_transfer", purpose: null, userId: null,
    relatedKind: null, relatedId: null, status: "confirmed",
  });

  const byQ = await listTreasuryLedger({ q: marker, limit: 100 });
  check("search-by-marker finds all 7 rows this test just made", byQ.total === 7, `total=${byQ.total}`);

  const usdtOnly = await listTreasuryLedger({ q: marker, token: "USDT", limit: 100 });
  check("token=USDT filter excludes the BNB row", usdtOnly.total === 6, `total=${usdtOnly.total}`);

  const payoutOnly = await listTreasuryLedger({ q: marker, category: "user_payout", limit: 100 });
  check("category=user_payout excludes the external-transfer row", payoutOnly.total === 6, `total=${payoutOnly.total}`);

  const page1 = await listTreasuryLedger({ q: marker, category: "user_payout", token: "USDT", sort: "amount_micro", dir: "desc", limit: 2, offset: 0 });
  check("page 1 (limit 2, sort amount desc) returns the two largest", page1.rows.length === 2 && page1.rows[0].amountMicro === 5_000_000 && page1.rows[1].amountMicro === 4_000_000, JSON.stringify(page1.rows.map((r) => r.amountMicro)));
  check("total still reflects the whole filtered set, not the page", page1.total === 5, `total=${page1.total}`);

  const page2 = await listTreasuryLedger({ q: marker, category: "user_payout", token: "USDT", sort: "amount_micro", dir: "desc", limit: 2, offset: 2 });
  check("page 2 continues from where page 1 left off", page2.rows[0].amountMicro === 3_000_000 && page2.rows[1].amountMicro === 2_000_000, JSON.stringify(page2.rows.map((r) => r.amountMicro)));

  const byUser = await listTreasuryLedger({ q: userId, limit: 100 });
  check("searching by user id also finds their rows", byUser.total >= 6, `total=${byUser.total}`);
}

console.log("\n-- empty states --");
{
  const nothingCategory = await listTreasuryLedger({ q: `no-such-marker-${newId()}`, limit: 25 });
  check("an unmatched search returns an empty page, not an error", nothingCategory.rows.length === 0 && nothingCategory.total === 0);

  const nothingLargest = await largestConfirmedTreasuryPayouts(6);
  // Not necessarily zero globally (other test blocks above added confirmed
  // payouts) — but scoped correctly it must never throw and must respect the cap.
  check("largestConfirmedTreasuryPayouts never returns more than asked", nothingLargest.length <= 6);
}

console.log("\n-- largest-six confirmed payouts: sorted, capped, correctly scoped --");
{
  const address = testAddress();
  const userId = await mkUserWithDeposit("bep20", address);
  const marker = newId().slice(0, 8);
  const amounts = [10, 50, 5, 90, 1, 30, 70, 20]; // 8 candidates, USDT
  for (const amt of amounts) {
    await upsertTreasuryTx({
      chain: "bep20", txHash: `0x${marker}${amt.toString().padStart(60, "0")}`, logIndex: amt,
      fromAddress: testAddress(), toAddress: address,
      tokenAddress: "0x55d398326f99059fF775485246999027B3197955", tokenSymbol: "USDT", tokenDecimals: 18,
      amountRaw: "0", amountMicro: amt * 1_000_000,
      direction: "out", category: "user_payout", purpose: "withdrawal", userId,
      relatedKind: "withdrawal_requests", relatedId: newId(), status: "confirmed",
    });
  }
  // A larger amount that must NOT appear: not confirmed yet.
  await upsertTreasuryTx({
    chain: "bep20", txHash: `0x${marker}pending`.padEnd(66, "0"), logIndex: 999,
    fromAddress: testAddress(), toAddress: address,
    tokenAddress: "0x55d398326f99059fF775485246999027B3197955", tokenSymbol: "USDT", tokenDecimals: 18,
    amountRaw: "0", amountMicro: 999_000_000,
    direction: "out", category: "user_payout", purpose: "withdrawal", userId,
    relatedKind: "withdrawal_requests", relatedId: newId(), status: "submitted",
  });
  // A larger amount that must NOT appear: an external transfer, not a user payout.
  await upsertTreasuryTx({
    chain: "bep20", txHash: `0x${marker}extbig`.padEnd(66, "0"), logIndex: 998,
    fromAddress: address, toAddress: testAddress(),
    tokenAddress: "0x55d398326f99059fF775485246999027B3197955", tokenSymbol: "USDT", tokenDecimals: 18,
    amountRaw: "0", amountMicro: 888_000_000,
    direction: "out", category: "external_transfer", purpose: null, userId: null,
    relatedKind: null, relatedId: null, status: "confirmed",
  });

  const top = await largestConfirmedTreasuryPayouts(6);
  const topAmounts = top.map((r) => (r.amountMicro ?? 0) / 1_000_000);
  check("returns exactly 6 rows", top.length === 6, String(top.length));
  check("sorted strictly descending", topAmounts.every((v, i) => i === 0 || topAmounts[i - 1] >= v), JSON.stringify(topAmounts));
  check("the top one really is the global maximum seen among CONFIRMED user payouts", topAmounts[0] >= 90, JSON.stringify(topAmounts));
  check("the unconfirmed 999 row never appears", !topAmounts.includes(999));
  check("the external-transfer 888 row never appears", !topAmounts.includes(888));
}

console.log("\n-- staff authorization --");
{
  check("admin holds treasury.view", hasPermission("admin", "treasury.view"));
  check("agent does NOT hold treasury.view", !hasPermission("agent", "treasury.view"));
  check("manager does NOT hold treasury.view", !hasPermission("manager", "treasury.view"));
  check("admin holds withdrawals.view", hasPermission("admin", "withdrawals.view"));
  check("agent holds withdrawals.view (the largest-payouts block's own gate)", hasPermission("agent", "withdrawals.view"));
}

console.log("\n-- monitor status (Part 7) never throws, even unconfigured --");
{
  const status = await treasuryMonitorStatus("bep20");
  check("returns a well-formed object", typeof status.scanEnabled === "boolean" && typeof status.confirmationsRequired === "number", JSON.stringify(status));
}

// ---------------------------------------------------------------------------
// The scanner itself: stubbed RPC, no real chain. Mirrors deposits.e2e.ts's
// own stubbing approach; extended for BOTH directions (treasury as sender OR
// recipient), which per-user deposit scanning never needed.
console.log("\n-- scanTreasuryUsdt: both directions, checkpoint resume, reconciliation of a missed event --");
{
  let logsFixture: { transactionHash: string; logIndex: string; data: string; topics: string[]; blockNumber: string; blockHash: string }[] = [];
  const realFetch = globalThis.fetch;
  // @ts-expect-error test stub — narrower signature than the real fetch
  globalThis.fetch = async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body as string);
    if (body.method === "eth_getLogs") {
      const [{ fromBlock, toBlock, topics }] = body.params;
      const from = parseInt(fromBlock, 16), to = parseInt(toBlock, 16);
      const wantFrom: string[] | null = topics[1];
      const wantTo: string[] | null = topics[2];
      const matches = logsFixture.filter((l) => {
        const bn = parseInt(l.blockNumber, 16);
        if (bn < from || bn > to) return false;
        if (wantTo && !wantTo.includes(l.topics[2])) return false;
        if (wantFrom && !wantFrom.includes(l.topics[1])) return false;
        return true;
      });
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: matches }) };
    }
    throw new Error(`Unexpected RPC method in test stub: ${body.method}`);
  };

  const treasuryAddr = testAddress();
  const userAddr = testAddress();
  const userId = await mkUserWithDeposit("bep20", userAddr);
  const externalAddr = testAddress();

  function fixtureLog(from: string, to: string, blockNumber: number, amountMicro: number) {
    return {
      transactionHash: testTxHash(), logIndex: "0x0",
      data: "0x" + (BigInt(amountMicro) * 10n ** 12n).toString(16),
      topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", addrTopic(from), addrTopic(to)],
      blockNumber: "0x" + blockNumber.toString(16), blockHash: "0xaaaa",
    };
  }

  // Incoming: userAddr -> treasury, at block 100.
  const incomingLog = fixtureLog(userAddr, treasuryAddr, 100, 7_000_000);
  // Outgoing: treasury -> externalAddr, at block 101.
  const outgoingLog = fixtureLog(treasuryAddr, externalAddr, 101, 4_000_000);
  logsFixture = [incomingLog, outgoingLog];

  const first = await scanTreasuryUsdt("bep20", [treasuryAddr], 0, 200);
  check("finds both the incoming and the outgoing transaction", first.txs.length === 2, String(first.txs.length));
  const incoming = first.txs.find((t) => t.txHash === incomingLog.transactionHash);
  const outgoing = first.txs.find((t) => t.txHash === outgoingLog.transactionHash);
  check("the incoming one is really addressed FROM the user TO treasury",
    !!incoming && incoming.fromAddress.toLowerCase() === userAddr.toLowerCase() && incoming.toAddress.toLowerCase() === treasuryAddr.toLowerCase());
  check("the outgoing one is really addressed FROM treasury TO the external address",
    !!outgoing && outgoing.fromAddress.toLowerCase() === treasuryAddr.toLowerCase() && outgoing.toAddress.toLowerCase() === externalAddr.toLowerCase());

  const addrSet = new Set([treasuryAddr.toLowerCase()]);
  await recordObservedTx(incoming!, addrSet, 15, sql);
  await recordObservedTx(outgoing!, addrSet, 15, sql);

  const incomingRow = await sql.get<{ direction: string; category: string; user_id: string | null }>(
    "SELECT direction, category, user_id FROM treasury_ledger_entries WHERE LOWER(tx_hash) = LOWER(?)", incomingLog.transactionHash);
  check("incoming classified as a treasury deposit, attributed to the sender", incomingRow?.direction === "in" && incomingRow?.category === "treasury_deposit" && incomingRow?.user_id === userId, JSON.stringify(incomingRow));

  const outgoingRow = await sql.get<{ direction: string; category: string; user_id: string | null }>(
    "SELECT direction, category, user_id FROM treasury_ledger_entries WHERE LOWER(tx_hash) = LOWER(?)", outgoingLog.transactionHash);
  check("outgoing to an unregistered address classified as external money out", outgoingRow?.direction === "out" && outgoingRow?.category === "external_transfer" && outgoingRow?.user_id === null, JSON.stringify(outgoingRow));

  // "Worker restart from checkpoint": scanning again from scannedTo+1 finds
  // nothing NEW (the fixture's blocks are all behind the new cursor) — this
  // is exactly what a resumed scan does after a process restart.
  const resumed = await scanTreasuryUsdt("bep20", [treasuryAddr], first.scannedTo + 1, first.scannedTo + 50);
  check("resuming past the last checkpoint finds no already-seen transactions", resumed.txs.length === 0, String(resumed.txs.length));

  // "Reconciliation of a missed event": a transaction that existed on-chain
  // ALL ALONG (block 50, behind the forward cursor) but was never seen —
  // simulating a provider hiccup on the very first tick. A trailing-window
  // re-scan picks it up, and recording it is a safe, idempotent no-op should
  // it ever be seen again.
  const missedLog = fixtureLog(externalAddr, treasuryAddr, 50, 1_500_000);
  logsFixture = [incomingLog, outgoingLog, missedLog];
  const reconcile = await scanTreasuryUsdt("bep20", [treasuryAddr], 0, first.scannedTo);
  const missed = reconcile.txs.find((t) => t.txHash === missedLog.transactionHash);
  check("the trailing re-scan finds the previously-missed transaction", !!missed);
  await recordObservedTx(missed!, addrSet, 15, sql);
  const missedRow = await sql.get<{ category: string }>(
    "SELECT category FROM treasury_ledger_entries WHERE LOWER(tx_hash) = LOWER(?)", missedLog.transactionHash);
  check("it is recorded as a treasury deposit", missedRow?.category === "treasury_deposit");
  // Re-processing it again (a second reconciliation tick, or the forward
  // cursor eventually reaching it too) must not create a duplicate.
  await recordObservedTx(missed!, addrSet, 15, sql);
  const missedCount = await sql.get<{ n: string | number }>(
    "SELECT COUNT(*) AS n FROM treasury_ledger_entries WHERE LOWER(tx_hash) = LOWER(?)", missedLog.transactionHash);
  check("re-processing the same missed event is a no-op, not a duplicate", Number(missedCount?.n) === 1);

  // A treasury -> treasury log (both filters can match the same event) must
  // never be recorded as a real business transaction.
  const selfLog = fixtureLog(treasuryAddr, treasuryAddr, 102, 100_000);
  logsFixture = [selfLog];
  const selfScan = await scanTreasuryUsdt("bep20", [treasuryAddr], 0, 200);
  check("a treasury -> treasury self-transfer is never surfaced as a real event", selfScan.txs.length === 0, String(selfScan.txs.length));

  globalThis.fetch = realFetch;
}

console.log("\n-- treasuryAddresses: no address configured at all --");
{
  // Neither a signer key nor a configured setting exists in this test run —
  // the scanner (and everything downstream) must be a clean no-op, not throw.
  const addrs = await treasuryAddresses("aptos"); // an unsupported chain
  check("an unsupported chain returns no addresses", addrs.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
