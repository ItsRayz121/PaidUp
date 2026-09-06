// Treasury transaction ledger — Staff → Money & payouts → Treasury.
//
// The chain explorer (bscscan.ts) can fail outright ("Free API access is not
// supported for this chain") and, even when it works, it is only ever a
// window onto the chain — it has no idea WHY a transaction happened or who a
// counterparty is on OUR platform. This module is the internal, persistent
// answer to both: every transaction that touches the treasury wallet gets one
// row here, written from two sources:
//
//   1. PLATFORM-INITIATED (recordPlatformTx) — called the instant a
//      transaction hash exists, from payoutRelay.ts / autoWithdraw.ts /
//      autoRefund.ts / the manual staff "mark paid" actions. This is the
//      primary path, and it means the ledger never depends on the explorer
//      to remember what we ourselves did (Part 4/8's own rule).
//   2. EXTERNALLY OBSERVED (recordObservedTx, called from
//      deposits/adapters/treasuryEvm.ts's background scan) — catches
//      anything that moved through the treasury address WITHOUT the platform
//      starting it: a manual treasury operation, or a mistake. This is what
//      makes the ledger a real monitor, not just a payout log.
//
// ⚠️ SOURCE OF TRUTH FOR STATUS IS THE CHAIN, NEVER OUR OWN INTENT (Part 8).
// Writing a row with status='submitted' the moment we broadcast is not the
// same as the transaction having succeeded — status only ever advances to
// 'confirmed' once a receipt or a confirmed log event says so (the platform
// call sites do this themselves, right where they already check a receipt;
// the background scanner does it for anything it observes directly).
//
// ⚠️ CLASSIFICATION IS FIRST-WRITER-WINS, STATUS IS NOT. See upsertTreasuryTx.
import { sql, now, newId, getSetting, type TxApi } from "./db.ts";
import { config } from "./config.ts";
import { treasurySignerAddress } from "./signer.ts";
import { rpcCall } from "./rpc.ts";
import { scanTreasuryUsdt, scanTreasuryNative, type ObservedTreasuryTx } from "./deposits/adapters/treasuryEvm.ts";

export type TreasuryDirection = "in" | "out";
export type TreasuryCategory = "treasury_deposit" | "user_payout" | "external_transfer" | "unknown";
export type TreasuryPurpose = "withdrawal" | "reward" | "refund" | "bonus" | "mining_reward" | "other";
export type TreasuryStatus = "detected" | "submitted" | "pending" | "confirmed" | "failed" | "replaced" | "reverted";

export function normalizeAddress(a: string): string {
  return a.trim().toLowerCase();
}

// The treasury address(es) worth monitoring — the address that actually
// signs (treasurySignerAddress) and, if it differs, the separately-configured
// display/deposit address (routes/staff.ts's own signerMismatch note explains
// why these can disagree). Both are worth watching: money sent to the
// "wrong" configured address is exactly the kind of thing this ledger exists
// to surface, not hide.
export async function treasuryAddresses(chain: string, t: Pick<TxApi, "get"> = sql): Promise<string[]> {
  if (chain !== "bep20") return [];
  const out = new Set<string>();
  const signer = treasurySignerAddress();
  if (signer) out.add(normalizeAddress(signer));
  // getSetting always reads through the plain (non-transactional) pool — a
  // rarely-written config row, so reading it outside the caller's own
  // transaction is harmless; `t` above is accepted for the OTHER reads in
  // this file that do matter (deposit_wallets / internal-record lookups).
  const configured = await getSetting("treasury_address_bep20", "");
  if (configured) out.add(normalizeAddress(configured));
  return [...out];
}

// Is `address` one of ours — a per-user custody-derived deposit wallet? Used
// to tell "Payment or reward sent to a registered user" apart from "External
// money out" (Part 5's own classification rule), and to attach a user_id for
// display. Never guesses: an address not in deposit_wallets is unregistered,
// full stop, even if it happens to belong to a real person off-platform.
export async function registeredWalletUser(
  chain: string, address: string, t: Pick<TxApi, "get"> = sql,
): Promise<string | null> {
  const row = await t.get<{ user_id: string }>(
    "SELECT user_id FROM deposit_wallets WHERE chain = ? AND LOWER(address) = LOWER(?)",
    chain, address,
  );
  return row?.user_id ?? null;
}

