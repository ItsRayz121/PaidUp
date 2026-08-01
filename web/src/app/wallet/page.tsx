"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, Button, StatusBadge, SectionTitle } from "@/components/ui";
import { StatusLegend } from "@/components/TaskFlow";
import { Loading, ErrorState, EmptyState } from "@/components/state";
import {
  StarIcon, WalletIcon, GiftIcon, MineIcon, BoltIcon, ChipIcon,
  SendIcon, ReceiveIcon,
} from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import {
  fetchBalance, fetchLedger, fetchMiningState, fetchRoziHistory, fetchUsdt,
  type LedgerEntry, type RoziEntry,
} from "@/lib/api";
import {
  formatRozi, usdtFromMicro, pointsToRoziMicro, totalRoziMicro, timeAgo,
} from "@/lib/format";

// The money screen, and now the ONLY one (founder, 2026-07-30). Home no longer
// shows a USDT figure or a payout button, so everything about being paid lives
// here: the balance, what this account holds, and the history.
//
// ⚠️ THE "SET UP YOUR WITHDRAWAL WALLET" CARD IS GONE FROM THIS SCREEN (founder,
// 2026-08-01) and now sits on /profile. It was never compulsory here: the
// withdraw screen still collects the address, still validates it, and still
// offers Connect-my-wallet, so no payout path lost a step. What it was doing was
// putting a form for a feature that is not open yet above the balance on the
// screen named "wallet" — an account setting wearing the clothes of the main
// action. Settings live on Profile.
//
// ⚠️ THE THRESHOLD NOTICE IS GONE TOO. "You need N earned from tasks and friends
// to get money" ran under the balance for every user below the minimum, i.e.
// almost everyone, and it is a sentence about a door that is shut. The withdraw
// screen still states the minimum, where it is the thing being decided.
export default function WalletPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const bal = useApi(fetchBalance, []);
  const led = useApi(fetchLedger, []);
  const rozi = useApi(fetchRoziHistory, []);
  const mining = useApi(fetchMiningState, []);
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
  // The history opens short (founder, 2026-08-01) — see the section below.
  // Declared up here with the other hooks because of the `ready` early return.
  const [showAll, setShowAll] = useState(false);

  if (!ready) return <div className="p-4 pt-6"><Loading /></div>;

  const points = bal.data?.points ?? 0;
  const min = bal.data?.minWithdrawPoints ?? 1000;
  const canWithdraw = points >= min;
  // HISTORY IS EVERY TRANSACTION ON THIS ACCOUNT (founder, 2026-08-01), which
  // means BOTH ledgers. It used to be the points ledger alone, so the screen
  // showing a combined ROZI balance explained only the smaller half of it: a
  // user who had mined for a week saw a history that never once said the word
  // "mined", and the number above it was mostly mining. That reads as money
  // arriving from nowhere, which is the one thing a wallet must never do.
  //
  // ⚠️ THIS IS A DISPLAY MERGE AND THE LEDGERS ARE UNTOUCHED (guardrail #7).
  // Two API calls, two independent lists, interleaved by time in the browser.
  // Nothing converts, nothing is written, and each row still knows which ledger
  // it came from — see `unify` at the bottom of this file.
  //
  // `rejected` rows are dropped: nothing moved, so a line saying "not added"
  // beside a balance is noise that makes the app look broken. ⚠️ `pending` ROWS
  // STAY, DELIBERATELY. A withdrawal being checked is real money in flight, and
  // a user who cannot see it will assume it vanished and open a ticket. "Clean
  // history" must never mean hiding money we owe someone.
  const entries = unify(led.data?.entries ?? [], rozi.data?.entries ?? [], t);
  const historyLoading = led.loading || rozi.loading;
  // ⚠️ ONE FAILING CALL MUST NOT BLANK THE OTHER'S ROWS. An error is shown only
  // when BOTH halves failed; if mining history is down, the points rows still
  // render, because a history that silently drops half of itself is worse than
  // one that is briefly short.
  const historyError = led.error && rozi.error ? led.error : null;
  // ---- The history opens short (founder, 2026-08-01) ----
  // The full list ran to every transaction this account has ever had, so a
  // miner who settles every epoch turned the wallet into an endless feed and
  // pushed the balance, Send/Receive and the token list off the top of the
  // screen after a week. Two rows answer the question people actually open
  // this screen with — "did the last thing land?" — and the rest is one tap
  // away, the same shape home already uses for tasks.
  const visible = showAll ? entries : preview(entries);
  const hidden = entries.length - visible.length;

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

      {/* The "Set up your withdrawal wallet" card used to sit here and now lives
          on /profile — see the note at the top of this file. The withdraw screen
          is unchanged and still collects, validates and can prove the address,
          so nothing about being paid got harder.

          The standalone "Your money · X USDT" card is GONE too (founder,
          2026-07-30: hide the USDT amount everywhere). Its two jobs were split:
          the balance is in the token list above, in ROZI, and the payout action
          is the button below. The withdraw screen itself still speaks USDT,
          because that is the currency we genuinely send. */}
      {bal.error ? (
        <ErrorState message={bal.error} onRetry={bal.reload} />
      ) : canWithdraw ? (
        <Button href="/wallet/withdraw" variant="primary">
          <WalletIcon size={20} /> {t("common.getMyMoney")}
        </Button>
      ) : null}

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
        <p className="mb-2 px-1 text-xs text-muted">{t("wallet.history.sub")}</p>
        <Card className="p-2 mb-2"><div className="px-2 py-1"><StatusLegend /></div></Card>

        {historyLoading ? <Loading /> : historyError ? (
          <ErrorState message={historyError} onRetry={() => { led.reload(); rozi.reload(); }} />
        ) : entries.length === 0 ? (
          <EmptyState title={t("wallet.noHistoryTitle")} body={t("wallet.noHistoryBody")} />
        ) : (
          <ul className="space-y-2.5">
            {visible.map((e) => {
              const credit = e.micro >= 0;
              return (
                <li key={e.key}>
                  <Card className="p-3.5">
                    <div className="flex items-start gap-3">
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
                        <e.Icon size={20} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-brand-ink leading-snug">{e.label}</p>
                        <p className="text-xs text-muted">{timeAgo(e.at)}</p>
                      </div>
                      <div className="text-right">
                        <p className={`num font-bold ${credit ? "text-success" : "text-brand-ink"}`}>
                          {credit ? "+" : "−"}{formatRozi(Math.abs(e.micro))} ROZI
                        </p>
                        {/* Only the points ledger carries a status. A ROZI row is
                            already settled by the time it exists — there is no
                            "waiting" state to be in — and stamping every mining
                            payout "Added" would bury the one badge that matters,
                            the pending withdrawal. */}
                        {e.status && (
                          <div className="mt-1 flex justify-end"><StatusBadge status={e.status} /></div>
                        )}
                      </div>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}

        {/* Shown only when something is actually hidden. "Show less" appears
            once the list is open so the screen can be put back the way it was —
            a one-way expand leaves a long history no way to close. */}
        {!historyLoading && !historyError && (hidden > 0 || showAll) && (
          <div className="mt-3">
            <Button onClick={() => setShowAll(!showAll)} variant="ghost" size="md">
              {showAll ? t("wallet.history.less") : t("wallet.history.seeAll", { count: String(hidden) })}
            </Button>
          </div>
        )}
      </section>

      <p className="text-center text-xs text-muted">
        {t("wallet.needHelp")} <Link href="/help" className="font-semibold text-brand">{t("wallet.contactSupport")}</Link>
      </p>
    </div>
  );
}

// ---- One history out of two ledgers ---------------------------------------
//
// Points rows and ROZI rows, interleaved newest-first and expressed in the same
// unit so the column can be read straight down. Purely a view: no request is
// made, nothing is written, and `status` survives only on the rows that have one.
//
// ⚠️ THE ROZI SIDE IS NOT LABELLED FROM `note`, EXCEPT WHERE THE NOTE NAMES A
// THING THE USER PICKED (a machine, a store item, who they sent to). The notes
// are written for staff reading the ledger and some of them say "points" — a
// word this app deliberately does not use with earners. A source type we have
// not given a sentence to falls back to a neutral one rather than leaking an
// internal string onto the money screen.
type Row = {
  key: string;
  label: string;
  at: string;
  micro: number; // signed micro-ROZI: positive in, negative out
  status?: LedgerEntry["status"];
  Icon: (p: { size?: number; className?: string }) => React.ReactElement;
};

// The two newest rows — plus anything still waiting, wherever it sits.
//
// ⚠️ A PENDING ROW IS NEVER COLLAPSED, and that exception is the whole reason
// this is a function instead of `.slice(0, 2)`. A withdrawal being checked is
// real money in flight; it can sit for a day while newer mining rows pile on
// top of it, and a user who opens the wallet and cannot see it will assume it
// vanished and open a ticket. The rest of this screen already refuses to hide
// money we owe someone (see the `unify` note on why `pending` survives the
// filter) — shortening the list must not undo that.
const HISTORY_PREVIEW = 2;

function preview(rows: Row[]): Row[] {
  const keep = new Set(rows.slice(0, HISTORY_PREVIEW).map((r) => r.key));
  for (const r of rows) if (r.status === "pending") keep.add(r.key);
  return rows.filter((r) => keep.has(r.key)); // filter, so the order is kept
}

function unify(
  ledger: LedgerEntry[],
  rozi: RoziEntry[],
  t: (key: string, vars?: Record<string, string>) => string,
): Row[] {
  const roziIcon: Record<string, Row["Icon"]> = {
    mining: MineIcon,
    rig_purchase: ChipIcon,
    transfer_in: ReceiveIcon,
    transfer_out: SendIcon,
    transfer_fee: BoltIcon,
    conversion_burn: WalletIcon,
    store_redemption: GiftIcon,
    bonus: GiftIcon,
    admin_adjustment: BoltIcon,
  };
  // Source types whose note names something the user chose, so the note is more
  // useful than the generic sentence. Everything else uses the sentence.
  const useNote = new Set(["rig_purchase", "store_redemption", "transfer_out"]);

  const a: Row[] = ledger
    .filter((e) => e.status !== "rejected")
    .map((e) => ({
      key: `p:${e.id}`,
      label: e.label,
      at: e.at,
      micro: pointsToRoziMicro(e.points),
      status: e.status,
      Icon: e.kind === "referral" ? GiftIcon : e.kind === "withdrawal" ? WalletIcon : StarIcon,
    }));

  const b: Row[] = rozi.map((e) => ({
    key: `r:${e.id}`,
    label: (useNote.has(e.source_type) && e.note) || t(`wallet.tx.${e.source_type}`),
    at: e.created_at,
    micro: e.amountMicro,
    Icon: roziIcon[e.source_type] ?? MineIcon,
  }));

  return [...a, ...b].sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
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
