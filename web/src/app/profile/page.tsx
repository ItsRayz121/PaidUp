"use client";

// The fifth tab. The tab bar holds the four earning screens + this one; every
// other destination (invites, ID check, leaderboard, help, notifications,
// sign out) lives here as a row, so the bar never grows past five tabs
// (founder, 2026-07-17 — Help's old slot was given to Profile).
import Link from "next/link";
import { Card } from "@/components/ui";
import { NotificationsCard } from "@/components/NotificationsCard";
import { ConnectTelegramCard } from "@/components/ConnectTelegramCard";
import { ConnectEmailCard } from "@/components/ConnectEmailCard";
import { Loading } from "@/components/state";
import {
  ProfileIcon,
  GiftIcon,
  ShieldIcon,
  StarIcon,
  HelpIcon,
  SlidersIcon,
  WalletIcon,
  ArrowRightIcon,
} from "@/components/icons";
import { useRouter } from "next/navigation";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchKyc, fetchAvatar, fetchPayoutAddresses, clearSession, type KycState } from "@/lib/api";

export default function ProfilePage() {
  const { user, ready } = useRequireAuth();
  const { t } = useI18n();
  const kyc = useApi(fetchKyc, []);
  const avatar = useApi(fetchAvatar, []);
  // Where the money gets sent. This row moved here from /wallet (founder,
  // 2026-08-01): it is an account setting for a feature that has not opened, and
  // it was the first thing on the screen holding someone's balance.
  const addrs = useApi(fetchPayoutAddresses, []);

  if (!ready) return <div className="p-4 pt-6"><Loading /></div>;

  // The name they chose wins; the email prefix is the fallback for every account
  // that has never opened the settings screen.
  const name = user?.displayName || user?.email?.split("@")[0] || "";
  const picture = avatar.data?.image ?? null;

  // Any saved chain counts: only one chain is offered right now, and a user who
  // saved an address before a chain was retired has still done the task.
  const hasAddress = Object.keys(addrs.data?.addresses ?? {}).length > 0;
  // Saved and PROVED by connecting the wallet, versus saved because it was typed
  // in. Two different states, and merging them would tell the user a check
  // happened that did not — on the setting that decides where real money goes.
  const addressVerified = Object.values(addrs.data?.verified ?? {}).some(Boolean);

  // The ID check can be switched off by an Admin (/staff → Verify IDs). When it
  // is, the row stays visible but reads "Coming soon" and does not open: a tab
  // that vanishes looks like a bug, and a tab that opens a dead screen is worse.
  const kycOn = kyc.data?.enabled !== false;

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
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
        {/* Where your money gets sent — moved off /wallet (founder, 2026-08-01),
            then off the withdraw screen entirely and into Settings (founder,
            2026-08-05): the actual connect/type flow lives at /profile/settings
            now, not on the way to asking for money. The badge is the whole
            point of it being a row: a user who typed an address months ago can
            see at a glance whether it was ever proved, without opening it. */}
        <Row
          href="/profile/settings"
          Icon={WalletIcon}
          label={t("wallet.setup.title")}
          hint={t("profile.walletHint")}
          badge={
            addrs.data
              ? <PlainBadge
                  label={t(hasAddress
                    ? addressVerified ? "profile.wallet.badge.checked" : "profile.wallet.badge.saved"
                    : "profile.wallet.badge.none")}
                  tone={hasAddress ? (addressVerified ? "success" : "pending") : "brand"}
                />
              : undefined
          }
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

      {user?.hasEmail !== false && user?.email && (
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">{t("profile.accountEmail")}</p>
          <p className="mt-1 break-all font-semibold text-brand-ink">{user.email}</p>
        </Card>
      )}

      {/* Same account through both doors: Telegram-first users add an email
          (works on the website), email-first users connect Telegram. Each
          card renders nothing when there is nothing to do. */}
      {user && <ConnectEmailCard user={user} />}
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
