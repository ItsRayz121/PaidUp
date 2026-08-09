// Shared history-row builder for the wallet overhaul — used by /wallet and
// the per-token pages (/wallet/usdt, /wallet/bnb, /wallet/rozi) so all four
// screens agree on how a transaction is labelled, formatted and detailed.
//
// ⚠️ THIS IS A DISPLAY MERGE ONLY (guardrail #7). Nothing here writes
// anything; it turns five already-fetched API responses into one sorted,
// filterable list. Task/referral/adjustment rows stay in ROZI (the app-wide
// convention) — only real USDT/BNB movement (withdrawals, refunds, top-ups,
// BNB sends) renders in its own native currency, because that is what
// actually moved.
import {
  StarIcon, WalletIcon, GiftIcon, MineIcon, BoltIcon, ChipIcon, SendIcon, ReceiveIcon,
} from "@/components/icons";
import {
  type LedgerEntry, type RoziEntry, type Withdrawal, type BnbWithdrawal, type UsdtTopup, type UsdtRefund,
  type UsdtTaskReward,
} from "@/lib/api";
import { formatRozi, usdtFromMicro, pointsToRoziMicro, pointsToUsdt, formatBnbWei } from "@/lib/format";

export type IconComp = (p: { size?: number; className?: string }) => React.ReactElement;
export type TokenFilter = "all" | "USDT" | "BNB" | "ROZI";
export type KindFilter = "all" | "received" | "sent" | "reward" | "mining";

export type Row = {
  key: string;
  label: string;
  at: string;
  token: "USDT" | "BNB" | "ROZI";
  kind: Exclude<KindFilter, "all">;
  amountText: string; // pre-formatted, signed, with unit
  credit: boolean;
  status?: LedgerEntry["status"];
  Icon: IconComp;
  detail: {
    amountText: string;
    statusText: string;
    network?: string;
    from?: string;
    to?: string;
    txHash?: string;
  };
};

const HISTORY_PREVIEW = 2;

// The two newest rows, plus anything still in flight — a pending/sending row
// is real money in flight and must never disappear just because newer rows
// piled on top of it (same rule the original wallet screen used).
export function preview(rows: Row[]): Row[] {
  const keep = new Set(rows.slice(0, HISTORY_PREVIEW).map((r) => r.key));
  for (const r of rows) if (r.status === "pending" || r.status === "sending") keep.add(r.key);
  return rows.filter((r) => keep.has(r.key));
}

// The long form of ui.tsx's `statusMap`, shown inside the transaction detail
// sheet where there is room for a sentence. Same five outcomes, same words —
// keep the two in step, and read the note above statusMap before changing
// either (in particular: `refunded` must never become "Failed").
export const STATUS_TEXT: Record<string, string> = {
  earned: "Completed", paid: "Completed", pending: "Pending", sending: "Processing",
  rejected: "Rejected",
  // Distinct from "rejected": this row is an outgoing send that didn't go
  // through — the amount was credited back, not withheld.
  refunded: "Returned — the money is back in your balance",
};

