"use client";

import { useState } from "react";
import { Card, Button } from "@/components/ui";
import { Loading, ErrorState } from "@/components/state";
import { CopyIcon, ShareIcon, CheckIcon, GiftIcon, StarIcon } from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { fetchReferrals } from "@/lib/api";
import { formatPoints } from "@/lib/format";

export default function ReferPage() {
  const { ready } = useRequireAuth();
  const ref = useApi(fetchReferrals, []);
  const [copied, setCopied] = useState(false);

  if (!ready || ref.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (ref.error) return <div className="p-4 pt-6"><ErrorState message={ref.error} onRetry={ref.reload} /></div>;

  const code = ref.data?.code ?? "";
  // Invite link points back at the app's own origin with ?ref=CODE.
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const link = `${origin}/login?ref=${code}`;
  const message = `I use PaidUp to earn real money. Join with my code ${code} and we both get points. ${link}`;

  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { setCopied(false); }
  }
  async function share() {
    if (navigator.share) { try { await navigator.share({ title: "Join PaidUp", text: message, url: link }); } catch {} }
    else { copy(); }
  }

  const steps = [
    { Icon: ShareIcon, text: "Share your code with friends." },
    { Icon: CheckIcon, text: "They join and start earning." },
    { Icon: StarIcon, text: "You get points when they earn." },
  ];

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header>
        <h1 className="text-xl font-bold text-brand-ink">Invite friends</h1>
        <p className="text-sm text-muted">Share your code. Earn together.</p>
      </header>

      <Card className="overflow-hidden">
        <div className="bg-brand p-5 text-center text-white">
          <p className="text-sm text-white/80">Your code</p>
          <p className="num mt-1 text-4xl font-bold tracking-wider">{code}</p>
        </div>
        <div className="grid grid-cols-2 gap-2.5 p-4">
          <Button variant="ghost" size="md" onClick={copy}>
            {copied ? <><CheckIcon size={18} /> Copied</> : <><CopyIcon size={18} /> Copy link</>}
          </Button>
          <Button variant="primary" size="md" onClick={share}><ShareIcon size={18} /> Share</Button>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-2.5">
        <Stat label="Friends joined" value={String(ref.data?.joined ?? 0)} />
        <Stat label="Points earned" value={formatPoints(ref.data?.earnedPoints ?? 0)} accent />
      </div>

      <section>
        <h2 className="mb-2 px-1 text-base font-bold text-brand-ink">How it works</h2>
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
        <p className="text-sm text-accent-ink">Your friends only trust apps that pay. Get your money first, then share.</p>
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
