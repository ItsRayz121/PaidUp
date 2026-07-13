"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Button, SectionTitle } from "@/components/ui";
import { Loading, ErrorState } from "@/components/state";
import {
  MineIcon, FlameIcon, BoltIcon, LockIcon, InfoIcon, ArrowRightIcon, VideoIcon,
} from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import {
  fetchMiningState, startMining, issueAd, completeAd, type MiningState,
} from "@/lib/api";
import { formatRozi } from "@/lib/format";
import { showRewardedAd } from "@/lib/ads";

// Countdown to a session's expiry, in words. Ticks locally so we are not
// polling the API once a second just to move a clock.
function useCountdown(until: string | null | undefined): string | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (!until) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [until]);

  if (!until) return null;
  const ms = Date.parse(until) - Date.now();
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
}

export default function MinePage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const mining = useApi(fetchMiningState, []);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const s: MiningState | null = mining.data;
  const countdown = useCountdown(s?.session.expiresAt);

  // The session ended while the page was open — refresh so the button comes back
  // rather than leaving a dead countdown on screen.
  useEffect(() => {
    if (s?.session.active && !countdown) mining.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown, s?.session.active]);

  // Start mining. If the ad gate is on, one short video plays first.
  //
  // Every failure here FAILS OPEN — no ad tag, an ad blocker, no fill, a wedged
  // SDK — and mining starts anyway with no boost. A hard gate would mean that a
  // bad night at Monetag stops the whole country mining and breaks streaks people
  // earned. Losing one impression is the cheaper mistake by a wide margin.
  async function onStart() {
    setBusy(true);
    setNotice(null);
    try {
      let nonce: string | undefined;

      if (s?.ads.gateOnStart && s.ads.monetagZoneId) {
        try {
          // The nonce is issued BEFORE the video. The server times the watch from
          // the moment it hands this out, so a user cannot request one, sit on it,
          // and redeem it instantly later.
          const issued = await issueAd();
          const watched = await showRewardedAd(s.ads.monetagZoneId);
          if (watched) nonce = issued.nonce;
          else setNotice(t("mine.gate.skipped"));
        } catch {
          // Includes the daily cap (429). They have had their ads for today; they
          // can still mine.
          setNotice(t("mine.gate.skipped"));
        }
      }

      const res = await startMining(nonce);
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

  // The standalone "watch a video for a speed boost" button, separate from the
  // start-mining gate. Same server path, same nonce, same daily cap.
  async function onWatchAd() {
    setBusy(true);
    setNotice(null);
    try {
      const { nonce } = await issueAd();
      const watched = s?.ads.monetagZoneId
        ? await showRewardedAd(s.ads.monetagZoneId)
        : false;
      if (!watched) {
        setNotice(t("mine.gate.skipped"));
        return;
      }
      const res = await completeAd(nonce);
      setNotice(t("mine.ad.done").replace("{pct}", String(res.boostPct)).replace("{hours}", String(res.hours)));
      mining.reload();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!ready) return <div className="p-4 pt-6"><Loading /></div>;
  if (mining.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (mining.error || !s) {
    return <div className="p-4 pt-6"><ErrorState message={mining.error ?? "…"} onRetry={mining.reload} /></div>;
  }

  const adsLeft = Math.max(0, s.ads.dailyCap - s.ads.watchedToday);

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-brand-ink">{t("mine.title")}</h1>
          <p className="text-sm text-muted">{t("mine.subtitle")}</p>
        </div>
      </header>

      {/* GUARDRAIL: ROZI is not cash. Say it first, say it plainly, every time.
          Letting the UI imply a USDT value would be the fastest way to burn the
          brand — and it would not even be true. */}
      <p className="flex gap-2 rounded-xl border border-line bg-pending-tint/40 p-3 text-sm text-brand-ink">
        <LockIcon size={18} className="mt-0.5 shrink-0 text-pending" />
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
                {busy && s.ads.gateOnStart
                  ? t("mine.gate.loading")
                  : t("mine.start").replace("{hours}", String(s.session.sessionHours))}
              </Button>
              {/* Tell them a video comes first, so it is not a surprise. Only when
                  the gate is actually live (flag + provider + a zone id). */}
              {s.ads.gateOnStart && !busy && (
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

          {s.ads.enabled && (
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
              <Button
                onClick={onWatchAd}
                disabled={busy || adsLeft === 0}
                variant="accent"
                size="md"
                full={false}
              >
                {t("mine.boost.ad.cta")}
              </Button>
            </Card>
          )}

          <Link href="/mine/rigs" className="block">
            <Card className="flex items-center gap-3 p-4">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
                <MineIcon size={22} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-bold text-brand-ink">{t("mine.boost.rigs.title")}</p>
                <p className="text-sm text-muted">{t("mine.boost.rigs.body")}</p>
              </div>
              <ArrowRightIcon size={22} className="text-brand" />
            </Card>
          </Link>
        </div>
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