// What do OUR OWN RECORDS already know about this transaction hash? Mirrors
// routes/staff.ts's labelTreasuryHashes (built for the same reason: a hash
// that matches nothing here is exactly the row worth a human looking at) but
// returns structured data instead of a display string, and additionally
// checks bnb_withdrawal_requests and whether a withdrawal was created by an
// admin reward disbursement (payout_disbursements) rather than a user's own
// cash-out request.
export type InternalMatch = {
  purpose: TreasuryPurpose; relatedKind: string; relatedId: string; userId: string;
};
export async function matchInternalRecord(
  chain: string, txHash: string, t: Pick<TxApi, "get"> = sql,
): Promise<InternalMatch | null> {
  const w = await t.get<{ id: string; user_id: string; is_reward: number }>(
    `SELECT w.id, w.user_id, (CASE WHEN d.id IS NOT NULL THEN 1 ELSE 0 END) AS is_reward
       FROM withdrawal_requests w
       LEFT JOIN payout_disbursements d ON d.withdrawal_request_id = w.id
      WHERE LOWER(w.tx_hash) = LOWER(?) LIMIT 1`,
    txHash,
  );
  if (w) {
    return { purpose: w.is_reward ? "reward" : "withdrawal", relatedKind: "withdrawal_requests", relatedId: w.id, userId: w.user_id };
  }
  // The prefund leg of a withdrawal relay job carries its own hash, distinct
  // from withdrawal_requests.tx_hash (which only ever holds the FORWARD leg's
  // hash — see payoutRelay.ts's completeRequest). This is what lets the
  // prefund transaction itself (the one that actually left the treasury
  // address) be classified even before the whole withdrawal has settled.
  const relay = await t.get<{ request_id: string; user_id: string; is_reward: number }>(
    `SELECT j.request_id, j.user_id, (CASE WHEN d.id IS NOT NULL THEN 1 ELSE 0 END) AS is_reward
       FROM payout_relay_jobs j
       LEFT JOIN payout_disbursements d ON d.withdrawal_request_id = j.request_id
      WHERE j.purpose = 'withdrawal' AND LOWER(j.prefund_tx_hash) = LOWER(?) LIMIT 1`,
    txHash,
  );
  if (relay) {
    return { purpose: relay.is_reward ? "reward" : "withdrawal", relatedKind: "payout_relay_jobs", relatedId: relay.request_id, userId: relay.user_id };
  }
  const r = await t.get<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM usdt_refund_requests WHERE LOWER(tx_hash) = LOWER(?) LIMIT 1`, txHash,
  );
  if (r) return { purpose: "refund", relatedKind: "usdt_refund_requests", relatedId: r.id, userId: r.user_id };
  const b = await t.get<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM bnb_withdrawal_requests WHERE LOWER(tx_hash) = LOWER(?) LIMIT 1`, txHash,
  );
  if (b) return { purpose: "other", relatedKind: "bnb_withdrawal_requests", relatedId: b.id, userId: b.user_id };
  return null;
}

// Direction + counterparty -> the three business categories Part 5 defines.
// `counterpartyUserId` is null for an address that is not a registered
// deposit wallet.
export function classifyCategory(direction: TreasuryDirection, counterpartyUserId: string | null): TreasuryCategory {
  if (direction === "in") return "treasury_deposit";
  return counterpartyUserId ? "user_payout" : "external_transfer";
}

export type UpsertTreasuryTxInput = {
  chain: string;
  txHash: string;
  logIndex: number | null;
  blockNumber?: number | null;
  blockHash?: string | null;
  fromAddress: string;
  toAddress: string;
  tokenAddress: string | null;
  tokenSymbol: "USDT" | "BNB";
  tokenDecimals: number;
  amountRaw: string;
  amountMicro: number | null;
  direction: TreasuryDirection;
  category: TreasuryCategory;
  purpose: TreasuryPurpose | null;
  userId: string | null;
  relatedKind: string | null;
  relatedId: string | null;
  status: TreasuryStatus;
  confirmationsRequired?: number;
  failureReason?: string | null;
  detectedAt?: string | null;
  submittedAt?: string | null;
  confirmedAt?: string | null;
};

