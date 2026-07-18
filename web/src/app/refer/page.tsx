"use client";

import { useState } from "react";
import { Card, Button } from "@/components/ui";
import { Loading, ErrorState } from "@/components/state";
import { CopyIcon, ShareIcon, CheckIcon, GiftIcon, StarIcon, MineIcon, TelegramIcon } from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchReferrals, fetchTelegramConfig } from "@/lib/api";
import { formatPoints } from "@/lib/format";

export default function ReferPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const ref = useApi(fetchReferrals, []);
  const tg = useApi(fetchTelegramConfig, []);
  const [copied, setCopied] = useState<"web" | "tg" | null>(null);

  if (!ready || ref.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (ref.error) return <div className="p-4 pt-6"><ErrorState message={ref.error} onRetry={ref.reload} /></div>;

  const code = ref.data?.code ?? "";
  // Invite link points back at the app's own origin with ?ref=CODE.
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const link = `${origin}/login?ref=${code}`;
  const message = t("refer.inviteMessage", { code, link });
  // The Telegram-native invite: opens RoziPay INSIDE Telegram with the code
  // riding in start_param (signed by Telegram — it can't be tampered with).
  // Both links are shown; friends pick whichever app they live in.
  const bot = tg.data?.botUsername ?? "";
  const tgLink = bot ? `https://t.me/${bot}?startapp=${code}` : "";

  async function copy(which: "web" | "tg", value: string) {
    try { await navigator.clipboard.writeText(value); setCopied(which); setTimeout(() => setCopied(null), 2000); }
    catch { setCopied(null); }
  }
  async function share() {
    if (navigator.share) { try { await navigator.share({ title: "Join RoziPay", text: message, url: link }); } catch {} }
    else { copy("web", link); }
  }
  function shareTelegram() {
    // t.me/share opens Telegram's own "send to a chat" picker with the invite.
    const url = `https://t.me/share/url?url=${encodeURIComponent(tgLink)}&text=${encodeURIComponent(t("refer.telegramShareText", { code }))}`;
    window.open(url, "_blank", "noopener");
  }

  const steps = [
    { Icon: ShareIcon, text: t("refer.step1") },
    { Icon: CheckIcon, text: t("refer.step2") },
    { Icon: StarIcon, text: t("refer.step3") },
    // Friends do two things for you, not one: points AND mining speed. The Refer
    // screen is where people decide whether inviting is worth it, so the mining
    // half of the reward has to be said here, not only on /mine.
    { Icon: MineIcon, text: t("refer.step4") },
  ];

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header>
        <h1 className="text-xl font-bold text-brand-ink">{t("refer.title")}</h1>
        <p className="text-sm text-muted">{t("refer.subtitle")}</p>
      </header>

      <Card className="overflow-hidden">
        <div className="bg-brand p-5 text-center text-white">
          <p className="text-sm text-white/80">{t("refer.yourCode")}</p>
          <p className="num mt-1 text-4xl font-bold tracking-wider">{code}</p>
        </div>
        <div className="grid grid-cols-2 gap-2.5 p-4">
          <Button variant="ghost" size="md" onClick={() => copy("web", link)}>
            {copied === "web" ? <><CheckIcon size={18} /> {t("refer.copied")}</> : <><CopyIcon size={18} /> {t("refer.copyLink")}</>}
          </Button>
          <Button variant="primary" size="md" onClick={share}><ShareIcon size={18} /> {t("refer.share")}</Button>
        </div>
      </Card>

      {/* The second door: invite straight into Telegram. Hidden until the bot
          is configured server-side — never a dead button. */}
      {tgLink !== "" && (
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
              <TelegramIcon size={22} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-brand-ink">{t("refer.telegramTitle")}</p>
              <p className="text-sm text-muted">{t("refer.telegramHint")}</p>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            <Button variant="ghost" size="md" onClick={() => copy("tg", tgLink)}>
              {copied === "tg" ? <><CheckIcon size={18} /> {t("refer.copied")}</> : <><CopyIcon size={18} /> {t("refer.copyLink")}</>}
            </Button>
            <Button variant="primary" size="md" onClick={shareTelegram}>
              <TelegramIcon size={18} /> {t("refer.share")}
            </Button>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-2.5">
        <Stat label={t("refer.friendsJoined")} value={String(ref.data?.joined ?? 0)} />
        <Stat label={t("refer.pointsEarned")} value={formatPoints(ref.data?.earnedPoints ?? 0)} accent />
      </div>

      <Button href="/leaderboard" variant="ghost">🏆 {t("leaderboard.seeLeaderboard")}</Button>

      <section>
        <h2 className="mb-2 px-1 text-base font-bold text-brand-ink">{t("refer.howItWorks")}</h2>
        <Card className="divide-y divide-line">
          {steps.map(({ Icon, text }, i) => (
            <div key={i} className="flex items-center gap-3 p-3.5">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand"><Icon size={20} /></span>
              <p className="text-brand-ink">{text}</p>
            </div>
          ))}
        </Card>
      </section>

      <Card className="flex items-center gap-3 bg-accent-tint p-4">
        <GiftIcon size={22} className="shrink-0 text-accent-ink" />
        <p className="text-sm text-accent-ink">{t("refer.trustNote")}</p>
      </Card>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <Card className="p-3 text-center">
      <p className={`num text-2xl font-bold ${accent ? "text-accent-ink" : "text-brand-ink"}`}>{value}</p>
      <p className="text-xs text-muted">{label}</p>
    </Card>
  );
}
