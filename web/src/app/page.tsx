import Link from "next/link";
import { Card, Button, SectionTitle } from "@/components/ui";
import { TaskFlow } from "@/components/TaskFlow";
import {
  StarIcon, WalletIcon, ArrowRightIcon, GiftIcon, ShieldIcon, VideoIcon,
} from "@/components/icons";
import { user, tasks, referral } from "@/lib/mock";
import { formatPoints, formatMoney } from "@/lib/format";

export default function HomePage() {
  const canWithdraw = user.balancePoints >= user.minWithdrawPoints;
  const toGo = Math.max(0, user.minWithdrawPoints - user.balancePoints);
  const pct = Math.min(100, Math.round((user.balancePoints / user.minWithdrawPoints) * 100));

  return (
    <div className="px-4 pt-5 pb-8 space-y-6">
      {/* Greeting */}
      <header className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted">Hello,</p>
          <h1 className="text-xl font-bold text-brand-ink">{user.name}</h1>
        </div>
        <span className="flex items-center gap-1 rounded-full bg-success-tint px-2.5 py-1 text-xs font-semibold text-success">
          <ShieldIcon size={14} /> We pay real cash
        </span>
      </header>

      {/* Balance — the trust anchor, above the fold */}
      <Card className="overflow-hidden">
        <div className="bg-brand p-5 text-white">
          <p className="text-sm text-white/80">Your points</p>
          <p className="mt-1 flex items-center gap-2">
            <StarIcon size={30} className="text-accent" />
            <span className="num text-5xl font-bold">{formatPoints(user.balancePoints)}</span>
          </p>
          <p className="mt-1 text-white/80">
            That is about <span className="font-semibold text-white">{formatMoney(user.balancePoints)}</span>
          </p>
        </div>

        <div className="p-4">
          {canWithdraw ? (
            <Button href="/wallet/withdraw" variant="accent">
              <WalletIcon size={20} /> Get my money
            </Button>
          ) : (
            <>
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="text-muted">
                  {formatPoints(toGo)} points to your first payout
                </span>
                <span className="font-semibold text-brand">{pct}%</span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-brand-tint" aria-hidden>
                <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
              </div>
            </>
          )}
        </div>
      </Card>

      {/* Next action — one clear thing to do */}
      <Card className="flex items-center gap-3 p-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent-tint text-accent-ink">
          <VideoIcon size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-brand-ink">Do a quick task now</p>
          <p className="text-sm text-muted">Watch a short video and get points fast.</p>
        </div>
        <Link href="/tasks" className="text-brand" aria-label="Go to tasks">
          <ArrowRightIcon size={22} />
        </Link>
      </Card>

      {/* Referral status */}
      <Link href="/refer" className="block">
        <Card className="flex items-center gap-3 p-4">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
            <GiftIcon size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-brand-ink">
              {referral.joined} friends joined
            </p>
            <p className="text-sm text-muted">
              You earned <span className="font-semibold text-accent-ink">{formatPoints(referral.earnedPoints)} points</span> from them.
            </p>
          </div>
          <ArrowRightIcon size={22} className="text-brand" />
        </Card>
      </Link>

      {/* Tasks below, tagged sponsored */}
      <section>
        <SectionTitle action={<Link href="/tasks" className="text-sm font-semibold text-brand">See all</Link>}>
          Ways to earn
        </SectionTitle>
        <TaskFlow tasks={tasks.slice(0, 3)} />
      </section>
    </div>
  );
}