// Insert-or-refresh. ⚠️ CLASSIFICATION FIELDS (category/purpose/user_id/
// related_*/detected_at) ARE ONLY EVER SET ON THE FIRST INSERT — a later
// upsert of the SAME (chain, tx, log) only ever advances the on-chain STATUS
// fields. This is what lets platform-initiated code (which knows the real
// purpose) win over a later, unrelated scanner sighting of the identical
// transaction, and equally lets a genuinely externally-detected row keep its
// classification if the platform later independently confirms it via its own
// receipt check.
export async function upsertTreasuryTx(input: UpsertTreasuryTxInput, t: Pick<TxApi, "run" | "get"> = sql): Promise<string> {
  const nowIso = now();
  // ⚠️ MATCHES ON tx_hash ALONE WHENEVER EITHER SIDE'S log_index IS UNKNOWN,
  // NOT JUST ON THE EXACT (chain, tx, log) TRIPLE. recordPlatformTx writes
  // log_index: null the instant it broadcasts (it does not wait on a receipt
  // to learn the real log index) — a real, non-null log index is only ever
  // known once the background scanner (or a receipt) observes the actual
  // Transfer event. Matching the exact triple only would mean a
  // platform-written NULL-log-index row and the SAME transaction's later
  // scanner sighting (real log index) satisfy two DIFFERENT unique-index keys
  // (-1 vs. e.g. 0) and land as two separate rows for one payout — exactly
  // the case this function's own "first-writer-wins" comment above claims
  // never happens. A treasury-initiated send is always our own plain
  // transfer() call (one Transfer log per tx), so merging on tx_hash whenever
  // either side is ambiguous is safe for every real case this ledger records.
  const existing = await t.get<{ id: string; log_index: number | null }>(
    `SELECT id, log_index FROM treasury_ledger_entries
      WHERE LOWER(chain) = LOWER(?) AND LOWER(tx_hash) = LOWER(?)
        AND (log_index IS NULL OR ?::integer IS NULL OR log_index = ?::integer)`,
    input.chain, input.txHash, input.logIndex, input.logIndex,
  );
  if (existing) {
    // Part 5.11 — a ONE-WAY upgrade, never an overwrite: a row first recorded
    // with no identifiable counterparty (user_id IS NULL — an unregistered
    // address at the time, so category landed on external_transfer/unknown)
    // gets to learn who that was on a LATER upsert of the same transaction,
    // if by then the address has become a registered deposit wallet or the
    // transaction hash matches an internal record. This does not weaken
    // first-writer-wins: a row that already carries a user_id (whichever
    // writer supplied it first) is untouched by this CASE, in every branch,
    // forever — only the "we genuinely didn't know" state can ever change.
    await t.run(
      `UPDATE treasury_ledger_entries SET
         status = ?,
         log_index = COALESCE(log_index, ?),
         block_number = COALESCE(?, block_number),
         block_hash = COALESCE(?, block_hash),
         confirmed_at = COALESCE(confirmed_at, ?),
         submitted_at = COALESCE(submitted_at, ?),
         failure_reason = COALESCE(?, failure_reason),
         category = CASE WHEN user_id IS NULL THEN ? ELSE category END,
         purpose = CASE WHEN user_id IS NULL THEN ? ELSE purpose END,
         user_id = CASE WHEN user_id IS NULL THEN ? ELSE user_id END,
         related_kind = CASE WHEN user_id IS NULL THEN ? ELSE related_kind END,
         related_id = CASE WHEN user_id IS NULL THEN ? ELSE related_id END,
         last_checked_at = ?,
         updated_at = ?
       WHERE id = ?`,
      input.status, input.logIndex, input.blockNumber ?? null, input.blockHash ?? null,
      input.confirmedAt ?? null, input.submittedAt ?? null, input.failureReason ?? null,
      input.category, input.purpose, input.userId, input.relatedKind, input.relatedId,
      nowIso, nowIso, existing.id,
    );
    return existing.id;
  }
  const id = newId();
  await t.run(
    `INSERT INTO treasury_ledger_entries
       (id, chain, tx_hash, log_index, block_number, block_hash,
        from_address, to_address, from_address_norm, to_address_norm,
        token_address, token_symbol, token_decimals, amount_raw, amount_micro,
        direction, category, purpose, user_id, related_kind, related_id,
        status, confirmations_required, failure_reason,
        detected_at, submitted_at, confirmed_at, last_checked_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?, ?,?,?, ?,?,?,?,?,?)
     ON CONFLICT (LOWER(chain), LOWER(tx_hash), COALESCE(log_index, -1)) DO NOTHING`,
    id, input.chain, input.txHash, input.logIndex, input.blockNumber ?? null, input.blockHash ?? null,
    input.fromAddress, input.toAddress, normalizeAddress(input.fromAddress), normalizeAddress(input.toAddress),
    input.tokenAddress, input.tokenSymbol, input.tokenDecimals, input.amountRaw, input.amountMicro,
    input.direction, input.category, input.purpose, input.userId, input.relatedKind, input.relatedId,
    input.status, input.confirmationsRequired ?? 1, input.failureReason ?? null,
    input.detectedAt ?? nowIso, input.submittedAt ?? null, input.confirmedAt ?? null, nowIso, nowIso, nowIso,
  );
  // A concurrent insert could have won the race (ON CONFLICT DO NOTHING) —
  // re-select rather than assume `id` above is the row that actually landed.
  const row = await t.get<{ id: string }>(
    `SELECT id FROM treasury_ledger_entries
      WHERE LOWER(chain) = LOWER(?) AND LOWER(tx_hash) = LOWER(?) AND COALESCE(log_index, -1) = ?`,
    input.chain, input.txHash, input.logIndex ?? -1,
  );
  return row?.id ?? id;
}

