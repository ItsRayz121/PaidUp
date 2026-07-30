"use client";

import Link from "next/link";
import { Card, Button, SectionTitle } from "@/components/ui";
import { TaskFlow } from "@/components/TaskFlow";
import { InviteRewards } from "@/components/InviteRewards";
import { Loading, ErrorState } from "@/components/state";
import {
  StarIcon, WalletIcon, ArrowRightIcon, GiftIcon, ShieldIcon, VideoIcon, MineIcon, BoltIcon,
} from "@/components/icons";
import { useRequireAuth, useApi, useCountdown } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchBalance, fetchReferrals, fetchTasks, fetchMiningState } from "@/lib/api";
import { formatMoney, formatRozi } from "@/lib/format";

// THE ORDER OF THIS SCREEN IS THE PRODUCT DECISION (founder, 2026-07-29).
//
// ROZI leads. Points follow. Everything else supports one of the two.
//
// Mining is the reason someone opens RoziPay on a day when CPX has no survey to
// give a Pakistani user — which, right now, is most of the day. A home screen
// that led with a points balance that had not moved since yesterday was a home
// screen that taught people there was nothing here today.
//
// What did NOT change, and must not: the two currencies stay visually and
// verbally separate, and nothing on this screen implies ROZI can be cashed out.
// Leading with ROZI is a statement about what the app is FOR, not a promise
// about what ROZI is worth. The points card still owns every money word.
export default function HomePage() {
  const { user, ready } = useRequireAuth();
  const { t } = useI18n();
  const bal = useApi(fetchBalance, []);
  const ref = useApi(fetchReferrals, []);
  const tasks = useApi(fetchTasks, []);
  const mining = useApi(fetchMiningState, []);

  const countdown = useCountdown(mining.data?.session.expiresAt);

  if (!ready) return <div className="p-4 pt-6"><Loading /></div>;

  const name = user?.email?.split("@")[0] ?? "there";
  const points = bal.data?.points ?? 0;
  const min = bal.data?.minWithdrawPoints ?? 2000;
  const canWithdraw = points >= min;
  const toGo = Math.max(0, min - points);
  const pct = Math.min(100, Math.round((points / min) * 100));
  const m = mining.data;
  const isMining = Boolean(m?.session.active && countdown);

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted">{t("home.hello")}</p>
          <h1 className="text-xl font-bold text-brand-ink break-all">{name}</h1>
        </div>
        <span className="flex items-center gap-1 rounded-full bg-success-tint px-2.5 py-1 text-xs font-semibold text-success">
          <ShieldIcon size={14} /> {t("home.wePayCash")}
        </span>
      </header>

      {/* ---- ROZI: the headline ---- */}
      {mining.loading ? <Loading lines={2} /> : m && (
        <Card className="overflow-hidden">
          <Link href="/mine" className="block bg-brand p-5 text-white">
            <p className="flex items-center gap-1.5 text-sm text-white/80">
              <MineIcon size={16} /> {t("home.rozi.label")}
            </p>
            <p className="num mt-1 text-5xl font-extrabold">
              {formatRozi(m.roziMicro)} <span className="text-2xl font-bold text-white/70">ROZI</span>
            </p>
            <p className="mt-2 text-sm text-white/85">{t("home.rozi.tagline")}</p>
          </Link>
          <div className="p-4">
            {isMining ? (
              <Link
                href="/mine"
                className="flex items-center justify-between rounded-xl border border-success/30 bg-success-tint/50 p-3"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-success">
                    {t("home.rozi.running", { time: countdown ?? "" })}
                  </span>
                  <span className="num block text-xs text-muted">
                    {t("home.rozi.speed")}: {m.hashrate.toLocaleString()}
                  </span>
                </span>
                <ArrowRightIcon size={22} className="shrink-0 text-success" />
              </Link>
            ) : (
              <Button href="/mine"><MineIcon size={20} /> {t("home.rozi.start")}</Button>
            )}
          </div>
        </Card>
      )}

      {/* ---- Points: the money ---- */}
      {bal.loading ? <Loading lines={1} /> : bal.error ? (
        <ErrorState message={bal.error} onRetry={bal.reload} />
      ) : (
        <Card className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-muted">{t("home.cash.label")}</p>
              {/* One number, in the currency they will actually be paid in.
                  This used to be a points figure with the USDT value under it —
                  two numbers for one balance, and the big one was the fake. */}
              <p className="mt-0.5 flex items-center gap-2">
                <StarIcon size={24} className="shrink-0 text-accent" />
                <span className="num text-3xl font-bold text-brand-ink">{formatMoney(points)}</span>
              </p>
              <p className="mt-0.5 text-sm text-muted">{t("home.aboutValue")}</p>
            </div>
            <Link href="/wallet" className="mt-1 shrink-0 text-brand" aria-label="Go to wallet">
              <ArrowRightIcon size={22} />
            </Link>
          </div>
          <div className="mt-3">
            {canWithdraw ? (
              <Button href="/wallet/withdraw" variant="accent">
                <WalletIcon size={20} /> {t("common.getMyMoney")}
              </Button>
            ) : (
              <>
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="text-muted">{t("home.toPayout", { points: formatMoney(toGo) })}</span>
                  <span className="font-semibold text-brand">{pct}%</span>
                </div>
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-brand-tint" aria-hidden>
                  <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                </div>
              </>
            )}
          </div>
        </Card>
      )}

      {/* Next action. Tasks are how points AND mining speed both go up, so the
          card says the second half — it is what makes the offerwall worth
          opening on a screen that now leads with mining. */}
      <Card className="flex items-center gap-3 p-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent-tint text-accent-ink">
          <VideoIcon size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-brand-ink">{t("home.quickTaskTitle")}</p>
          <p className="flex items-start gap-1 text-sm text-muted">
            <BoltIcon size={14} className="mt-0.5 shrink-0 text-brand" />
            {t("home.taskBoost")}
          </p>
        </div>
        <Link href="/tasks" className="text-brand" aria-label="Go to tasks"><ArrowRightIcon size={22} /></Link>
      </Card>

      {/* ---- Invite ----
          Two parts on purpose: the status line (what your friends have already
          paid you) and, for anyone who has not invited yet, the offer itself.
          Someone with zero friends has nothing to read in a status line — they
          need to be told what a friend is worth, which is what the rewards card
          does. */}
      <section className="space-y-2.5">
        <Link href="/refer" className="block">
          <Card className="flex items-center gap-3 p-4">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
              <GiftIcon size={22} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-brand-ink">
                {t("home.friendsJoined", { n: String(ref.data?.joined ?? 0) })}
              </p>
              <p className="text-sm font-semibold text-accent-ink">
                {t("home.earnedFromThem", { points: formatMoney(ref.data?.earnedPoints ?? 0) })}
              </p>
            </div>
            <ArrowRightIcon size={22} className="text-brand" />
          </Card>
        </Link>

        {ref.data && ref.data.joined === 0 && (
          <InviteRewards rewards={ref.data.rewards} showCta />
        )}
      </section>

      {/* Tasks */}
      <section>
        <SectionTitle action={<Link href="/tasks" className="text-sm font-semibold text-brand">{t("tasks.seeAll")}</Link>}>
          {t("tasks.title")}
        </SectionTitle>
        {tasks.loading ? <Loading lines={2} /> : tasks.error ? (
          <ErrorState message={tasks.error} onRetry={tasks.reload} />
        ) : (
          <TaskFlow tasks={(tasks.data?.tasks ?? []).slice(0, 3)} />
        )}
      </section>
    </div>
  );
}
