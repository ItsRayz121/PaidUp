"use client";

// Receive ROZI — the other half of /mine/send.
//
// There is deliberately nothing to fill in and nothing to be refused. Receiving
// is NOT gated on the ID check, the account-age minimum or the daily cap, all of
// which apply only to sending (see transferRequireKyc in api/src/mining/core.ts):
// a new user being sent ROZI by a friend has done nothing wrong, and blocking it
// would make the app look broken to the person doing the sending.
//
// So the whole screen is "here is your name, copy it" — plus the one sentence
// that answers the question every user in our markets asks about sharing an
// identifier: no, this cannot be used to take anything from you.
import { useState } from "react";
import Link from "next/link";
import { Card, Button, SectionTitle } from "@/components/ui";
import { Loading } from "@/components/state";
import { ArrowRightIcon, CopyIcon, CheckIcon, LockIcon, ShareIcon } from "@/components/icons";
import { useRequireAuth } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";

export default function ReceiveRoziPage() {
  const { user, ready } = useRequireAuth();
  const { t } = useI18n();
  const [copied, setCopied] = useState<string | null>(null);

  if (!ready) return <div className="p-4 pt-6"><Loading /></div>;

  const handle = user?.username ?? null;
  const code = user?.referralCode ?? "";

  function copy(value: string) {
    void navigator.clipboard?.writeText(value);
    setCopied(value);
    window.setTimeout(() => setCopied(null), 2000);
  }

  // Reached ONLY from /wallet's Receive button today (nothing on /mine links
  // here) — see the comment on the /wallet BottomNav entry.
  const header = (
    <header>
      <Link href="/wallet" className="inline-flex items-center gap-1 text-sm font-semibold text-brand">
        <ArrowRightIcon size={16} className="rotate-180" />
        {t("nav.wallet")}
      </Link>
      <h1 className="mt-2 text-xl font-bold text-brand-ink">{t("receive.title")}</h1>
      <p className="text-sm text-muted">{t("receive.subtitle")}</p>
    </header>
  );

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      {header}

      {handle ? (
        <div>
          <SectionTitle>{t("receive.handle")}</SectionTitle>
          <Card className="flex items-center gap-3 p-4">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
              <ShareIcon size={22} />
            </span>
            <p className="num min-w-0 flex-1 truncate text-lg font-bold text-brand-ink">
              @{handle}
            </p>
            <CopyButton value={`@${handle}`} copied={copied} onCopy={copy} />
          </Card>
        </div>
      ) : (
        // No handle yet. Say what a handle IS before asking them to pick one —
        // "@handle" means nothing to a first-time user, and a screen that only
        // demands is a screen people leave.
        <Card className="p-4">
          <p className="font-bold text-brand-ink">{t("receive.noHandle.title")}</p>
          <p className="mt-1 text-sm text-muted">{t("receive.noHandle.body")}</p>
          <div className="mt-3">
            <Button href="/profile/settings" full>{t("receive.noHandle.cta")}</Button>
          </div>
        </Card>
      )}

      {/* The invite code always works as a send target too (the server accepts
          handle, code or email), so it is the fallback that makes this screen
          useful even before a handle is picked. */}
      <div>
        <SectionTitle>{t("receive.code")}</SectionTitle>
        <Card className="flex items-center gap-3 p-4">
          <p className="num min-w-0 flex-1 truncate text-lg font-bold tracking-wider text-brand-ink">
            {code}
          </p>
          <CopyButton value={code} copied={copied} onCopy={copy} />
        </Card>
        <p className="mt-1.5 px-1 text-xs text-muted">{t("receive.codeHint")}</p>
      </div>

      <p className="flex gap-2 rounded-xl border border-line bg-card p-3 text-sm text-muted">
        <LockIcon size={18} className="mt-0.5 shrink-0 text-success" />
        <span>{t("receive.safe")}</span>
      </p>
    </div>
  );
}

function CopyButton({ value, copied, onCopy }: {
  value: string;
  copied: string | null;
  onCopy: (v: string) => void;
}) {
  const { t } = useI18n();
  const done = copied === value;
  return (
    <button
      onClick={() => onCopy(value)}
      className="flex shrink-0 items-center gap-1.5 rounded-xl border border-brand bg-brand-tint px-3 py-2 text-sm font-bold text-brand"
    >
      {done ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
      {done ? t("receive.copied") : t("receive.copy")}
    </button>
  );
}