type RecordPlatformTxInput = {
  chain: string;
  txHash: string;
  fromAddress: string;
  toAddress: string;
  amountMicro: number; // micro-USDT — every platform-initiated treasury send in this codebase is a USDT ERC-20 transfer
  purpose: TreasuryPurpose;
  userId: string;
  relatedKind: string;
  relatedId: string;
  status: Extract<TreasuryStatus, "submitted" | "confirmed" | "failed">;
  failureReason?: string;
};

// Is this withdrawal request the outgoing leg of an admin reward disbursement
// (staffDisbursements.ts) rather than a user's own cash-out request? Shared by
// every platform-initiated call site so "withdrawal" vs "reward" can never be
// decided two different ways in two different files.
export async function purposeForWithdrawal(
  withdrawalRequestId: string, t: Pick<TxApi, "get"> = sql,
): Promise<Extract<TreasuryPurpose, "withdrawal" | "reward">> {
  const row = await t.get<{ x: number }>(
    "SELECT 1 AS x FROM payout_disbursements WHERE withdrawal_request_id = ?", withdrawalRequestId,
  );
  return row ? "reward" : "withdrawal";
}

// Called the instant a broadcast succeeds — status='submitted', a real hash,
// no waiting on a chain read.
//
// ⚠️ WHO ADVANCES 'submitted' -> 'confirmed'/'reverted' DIFFERS BY CALLER.
// payoutRelay.ts's own withdrawal-prefund path calls markTreasuryTxConfirmed/
// markTreasuryTxFailed itself, right where it already checks the receipt for
// its own state machine — that is the fast, certain path. The DIRECT
// provider.send() fallback (autoWithdraw.ts / autoRefund.ts / the manual
// staff "mark paid" actions), used only when the relay is unavailable, has no
// receipt-check step of its own (payout.ts's onchainProvider only broadcasts)
// — those rows are confirmed later, INDIRECTLY, by the background scan
// (deposits/adapters/treasuryEvm.ts) independently re-observing the same
// transaction at the treasury address and calling upsertTreasuryTx with
// status='confirmed'. That merge only works correctly because upsertTreasuryTx
// matches on tx_hash whenever either side's log_index is unknown (see its own
// comment) — do not "simplify" that back to an exact-triple match, or every
// row written here would sit at 'submitted' forever once the scanner found
// the real log index under a different key.
export async function recordPlatformTx(input: RecordPlatformTxInput, t: Pick<TxApi, "run" | "get"> = sql): Promise<void> {
  const usdt = { address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 };
  const amountRaw = (BigInt(input.amountMicro) * 10n ** BigInt(usdt.decimals - 6)).toString();
  await upsertTreasuryTx({
    chain: input.chain, txHash: input.txHash, logIndex: null,
    fromAddress: input.fromAddress, toAddress: input.toAddress,
    tokenAddress: usdt.address, tokenSymbol: "USDT", tokenDecimals: usdt.decimals,
    amountRaw, amountMicro: input.amountMicro,
    direction: "out",
    // A platform-initiated send is, by definition, treasury money moving to
    // a registered wallet (payoutRelay's prefund leg is the only send this
    // codebase ever initiates FROM treasury) — never re-derived from address
    // matching, because we already know exactly why this transaction exists.
    category: "user_payout",
    purpose: input.purpose, userId: input.userId,
    relatedKind: input.relatedKind, relatedId: input.relatedId,
    status: input.status,
    submittedAt: now(),
    confirmedAt: input.status === "confirmed" ? now() : null,
    failureReason: input.failureReason ?? null,
  }, t);
}

