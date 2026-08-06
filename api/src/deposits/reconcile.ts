// Reconciliation — CUSTODY_SPEC.md § 5 step 3 / § 3.5 ("who is accountable at
// 3am"). This does NOT answer that question. It only makes the data visible
// when a human looks — there is no paging in this codebase (Sentry declined),
// so a mismatch found here sits as a flag + a snapshot row until someone
// opens the staff panel. Recorded plainly rather than implied: "reconciled"
// here means "checked and written down", not "alerted".
import { createPublicClient, http, fallback, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sql, now, newId } from "../db.ts";
import { config } from "../config.ts";
import { ONCHAIN_CHAINS } from "../payout.ts";
import { treasurySignerKey } from "../signer.ts";
import { flagOnce } from "../fraud.ts";

// Beyond this delta (micro-USDT), a shortfall gets flagged. Not zero on
// purpose — a deposit mid-sweep or a gas send not yet landed is ordinary
// noise, not a discrepancy.
const MISMATCH_THRESHOLD_MICRO = 1_000_000; // $1

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

  // Deposits credited to a user but not yet consolidated into treasury still
  // count as "ours" — comparing treasury-alone against the ledger would flag
  // every completely ordinary not-yet-swept deposit as a discrepancy.
  const unsweptRow = await sql.get<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM chain_deposits
     WHERE chain = ? AND status = 'credited' AND swept_at IS NULL`,
    chain,
  );
  const unsweptMicro = BigInt(unsweptRow?.total ?? "0");

  const ledgerRow = await sql.get<{ total: string }>(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM usdt_ledger WHERE chain = ?", chain,
  );
  const ledgerMicro = BigInt(ledgerRow?.total ?? "0");

  const onchainMicro = treasuryMicro + unsweptMicro;
  const delta = onchainMicro - ledgerMicro;

  await sql.run(
    `INSERT INTO treasury_balance_snapshots (id, chain, token, onchain_balance, ledger_total, delta, checked_at)
     VALUES (?,?,?,?,?,?,?)`,
    newId(), chain, "usdt", onchainMicro.toString(), ledgerMicro.toString(), delta.toString(), now(),
  );

  // Only a SHORTFALL is flagged — holding more than the ledger says we owe is
  // an unaccounted float (a fee, a rounding remainder), not a risk. Holding
  // LESS is the direction that means money the ledger promises isn't there.
  if (delta < 0n && -delta > BigInt(MISMATCH_THRESHOLD_MICRO)) {
    await flagOnce(
      "reconciliation_mismatch", `chain:${chain}`, null, "high",
      `${chain}: on-chain + unswept (${onchainMicro} micro-USDT) is ${-delta} micro-USDT short of the ledger (${ledgerMicro}).`,
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
