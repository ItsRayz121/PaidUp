"use client";

// Announcement cards on the home screen, written by staff with no deploy
// (brief part 43).
//
// ⚠️ THIS RENDERS TEXT NOBODY REVIEWED, DIRECTLY ABOVE A BALANCE. Three rules
// fall out of that, and none of them are cosmetic:
//
//   1. The ICON is a closed list (contentIcon in icons.tsx ↔ CONTENT_ICONS in
//      the API), never a URL. An admin-supplied remote image here would be a
//      third-party request on a money screen.
//   2. A link that LEAVES the app says so, in words, before it is tapped. A
//      card inside our own chrome is the most trusted thing on the screen.
//   3. It renders NOTHING while loading and nothing on error. Every other
//      section on home says "we could not load this" — this one must not,
//      because an announcement that fails to arrive is not a missing feature,
//      and a red error box above the balance for a card that was never there
//      is a worse screen than no card.
import Link from "next/link";
import { useApi } from "@/lib/hooks";
import { fetchHomeContent, type HomeBlock } from "@/lib/api";
import { contentIcon, InfoIcon, ArrowRightIcon } from "@/components/icons";

const TONE = {
  info: "border-line bg-card",
  good: "border-success/30 bg-success-tint/40",
  warn: "border-pending/30 bg-pending-tint/40",
} as const;

const ICON_TONE = {
  info: "text-brand",
  good: "text-success",
  warn: "text-pending",
} as const;

export function HomeContent() {
  const content = useApi(fetchHomeContent, []);
  const blocks = content.data?.blocks ?? [];
  if (blocks.length === 0) return null;
  return (
    <div className="space-y-2.5">
      {blocks.map((b) => <Block key={b.id} b={b} />)}
    </div>
  );
}

function Block({ b }: { b: HomeBlock }) {
  const Icon = contentIcon[b.icon] ?? InfoIcon;
  const tone = TONE[b.tone] ?? TONE.info;
  const iconTone = ICON_TONE[b.tone] ?? ICON_TONE.info;

  const inner = (
    <>
      <div className="flex items-start gap-3">
        <span className={`shrink-0 ${iconTone}`}><Icon size={22} /></span>
        <div className="min-w-0">
          <p className="font-semibold text-brand-ink">{b.title}</p>
          <p className="text-sm text-muted">{b.body}</p>
        </div>
        {b.linkUrl && <ArrowRightIcon size={20} className="ml-auto shrink-0 self-center text-brand" />}
      </div>
      {b.linkUrl && b.linkLabel && (
        <p className="mt-2 text-sm font-semibold text-brand">
          {b.linkLabel}
          {/* Said in words, not with an icon nobody has to know. */}
          {b.external && <span className="ms-1 font-normal text-muted">(opens outside the app)</span>}
        </p>
      )}
    </>
  );

  const className = `block rounded-2xl border p-4 ${tone}`;

  if (!b.linkUrl) return <div className={className}>{inner}</div>;
  // An external link gets rel="noreferrer" and a new tab: it must not be able
  // to reach back into the page it came from, and the user should still have
  // the app open behind it.
  if (b.external) {
    return (
      <a href={b.linkUrl} target="_blank" rel="noopener noreferrer" className={className}>
        {inner}
      </a>
    );
  }
  return <Link href={b.linkUrl} className={className}>{inner}</Link>;
}
