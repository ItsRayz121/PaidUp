"use client";

// Shared bottom-sheet transaction detail + filter chip, used by /wallet and
// the per-token pages. Renders exactly what the tapped Row already carries —
// no second fetch, since every field the spec asks for (amount, status,
// network, from/to, hash, date) is already on hand by the time a row exists.
import { useState } from "react";
import { Button } from "@/components/ui";
import { BottomSheet } from "@/components/BottomSheet";
import { CopyIcon, CheckIcon } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { chainLabel } from "@/lib/chains";
import { shortAddress } from "@/lib/wallet";
import type { Row } from "@/lib/walletHistory";

export function TxDetailSheet({ row, onClose }: { row: Row; onClose: () => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState<string | null>(null);

  function copy(label: string, value: string) {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  const explorerUrl = row.detail.txHash && row.detail.network === "bep20"
    ? `https://bscscan.com/tx/0x${row.detail.txHash.replace(/^0x/, "")}`
    : null;

  return (
    <BottomSheet labelledBy="tx-detail-title" onClose={onClose}>
      <div className="space-y-3">
        <div className="flex items-center gap-3 pe-10">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
            <row.Icon size={22} />
          </span>
          <div className="min-w-0">
            <h2 id="tx-detail-title" className="text-lg font-bold text-brand-ink">{row.label}</h2>
            <p className="text-xs text-muted">{new Date(row.at).toLocaleString()}</p>
          </div>
        </div>

        <div className="rounded-xl border border-line divide-y divide-line">
          <DetailField label={t("tx.amount")} value={row.detail.amountText} />
          <DetailField label={t("tx.status")} value={row.detail.statusText} />
          {row.detail.network && <DetailField label={t("tx.network")} value={chainLabel(row.detail.network)} />}
          {row.detail.from && (
            <DetailField label={t("tx.from")} value={shortAddress(row.detail.from)} mono
              onCopy={() => copy("from", row.detail.from!)} copied={copied === "from"} />
          )}
          {row.detail.to && (
            <DetailField label={t("tx.to")} value={shortAddress(row.detail.to)} mono
              onCopy={() => copy("to", row.detail.to!)} copied={copied === "to"} />
          )}
          {row.detail.txHash && (
            <DetailField label={t("tx.hash")} value={shortAddress(row.detail.txHash)} mono
              onCopy={() => copy("hash", row.detail.txHash!)} copied={copied === "hash"} />
          )}
        </div>

        {explorerUrl && (
          <a href={explorerUrl} target="_blank" rel="noreferrer"
            className="block rounded-xl border border-line p-3 text-center text-sm font-semibold text-brand active:bg-brand-tint/40">
            {t("tx.viewExplorer")}
          </a>
        )}
        <Button onClick={onClose} variant="ghost">{t("common.close")}</Button>
      </div>
    </BottomSheet>
  );
}

function DetailField({
  label, value, mono = false, onCopy, copied,
}: { label: string; value: string; mono?: boolean; onCopy?: () => void; copied?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 p-3">
      <span className="text-sm text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <span className={`text-sm font-semibold text-brand-ink text-right ${mono ? "num" : ""}`}>{value}</span>
        {onCopy && (
          <button onClick={onCopy} aria-label={`Copy ${label}`} className="shrink-0 text-muted active:text-brand">
            {copied ? <CheckIcon size={16} className="text-success" /> : <CopyIcon size={16} />}
          </button>
        )}
      </div>
    </div>
  );
}

export function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
        active ? "border-brand bg-brand-tint text-brand" : "border-line bg-card text-muted"
      }`}
    >
      {children}
    </button>
  );
}
