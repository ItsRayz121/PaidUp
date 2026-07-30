"use client";

import Link from "next/link";
import { Card } from "@/components/ui";
import { GiftIcon, StarIcon, MineIcon, ShieldIcon, ArrowRightIcon } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { formatMoney } from "@/lib/format";
import type { Referrals } from "@/lib/api";

// "What is a friend actually worth?" — answered in one card, in one place.
//
// This exists because the answer was previously NOWHERE in the product. The app
// paid two levels of referral points, a first-task bonus AND referral mining
// speed, and a user could only find out by watching their balance move. People
// do not share a link for a reward they have not been told about.
//
// Every number is passed in from /referrals/me. Nothing here is hard-coded: the
// percentages are Admin-tunable per network, so a literal in this file would go
// stale the first time an Admin edits a row, and the stale version is the one
// users would have already repeated to their friends.
//
// Used on three screens (home, /refer, /wallet), which is the point — the offer
// is the same wherever you meet it.
export function InviteRewards({
  rewards,
  showCta = false,
}: {
  rewards: Referrals["rewards"];
  showCta?: boolean;
}) {
  const { t } = useI18n();

  const rows = [
    {
      Icon: StarIcon,
      title: t("invite.l1.title", { pct: String(rewards.l1Pct) }),
      body: t("invite.l1.body"),
      strong: true,
    },
    {
      Icon: GiftIcon,
      title: t("invite.l2.title", { pct: String(rewards.l2Pct) }),
      body: t("invite.l2.body"),
    },
    {
      Icon: StarIcon,
      title: t("invite.first.title", { n: formatMoney(rewards.firstTaskBonus) }),
      body: t("invite.first.body"),
    },
    // Mining is not a footnote to the referral offer — a friend who mines raises
    // your speed for as long as they keep mining, which is the half of the deal
    // that keeps paying on days the offerwall is empty.
    {
      Icon: MineIcon,
      title: t("invite.mining.title"),
      body: t("invite.mining.body", {
        pct: String(rewards.miningL1Pct),
        pct2: String(rewards.miningL2Pct),
      }),
    },
  ];

  return (
    <Card className="overflow-hidden">
      <div className="bg-brand p-4 text-white">
        <p className="text-lg font-extrabold leading-tight">{t("invite.title")}</p>
        <p className="mt-0.5 text-sm text-white/85">{t("invite.subtitle")}</p>
      </div>

      <div className="divide-y divide-line">
        {rows.map(({ Icon, title, body, strong }, i) => (
          <div key={i} className="flex items-start gap-3 p-3.5">
            <span
              className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${
                strong ? "bg-accent text-brand-ink" : "bg-brand-tint text-brand"
              }`}
            >
              <Icon size={20} />
            </span>
            <div className="min-w-0">
              <p className="font-bold text-brand-ink leading-snug">{title}</p>
              <p className="text-sm text-muted">{body}</p>
            </div>
          </div>
        ))}
      </div>

      {/* The objection every user in our markets has already met: "is my friend
          paying for my bonus?" They are not — referral points come out of our
          margin (api/src/credit.ts), never the invitee's balance. Saying so is
          worth more than another percentage. */}
      <div className="flex items-start gap-3 bg-success-tint p-3.5">
        <ShieldIcon size={20} className="mt-0.5 shrink-0 text-success" />
        <div className="min-w-0">
          <p className="font-bold text-success leading-snug">{t("invite.free.title")}</p>
          <p className="text-sm text-brand-ink">{t("invite.free.body")}</p>
        </div>
      </div>

      {showCta && (
        <Link
          href="/refer"
          className="flex items-center justify-between p-3.5 font-bold text-brand"
        >
          {t("invite.cta")}
          <ArrowRightIcon size={20} />
        </Link>
      )}
    </Card>
  );
}
