// Reconciliation — CUSTODY_SPEC.md § 5 step 3 / § 3.5 ("who is accountable at
// 3am"). A shortfall below every tick is written to a snapshot row AND (since
// alerts.ts) pages a staff Telegram channel via fraud.ts's flagOnce, on the
// first tick that finds it — later ticks re-detecting the same open flag stay
// silent (flagOnce's own dedupe), so the page fires once, not every hour the
// mismatch stays open. That still isn't real on-call paging — Telegram has no
// escalation, no acknowledgement, no rotation — but it is no longer "nobody
// finds out until someone opens the panel".
//
// ⚠️ REWRITTEN 2026-08-08 for "never sweep" (config.custodySweepEnabled
// default off). The old version summed treasury balance + SUM(chain_deposits
// WHERE swept_at IS NULL) — a fine proxy while sweeping ran promptly, because
// "unswept" was normally near-zero and transient. Once sweeping stops,
// swept_at never gets set, so that sum silently drifts from reality the
// first time ANY refund or payoutRelay.ts withdrawal pass-through actually
// drains a deposit address's real balance: the stale sum still counts that
// money as "ours" while the ledger has already netted the debit out, which
// reads as a false SURPLUS (the direction this file does not even flag) —
// exactly masking the one thing reconciliation exists to catch. So this now
// sums LIVE on-chain balances across every known deposit address, via
// multicall, instead of trusting any bookkeeping column. Correct regardless
// of whether sweeping is ever turned back on — a swept address just
// contributes ~0.
import { createPublicClient, http, fallback, erc20Abi } from "viem";
import { charge } from "../costGuard.ts";
import { privateKeyToAccount } from "viem/accounts";
import { sql, now, newId, getSetting, setSetting } from "../db.ts";
import { config } from "../config.ts";
import { ONCHAIN_CHAINS } from "../payout.ts";
import { treasurySignerKey } from "../signer.ts";
import { flagOnce } from "../fraud.ts";

// Beyond this delta (micro-USDT), a shortfall gets flagged. Not zero on
// purpose — a gas/prefund leg mid-flight in payoutRelay.ts is ordinary noise,
// not a discrepancy.
const MISMATCH_THRESHOLD_MICRO = 1_000_000; // $1

// Once a shortfall of a given size has been raised and a human has RESOLVED
// the flag, re-raising an identical one every hour is exactly the noise the
// founder asked us to stop (2026-09-02): the dashboard tile already tracks the
// live snapshot, and flagOnce only dedupes against UNRESOLVED rows, so a
// resolve-then-re-detect loop pages staff forever. We remember the last
// magnitude we alerted on (per chain, in app_settings) and stay silent unless
// the shortfall gets materially WORSE (a genuinely new problem) or a long time
// has passed (a forgotten shortfall shouldn't vanish for good).
const RECON_REALERT_MS = 7 * 24 * 60 * 60 * 1000; // re-surface a stale, still-open shortfall weekly
const reconAlertKey = (chain: string) => `recon.lastAlert.${chain}`;

async function shouldRaiseReconFlag(chain: string, absShortfallMicro: bigint): Promise<boolean> {
  // An unresolved flag already covers it (flagOnce would no-op anyway).
  const open = await sql.get<{ id: string }>(
    "SELECT id FROM fraud_flags WHERE flag_type = 'reconciliation_mismatch' AND device_id = ? AND resolved_by IS NULL LIMIT 1",
    `chain:${chain}`,
  );
  if (open) return false;

  const raw = await getSetting(reconAlertKey(chain), "");
  if (!raw) return true; // never alerted for this chain — raise it
  let prevAbs = 0n;
  let prevAt = 0;
  try {
    const prev = JSON.parse(raw) as { abs?: string; at?: string };
    prevAbs = BigInt(String(prev.abs ?? "0").replace(/[^0-9]/g, "") || "0");
    prevAt = Date.parse(prev.at ?? "") || 0;
  } catch {
    return true; // marker is corrupt — treat as "never alerted" and raise
  }

  // Materially worse than the shortfall someone already resolved → new problem.
  if (absShortfallMicro > prevAbs + BigInt(MISMATCH_THRESHOLD_MICRO)) return true;
  // Same (or smaller) shortfall, already resolved once — re-surface only weekly.
  if (Date.now() - prevAt > RECON_REALERT_MS) return true;
  return false;
}

// eth_call/multicall responses have a size limit on public RPC nodes — the
// same class of limit already breaking the deposit scanner's eth_getLogs in
// production (see CLAUDE.md). Batching keeps one reconciliation tick from
// being the next thing that trips it.
const MULTICALL_BATCH_SIZE = 300;

// ⚠️ THROWS on any unresolved address, deliberately — never substitutes 0
// for a balance the RPC failed to return. A silent 0-on-failure would make a
// rate-limited or flaky RPC batch (this project's own public BEP20 nodes are
// documented as hitting "limit exceeded" in production) UNDER-count real
// on-chain holdings, which reads as a false shortfall and could page staff
// over nothing — or, on a batch that happens to contain the one address that
// really is short, get buried in a pile of routine-looking noise instead of
// standing out. reconcileChain's caller (tickReconcile) already retries
// every hour, so failing this attempt outright and trying again next tick is
// strictly safer than recording a number that might not be true.
async function sumLiveBalances(
  publicClient: ReturnType<typeof createPublicClient>,
  token: NonNullable<(typeof ONCHAIN_CHAINS)[keyof typeof ONCHAIN_CHAINS]>,
  addresses: string[],
): Promise<bigint> {
  let total = 0n;
  for (let i = 0; i < addresses.length; i += MULTICALL_BATCH_SIZE) {
    const batch = addresses.slice(i, i + MULTICALL_BATCH_SIZE);
    const results = await publicClient.multicall({
      contracts: batch.map((address) => ({
        address: token.usdt, abi: erc20Abi, functionName: "balanceOf", args: [address as `0x${string}`],
      })),
      allowFailure: true,
    });
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status !== "success") {
        throw new Error(`balanceOf failed for deposit address ${batch[j]}: ${r.error?.message ?? "unknown error"}`);
      }
      total += r.result as bigint;
    }
  }
  return total;
}

