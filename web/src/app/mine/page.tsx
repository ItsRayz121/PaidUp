"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Button, SectionTitle, Tile } from "@/components/ui";
import { Loading, ErrorState } from "@/components/state";
import {
  MineIcon, FlameIcon, BoltIcon, StarIcon, InfoIcon, ArrowRightIcon, VideoIcon,
  ChartIcon, WalletIcon, GiftIcon,
} from "@/components/icons";
import { useRequireAuth, useApi, useCountdown } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import {
  fetchMiningState, startMining, issueAd, completeAd, fetchBalance, type MiningState,
} from "@/lib/api";
import { formatRozi, formatPointsAsRozi } from "@/lib/format";
import {
  ensureVignette, ensureBanner, ensureRewarded, showRewarded, openAdTab, showGateAd,
} from "@/lib/ads";
import { useInsideTelegram } from "@/lib/telegram";

// The session countdown moved to lib/hooks.ts — the home screen leads with
// mining now and shows the same clock.

export default function MinePage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const mining = useApi(fetchMiningState, []);
  // Task/referral earnings, for the reconciling line under the balance. This
  // screen's big number is MINED ONLY — it is what can be spent on rigs, sent or
  // converted — while home and the top bar show mined + earned. Naming both here
  // is what stops the smaller number reading as money going missing.
  const bal = useApi(fetchBalance, []);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // A direct-link ad the user opened and has not claimed yet. `readyAt` is when
  // the server's minimum watch time will have passed and the claim can succeed.
  const [adClaim, setAdClaim] = useState<{ nonce: string; readyAt: number } | null>(null);

  const s: MiningState | null = mining.data;
  const countdown = useCountdown(s?.session.expiresAt);

  // The session ended while the page was open — refresh so the button comes back
  // rather than leaving a dead countdown on screen.
  useEffect(() => {
    if (s?.session.active && !countdown) mining.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown, s?.session.active]);

  // Monetag's vignette: the "an ad appears when you start mining" line. It is
  // passive — once its script is on the page it decorates the user's next taps
  // with a full-screen ad on its own schedule, so loading it HERE, only when
  // there is a Start button to tap, is what scopes the ads to mining. It cannot
  // prove a watch, so the gate ad grants no boost (see lib/ads.ts).
  useEffect(() => {
    if (s && !s.session.active && s.ads.gateOnStart && s.ads.monetagZoneId) {
      ensureVignette(s.ads.monetagZoneId);
    }
  }, [s]);

  // The banner (in-page push) is not tied to the session — it monetises the
  // whole time on this screen. Only here: this is the screen people idle on,
  // and the one whose users chose an ad-supported feature.
  useEffect(() => {
    if (s && s.ads.enabled && s.ads.monetagBannerZone) {
      ensureBanner(s.ads.monetagBannerZone);
    }
  }, [s]);

  // Tick once a second while a claim is pending so its countdown moves.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!adClaim) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [adClaim]);
  // Fresh at every render — the interval above re-renders us for exactly this.
  // eslint-disable-next-line react-hooks/purity
  const claimWait = adClaim ? Math.max(0, Math.ceil((adClaim.readyAt - Date.now()) / 1000)) : 0;

  // Start mining. An ad fires first when the gate is on: the rewarded video
  // inside Telegram, the direct link on the website — the same formats the
  // boost button uses, because relying on the vignette alone meant this tap
  // usually showed no ad at all (see showGateAd in lib/ads.ts).
  //
  // The gate ad grants NO boost, and the session starts whether it played, was
  // blocked, or never filled. An ad network having a bad night must never stop
  // mining or cost a streak someone earned.
  async function onStart() {
    setBusy(true);
    setNotice(null);
    // Called before the first `await` on purpose: its direct-link branch opens a
    // tab, and a tab opened after an await is a tab the pop-up blocker kills.
    const gateAd = s && s.ads.gateOnStart
      ? showGateAd(rewardedZone, s.ads.monetagDirectLink)
      : null;
    try {
      if (gateAd) await gateAd;
      const res = await startMining();
      if (res.boost) {
        setNotice(
          t("mine.ad.done")
            .replace("{pct}", String(res.boost.pct))
            .replace("{hours}", String(res.boost.hours)),
        );
      }
      mining.reload();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Inside the Telegram Mini App, with a rewarded zone configured, the boost
  // button plays a REAL video (Monetag's rewarded SDK — Telegram-only format)
  // instead of opening the direct-link tab. Same server rules: nonce first,
  // dwell timer, daily cap; the SDK's promise is a nicer ad, not extra trust.
  const inTelegram = useInsideTelegram();
  const rewardedZone = inTelegram ? (s?.ads.monetagRewardedZone ?? "") : "";
  useEffect(() => {
    if (s?.ads.enabled && rewardedZone) ensureRewarded(rewardedZone);
  }, [s?.ads.enabled, rewardedZone]);

  function onWatchAdRewarded() {
    setBusy(true);
    setNotice(null);
    issueAd()
      .then(({ nonce, minSeconds }) => {
        setAdClaim({ nonce, readyAt: Date.now() + (minSeconds + 2) * 1000 });
        setNotice(t("mine.ad.open"));
        // Fire-and-forget: if the SDK is blocked or has no fill, the claim
        // still stands — the server dwell timer is the gate, not the promise.
        void showRewarded(rewardedZone);
      })
      .catch((e) => setNotice((e as Error).message))
      .finally(() => setBusy(false));
  }

  // The "watch an ad, mine faster" button — a Monetag direct link in a new tab.
  // The server issued the nonce BEFORE the tab opened and times the watch from
  // that moment, enforces the daily cap, and consumes the nonce exactly once;
  // the claim button below merely comes back to collect.
  function onWatchAd() {
    if (rewardedZone) return onWatchAdRewarded();
    const url = s?.ads.monetagDirectLink;
    if (!url) return;
    // The tab must open synchronously inside this tap — window.open after an
    // `await` is exactly what pop-up blockers kill.
    const tab = openAdTab();
    if (!tab) {
      setNotice(t("mine.ad.blocked"));
      return;
    }
    setBusy(true);
    setNotice(null);
    issueAd()
      .then(({ nonce, minSeconds }) => {
        tab.navigate(url);
        // +2s of slack so an honest claim can never land under the server's
        // minimum by clock or network jitter.
        setAdClaim({ nonce, readyAt: Date.now() + (minSeconds + 2) * 1000 });
        setNotice(t("mine.ad.open"));
      })
      .catch((e) => {
        // Over the daily cap, or the API is down — either way no ad is owed.
        tab.close();
        setNotice((e as Error).message);
      })
      .finally(() => setBusy(false));
  }

  async function onClaimBoost() {
    if (!adClaim) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await completeAd(adClaim.nonce);
      setNotice(t("mine.ad.done").replace("{pct}", String(res.boostPct)).replace("{hours}", String(res.hours)));
      mining.reload();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      // Success or failure, the nonce is spent — a dead claim has no second life.
      setAdClaim(null);
      setBusy(false);
    }
  }

  if (!ready) return <div className="p-4 pt-6"><Loading /></div>;
  if (mining.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (mining.error || !s) {
    return <div className="p-4 pt-6"><ErrorState message={mining.error ?? "…"} onRetry={mining.reload} /></div>;
  }

  const adsLeft = Math.max(0, s.ads.dailyCap - s.ads.watchedToday);
  // The gate is only real if something can actually render: the active ad needs
  // a rewarded zone (Telegram) or a direct link, and the passive vignette needs
  // its own zone. All three empty => promising "an ad may show" would be noise.
  const gateAdLive =
    s.ads.gateOnStart &&
    (rewardedZone !== "" || s.ads.monetagDirectLink !== "" || s.ads.monetagZoneId !== "");

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-brand-ink">{t("mine.title")}</h1>
          <p className="text-sm text-muted">{t("mine.subtitle")}</p>
        </div>
      </header>

      {/* GUARDRAIL, unchanged: this banner must still say ROZI cannot be cashed
          out, plainly, every time — letting the UI imply a USDT value would be
          the fastest way to burn the brand, and it would not even be true.
          What changed (2026-07-27) is only the framing: warning colours and a
          padlock made the app's headline feature look like a problem. The limit
          is still in the copy; it just no longer leads. */}
      <p className="flex gap-2 rounded-xl border border-brand/30 bg-brand-tint/60 p-3 text-sm text-brand-ink">
        <StarIcon size={18} className="mt-0.5 shrink-0 text-brand" />
        <span>
          <strong className="font-bold">{t("mine.notcash.title")}</strong>{" "}
          {t("mine.notcash.body")}
        </span>
      </p>

      {/* ---- The dial ---- */}
      <Card className="p-5 text-center">
        <p className="text-sm font-semibold text-muted">{t("mine.balance")}</p>
        <p className="num mt-1 text-4xl font-extrabold text-brand-ink">
          {formatRozi(s.roziMicro)} <span className="text-2xl text-brand">ROZI</span>
        </p>
        {/* The other half of the balance, named. Home and the top bar add these
            two together; this screen cannot, because only the mined figure above
            is spendable. Showing the earned part here is what makes the smaller
            number legible instead of alarming — a user who taps 14.68 on home
            and lands on 4.68 can see, in one line, where the rest of it is. */}
        {(bal.data?.points ?? 0) > 0 && (
          <p className="num mt-1 text-xs text-muted">
            {t("mine.balance.earned", { n: formatPointsAsRozi(bal.data?.points ?? 0) })}
          </p>
        )}

        <div className="mt-4 rounded-xl bg-brand-tint/60 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            {t("mine.hashrate")}
          </p>
          <p className="num text-3xl font-extrabold text-brand">
            {s.hashrate.toLocaleString()}
          </p>
          {/* Two genuinely different numbers, and the copy must not blur them.
              Pool model: a live estimate that MOVES as other people mine — say so,
              rather than letting users discover it and think we cheated them.
              Pi model: what they have actually earned. Nobody else can move it, so
              the "~" and the hedge both come off. */}
          <p className="mt-1 text-sm text-muted">
            {s.estimateIsLive ? t("mine.today") : t("mine.earned")}:{" "}
            <strong className="num text-brand-ink">
              {s.estimateIsLive ? "~" : ""}{formatRozi(s.estimatedRoziMicro)} ROZI
            </strong>
          </p>
          <p className="mt-1 text-xs text-muted">
            {s.estimateIsLive ? t("mine.estimate.note") : t("mine.earned.note")}
          </p>
        </div>

        <div className="mt-4">
          {s.session.active ? (
            <div className="rounded-xl border border-success/30 bg-success-tint/50 p-3">
              <p className="text-sm font-semibold text-success">{t("mine.running")}</p>
              <p className="num text-2xl font-bold text-brand-ink">{countdown}</p>
              <p className="mt-1 text-xs text-muted">{t("mine.running.note")}</p>
            </div>
          ) : (
            <>
              <Button onClick={onStart} disabled={busy}>
                <MineIcon size={20} />
                {t("mine.start").replace("{hours}", String(s.session.sessionHours))}
              </Button>
              {/* Tell them an ad may come first, so it is not a surprise. Only
                  when the gate can actually show something: the flag and the
                  provider are already folded into gateOnStart by the API, but
                  all three zones being empty means nothing would appear. */}
              {gateAdLive && !busy && (
                <p className="mt-2 text-xs text-muted">
                  {t("mine.gate.body").replace("{hours}", String(s.session.sessionHours))}
                </p>
              )}
            </>
          )}
        </div>

        {s.deviceBlocked && (
          <p className="mt-3 rounded-xl bg-danger-tint p-3 text-left text-sm text-danger">
            {t("mine.device.blocked")}
          </p>
        )}
      </Card>

      {notice && (
        <p className="rounded-xl border border-line bg-card p-3 text-sm text-brand-ink">{notice}</p>
      )}

      {/* ---- Boost your hashrate ---- */}
      <div>
        <SectionTitle>{t("mine.boost.title")}</SectionTitle>
        <div className="space-y-2">
          {/* Do a task -> boost. THE loop: mining recruits for the offerwall
              rather than competing with it. */}
          <Link href="/surveys" className="block">
            <Card className="flex items-center gap-3 border-brand/30 bg-brand-tint/60 p-4">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand text-white">
                <BoltIcon size={22} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-bold text-brand-ink">{t("mine.boost.task.title")}</p>
                <p className="text-sm text-muted">{t("mine.boost.task.body")}</p>
              </div>
              <ArrowRightIcon size={22} className="text-brand" />
            </Card>
          </Link>

          {s.ads.enabled && (s.ads.monetagDirectLink !== "" || rewardedZone !== "") && (
            <Card className="flex items-center gap-3 p-4">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent text-brand-ink">
                <VideoIcon size={22} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-bold text-brand-ink">{t("mine.boost.ad.title")}</p>
                <p className="text-sm text-muted">
                  {t("mine.boost.ad.body")
                    .replace("{pct}", String(s.ads.boostPct))
                    .replace("{hours}", String(s.ads.boostHours))}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {t("mine.boost.ad.left").replace("{n}", String(adsLeft))}
                </p>
              </div>
              {adClaim ? (
                <Button
                  onClick={onClaimBoost}
                  disabled={busy || claimWait > 0}
                  variant="accent"
                  size="md"
                  full={false}
                >
                  {claimWait > 0
                    ? t("mine.ad.claimWait").replace("{s}", String(claimWait))
                    : t("mine.ad.claim")}
                </Button>
              ) : (
                <Button
                  onClick={onWatchAd}
                  disabled={busy || adsLeft === 0}
                  variant="accent"
                  size="md"
                  full={false}
                >
                  {t("mine.boost.ad.cta")}
                </Button>
              )}
            </Card>
          )}

        </div>
      </div>

      {/* ---- Everything else on this screen, in one grid (founder, 2026-08-01)
          THIS REPLACED SIX FULL-WIDTH LINK CARDS stacked vertically — rigs,
          top-up, convert, store, send, receive — each ~76px of icon, title,
          sentence and chevron. Together they were taller than the mining dial
          people open this screen to look at, and every one of them was a
          destination rather than an action.

          The flags are unchanged and still decide what appears: a tile that
          leads to a "not open yet" page teaches users to ignore this grid. What
          changed is only how much room the survivors take.

          ⚠️ SEND AND RECEIVE ARE NOT HERE ANY MORE (founder, 2026-08-01), and
          that is a placement decision, not a rollback. Both screens still exist,
          `POST /mining/transfer` is untouched, and the ID check, the account-age
          minimum and the daily cap all still apply — the two entry points simply
          live on /wallet now, which is the screen people open when they want to
          move money. Two doors into the same room, one of them on the screen
          about mining, was the duplication.

          THE ROAD MAP LEADS. It is the only tile that is true for everyone: the
          rest appear and disappear with their flags, so on a fresh instance this
          grid was one rigs tile and a road map hidden behind it. Someone working
          out whether ROZI is worth their time should meet the plan first. */}
      <div className="grid grid-cols-3 gap-2.5">
        <Tile href="/mine/roadmap" Icon={ChartIcon} label={t("mine.roadmap.title")} />
        <Tile href="/mine/rigs" Icon={MineIcon} label={t("mine.boost.rigs.title")} />
        {s.usdtTopup && (
          <Tile href="/mine/topup" Icon={WalletIcon} label={t("mine.topup.title")} tone="accent" />
        )}
        {s.convertible && (
          <Tile href="/mine/convert" Icon={StarIcon} label={t("mine.convert.title")} tone="accent" />
        )}
        {s.storeOpen && (
          <Tile href="/mine/store" Icon={GiftIcon} label={t("mine.store.title")} />
        )}
      </div>

      {/* ---- Where your hashrate comes from ---- */}
      <div>
        <SectionTitle>{t("mine.breakdown.title")}</SectionTitle>
        <Card className="divide-y divide-line">
          <Row label={t("mine.breakdown.base")} value={`${s.breakdown.base}`} />
          <Row label={t("mine.breakdown.rigs")} value={`+${s.breakdown.rigs.toLocaleString()}`} />
          <Row
            label={
              <span className="inline-flex items-center gap-1.5">
                <FlameIcon size={16} className="text-pending" />
                {t("mine.breakdown.streak").replace("{days}", String(s.streak.current))}
              </span>
            }
            value={`×${(s.breakdown.streakMultiplierPct / 100).toFixed(2)}`}
          />
          <Row
            label={t("mine.breakdown.boosts")}
            value={s.breakdown.boostPct > 0 ? `+${s.breakdown.boostPct}%` : "—"}
          />
          <Row
            label={t("mine.breakdown.referral")}
            value={s.breakdown.referral > 0 ? `+${s.breakdown.referral.toLocaleString()}` : "—"}
          />
        </Card>
        <p className="mt-2 flex gap-2 px-1 text-xs text-muted">
          <InfoIcon size={14} className="mt-0.5 shrink-0" />
          {t("mine.breakdown.note")}
        </p>
      </div>

      {/* The road map moved into the grid above. It keeps its unflagged,
          always-present status there: what we are building next is true whether
          or not any feature is switched on, and someone deciding whether ROZI is
          worth their time should never have to hunt for it. */}
    </div>
  );
}

function Row({ label, value }: { label: React.ReactNode; value: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-sm text-muted">{label}</span>
      <span className="num text-sm font-semibold text-brand-ink">{value}</span>
    </div>
  );
}
