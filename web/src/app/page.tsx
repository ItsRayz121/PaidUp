"use client";

import Link from "next/link";
import { Card, Button, SectionTitle, Tile } from "@/components/ui";
import { TaskFlow } from "@/components/TaskFlow";
import { Loading, ErrorState } from "@/components/state";
import {
  ArrowRightIcon, GiftIcon, ShieldIcon, MineIcon, TasksIcon, WalletIcon,
} from "@/components/icons";
import { useRequireAuth, useApi, useCountdown } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchBalance, fetchTasks, fetchMiningState } from "@/lib/api";
import { formatRozi, pointsToRoziMicro, totalRoziMicro, HERO_DECIMALS } from "@/lib/format";

// ONE CURRENCY (founder, 2026-07-30). This screen shows a SINGLE balance, in
// ROZI: what the user mined, plus what they earned from tasks and friends,
// added at the fixed display ratio in lib/format.ts.
//
// It replaced two cards. The second one said "Your money · 1.60 USDT" and had a
// progress bar to a payout, and it was the weakest thing on the screen: there is
// not enough survey fill for Pakistani traffic yet for that number to move, so
// most users met a money figure that had been identical for days. Two balances,
// one of them frozen, taught people the app was two apps and one of them was
// broken.
//
// WHAT MOVED AND WHAT DID NOT. The USDT figure and the "Get my money" button are
// gone FROM HERE, not from the app — they live on /wallet, which is now the one
// screen that talks about being paid. The ledgers underneath are untouched and
// still separate (guardrail #7): this is a display merge, and lib/format.ts
// carries the note on what a fixed ratio costs us.
//
// THE LINE THIS SCREEN MUST NOT CROSS: no copy here may say the balance can be
// cashed out today. It cannot. "Soon" is the strongest word available, and the
// mining screen and the road map use exactly that word too.
export default function HomePage() {
  const { user, ready } = useRequireAuth();
  const { t } = useI18n();
  const bal = useApi(fetchBalance, []);
  const tasks = useApi(fetchTasks, []);
  const mining = useApi(fetchMiningState, []);

  const countdown = useCountdown(mining.data?.session.expiresAt);

  if (!ready) return <div className="p-4 pt-6"><Loading /></div>;

  // What the user CHOSE to be called (profile/settings) wins. The email prefix is
  // only a fallback, and for a Telegram-created account it is a synthetic address
  // (…@telegram.local) whose prefix is a number — this screen greeted those users
  // as "Hello, tg7734219". `hasEmail === false` marks exactly those accounts.
  const name =
    user?.displayName?.trim() ||
    (user?.hasEmail === false ? "" : user?.email?.split("@")[0]) ||
    "there";
  const points = bal.data?.points ?? 0;
  const m = mining.data;
  const isMining = Boolean(m?.session.active && countdown);
  // The one number. Waits for BOTH calls: rendering the mined half alone would
  // show a balance that jumps upward a moment later, which reads as a glitch on
  // the first screen a user ever sees.
  const ready2 = !mining.loading && !bal.loading;
  const minedMicro = m?.roziMicro ?? 0;
  const earnedMicro = pointsToRoziMicro(points);

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

      {/* ---- The one balance ---- */}
      {/* BOTH errors, not just the balance one. This branch checked bal.error
          alone while the card itself rendered behind `m &&` — so a failing
          /mining/state made the balance card SILENTLY VANISH, with no message
          and no retry, leaving home as a greeting and a hole where the product
          is. The one number this screen now stakes everything on must have a
          failure state. */}
      {!ready2 ? <Loading lines={2} /> : (bal.error || mining.error) ? (
        <ErrorState
          message={bal.error ?? mining.error ?? ""}
          onRetry={() => { bal.reload(); mining.reload(); }}
        />
      ) : m && (
        <Card className="overflow-hidden">
          <Link href="/mine" className="block bg-brand p-5 text-white">
            {/* The chevron is the affordance, and it was missing. Every other
                row on this screen ends in one, so the single most important
                tappable element on the app's first screen was the only one that
                did not look tappable. */}
            <p className="flex items-center gap-1.5 text-sm text-white/80">
              <MineIcon size={16} /> {t("home.rozi.label")}
              <ArrowRightIcon size={16} className="ml-auto shrink-0 text-white/70" />
            </p>
            <p className="num mt-1 text-5xl font-extrabold">
              {formatRozi(totalRoziMicro(minedMicro, points), HERO_DECIMALS)}{" "}
              <span className="text-2xl font-bold text-white/70">ROZI</span>
            </p>
            {/* The split, small. One currency does not mean one source: a user
                who finishes a survey has to be able to see that it landed, or
                the next survey does not get done. */}
            {earnedMicro > 0 && (
              <p className="num mt-1 text-xs text-white/70">
                {t("home.rozi.breakdown", {
                  mined: formatRozi(minedMicro),
                  earned: formatRozi(earnedMicro),
                })}
              </p>
            )}
            {/* The tagline paragraph that sat here is GONE (founder,
                2026-08-01). Two dense lines about halving, inside the hero,
                between the balance and the button — the one place on the app's
                first screen where nothing should compete with the number. The
                same sentence still runs on /mine, which is where someone who
                wants to understand the rate actually goes. */}
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

      {/* The "Your money · X USDT" card used to sit here, with a progress bar to
          the payout threshold. Both moved to /wallet (founder, 2026-07-30) — see
          the note at the top of this file. Do not restore a money figure to this
          screen without restoring the reason it was removed. */}

      {/* ---- Where to go next, in one row (founder, 2026-08-01) ----
          THIS REPLACED THREE FULL-WIDTH BLOCKS: a "Do a quick task now" card, a
          "N friends joined" card, and — for every user who had not yet invited
          anyone, i.e. almost all of them — the seven-row InviteRewards advert.
          All three said the same thing, "go somewhere else", and together they
          were taller than the balance card they sat under.

          The invite ENTRY POINT survives as a tile, because referrals are the
          growth loop and deleting the door would be a different mistake. What
          went is the sales pitch, which still runs in full on /refer, where a
          user has actually chosen to read it. */}
      <div className="grid grid-cols-3 gap-2.5">
        <Tile href="/tasks" Icon={TasksIcon} label={t("nav.tasks")} tone="accent" />
        <Tile href="/refer" Icon={GiftIcon} label={t("invite.cta")} />
        <Tile href="/wallet" Icon={WalletIcon} label={t("nav.wallet")} />
      </div>

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
