"use client";

// The road map — what is coming for ROZI, and when.
//
// It hangs off the mining tab rather than living on its own, because the only
// people who care what happens to ROZI in eighteen months are the people who
// are mining it today.
//
// THREE RULES THIS PAGE MUST KEEP, and they are not style preferences:
//
//   1. NO PRICE, EVER — not a number, not a range, not a hint. The moment a road
//      map mentions what ROZI might be worth it stops being a plan and starts
//      being an offer, which is the thing MINING_SPEC.md § 7 exists to keep us
//      out of. "Open trading" is a step we are working on; "worth $X" is a
//      promise we cannot keep.
//   2. WHAT ALREADY WORKS COMES FIRST. A road map made only of future dates
//      reads like a wish list. Leading with the five things a user can do right
//      now is what earns the rest of the page any credit at all.
//   3. THE "PLANS, NOT PROMISES" NOTE STAYS. Dates on a public page are read as
//      commitments by users and as an offering by regulators. That one small
//      paragraph is what lets a date move later without it being a betrayal —
//      and the last step, a big exchange listing, is genuinely not ours alone to
//      decide, so the page says so out loud.
//
// Dates are the founder's (2026-07-29). Every string lives in the copy deck.
import Link from "next/link";
import { Card, Button, SectionTitle } from "@/components/ui";
import {
  ArrowRightIcon, CheckIcon, InfoIcon, MineIcon,
} from "@/components/icons";
import { useI18n } from "@/lib/i18n";

// The steps, in order. `key` drives every string, so the copy deck stays the one
// place any of this is worded.
const STEPS = ["launch", "kyc", "b2b", "dex", "cex"] as const;

const LIVE = [
  "roadmap.live.mining",
  "roadmap.live.tasks",
  "roadmap.live.withdraw",
  "roadmap.live.rigs",
  "roadmap.live.invite",
] as const;

export default function RoadmapPage() {
  const { t } = useI18n();

  // Deliberately NOT behind useRequireAuth. Someone deciding whether to trust
  // this app enough to sign up is exactly the person who should be able to read
  // the plan, and there is nothing personal on the page.
  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header>
        <Link
          href="/mine"
          className="inline-flex items-center gap-1 text-sm font-semibold text-brand"
        >
          <ArrowRightIcon size={16} className="rotate-180" />
          {t("nav.mine")}
        </Link>
        <h1 className="mt-2 text-xl font-bold text-brand-ink">{t("roadmap.title")}</h1>
        <p className="text-sm text-muted">{t("roadmap.subtitle")}</p>
      </header>

      {/* ---- What already works ---- */}
      <div>
        <SectionTitle>{t("roadmap.live.title")}</SectionTitle>
        <Card className="divide-y divide-line">
          {LIVE.map((key) => (
            <p key={key} className="flex items-center gap-2.5 px-4 py-3 text-sm text-brand-ink">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-success text-white">
                <CheckIcon size={14} />
              </span>
              {t(key)}
            </p>
          ))}
        </Card>
      </div>

      {/* ---- What is next ---- */}
      <div>
        <SectionTitle>{t("roadmap.next.title")}</SectionTitle>
        {/* A single vertical line down the left with a dot per step. The line is
            drawn by the border on each row rather than by an absolutely
            positioned element, so it can never drift out of line with the dots
            at a different font size. */}
        <ol className="space-y-0">
          {STEPS.map((step, i) => (
            <li key={step} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span
                  aria-hidden
                  className="mt-1.5 grid h-3 w-3 shrink-0 place-items-center rounded-full bg-brand ring-4 ring-brand-tint"
                />
                {i < STEPS.length - 1 && <span aria-hidden className="w-px flex-1 bg-line" />}
              </div>
              <div className="min-w-0 flex-1 pb-5">
                <p className="text-xs font-bold uppercase tracking-wide text-brand">
                  {t(`roadmap.step.${step}.when`)}
                </p>
                <p className="mt-0.5 font-bold text-brand-ink">
                  {t(`roadmap.step.${step}.title`)}
                </p>
                <p className="mt-1 text-sm text-muted">{t(`roadmap.step.${step}.body`)}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* ---- Plans, not promises ---- */}
      <Card className="p-4">
        <p className="flex items-center gap-2 font-bold text-brand-ink">
          <InfoIcon size={18} className="shrink-0 text-brand" />
          {t("roadmap.note.title")}
        </p>
        <p className="mt-1 text-sm text-muted">{t("roadmap.note.body")}</p>
      </Card>

      <Button href="/mine" full>
        <MineIcon size={20} />
        {t("roadmap.mine.cta")}
      </Button>
    </div>
  );
}
