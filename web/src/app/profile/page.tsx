"use client";

// The fifth tab. The tab bar holds the four earning screens + this one; every
// other destination (invites, ID check, leaderboard, help, notifications,
// sign out) lives here as a row, so the bar never grows past five tabs
// (founder, 2026-07-17 — Help's old slot was given to Profile).
import Link from "next/link";
import { Card } from "@/components/ui";
import { NotificationsCard } from "@/components/NotificationsCard";
import { Loading, LogoutButton } from "@/components/state";
import {
  ProfileIcon,
  GiftIcon,
  ShieldIcon,
  StarIcon,
  HelpIcon,
  ArrowRightIcon,
} from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchKyc, type KycState } from "@/lib/api";

export default function ProfilePage() {
  const { user, ready } = useRequireAuth();
  const { t } = useI18n();
  const kyc = useApi(fetchKyc, []);

  if (!ready) return <div className="p-4 pt-6"><Loading /></div>;

  const name = user?.email?.split("@")[0] ?? "";

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header className="flex items-center gap-3">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-brand-tint text-brand">
          <ProfileIcon size={28} />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold text-brand-ink">{name}</h1>
          <p className="truncate text-sm text-muted">{user?.email}</p>
        </div>
      </header>

      <div className="space-y-2">
        <Row
          href="/refer"
          Icon={GiftIcon}
          label={t("profile.refer")}
          hint={t("profile.referHint")}
        />
        <Row
          href="/kyc"
          Icon={ShieldIcon}
          label={t("profile.verifyId")}
          hint={t("profile.verifyIdHint")}
          badge={kyc.data ? <KycBadge status={kyc.data.status} /> : undefined}
        />
        <Row
          href="/leaderboard"
          Icon={StarIcon}
          label={t("profile.leaderboard")}
          hint={t("profile.leaderboardHint")}
        />
        <Row
          href="/help"
          Icon={HelpIcon}
          label={t("profile.help")}
          hint={t("profile.helpHint")}
        />
      </div>

      {/* Turn notifications on/off. The card renders nothing when push can't
          work on this phone — the heading lives inside it so they vanish
          together, never leaving a bare "Notifications" title. */}
      <NotificationsCard heading={t("profile.notifications")} />

      <div className="pt-2 text-center">
        <LogoutButton />
      </div>
    </div>
  );
}

function Row({ href, Icon, label, hint, badge }: {
  href: string;
  Icon: (p: { size?: number }) => React.ReactElement;
  label: string;
  hint: string;
  badge?: React.ReactNode;
}) {
  return (
    <Link href={href} className="block">
      <Card className="flex items-center gap-3 p-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
          <Icon size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-brand-ink">{label}</p>
          <p className="text-sm text-muted">{hint}</p>
        </div>
        {badge}
        <ArrowRightIcon size={20} className="shrink-0 text-brand" />
      </Card>
    </Link>
  );
}

// The ID-check status at a glance, so people see "Checking" or "Try again"
// without opening the screen.
function KycBadge({ status }: { status: KycState["status"] }) {
  const { t } = useI18n();
  const cls = {
    none: "bg-brand-tint text-brand",
    pending: "bg-pending-tint text-pending",
    approved: "bg-success-tint text-success",
    rejected: "bg-danger-tint text-danger",
  }[status];
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${cls}`}>
      {t(`profile.kycBadge.${status}`)}
    </span>
  );
}
