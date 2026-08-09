"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, Button, SectionTitle } from "@/components/ui";
import { Loading, ErrorState, EmptyState } from "@/components/state";
import { ArrowRightIcon, SendIcon, ReceiveIcon } from "@/components/icons";
import { RoziMark } from "@/components/tokenIcons";
import { TxDetailSheet } from "@/components/TxDetailSheet";
import { HistoryList } from "@/components/HistoryList";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchMiningState, fetchRoziHistory } from "@/lib/api";
import { formatRozi } from "@/lib/format";
import { unifyHistory, type Row } from "@/lib/walletHistory";

// ROZI as its own wallet page. Mining itself is untouched — /mine still owns
// the full balance and dial — this is a thin reuse of the same data plus the
// ROZI slice of the unified history, in the shape the other token pages use,
// so the app is ready for ROZI deposits/withdrawals/transfers the moment
// that becomes real (see the request this page answers: "do not build the
// system in a way that only supports USDT").
export default function RoziWalletPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const mining = useApi(fetchMiningState, []);
  const rozi = useApi(fetchRoziHistory, []);
  const [openTx, setOpenTx] = useState<Row | null>(null);

  if (!ready) return <div className="p-4 pt-6"><Loading /></div>;

  const transfersOn = Boolean(mining.data?.transfersEnabled);
  const rows = unifyHistory({
    ledger: [], rozi: rozi.data?.entries ?? [], withdrawals: [], topups: [], refunds: [], bnb: [], t,
  });

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header className="flex items-center gap-2">
        <Link href="/wallet" aria-label="Back to wallet" className="text-brand">
          <ArrowRightIcon size={22} className="rotate-180" />
        </Link>
        <span className="grid h-8 w-8 place-items-center rounded-full bg-brand-tint text-brand"><RoziMark size={18} /></span>
        <h1 className="text-xl font-bold text-brand-ink">{t("wallet.token.rozi.name")}</h1>
      </header>

      <Card className="p-4">
        <p className="text-sm text-muted">{t("wallet.rozi.miningBalance")}</p>
        {mining.loading ? <Loading /> : mining.error ? (
          <ErrorState message={mining.error} onRetry={mining.reload} />
        ) : (
          <p className="num text-3xl font-bold text-brand-ink">{formatRozi(mining.data?.roziMicro ?? 0)} ROZI</p>
        )}
        <p className="mt-2 text-xs text-muted">{t("wallet.rozi.seeMine")}</p>
        <Link href="/mine" className="mt-2 inline-block text-sm font-semibold text-brand">{t("wallet.rozi.openMine")}</Link>
      </Card>

      {/* ⚠️ SEND IS GATED ON transfersEnabled, THE SAME WAY /wallet's chooser
          sheet gates it. Without this the button was a dead end: it led to a
          filled-in form on /mine/send, which has no gate of its own, and the
          API refused the submit at the last step (routes/mining.ts — "Sending
          ROZI is not switched on yet"). Disabled-with-a-reason is the rule
          this app already uses for a shut Send — a missing button reads as a
          broken wallet, and a live one that fails at submit is worse.

          Labels are Send/Receive, not Withdraw/Deposit: ROZI moves between
          accounts and never crosses a chain. */}
      <div className="grid grid-cols-2 gap-2.5">
        {transfersOn ? (
          <Button href="/mine/send" variant="ghost">
            <SendIcon size={20} /> {t("wallet.rozi.send")}
          </Button>
        ) : (
          <Button variant="ghost" disabled>
            <SendIcon size={20} /> {t("wallet.rozi.send")}
          </Button>
        )}
        <Button href="/mine/receive" variant="primary">
          <ReceiveIcon size={20} /> {t("wallet.rozi.receive")}
        </Button>
      </div>
      {!transfersOn && <p className="-mt-3 text-center text-xs text-muted">{t("wallet.sendOff")}</p>}

      <section>
        <SectionTitle>{t("wallet.rozi.transactions")}</SectionTitle>
        {rozi.loading ? <Loading /> : rozi.error ? (
          <ErrorState message={rozi.error} onRetry={rozi.reload} />
        ) : rows.length === 0 ? (
          <EmptyState title={t("wallet.noHistoryTitle")} body={t("wallet.noHistoryBody")} />
        ) : (
          <HistoryList rows={rows} onOpen={setOpenTx} />
        )}
      </section>

      {openTx && <TxDetailSheet row={openTx} onClose={() => setOpenTx(null)} />}
    </div>
  );
}