export async function reconcileChain(chain: string): Promise<void> {
  const token = ONCHAIN_CHAINS[chain as keyof typeof ONCHAIN_CHAINS];
  if (!token) return;
  const pk = treasurySignerKey();
  if (!pk) return; // no treasury signer configured — nothing on-chain to compare against yet

  const treasuryAddress = privateKeyToAccount(pk).address;

  // Count this tick against the process-wide RPC ceiling (costGuard.ts) before
  // spending anything. These calls go out through viem's own transport rather
  // than rpc.ts, so they are invisible to the per-call charge there — this is
  // where they get counted. The estimate is one treasury balanceOf plus one
  // multicall per batch of deposit addresses; being refused simply means the
  // hourly snapshot is skipped, and the next tick takes it, which is already
  // how every other failure of this job behaves.
  const addressCount = Number(
    (await sql.get<{ n: number | string }>(
      "SELECT COUNT(*) AS n FROM deposit_wallets WHERE chain = ?", chain,
    ))?.n ?? 0,
  );
  const estimatedCalls = 1 + Math.ceil(addressCount / MULTICALL_BATCH_SIZE);
  if (!charge("rpc", estimatedCalls, "low")) return;

  const transport = fallback(config.payoutRpc[chain].map((url) => http(url)));
  const publicClient = createPublicClient({ chain: token.viemChain, transport });

  const rawTreasuryBalance = (await publicClient.readContract({
    address: token.usdt, abi: erc20Abi, functionName: "balanceOf", args: [treasuryAddress],
  })) as bigint;
  const treasuryMicro = rawTreasuryBalance / 10n ** BigInt(Math.max(0, token.decimals - 6));

  const addressRows = await sql.all<{ address: string }>(
    "SELECT address FROM deposit_wallets WHERE chain = ?", chain,
  );
  const rawDepositAddressesBalance = await sumLiveBalances(publicClient, token, addressRows.map((r) => r.address));
  const depositAddressesMicro = rawDepositAddressesBalance / 10n ** BigInt(Math.max(0, token.decimals - 6));

  // usdt_ledger has been BEP20-only since "one chain in, one chain out": every
  // topup, refund and rig purchase touches BEP20 and nothing else. Two kinds of
  // row carry chain = NULL anyway — rows written before the column existed, and
  // admin_adjustment rows, which postUsdt writes with no chain by design. Those
  // are BEP20 activity too, and skipping them means a correcting adjustment for
  // a BEP20 discrepancy is invisible to the very check that flagged it: the
  // 2026-09-02 "-2.00 phantom shortfall" was exactly this — a resolved
  // double-credit whose -2.04 of admin_adjustment reversals summed outside
  // `WHERE chain = 'bep20'`, so the flag never cleared and re-raised every hour.
  // Fold NULL into the sole chain. If a second deposit chain is ever added
  // ONCHAIN_CHAINS grows past one key and this guard stops, so NULL rows are
  // never double-counted across chains.
  const isSoleChain = Object.keys(ONCHAIN_CHAINS).length === 1;
  const ledgerRow = await sql.get<{ total: string }>(
    isSoleChain
      ? "SELECT COALESCE(SUM(amount), 0) AS total FROM usdt_ledger WHERE chain = ? OR chain IS NULL"
      : "SELECT COALESCE(SUM(amount), 0) AS total FROM usdt_ledger WHERE chain = ?",
    chain,
  );
  const ledgerMicro = BigInt(ledgerRow?.total ?? "0");

  const onchainMicro = treasuryMicro + depositAddressesMicro;
  const delta = onchainMicro - ledgerMicro;

  await sql.run(
    `INSERT INTO treasury_balance_snapshots (id, chain, token, onchain_balance, ledger_total, delta, checked_at)
     VALUES (?,?,?,?,?,?,?)`,
    newId(), chain, "usdt", onchainMicro.toString(), ledgerMicro.toString(), delta.toString(), now(),
  );

  // Only a SHORTFALL is flagged — holding more than the ledger says we owe is
  // an unaccounted float (a fee, a rounding remainder, a job mid-flight), not
  // a risk. Holding LESS is the direction that means money the ledger
  // promises isn't there.
  if (delta < 0n && -delta > BigInt(MISMATCH_THRESHOLD_MICRO)) {
    if (await shouldRaiseReconFlag(chain, -delta)) {
      await flagOnce(
        "reconciliation_mismatch", `chain:${chain}`, null, "high",
        `${chain}: on-chain (treasury + every deposit address, live-checked = ${onchainMicro} micro-USDT) ` +
        `is ${-delta} micro-USDT short of the ledger (${ledgerMicro}).`,
      );
      await setSetting(reconAlertKey(chain), JSON.stringify({ abs: (-delta).toString(), at: now() }));
    }
  } else if (delta >= 0n) {
    // Books are square again — forget the last-alerted magnitude so a future
    // fresh shortfall pages immediately instead of being suppressed against a
    // stale marker.
    await setSetting(reconAlertKey(chain), "");
  }
}

export async function tickReconcile(): Promise<void> {
  for (const chain of ["bep20"]) {
    try {
      await reconcileChain(chain);
    } catch {
      // An RPC outage or similar must not crash the process — the next
      // hourly tick tries again, and a stuck run is itself visible as a gap
      // in treasury_balance_snapshots' timeline.
    }
  }
}
