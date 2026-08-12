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
// Dates are the founder's (revised 2026-07-30). Every string lives in the copy
// deck. NOTE: "Cash out to USDT" was removed from the live list in that same
// pass — the code works but the treasury is not funded, so no user can act on
// it. See the roadmap.live.* comment in lib/i18n.tsx.
import Link from "next/link";
import { Card, Button, SectionTitle } from "@/components/ui";
import {
  ArrowRightIcon, CheckIcon, InfoIcon, MineIcon,
} from "@/components/icons";
import { useI18n } from "@/lib/i18n";

// The steps, in order, each with the date range its `roadmap.step.*.when`
// string in the copy deck describes IN WORDS ("August — September 2026").
// These `start`/`end` values exist only to compute which state a step is in
// below — they are never rendered, so they can never drift into a second,
// more precise promise sitting next to the deliberately vague public one.
//
// NOT wired to the admin content_blocks table (audit 2026-08-12 asked for
// this). That table is built for timed announcement cards with free-text
// body/link fields — a fine fit for home-screen banners, a bad one here:
// this page's own header comments carry three rules (no price, ever; dates
// read as regulatory commitments) that a generic CMS field has no way to
// enforce. Keeping these dates in the copy deck, reviewable in one file, is
// what makes "grep this file for a dollar sign before shipping" possible.
const STEPS = [
  { key: "launch", start: "2026-08-01", end: "2026-09-30" },
  { key: "kyc", start: "2026-10-01", end: "2026-11-30" },
  { key: "dex", start: "2026-12-01", end: "2026-12-31" },
  { key: "cex", start: "2027-01-01", end: "2027-01-31" },
] as const;

type StepState = "done" | "active" | "upcoming" | "planned";

// Every row looked identical before this (audit 2026-08-12) — no way to tell
// "happening now" from "months away" apart from reading the date text. Pure
// date math against the ranges above; the first step that is neither done nor
// active is "upcoming" (the one concrete "what's next"), everything after it
// "planned". That is also correct with no active step at all (e.g. between two
// ranges, or before launch) — it just names the very next one "upcoming".
function stepStates(now: Date): StepState[] {
  const t = now.getTime();
  const states: StepState[] = STEPS.map((s) => {
    if (t > new Date(`${s.end}T23:59:59`).getTime()) return "done";
    if (t >= new Date(`${s.start}T00:00:00`).getTime()) return "active";
    return "planned";
  });
  const firstPlanned = states.indexOf("planned");
  if (firstPlanned !== -1) states[firstPlanned] = "upcoming";
  return states;
}

const LIVE = [
  "roadmap.live.mining",
  "roadmap.live.tasks",
  "roadmap.live.rigs",
  "roadmap.live.send",
  "roadmap.live.invite",
] as const;

export default function RoadmapPage() {
  const { t } = useI18n();
  // Which state each step is in "as of right now" — a fresh read on every
  // render is exactly what's wanted here (a page left open across midnight
  // should flip from "Happening now" the moment that becomes true).
  const states = stepStates(new Date());

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
            at a different font size. Dot style + badge now carry the step's
            state (done/active/upcoming/planned) — every row used to look
            identical, which is exactly why a page whose whole point is "when"
            gave no visual answer to "which one is now". */}
        <ol className="space-y-0">
          {STEPS.map((step, i) => {
            const state = states[i];
            return (
              <li key={step.key} className="flex gap-3">
                <div className="flex flex-col items-center">
                  {state === "done" ? (
                    <span
                      aria-hidden
                      className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-success text-white"
                    >
                      <CheckIcon size={14} />
                    </span>
                  ) : state === "active" ? (
                    <span className="mining-chamber mt-1 h-6 w-6 shrink-0 text-brand">
                      <span className="mining-ring" aria-hidden="true" />
                      <span
                        aria-hidden
                        className="relative grid h-3 w-3 place-items-center rounded-full bg-brand"
                      />
                    </span>
                  ) : (
                    <span
                      aria-hidden
                      className={`mt-1.5 grid h-3 w-3 shrink-0 place-items-center rounded-full ${
                        state === "upcoming"
                          ? "bg-card ring-2 ring-brand"
                          : "bg-card ring-2 ring-line"
                      }`}
                    />
                  )}
                  {i < STEPS.length - 1 && <span aria-hidden className="w-px flex-1 bg-line" />}
                </div>
                <div className="min-w-0 flex-1 pb-5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="text-xs font-bold uppercase tracking-wide text-brand">
                      {t(`roadmap.step.${step.key}.when`)}
                    </p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        state === "done"
                          ? "bg-success-tint text-success"
                          : state === "active"
                            ? "bg-brand text-white"
                            : state === "upcoming"
                              ? "bg-brand-tint text-brand"
                              : "bg-line/60 text-muted"
                      }`}
                    >
                      {t(`roadmap.state.${state}`)}
                    </span>
                  </div>
                  <p className="mt-0.5 font-bold text-brand-ink">
                    {t(`roadmap.step.${step.key}.title`)}
                  </p>
                  <p className="mt-1 text-sm text-muted">{t(`roadmap.step.${step.key}.body`)}</p>
                </div>
              </li>
            );
          })}
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
