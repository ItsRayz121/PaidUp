"use client";

import Link from "next/link";
import { Card, Button, StatusBadge, SectionTitle } from "@/components/ui";
import { StatusLegend } from "@/components/TaskFlow";
import { Loading, ErrorState, EmptyState } from "@/components/state";
import {
  StarIcon, WalletIcon, GiftIcon, InfoIcon, MineIcon, BoltIcon, CheckIcon,
  SendIcon, ReceiveIcon,
} from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import {
  fetchBalance, fetchLedger, fetchMiningState, fetchPayoutAddresses, fetchUsdt,
  type LedgerEntry,
} from "@/lib/api";
import {
  formatRozi, formatPointsAsRozi, usdtFromMicro, pointsToRoziMicro, totalRoziMicro, timeAgo,
} from "@/lib/format";

// The money screen, and now the ONLY one (founder, 2026-07-30). Home no longer
// shows a USDT figure or a payout button, so everything about being paid lives
// here: the balance, where the money will be sent, and the history.
//
// The order is the founder's: balance, then "set up your withdrawal wallet".
// Cash-out is not open yet, so saving an address is the one useful thing a user
// can actually finish on this screen today — which is exactly why it leads over
// a "Get my money" button most users cannot press.
export default function WalletPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const bal = useApi(fetchBalance, []);
  const led = useApi(fetchLedger, []);
  const mining = useApi(fetchMiningState, []);
  const addrs = useApi(fetchPayoutAddresses, []);
  // The spend-only top-up credit, for the USDT row of the token list. Its own
  // endpoint rather than a field on /mining/state, which is called on nearly
  // every screen — this balance is needed on exactly one.
  //
  // AND ONLY WHEN TOP-UPS ARE ON. This screen was firing six requests on mount,
  // and this was the one paying for a row that read 0.00 for every user — the
  // feature ships OFF, so nobody could have a balance to show. Gated, it costs
  // nothing until an Admin switches top-ups on, and comes back with them.
  const usdtOn = Boolean(mining.data?.usdtTopup);
  const usdt = useApi(fetchUsdt, [usdtOn], usdtOn);

  if (!ready) return <div className="p-4 pt-6"><Loading /></div>;

  const points = bal.data?.points ?? 0;
  const min = bal.data?.minWithdrawPoints ?? 2000;
  const canWithdraw = points >= min;
  // HISTORY IS MONEY THAT MOVED (founder, 2026-08-01), not a status board of
  // task attempts. `rejected` rows are dropped: nothing moved, so a line saying
  // "not added" beside a balance is noise that makes the app look broken.
  //
  // ⚠️ `pending` ROWS STAY, DELIBERATELY. A withdrawal being checked is real
  // money in flight, and a user who cannot see it will assume it vanished and
  // open a ticket. "Clean history" must never mean hiding money we owe someone.
  const entries = (led.data?.entries ?? []).filter((e: LedgerEntry) => e.status !== "rejected");
  // Any saved chain counts: only one chain is offered right now, and a user who
  // saved an address before a chain was retired has still done the task.
  const hasAddress = Object.keys(addrs.data?.addresses ?? {}).length > 0;
  // Whether any saved address was PROVED by connecting the wallet rather than
  // typed in. Two different sentences, because they are two different states:
  // a typed address is saved but unproven, and saying "done" over it would be
  // the app telling the user a check happened that did not.
  const anyVerified = Object.values(addrs.data?.verified ?? {}).some(Boolean);

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      {/* No sign-out here (founder, 2026-08-01). It lives on /profile, which is
          where people look for it, and a destructive action does not belong in
          the corner of the screen holding someone's balance. */}
      <header>
        <h1 className="text-xl font-bold text-brand-ink">{t("nav.wallet")}</h1>
        <p className="text-sm text-muted">{t("wallet.subtitle")}</p>
      </header>

      {/* ---- The one balance, same number as home ----
          Mined ROZI plus task/referral earnings, converted at the display ratio
          in lib/format.ts. It MUST match home exactly: two screens disagreeing
          about a balance is the single fastest way to lose a user's trust. */}
      {mining.data && (
        <Link href="/mine" className="block">
          <Card className="overflow-hidden">
            <div className="bg-brand p-5 text-white">
              <p className="flex items-center gap-1.5 text-sm text-white/80">
                <MineIcon size={16} /> {t("wallet.rozi.label")}
              </p>
              <p className="num mt-1 text-4xl font-extrabold">
                {formatRozi(totalRoziMicro(mining.data.roziMicro, points))}{" "}
                <span className="text-xl font-bold text-white/70">ROZI</span>
              </p>
              {points > 0 && (
                <p className="num mt-1 text-xs text-white/70">
                  {t("home.rozi.breakdown", {
                    mined: formatRozi(mining.data.roziMicro),
                    earned: formatRozi(pointsToRoziMicro(points)),
                  })}
                </p>
              )}
            </div>
            <p className="flex gap-2 p-3.5 text-xs text-muted">
              {/* Not StarIcon: that one is spent on earnings in the history list
                  below, and reusing it here would blur mining and money in the
                  place the copy works hardest to keep them apart. */}
              <BoltIcon size={14} className="mt-0.5 shrink-0 text-brand" />
              {t("wallet.rozi.notcash")}
            </p>
          </Card>
        </Link>
      )}

      {/* ---- Send / Receive (founder, 2026-07-30) ----
          The two actions a wallet is expected to have, in the place people look
          for them. Both screens already existed under /mine; nothing about the
          transfer rules changed by surfacing them here — the send screen and
          POST /mining/transfer still enforce the ID check, the account-age
          minimum and the daily cap.

          Send is disabled, not hidden, when transfers are off: a wallet missing
          its Send button reads as a broken app, where a greyed one with a reason
          reads as a feature that is not open yet. */}
      <div className="grid grid-cols-2 gap-2.5">
        {mining.data?.transfersEnabled ? (
          <Button href="/mine/send" variant="primary">
            <SendIcon size={20} /> {t("wallet.send")}
          </Button>
        ) : (
          <button
            type="button"
            disabled
            title={t("wallet.sendOff")}
            className="inline-flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-brand px-5 text-base font-semibold text-white opacity-50"
          >
            <SendIcon size={20} /> {t("wallet.send")}
          </button>
        )}
        <Button href="/mine/receive" variant="ghost">
          <ReceiveIcon size={20} /> {t("wallet.receive")}
        </Button>
      </div>

      {/* ---- The token list ----
          What this account holds, one row per token, the way a wallet app shows
          it. ROZI and USDT are real balances. BNB is NOT — see the comment on
          wallet.token.bnb.sub in lib/i18n.tsx: nothing in this system can make
          that number move, so the row says "not open yet" rather than showing a
          bare 0.00 that reads as a bug or as missing money. */}
      <section>
        <SectionTitle>{t("wallet.tokens.title")}</SectionTitle>
        <Card className="divide-y divide-line">
          <TokenRow
            Icon={MineIcon}
            name={t("wallet.token.rozi.name")}
            sub={t("wallet.token.rozi.sub")}
            symbol="ROZI"
            amount={formatRozi(totalRoziMicro(mining.data?.roziMicro ?? 0, points))}
          />
          {/* Only while top-ups are on, which is the same rule /mine and
              /mine/rigs already use for every USDT entry point — the whole
              feature appears and disappears together. A row for credit a user
              cannot obtain, spend or have is the "link to a room with nothing
              in it" this codebase avoids everywhere else. */}
          {usdtOn && (
            <TokenRow
              Icon={WalletIcon}
              name={t("wallet.token.usdt.name")}
              sub={t("wallet.token.usdt.sub")}
              symbol="USDT"
              // The symbol is its own column here, so the amount must NOT carry a
              // unit — string-stripping " USDT" off formatUsdtMicro would break
              // the day that function's format changes. Format the number itself.
              amount={usdtFromMicro(usdt.data?.balanceMicro ?? 0).toFixed(2)}
            />
          )}
          <TokenRow
            Icon={BoltIcon}
            name={t("wallet.token.bnb.name")}
            sub={t("wallet.token.bnb.sub")}
            symbol="BNB"
            amount={t("wallet.token.soon")}
            muted
          />
        </Card>
      </section>

      {/* ---- Where the money goes (founder, 2026-07-30) ----
          The primary action on this tab. Saving an address is something a user
          can finish TODAY, unlike cashing out, and it means the payout is one
          tap away the day it opens rather than a form to fill under pressure. */}
      <Card className="p-4">
        <p className="flex items-center gap-2 font-bold text-brand-ink">
          <WalletIcon size={20} className="shrink-0 text-brand" />
          {t("wallet.setup.title")}
        </p>
        {hasAddress ? (
          <>
            {anyVerified ? (
              <p className="mt-1 flex gap-2 text-sm text-success">
                <CheckIcon size={18} className="mt-0.5 shrink-0" />
                {t("wallet.setup.doneVerified")}
              </p>
            ) : (
              <p className="mt-1 flex gap-2 text-sm text-muted">
                <InfoIcon size={18} className="mt-0.5 shrink-0" />
                {t("wallet.setup.doneTyped")}
              </p>
            )}
            <Link href="/wallet/withdraw" className="mt-3 block text-sm font-semibold text-brand">
              {anyVerified ? t("wallet.setup.cta") : t("wallet.setup.ctaConnect")} →
            </Link>
          </>
        ) : (
          <>
            <p className="mt-1 text-sm text-muted">{t("wallet.setup.body")}</p>
            <div className="mt-3">
              <Button href="/wallet/withdraw" variant="primary">
                <WalletIcon size={20} /> {t("wallet.setupWallet")}
              </Button>
            </div>
          </>
        )}
      </Card>

      {/* The standalone "Your money · X USDT" card that used to sit here is GONE
          (founder, 2026-07-30: hide the USDT amount everywhere). Its two jobs
          were split: the balance is in the token list above, in ROZI, and the
          payout action is on the withdrawal card. The withdraw screen itself
          still speaks USDT, because that is the currency we genuinely send.

          What survives here is only the threshold notice — a user below the
          minimum needs to know one exists, and it is now stated in ROZI. */}
      {bal.error ? (
        <ErrorState message={bal.error} onRetry={bal.reload} />
      ) : canWithdraw ? (
        <Button href="/wallet/withdraw" variant="primary">
          <WalletIcon size={20} /> {t("common.getMyMoney")}
        </Button>
      ) : !bal.loading && (
        <p className="flex gap-2 rounded-xl bg-pending-tint p-3 text-sm text-pending">
          <InfoIcon size={18} className="mt-0.5 shrink-0" />
          {t("wallet.reachAt", { points: formatPointsAsRozi(min) })}
        </p>
      )}

      {/* The verify-your-ID nudge used to sit here; it moved to Profile (which
          shows the live status badge). The withdraw screen still walls off
          unverified users, so the check itself is not weakened. */}

      {/* The invite-rewards block used to sit here and is GONE (founder,
          2026-08-01). A wallet is for holding, sending and reviewing money —
          the pitch to recruit friends belongs on /refer and home, where it
          already runs. Putting a marketing card between a balance and its
          history is what made this screen feel like a feed instead of a wallet. */}

      <section>
        <SectionTitle>{t("wallet.history")}</SectionTitle>
        <Card className="p-2 mb-2"><div className="px-2 py-1"><StatusLegend /></div></Card>

        {led.loading ? <Loading /> : led.error ? (
          <ErrorState message={led.error} onRetry={led.reload} />
        ) : entries.length === 0 ? (
          <EmptyState title={t("wallet.noHistoryTitle")} body={t("wallet.noHistoryBody")} />
        ) : (
          <ul className="space-y-2.5">
            {entries.map((e: LedgerEntry) => {
              const credit = e.points >= 0;
              return (
                <li key={e.id}>
                  <Card className="p-3.5">
                    <div className="flex items-start gap-3">
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
                        {e.kind === "referral" ? <GiftIcon size={20} /> : e.kind === "withdrawal" ? <WalletIcon size={20} /> : <StarIcon size={20} />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-brand-ink leading-snug">{e.label}</p>
                        <p className="text-xs text-muted">{timeAgo(e.at)}</p>
                      </div>
                      <div className="text-right">
                        <p className={`num font-bold ${credit ? "text-success" : "text-brand-ink"}`}>
                          {credit ? "+" : "−"}{formatPointsAsRozi(Math.abs(e.points))}
                        </p>
                        <div className="mt-1 flex justify-end"><StatusBadge status={e.status} /></div>
                      </div>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <p className="text-center text-xs text-muted">
        {t("wallet.needHelp")} <Link href="/help" className="font-semibold text-brand">{t("wallet.contactSupport")}</Link>
      </p>
    </div>
  );
}

// One line of the token list: logo, name, what it is, and how much you hold.
//
// `muted` is for a token with no balance behind it (BNB today). It greys the
// amount so the row cannot be mistaken for a real holding at a glance — the
// subtitle says the same thing in words, because colour alone must never carry
// meaning (DESIGN_BRIEF accessibility floor).
function TokenRow({
  Icon, name, sub, symbol, amount, muted = false,
}: {
  Icon: (p: { size?: number; className?: string }) => React.ReactElement;
  name: string; sub: string; symbol: string; amount: string; muted?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 p-3.5">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-tint text-brand">
        <Icon size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-bold text-brand-ink leading-snug">{name}</p>
        <p className="text-xs text-muted">{sub}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className={`num font-bold ${muted ? "text-muted" : "text-brand-ink"}`}>{amount}</p>
        <p className="text-[11px] font-semibold text-muted">{symbol}</p>
      </div>
    </div>
  );
}