// Advance an already-recorded platform transaction's status once a receipt
// comes back (payoutRelay.ts's own prefund_sent -> prefund_confirmed/failed
// check is where this is called from — it already has the receipt in hand).
export async function markTreasuryTxConfirmed(chain: string, txHash: string, t: Pick<TxApi, "run" | "get"> = sql): Promise<void> {
  await t.run(
    `UPDATE treasury_ledger_entries SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, ?), last_checked_at = ?, updated_at = ?
      WHERE LOWER(chain) = LOWER(?) AND LOWER(tx_hash) = LOWER(?) AND status <> 'confirmed'`,
    now(), now(), now(), chain, txHash,
  );
}
export async function markTreasuryTxFailed(chain: string, txHash: string, reason: string, t: Pick<TxApi, "run" | "get"> = sql): Promise<void> {
  await t.run(
    `UPDATE treasury_ledger_entries SET status = 'reverted', failure_reason = ?, last_checked_at = ?, updated_at = ?
      WHERE LOWER(chain) = LOWER(?) AND LOWER(tx_hash) = LOWER(?) AND status NOT IN ('confirmed','reverted','failed')`,
    reason, now(), now(), chain, txHash,
  );
}

// ---- Listing (staff Money & payouts screens) -------------------------------

export type TreasuryLedgerFilters = {
  category?: TreasuryCategory | "all";
  direction?: TreasuryDirection | "all";
  token?: "USDT" | "BNB" | "all";
  status?: TreasuryStatus | "all";
  dateFrom?: string; // ISO date, inclusive
  dateTo?: string;   // ISO date, inclusive (end of day)
  q?: string;        // tx hash / address / user email|username|id
  limit?: number;
  offset?: number;
  sort?: "created_at" | "amount_micro";
  dir?: "asc" | "desc";
};

export type TreasuryLedgerRow = {
  id: string; chain: string; txHash: string; logIndex: number | null;
  blockNumber: number | null; fromAddress: string; toAddress: string;
  tokenSymbol: "USDT" | "BNB"; tokenDecimals: number; amountRaw: string; amountMicro: number | null;
  direction: TreasuryDirection; category: TreasuryCategory; purpose: TreasuryPurpose | null;
  userId: string | null; userEmail: string | null;
  userUsername: string | null; userDisplayName: string | null;
  userTelegramUsername: string | null; userTelegramName: string | null;
  status: TreasuryStatus; failureReason: string | null;
  createdAt: string; confirmedAt: string | null;
};

function mapRow(r: Record<string, unknown>): TreasuryLedgerRow {
  return {
    id: r.id as string, chain: r.chain as string, txHash: r.tx_hash as string,
    logIndex: r.log_index == null ? null : Number(r.log_index),
    blockNumber: r.block_number == null ? null : Number(r.block_number),
    fromAddress: r.from_address as string, toAddress: r.to_address as string,
    tokenSymbol: r.token_symbol as "USDT" | "BNB", tokenDecimals: Number(r.token_decimals),
    amountRaw: String(r.amount_raw), amountMicro: r.amount_micro == null ? null : Number(r.amount_micro),
    direction: r.direction as TreasuryDirection, category: r.category as TreasuryCategory,
    purpose: (r.purpose as TreasuryPurpose | null) ?? null,
    userId: (r.user_id as string | null) ?? null, userEmail: (r.user_email as string | null) ?? null,
    userUsername: (r.user_username as string | null) ?? null, userDisplayName: (r.user_display_name as string | null) ?? null,
    userTelegramUsername: (r.user_telegram_username as string | null) ?? null, userTelegramName: (r.user_telegram_name as string | null) ?? null,
    status: r.status as TreasuryStatus, failureReason: (r.failure_reason as string | null) ?? null,
    createdAt: r.created_at as string, confirmedAt: (r.confirmed_at as string | null) ?? null,
  };
}

