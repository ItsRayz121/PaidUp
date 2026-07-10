import Link from "next/link";
import { Card, Button, StatusBadge, SectionTitle } from "@/components/ui";
import { StatusLegend } from "@/components/TaskFlow";
import { StarIcon, WalletIcon, GiftIcon, InfoIcon } from "@/components/icons";
import { user, ledger } from "@/lib/mock";
import { formatPoints, formatMoney, timeAgo } from "@/lib/format";

export default function WalletPage() {
  const canWithdraw = user.balancePoints >= user.minWithdrawPoints;

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header>
        <h1 className="text-xl font-bold text-brand-ink">Wallet</h1>
        <p className="text-sm text-muted">Your points and your money history.</p>
      </header>

      {/* Balance */}
      <Card className="p-5">
        <p className="text-sm text-muted">Your points</p>
        <p className="mt-1 flex items-center gap-2">
          <StarIcon size={26} className="text-accent" />
          <span className="num text-4xl font-bold text-brand-ink">
            {formatPoints(user.balancePoints)}
          </span>
        </p>
        <p className="mt-1 text-muted">
          About <span className="font-semibold text-brand-ink">{formatMoney(user.balancePoints)}</span>
        </p>

        <div className="mt-4">
          {canWithdraw ? (
            <Button href="/wallet/withdraw" variant="primary">
              <WalletIcon size={20} /> Get my money
            </Button>
          ) : (
            <p className="flex gap-2 rounded-xl bg-pending-tint p-3 text-sm text-pending">
              <InfoIcon size={18} className="mt-0.5 shrink-0" />
              You can get your money at {formatPoints(user.minWithdrawPoints)} points.
              Keep earning — you are close.
            </p>
          )}
        </div>
      </Card>

      {/* History */}
      <section>
        <SectionTitle>History</SectionTitle>
        <Card className="p-2 mb-2">
          <div className="px-2 py-1"><StatusLegend /></div>
        </Card>

        <ul className="space-y-2.5">
          {ledger.map((e) => {
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
                        {credit ? "+" : "−"}{formatPoints(Math.abs(e.points))}
                      </p>
                      <div className="mt-1 flex justify-end"><StatusBadge status={e.status} /></div>
                    </div>
                  </div>

                  {/* Plain reason for waiting / not added — never just a status */}
                  {e.reason && (
                    <p className={`mt-3 rounded-lg p-2.5 text-xs ${
                      e.status === "rejected" ? "bg-danger-tint text-danger" : "bg-pending-tint text-pending"
                    }`}>
                      {e.reason}
                    </p>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      </section>

      <p className="text-center text-xs text-muted">
        Need help with a payment?{" "}
        <Link href="/refer" className="font-semibold text-brand">Contact support</Link>
      </p>
    </div>
  );
}