export function unifyHistory(args: {
  ledger: LedgerEntry[];
  rozi: RoziEntry[];
  withdrawals: Withdrawal[];
  topups: UsdtTopup[];
  refunds: UsdtRefund[];
  bnb: BnbWithdrawal[];
  taskUsdt?: UsdtTaskReward[];
  t: (key: string, vars?: Record<string, string>) => string;
}): Row[] {
  const { ledger, rozi, withdrawals, topups, refunds, bnb, taskUsdt = [], t } = args;

  const roziIcon: Record<string, IconComp> = {
    mining: MineIcon, rig_purchase: ChipIcon, transfer_in: ReceiveIcon,
    transfer_out: SendIcon, transfer_fee: BoltIcon, conversion_burn: WalletIcon,
    store_redemption: GiftIcon, bonus: GiftIcon, admin_adjustment: BoltIcon,
  };
  const roziKind: Record<string, Row["kind"]> = {
    mining: "mining", transfer_in: "received", transfer_out: "sent",
  };
  const useNote = new Set(["rig_purchase", "store_redemption", "transfer_out"]);

  // Task/referral/adjustment rows stay in ROZI. 'withdrawal' rows are
  // excluded here and rebuilt below from /withdrawals, which carries the
  // real USDT amount and tx hash the points ledger row does not.
  const points: Row[] = ledger
    .filter((e) => e.status !== "rejected" && e.kind !== "withdrawal")
    .map((e) => {
      const micro = pointsToRoziMicro(e.points);
      const credit = micro >= 0;
      const amountText = `${credit ? "+" : "−"}${formatRozi(Math.abs(micro))} ROZI`;
      return {
        key: `p:${e.id}`, label: e.label, at: e.at, token: "ROZI" as const, kind: "reward" as const,
        amountText, credit, status: e.status, Icon: e.kind === "referral" ? GiftIcon : StarIcon,
        detail: { amountText, statusText: STATUS_TEXT[e.status] ?? e.status },
      };
    });

  const roziRows: Row[] = rozi.map((e) => {
    const credit = e.amountMicro >= 0;
    const amountText = `${credit ? "+" : "−"}${formatRozi(Math.abs(e.amountMicro))} ROZI`;
    return {
      key: `r:${e.id}`,
      label: (useNote.has(e.source_type) && e.note) || t(`wallet.tx.${e.source_type}`),
      at: e.created_at, token: "ROZI" as const, kind: roziKind[e.source_type] ?? "reward",
      amountText, credit, Icon: roziIcon[e.source_type] ?? MineIcon,
      detail: { amountText, statusText: "Completed" },
    };
  });

  const withdrawalRows: Row[] = withdrawals.map((w) => {
    const usdt = w.usdtAmount ? Number(w.usdtAmount) : pointsToUsdt(w.amount);
    // A rejected withdrawal credits the held points straight back
    // (api/src/routes/staff.ts's reject branch) — "refunded", not "rejected".
    const statusKey = (w.status === "paid" ? "paid" : w.status === "rejected" ? "refunded"
      : w.status === "sending" ? "sending" : "pending") as LedgerEntry["status"];
    const amountText = `−${usdt.toFixed(2)} USDT`;
    return {
      key: `w:${w.id}`, label: t("wallet.tx.usdtWithdrawal"), at: w.at, token: "USDT" as const, kind: "sent" as const,
      amountText, credit: false, status: statusKey, Icon: SendIcon,
      detail: {
        amountText, statusText: STATUS_TEXT[statusKey] ?? w.status, network: w.chain, to: w.address, txHash: w.txHash,
      },
    };
  });

  const topupRows: Row[] = topups.map((u) => {
    const statusKey = (u.status === "confirmed" ? "paid" : u.status === "rejected" ? "rejected" : "pending") as LedgerEntry["status"];
    const amountText = `+${usdtFromMicro(u.amountMicro).toFixed(2)} USDT`;
    return {
      key: `tu:${u.id}`, label: t("wallet.tx.usdtDeposit"), at: u.createdAt, token: "USDT" as const, kind: "received" as const,
      amountText, credit: true, status: statusKey, Icon: ReceiveIcon,
      detail: { amountText, statusText: STATUS_TEXT[statusKey] ?? u.status, network: u.chain, txHash: u.txHash },
    };
  });

  const refundRows: Row[] = refunds.map((r) => {
    // A rejected refund returns the full gross amount (staffMining.ts) — the
    // user's deposit balance is untouched, so this reads "refunded", not
    // "rejected" (which would suggest the money is stuck or gone).
    const statusKey = (r.status === "paid" ? "paid" : r.status === "rejected" ? "refunded"
      : r.status === "sending" ? "sending" : "pending") as LedgerEntry["status"];
    const amountText = `−${usdtFromMicro(r.amountMicro - r.feeMicro).toFixed(2)} USDT`;
    return {
      key: `ru:${r.id}`, label: t("wallet.tx.usdtRefund"), at: r.createdAt, token: "USDT" as const, kind: "sent" as const,
      amountText, credit: false, status: statusKey, Icon: SendIcon,
      detail: {
        amountText, statusText: STATUS_TEXT[statusKey] ?? r.status, network: r.chain, to: r.address,
        txHash: r.txHash ?? undefined,
      },
    };
  });

  const bnbRows: Row[] = bnb.map((b) => {
    // A BNB withdraw has zero internal ledger entry (bnbWithdraw.ts) — a
    // "failed" job never took the user's balance in the first place, so
    // "refunded" (nothing lost) reads truer than "rejected" (implies denial).
    const statusKey = (b.status === "paid" ? "paid" : b.status === "failed" ? "refunded"
      : b.status === "sending" ? "sending" : "pending") as LedgerEntry["status"];
    // formatBnbWei does the bigint-safe wei->BNB split — see its own note on
    // why this never runs Number() on a raw wei string.
    const amountText = `−${formatBnbWei(b.amountWei)}`;
    return {
      key: `bw:${b.id}`, label: t("wallet.tx.bnbWithdrawal"), at: b.at, token: "BNB" as const, kind: "sent" as const,
      amountText, credit: false, status: statusKey, Icon: SendIcon,
      detail: { amountText, statusText: STATUS_TEXT[statusKey] ?? b.status, network: "bep20", to: b.address, txHash: b.txHash },
    };
  });

  const taskUsdtRows: Row[] = taskUsdt.map((r) => {
    const amountText = `+${usdtFromMicro(r.amountMicro).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")} USDT`;
    return {
      key: `tr:${r.id}`, label: r.label, at: r.at, token: "USDT" as const, kind: "reward" as const,
      amountText, credit: true, status: "paid" as const, Icon: StarIcon,
      detail: { amountText, statusText: "Completed" },
    };
  });

  return [...points, ...roziRows, ...withdrawalRows, ...topupRows, ...refundRows, ...bnbRows, ...taskUsdtRows]
    .sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
}
