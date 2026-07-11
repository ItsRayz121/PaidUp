"use client";

import Link from "next/link";
import { Card, Button, SectionTitle } from "@/components/ui";
import { TaskFlow } from "@/components/TaskFlow";
import { Loading, ErrorState } from "@/components/state";
import { StarIcon, WalletIcon, ArrowRightIcon, GiftIcon, ShieldIcon, VideoIcon } from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchBalance, fetchReferrals, fetchTasks } from "@/lib/api";
import { formatPoints, formatMoney } from "@/lib/format";

export default function HomePage() {
  const { user, ready } = useRequireAuth();
  const { t } = useI18n();
  const bal = useApi(fetchBalance, []);
  const ref = useApi(fetchReferrals, []);
  const tasks = useApi(fetchTasks, []);

  if (!ready) return <div className="p-4 pt-6"><Loading /></div>;

  const name = user?.email?.split("@")[0] ?? "there";
  const points = bal.data?.points ?? 0;
  const min = bal.data?.minWithdrawPoints ?? 2000;
  const canWithdraw = points >= min;
  const toGo = Math.max(0, min - points);
  const pct = Math.min(100, Math.round((points / min) * 100));

  return (
    <div className="px-4 pt-5 pb-8 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted">{t("home.hello")}</p>
          <h1 className="text-xl font-bold text-brand-ink break-all">{name}</h1>
        </div>
        <span className="flex items-center gap-1 rounded-full bg-success-tint px-2.5 py-1 text-xs font-semibold text-success">
          <ShieldIcon size={14} /> {t("home.wePayCash")}
        </span>
      </header>

      {/* Balance */}
      {bal.loading ? <Loading lines={1} /> : bal.error ? (
        <ErrorState message={bal.error} onRetry={bal.reload} />
      ) : (
        <Card className="overflow-hidden">
          <div className="bg-brand p-5 text-white">
            <p className="text-sm text-white/80">{t("common.yourPoints")}</p>
            <p className="mt-1 flex items-center gap-2">
              <StarIcon size={30} className="text-accent" />
              <span className="num text-5xl font-bold">{formatPoints(points)}</span>
            </p>
            <p className="mt-1 font-semibold text-white/90">{t("home.aboutValue", { value: formatMoney(points) })}</p>
          </div>
          <div className="p-4">
            {canWithdraw ? (
              <Button href="/wallet/withdraw" variant="accent"><WalletIcon size={20} /> {t("common.getMyMoney")}</Button>
            ) : (
              <>
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="text-muted">{t("home.toPayout", { points: formatPoints(toGo) })}</span>
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

      {/* Next action */}
      <Card className="flex items-center gap-3 p-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent-tint text-accent-ink">
          <VideoIcon size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-brand-ink">{t("home.quickTaskTitle")}</p>
          <p className="text-sm text-muted">{t("tasks.subtitle")}</p>
        </div>
        <Link href="/tasks" className="text-brand" aria-label="Go to tasks"><ArrowRightIcon size={22} /></Link>
      </Card>

      {/* Referral status */}
      <Link href="/refer" className="block">
        <Card className="flex items-center gap-3 p-4">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
            <GiftIcon size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-brand-ink">{t("home.friendsJoined", { n: String(ref.data?.joined ?? 0) })}</p>
            <p className="text-sm font-semibold text-accent-ink">
              {t("home.earnedFromThem", { points: formatPoints(ref.data?.earnedPoints ?? 0) })}
            </p>
          </div>
          <ArrowRightIcon size={22} className="text-brand" />
        </Card>
      </Link>

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
