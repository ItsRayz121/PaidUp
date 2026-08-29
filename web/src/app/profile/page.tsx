"use client";

// The fifth tab. The tab bar holds the four earning screens + this one; every
// other destination (invites, ID check, leaderboard, help, notifications,
// sign out) lives here as a row, so the bar never grows past five tabs
// (founder, 2026-07-17 — Help's old slot was given to Profile).
import Link from "next/link";
import { Card } from "@/components/ui";
import { NotificationsCard } from "@/components/NotificationsCard";
import { AmbientBg } from "@/components/AmbientBg";
import { ConnectTelegramCard } from "@/components/ConnectTelegramCard";
import { Loading } from "@/components/state";
import {
  ProfileIcon,
  GiftIcon,
  ShieldIcon,
  StarIcon,
  HelpIcon,
  SlidersIcon,
  ArrowRightIcon,
} from "@/components/icons";
import { useRouter } from "next/navigation";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchKyc, fetchAvatar, clearSession, type KycState } from "@/lib/api";

export default function ProfilePage() {
  const { user, ready } = useRequireAuth();
  const { t } = useI18n();
  const kyc = useApi(fetchKyc, []);
  const avatar = useApi(fetchAvatar, []);

  if (!ready) return <div className="p-4 pt-6"><Loading /></div>;

  // The name they chose wins; the email prefix is the fallback for every account
  // that has never opened the settings screen.
  const name = user?.displayName || user?.email?.split("@")[0] || "";
  const picture = avatar.data?.image ?? null;

  // The ID check can be switched off by an Admin (/staff → Verify IDs). When it
  // is, the row stays visible but reads "Coming soon" and does not open: a tab
  // that vanishes looks like a bug, and a tab that opens a dead screen is worse.
  const kycOn = kyc.data?.enabled !== false;

  return (
    <div className="relative px-4 pt-5 pb-8 space-y-5">
      <AmbientBg />

      <header className="flex items-center gap-3">
        <span className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-full bg-brand-tint text-brand">
          {picture ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={picture} alt="" className="h-full w-full object-cover" />
          ) : (
            <ProfileIcon size={28} />
          )}
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold text-brand-ink">{name}</h1>
          {/* The handle if they have one, otherwise the address. A Telegram-created
              account's stored address is a synthetic placeholder, so it is never
              shown. */}
          <p className="truncate text-sm text-muted">
            {user?.username ? `@${user.username}` : t("profile.member")}
          </p>
        </div>
      </header>

      <div className="space-y-2">
        <Row
          href="/profile/settings"
          Icon={SlidersIcon}
          label={t("profile.settings")}
          hint={t("profile.settingsHint")}
        />
        <Row
          href="/refer"
          Icon={GiftIcon}
          label={t("profile.refer")}
          hint={t("profile.referHint")}
        />
        {kycOn ? (
          <Row
            href="/kyc"
            Icon={ShieldIcon}
            label={t("profile.verifyId")}
            hint={t("profile.verifyIdHint")}
            badge={kyc.data ? <KycBadge status={kyc.data.status} /> : undefined}
          />
        ) : (
          <DeadRow
            Icon={ShieldIcon}
            label={t("profile.verifyId")}
            hint={t("profile.verifyIdOffHint")}
            badge={<PlainBadge label={t("profile.comingSoon")} tone="brand" />}
          />
        )}
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

      {/* Account email (display + the "add your email" flow for Telegram-only
          accounts) moved to Edit Profile (founder, 2026-08-28) — everything
          about the account's email now lives in one place instead of two. */}
      {user && <ConnectTelegramCard user={user} />}

      {/* Turn notifications on/off. The card renders nothing when push can't
          work on this phone — the heading lives inside it so they vanish
          together, never leaving a bare "Notifications" title. */}
      <NotificationsCard heading={t("profile.notifications")} />

      {/* Sign out, as a row like everything else on this screen. It used to be a
          small grey text link under the fold, which is where people stop looking
          — and "how do I log out" is the support ticket that gets asked when a
          phone is shared. */}
      <SignOutRow />
    </div>
  );
}

function SignOutRow() {
  const { t } = useI18n();
  const router = useRouter();
  return (
    <button
      onClick={() => { clearSession(); router.replace("/login"); }}
      className="block w-full text-left"
    >
      <Card className="flex items-center gap-3 p-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-danger-tint text-danger">
          <ArrowRightIcon size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-danger">{t("profile.signOut")}</p>
          <p className="text-sm text-muted">{t("profile.signOutHint")}</p>
        </div>
      </Card>
    </button>
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

// A row that deliberately goes nowhere: same shape as the others, greyed, with a
// word saying why. Used for a feature an Admin has switched off. Hiding it
// instead would be worse — a user who was told about the ID check by a friend
// would hunt for a tab that is not there and open a ticket.
function DeadRow({ Icon, label, hint, badge }: {
  Icon: (p: { size?: number }) => React.ReactElement;
  label: string;
  hint: string;
  badge?: React.ReactNode;
}) {
  return (
    <Card className="flex items-center gap-3 p-4 opacity-60">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
        <Icon size={22} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-brand-ink">{label}</p>
        <p className="text-sm text-muted">{hint}</p>
      </div>
      {badge}
    </Card>
  );
}

// A one-word status pill for a row. Same shape as KycBadge, but for states that
// are not a KYC status.
function PlainBadge({ label, tone }: { label: string; tone: "brand" | "pending" | "success" }) {
  const cls = {
    brand: "bg-brand-tint text-brand",
    pending: "bg-pending-tint text-pending",
    success: "bg-success-tint text-success",
  }[tone];
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${cls}`}>{label}</span>
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
