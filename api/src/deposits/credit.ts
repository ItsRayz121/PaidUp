// The single crediting path for an observed on-chain deposit — CUSTODY_SPEC.md
// § 5 step 2. Both the poller (deposits/scanner.ts) and, later, an optional
// webhook route are meant to call ONLY this function, so there is exactly one
// place a deposit can become a ledger credit no matter which source noticed
// it first — a webhook racing the poller on the same event must not double-pay.
//
// NEVER CREDITS BEFORE `confirmationsRequired`, and re-checks the block hash
// at credit time even though callers are expected to have already filtered by
// depth — a block that had enough confirmations when the scanner READ it can
// still be reorged away by the time this runs. The re-check, not the filter,
// is what actually enforces "never credit a deposit that no longer exists
// on-chain".
import { sql, now, newId, postUsdt, type TxApi } from "../db.ts";
import { rpcCall } from "../rpc.ts";
import type { ObservedDeposit } from "./types.ts";

async function currentBlockHash(chain: string, blockNumber: number): Promise<string | null> {
  const block = (await rpcCall(chain, "eth_getBlockByNumber", ["0x" + blockNumber.toString(16), false])) as
    { hash: string } | null;
  return block?.hash ?? null;
}

export type CreditOutcome = "credited" | "already_credited" | "reorged_out";

export async function recordObservedDeposit(
  observed: ObservedDeposit,
  confirmationsRequired: number,
  t: Pick<TxApi, "run" | "get"> = sql,
): Promise<{ status: CreditOutcome; id: string }> {
  const existing = await t.get<{ id: string; status: string }>(
    `SELECT id, status FROM chain_deposits
     WHERE LOWER(chain) = LOWER(?) AND LOWER(tx_hash) = LOWER(?) AND COALESCE(log_index, -1) = ?`,
    observed.chain, observed.txHash, observed.logIndex ?? -1,
  );

  let id = existing?.id;
  if (!id) {
    id = newId();
    await t.run(
      `INSERT INTO chain_deposits
         (id, user_id, chain, address, tx_hash, log_index, amount, token,
          block_number, block_hash, confirmations_required, status, first_seen_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'seen', ?, ?)
       ON CONFLICT (LOWER(chain), LOWER(tx_hash), COALESCE(log_index, -1)) DO NOTHING`,
      id, observed.userId, observed.chain, observed.address, observed.txHash, observed.logIndex,
      observed.amountMicro.toString(), observed.token, observed.blockNumber, observed.blockHash,
      confirmationsRequired, now(), now(),
    );
  } else if (existing!.status === "credited") {
    return { status: "already_credited", id };
  } else if (existing!.status === "reorged_out") {
    return { status: "reorged_out", id };
  }

  // Re-validate against the chain RIGHT NOW: the block this deposit lived in
  // must still have the same hash. A mismatch means a reorg happened
  // underneath it since it was first observed — flip to reorged_out and stop.
  // No credit, ever, for this row; if the payment reappears in a later block
  // it arrives as a NEW transaction hash and is evaluated fresh.
  const liveHash = await currentBlockHash(observed.chain, observed.blockNumber);
  if (!liveHash || liveHash.toLowerCase() !== observed.blockHash.toLowerCase()) {
    await t.run("UPDATE chain_deposits SET status = 'reorged_out' WHERE id = ? AND status <> 'credited'", id);
    return { status: "reorged_out", id };
  }

  // The idempotency guard: this conditional UPDATE's rowCount is the ONLY
  // thing that decides whether we credit. A concurrent caller (a webhook
  // firing the same instant the poller processes this row, or the poller
  // re-visiting a row it already handled) that loses this race matches zero
  // rows and returns without ever calling postUsdt.
  const claim = await t.run(
    "UPDATE chain_deposits SET status = 'confirmed', confirmed_at = ? WHERE id = ? AND status = 'seen'",
    now(), id,
  );
  if (claim.rowCount === 0) {
    return { status: "already_credited", id };
  }

  const ledgerId = await postUsdt({
    userId: observed.userId,
    micro: Number(observed.amountMicro),
    direction: "credit",
    sourceType: "topup",
    sourceRefId: id,
    chain: observed.chain,
    note: `On-chain deposit, ${observed.chain} ${observed.txHash}`,
  }, t);

  await t.run(
    "UPDATE chain_deposits SET status = 'credited', credited_ledger_id = ?, credited_at = ? WHERE id = ?",
    ledgerId, now(), id,
  );

  return { status: "credited", id };
}
