// The recording path for an observed native-value (BNB) deposit — the
// history-only counterpart to deposits/credit.ts. Read that file's header
// first: THIS FILE NEVER TOUCHES A LEDGER. A BNB deposit's only effect is a
// row in native_deposits so it can be shown to the user; the balance itself
// stays a live eth_getBalance read (payoutRelay.ts's userGasWallet), exactly
// as it already was before this file existed. If a future change makes this
// call postUsdt or any other ledger-crediting function, that is the bug this
// header exists to prevent.
import { sql, now, newId, type TxApi } from "../db.ts";
import { rpcCall } from "../rpc.ts";
import type { ObservedNativeDeposit } from "./types.ts";

async function currentBlockHash(chain: string, blockNumber: number): Promise<string | null> {
  const block = (await rpcCall(chain, "eth_getBlockByNumber", ["0x" + blockNumber.toString(16), false])) as
    { hash: string } | null;
  return block?.hash ?? null;
}

export type NativeCreditOutcome = "confirmed" | "already_confirmed" | "reorged_out";

export async function recordObservedNativeDeposit(
  observed: ObservedNativeDeposit,
  t: Pick<TxApi, "run" | "get"> = sql,
): Promise<{ status: NativeCreditOutcome; id: string; userId?: string; amountWei?: bigint }> {
  const existing = await t.get<{ id: string; status: string }>(
    `SELECT id, status FROM native_deposits WHERE LOWER(chain) = LOWER(?) AND LOWER(tx_hash) = LOWER(?)`,
    observed.chain, observed.txHash,
  );

  let id = existing?.id;
  if (!id) {
    id = newId();
    await t.run(
      `INSERT INTO native_deposits
         (id, user_id, chain, address, tx_hash, from_address, amount_wei,
          block_number, block_hash, status, first_seen_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?, 'seen', ?, ?)
       ON CONFLICT (LOWER(chain), LOWER(tx_hash)) DO NOTHING`,
      id, observed.userId, observed.chain, observed.address, observed.txHash, observed.fromAddress,
      observed.amountWei.toString(), observed.blockNumber, observed.blockHash, now(), now(),
    );
  } else if (existing!.status === "confirmed") {
    return { status: "already_confirmed", id };
  } else if (existing!.status === "reorged_out") {
    return { status: "reorged_out", id };
  }

  // Same reorg re-check credit.ts does before a real credit — here it only
  // gates whether the row is ever shown, but a phantom deposit that later
  // vanished on-chain must not sit in a user's history as if it happened.
  const liveHash = await currentBlockHash(observed.chain, observed.blockNumber);
  if (!liveHash || liveHash.toLowerCase() !== observed.blockHash.toLowerCase()) {
    await t.run("UPDATE native_deposits SET status = 'reorged_out' WHERE id = ? AND status <> 'confirmed'", id);
    return { status: "reorged_out", id };
  }

  const claim = await t.run(
    "UPDATE native_deposits SET status = 'confirmed', confirmed_at = ? WHERE id = ? AND status = 'seen'",
    now(), id,
  );
  if (claim.rowCount === 0) {
    return { status: "already_confirmed", id };
  }

  return { status: "confirmed", id, userId: observed.userId, amountWei: observed.amountWei };
}
