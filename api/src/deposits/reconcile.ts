// Reconciliation — CUSTODY_SPEC.md § 5 step 3 / § 3.5 ("who is accountable at
// 3am"). This does NOT answer that question. It only makes the data visible
// when a human looks — there is no paging in this codebase (Sentry declined),
// so a mismatch found here sits as a flag + a snapshot row until someone
// opens the staff panel. Recorded plainly rather than implied: "reconciled"
// here means "checked and written down", not "alerted".
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
import { privateKeyToAccount } from "viem/accounts";
import { sql, now, newId } from "../db.ts";
import { config } from "../config.ts";
import { ONCHAIN_CHAINS } from "../payout.ts";
import { treasurySignerKey } from "../signer.ts";
import { flagOnce } from "../fraud.ts";

// Beyond this delta (micro-USDT), a shortfall gets flagged. Not zero on
// purpose — a gas/prefund leg mid-flight in payoutRelay.ts is ordinary noise,
// not a discrepancy.
const MISMATCH_THRESHOLD_MICRO = 1_000_000; // $1

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

  const ledgerRow = await sql.get<{ total: string }>(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM usdt_ledger WHERE chain = ?", chain,
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
    await flagOnce(
      "reconciliation_mismatch", `chain:${chain}`, null, "high",
      `${chain}: on-chain (treasury + every deposit address, live-checked = ${onchainMicro} micro-USDT) ` +
      `is ${-delta} micro-USDT short of the ledger (${ledgerMicro}).`,
    );
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
