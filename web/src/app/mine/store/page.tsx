"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, Button } from "@/components/ui";
import { Loading, ErrorState, EmptyState } from "@/components/state";
import { ArrowRightIcon, CheckIcon, ClockIcon, MineIcon, XIcon } from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchStore, redeemStoreItem, type StoreItem, type Redemption } from "@/lib/api";
import { formatRozi, timeAgo } from "@/lib/format";

// Spend ROZI on real things.
//
// A SHOP, not an exchange. We sell items at a price we set; we never offer to
// buy ROZI back. That is the line between a bounded sink and an unfunded
// liability (MINING_SPEC.md § 6), and this screen is where a careless "worth
// Rs 100" would cross it. Prices only — no rates, no equivalences, no cash
// figure beside a ROZI figure anywhere on this page.
export default function StorePage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const store = useApi(fetchStore, []);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The delivery detail (a phone number, usually), per item — only the item
  // being bought has one open at a time.
  const [target, setTarget] = useState<{ id: string; value: string } | null>(null);

  if (!ready || store.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (store.error || !store.data) {
    return <div className="p-4 pt-6"><ErrorState message={store.error ?? "…"} onRetry={store.reload} /></div>;
  }

  const s = store.data;

  async function buy(item: StoreItem) {
    // Items that need a delivery detail open the input first; the second tap is
    // the one that spends. The server refuses a missing target either way.
    if (item.inputLabel && target?.id !== item.id) {
      setTarget({ id: item.id, value: "" });
      return;
    }
    if (item.inputLabel && !target?.value.trim()) return;
    if (!window.confirm(
      t("store.confirm", { n: formatRozi(item.costMicro), title: item.title }),
    )) return;

    setBusy(item.id);
    setError(null);
    setNotice(null);
    try {
      await redeemStoreItem(item.id, target?.value.trim() || undefined);
      setNotice(t("store.ordered"));
      setTarget(null);
      store.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header className="flex items-center gap-2">
        <Link href="/mine" aria-label="Back to mining" className="text-brand">
          <ArrowRightIcon size={22} className="rotate-180" />
        </Link>
        <h1 className="text-xl font-bold text-brand-ink">{t("store.title")}</h1>
      </header>
      <p className="px-1 text-sm text-muted">{t("store.subtitle")}</p>

      <Card className="flex items-center justify-between p-4">
        <span className="text-sm text-muted">{t("store.yourRozi")}</span>
        <span className="num font-bold text-brand-ink">{formatRozi(s.roziMicro)} ROZI</span>
      </Card>

      {notice && (
        <Card className="flex items-center gap-3 border-success/30 bg-success-tint/50 p-4">
          <CheckIcon size={22} className="shrink-0 text-success" />
          <p className="font-semibold text-brand-ink">{notice}</p>
        </Card>
      )}
      {error && <p className="rounded-xl bg-danger-tint p-3 text-sm text-danger">{error}</p>}

      {s.items.length === 0 ? (
        <EmptyState title={t("store.empty.title")} body={t("store.empty.body")} />
      ) : (
        <ul className="space-y-2.5">
          {s.items.map((item) => {
            const affordable = s.roziMicro >= item.costMicro;
            const open = target?.id === item.id;
            return (
              <li key={item.id}>
                <Card className="p-4">
                  <div className="flex items-start gap-3">
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
                      <MineIcon size={22} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-brand-ink">{item.title}</p>
                      {item.description && <p className="text-sm text-muted">{item.description}</p>}
                      <p className="num mt-1 font-bold text-accent-ink">
                        {t("store.cost", { n: formatRozi(item.costMicro) })}
                      </p>
                    </div>
                  </div>

                  {open && item.inputLabel && (
                    <div className="mt-3">
                      <label htmlFor={`t-${item.id}`} className="mb-1 block text-sm text-muted">
                        {item.inputLabel}
                      </label>
                      <input
                        id={`t-${item.id}`}
                        value={target.value}
                        onChange={(e) => setTarget({ id: item.id, value: e.target.value })}
                        placeholder={t("store.input.hint")}
                        className="w-full rounded-xl border border-line bg-card p-3 text-brand-ink outline-none focus:border-brand"
                      />
                    </div>
                  )}

                  <div className="mt-3">
                    <Button
                      onClick={() => buy(item)}
                      disabled={
                        busy === item.id || !item.inStock || !affordable
                        || (open && !target.value.trim())
                      }
                      variant={affordable && item.inStock ? "accent" : "ghost"}
                      full
                    >
                      {!item.inStock
                        ? t("store.outOfStock")
                        : !affordable
                          ? t("store.notEnough")
                          : t("store.get")}
                    </Button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {s.redemptions.length > 0 && (
        <section>
          <h2 className="mb-2 px-1 text-base font-bold text-brand-ink">{t("store.orders")}</h2>
          <ul className="space-y-2.5">
            {s.redemptions.map((r) => <OrderRow key={r.id} r={r} />)}
          </ul>
        </section>
      )}
    </div>
  );
}

function OrderRow({ r }: { r: Redemption }) {
  const { t } = useI18n();
  const look = {
    pending: { Icon: ClockIcon, tone: "text-pending", key: "store.status.pending" },
    fulfilled: { Icon: CheckIcon, tone: "text-success", key: "store.status.fulfilled" },
    rejected: { Icon: XIcon, tone: "text-danger", key: "store.status.rejected" },
  }[r.status];

  return (
    <li>
      <Card className="flex items-start gap-3 p-3.5">
        <look.Icon size={20} className={`mt-0.5 shrink-0 ${look.tone}`} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-brand-ink">{r.title}</p>
          <p className={`text-sm ${look.tone}`}>{t(look.key)}</p>
          {/* A staff note only exists when something went wrong, and it is the
              whole reason the user is looking at this row. */}
          {r.staffNote && <p className="mt-0.5 text-sm text-muted">{r.staffNote}</p>}
          <p className="text-xs text-muted">{timeAgo(r.at)}</p>
        </div>
        <span className="num shrink-0 text-sm font-bold text-brand-ink">
          {formatRozi(r.costMicro)}
        </span>
      </Card>
    </li>
  );
}