// ⚠️ EVERY FILTER IS A BOUND WHERE CLAUSE, NEVER A POST-FETCH JS FILTER — the
// same discipline GET /staff/users and GET /staff/withdrawals already follow,
// for the same reason: `total` and the page must agree, and pagination over
// an already-filtered set is what makes a "6 largest" or a "next page" query
// correct instead of approximate.
export async function listTreasuryLedger(f: TreasuryLedgerFilters): Promise<{ rows: TreasuryLedgerRow[]; total: number }> {
  const where: string[] = ["e.chain = 'bep20'"];
  const p: unknown[] = [];
  if (f.category && f.category !== "all") { where.push("e.category = ?"); p.push(f.category); }
  if (f.direction && f.direction !== "all") { where.push("e.direction = ?"); p.push(f.direction); }
  if (f.token && f.token !== "all") { where.push("e.token_symbol = ?"); p.push(f.token); }
  if (f.status && f.status !== "all") { where.push("e.status = ?"); p.push(f.status); }
  if (f.dateFrom) { where.push("e.created_at >= ?"); p.push(f.dateFrom); }
  if (f.dateTo) { where.push("e.created_at <= ?"); p.push(`${f.dateTo}T23:59:59.999Z`); }
  const q = (f.q ?? "").trim().toLowerCase();
  if (q) {
    where.push(
      "(LOWER(e.tx_hash) LIKE ? OR LOWER(e.from_address) LIKE ? OR LOWER(e.to_address) LIKE ? " +
      "OR LOWER(u.email) LIKE ? OR LOWER(u.username) LIKE ? OR LOWER(e.user_id) = ?)",
    );
    p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, q);
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const sortCol = f.sort === "amount_micro" ? "e.amount_micro" : "e.created_at";
  const dir = f.dir === "asc" ? "ASC" : "DESC";
  const limit = Math.min(Math.max(f.limit ?? 25, 1), 200);
  const offset = Math.max(f.offset ?? 0, 0);

  const [rows, totalRow] = await Promise.all([
    sql.all<Record<string, unknown>>(
      `SELECT e.*, u.email AS user_email, u.username AS user_username, u.display_name AS user_display_name,
              u.telegram_username AS user_telegram_username, u.telegram_name AS user_telegram_name
         FROM treasury_ledger_entries e
         LEFT JOIN users u ON u.id = e.user_id
        ${whereSql}
        ORDER BY ${sortCol} ${dir} NULLS LAST
        LIMIT ? OFFSET ?`,
      ...p, limit, offset,
    ),
    sql.get<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM treasury_ledger_entries e LEFT JOIN users u ON u.id = e.user_id ${whereSql}`,
      ...p,
    ),
  ]);
  return { rows: rows.map(mapRow), total: Number(totalRow?.n ?? rows.length) };
}

// Part 1 — the six largest CONFIRMED treasury -> registered-user payouts,
// newest-tiebreak-first if amounts are equal. Scoped to USDT (amount_micro):
// a BNB gas send is not comparable to a USDT payout on the same numeric
// scale, and in practice every real "payout" this app makes is USDT — see
// the Money & Payouts UI's own comment on this for the honest limitation.
export async function largestConfirmedTreasuryPayouts(limit = 6): Promise<TreasuryLedgerRow[]> {
  const rows = await sql.all<Record<string, unknown>>(
    `SELECT e.*, u.email AS user_email, u.username AS user_username, u.display_name AS user_display_name,
            u.telegram_username AS user_telegram_username, u.telegram_name AS user_telegram_name
       FROM treasury_ledger_entries e
       LEFT JOIN users u ON u.id = e.user_id
      WHERE e.chain = 'bep20' AND e.category = 'user_payout' AND e.direction = 'out'
        AND e.status = 'confirmed' AND e.token_symbol = 'USDT' AND e.amount_micro IS NOT NULL
      ORDER BY e.amount_micro DESC, e.created_at DESC
      LIMIT ?`,
    Math.min(Math.max(limit, 1), 25),
  );
  return rows.map(mapRow);
}

// Part 7 — a compact "is this working" readout for the staff panel, drawn
// entirely from our own checkpoint table + config, never from the explorer.
export type TreasuryMonitorStatus = {
  chain: string;
  scanEnabled: boolean;
  lastScannedBlock: number | null;
  lastSyncAt: string | null;
  trackingStartBlock: number | null;
  confirmationsRequired: number;
  nativeScanEnabled: boolean;
  wsConfigured: boolean;
};
export async function treasuryMonitorStatus(chain = "bep20"): Promise<TreasuryMonitorStatus> {
  const cursor = await sql.get<{ last_scanned_block: string; updated_at: string }>(
    "SELECT last_scanned_block, updated_at FROM deposit_scan_cursors WHERE chain = ?",
    `${chain}:treasury`,
  );
  const addrs = await treasuryAddresses(chain);
  return {
    chain,
    scanEnabled: addrs.length > 0,
    lastScannedBlock: cursor ? Number(cursor.last_scanned_block) : null,
    lastSyncAt: cursor?.updated_at ?? null,
    trackingStartBlock: config.treasuryTrackingStartBlock ?? null,
    confirmationsRequired: config.treasuryConfirmations,
    nativeScanEnabled: config.treasuryNativeScanEnabled,
    wsConfigured: config.rpcBep20Ws !== null,
  };
}

// ---- Background scan (Part 5/6) --------------------------------------------
// Wired into server.ts's existing deposit-scan tick — this reuses that
// interval and its "never let one tick overlap itself" guard rather than
// opening a second timer for what is, cost-wise, the same shape of work.

async function latestBlock(chain: string): Promise<number> {
  const hex = (await rpcCall(chain, "eth_blockNumber", [], { priority: "high" })) as string;
  return parseInt(hex, 16);
}

// Part 5.9 — the exact reorg re-check deposits/credit.ts already does before
// crediting a per-user deposit: a block that had enough confirmations when
// the scanner's window READ it can still be reorged away by the time this
// function actually runs (a later log line in the same tick, or the slower
// reconciliation pass re-visiting the same block). The from/toBlock depth
// filter in tickTreasuryLedgerScan is a necessary condition, not a
// sufficient one — this is what actually enforces "never mark confirmed a
// transaction that no longer lives in the block we think it does".
async function liveBlockHash(chain: string, blockNumber: number): Promise<string | null> {
  const block = (await rpcCall(chain, "eth_getBlockByNumber", ["0x" + blockNumber.toString(16), false], { priority: "high" })) as
    { hash: string } | null;
  return block?.hash ?? null;
}

// Classify + upsert ONE observed treasury-address transaction. Shared by the
// forward walk and the reconciliation re-scan below — both must apply the
// exact same rule, or a transaction classified one way on first sight could
// disagree with itself on a later reconciliation pass.
// Exported for direct testing (same reason deposits/credit.ts's
// recordObservedDeposit is exported) — shared by the forward walk and the
// reconciliation re-scan, both of which must apply the identical rule.
export async function recordObservedTx(
  tx: ObservedTreasuryTx, treasuryAddrSet: Set<string>, confirmationsRequired: number, t: TxApi,
): Promise<void> {
  const direction = treasuryAddrSet.has(tx.toAddress.toLowerCase()) ? "in" : "out";
  const counterpartyAddr = direction === "in" ? tx.fromAddress : tx.toAddress;
  const counterpartyUserId = await registeredWalletUser(tx.chain, counterpartyAddr, t);
  const category = classifyCategory(direction, counterpartyUserId);

  // Re-validate against the chain RIGHT NOW, not just against the depth the
  // scan window already filtered on. A mismatch means the block this
  // transaction lived in has been reorged away since it was first observed —
  // record it as 'reverted' (never 'confirmed') and stop; if the payment
  // reappears in a later block it arrives under a new tx hash and is
  // evaluated completely fresh next time this function sees it.
  const liveHash = await liveBlockHash(tx.chain, tx.blockNumber);
  if (!liveHash || liveHash.toLowerCase() !== tx.blockHash.toLowerCase()) {
    await upsertTreasuryTx({
      chain: tx.chain, txHash: tx.txHash, logIndex: tx.logIndex,
      blockNumber: tx.blockNumber, blockHash: tx.blockHash,
      fromAddress: tx.fromAddress, toAddress: tx.toAddress,
      tokenAddress: tx.tokenAddress, tokenSymbol: tx.tokenSymbol, tokenDecimals: tx.tokenDecimals,
      amountRaw: tx.amountRaw, amountMicro: tx.amountMicro,
      direction, category, userId: counterpartyUserId,
      purpose: null, relatedKind: null, relatedId: null,
      status: "reverted", confirmationsRequired,
      failureReason: "Reorged out — the block this transaction was observed in no longer matches the live chain.",
    }, t);
    return;
  }

  // Only worth asking for outgoing transactions — an incoming deposit was
  // never something OUR code initiated, so it can never match a withdrawal/
  // refund/relay row (those all record the FORWARD/OUTgoing leg's own hash).
  const match = direction === "out" ? await matchInternalRecord(tx.chain, tx.txHash, t) : null;
  await upsertTreasuryTx({
    chain: tx.chain, txHash: tx.txHash, logIndex: tx.logIndex,
    blockNumber: tx.blockNumber, blockHash: tx.blockHash,
    fromAddress: tx.fromAddress, toAddress: tx.toAddress,
    tokenAddress: tx.tokenAddress, tokenSymbol: tx.tokenSymbol, tokenDecimals: tx.tokenDecimals,
    amountRaw: tx.amountRaw, amountMicro: tx.amountMicro,
    direction, category,
    purpose: match?.purpose ?? null,
    userId: match?.userId ?? counterpartyUserId,
    relatedKind: match?.relatedKind ?? null, relatedId: match?.relatedId ?? null,
    // A USDT/BNB transfer is only ever OBSERVED here via a log/block that has
    // already reached `confirmations_required` blocks deep (the fromBlock..
    // safeTip window below enforces that BEFORE a transaction is ever handed
    // to this function) — so "seen by this scan" already means "confirmed",
    // the same convention deposits/credit.ts follows for per-user deposits,
    // ONCE the live re-check above has also passed.
    status: "confirmed", confirmationsRequired,
    confirmedAt: now(),
  }, t);
}

let lastReconcileAt = 0;

// Re-scans a trailing window of already-passed blocks on a slow cadence, to
// recover anything a transient RPC hiccup caused the forward walk to miss
// (Part 5.10). Always safe: every write is idempotent on (chain, tx, log), so
// re-processing an already-recorded event is a no-op status refresh, never a
// duplicate.
async function reconcileTrailingWindow(
  chain: string, addrs: string[], addrSet: Set<string>, safeTip: number, t: TxApi,
): Promise<void> {
  if (Date.now() - lastReconcileAt < config.treasuryReconcileIntervalMs) return;
  lastReconcileAt = Date.now();
  const lookback = config.treasuryReconcileLookbackBlocks;
  if (lookback <= 0) return;
  const fromBlock = Math.max(0, safeTip - lookback);
  if (fromBlock > safeTip) return;
  const { txs } = await scanTreasuryUsdt(chain, addrs, fromBlock, safeTip);
  for (const tx of txs) await recordObservedTx(tx, addrSet, config.treasuryConfirmations, t);
}

// One tick: advance the USDT log scan from its checkpoint, optionally the
// native (BNB) block walk, then (on a slower cadence) reconcile a trailing
// window. A no-op the moment no treasury address is configured at all — the
// same "ships as a no-op until config exists" posture as deposits/scanner.ts.
export async function tickTreasuryLedgerScan(): Promise<void> {
  const chain = "bep20";
  const addrs = await treasuryAddresses(chain);
  if (addrs.length === 0) return;
  const addrSet = new Set(addrs);

  await sql.tx(async (t) => {
    // TRY, not WAIT — same reasoning as deposits/scanner.ts's own lock:
    // declining a tick is always safe (cursor-based, idempotent writes), and
    // a blocking wait would hold a pooled connection for a whole scan's worth
    // of RPC round trips if a previous tick were still running.
    const lock = await t.get<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('treasury-ledger-scan')) AS locked");
    if (!lock?.locked) return;

    const confirmations = config.treasuryConfirmations;
    const latest = await latestBlock(chain);
    const safeTip = latest - confirmations;

    const cursorKey = `${chain}:treasury`;
    const cursor = await t.get<{ last_scanned_block: string }>(
      "SELECT last_scanned_block FROM deposit_scan_cursors WHERE chain = ?", cursorKey,
    );
    // No cursor yet: start from the configured backfill block (Part 6) if
    // set, otherwise the current safe tip — never genesis, which would be an
    // unbounded, unrequested historical scan.
    const fromBlock = cursor
      ? Number(cursor.last_scanned_block) + 1
      : (config.treasuryTrackingStartBlock ?? Math.max(0, safeTip - 1));

    if (fromBlock <= safeTip) {
      const { txs, scannedTo } = await scanTreasuryUsdt(chain, addrs, fromBlock, safeTip);
      for (const tx of txs) await recordObservedTx(tx, addrSet, confirmations, t);
      await t.run(
        `INSERT INTO deposit_scan_cursors (chain, last_scanned_block, updated_at)
         VALUES (?,?,?)
         ON CONFLICT (chain) DO UPDATE SET last_scanned_block = EXCLUDED.last_scanned_block, updated_at = EXCLUDED.updated_at`,
        cursorKey, scannedTo, now(),
      );
    }

    if (config.treasuryNativeScanEnabled) {
      const nativeCursorKey = `${chain}:treasury:native`;
      const nativeCursor = await t.get<{ last_scanned_block: string }>(
        "SELECT last_scanned_block FROM deposit_scan_cursors WHERE chain = ?", nativeCursorKey,
      );
      const nativeFrom = nativeCursor ? Number(nativeCursor.last_scanned_block) + 1 : Math.max(0, safeTip - 1);
      if (nativeFrom <= safeTip) {
        const { txs, scannedTo } = await scanTreasuryNative(chain, addrs, nativeFrom, safeTip);
        for (const tx of txs) await recordObservedTx(tx, addrSet, confirmations, t);
        await t.run(
          `INSERT INTO deposit_scan_cursors (chain, last_scanned_block, updated_at)
           VALUES (?,?,?)
           ON CONFLICT (chain) DO UPDATE SET last_scanned_block = EXCLUDED.last_scanned_block, updated_at = EXCLUDED.updated_at`,
          nativeCursorKey, scannedTo, now(),
        );
      }
    }

    await reconcileTrailingWindow(chain, addrs, addrSet, safeTip, t);
  });
}
