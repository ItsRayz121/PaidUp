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
//
// VISUAL PASS (founder, 2026-09-07): the founder shared a reference layout
// (isometric mountain hero, four "floating island" milestone illustrations,
// a two-line "Our roadmap" header) and asked to match it closely. The
// illustrations are custom-coded SVGs (components/roadmapArt.tsx), not an
// imported asset, and — per the founder's own instruction — they read the
// app's real CSS theme tokens rather than the reference's own blue palette,
// so the page still follows whichever theme (light, or the default dark
// "Deep Vault") the rest of the app is in. The reference is a wide desktop
// mockup with alternating left/right cards; this app is a single-column
// mobile PWA, so each milestone's illustration sits ABOVE its card instead —
// the honest adaptation, not a literal copy of a layout that doesn't fit a
// phone screen. The tested dot/line timeline-state logic below is UNCHANGED.
import Link from "next/link";
import { Card, SectionTitle } from "@/components/ui";
import {
  ArrowRightIcon, CheckIcon, InfoIcon, MineIcon, TasksIcon, ChipIcon,
  SendIcon, ReferIcon, RocketIcon, ShieldIcon, ChartIcon, GemIcon,
} from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { AmbientBg } from "@/components/AmbientBg";
import { MountainHero, MilestoneArt } from "@/components/roadmapArt";

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

// Purely decorative pairing (a "Working today" tile with no icon at all read
// as flat next to the founder's own reference template) — the copy and the
// order are unchanged, this only adds a picture next to each line.
const LIVE = [
  { key: "roadmap.live.mining", Icon: MineIcon },
  { key: "roadmap.live.tasks", Icon: TasksIcon },
  { key: "roadmap.live.rigs", Icon: ChipIcon },
  { key: "roadmap.live.send", Icon: SendIcon },
  { key: "roadmap.live.invite", Icon: ReferIcon },
] as const;

// Same reasoning, one icon per timeline milestone. Never affects
// `stepStates()` or the STEPS dates above — display only.
const STEP_ICON: Record<(typeof STEPS)[number]["key"], typeof MineIcon> = {
  launch: RocketIcon,
  kyc: ShieldIcon,
  dex: ChartIcon,
  cex: GemIcon,
};

export default function RoadmapPage() {
  const { t } = useI18n();
  // Which state each step is in "as of right now" — a fresh read on every
  // render is exactly what's wanted here (a page left open across midnight
  // should flip from "Happening now" the moment that becomes true).
  const states = stepStates(new Date());
  const tagline = t("roadmap.hero.tagline").split("\n");

  // Deliberately NOT behind useRequireAuth. Someone deciding whether to trust
  // this app enough to sign up is exactly the person who should be able to read
  // the plan, and there is nothing personal on the page.
  return (
    <div className="relative overflow-hidden px-4 pb-8 pt-5 md:px-10 md:pb-10 md:pt-12 lg:px-16">
      <AmbientBg variant="mine" />

      <header className="md:hidden">
        <Link
          href="/mine"
          className="inline-flex items-center gap-1 text-sm font-semibold text-brand"
        >
          <ArrowRightIcon size={16} className="rotate-180" />
          {t("nav.mine")}
        </Link>
      </header>

      {/* ---- Hero: eyebrow, headline, mountain scene, tagline ---- */}
      <section className="mt-6 grid items-center gap-4 md:mt-0 md:min-h-[285px] md:grid-cols-[0.82fr_1.18fr] md:gap-7">
        <div className="relative z-10">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-brand md:text-xs">{t("roadmap.hero.eyebrow")}</p>
          <h1 className="mt-2 text-[34px] font-extrabold leading-[1.02] tracking-[-0.035em] text-brand-ink md:text-[54px]">{t("roadmap.title")}</h1>
          <p className="mt-2 text-base font-semibold text-brand-ink md:text-xl">{t("roadmap.subtitle")}</p>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-muted md:text-base">{t("roadmap.hero.description")}</p>
        </div>

        <div className="relative flex items-stretch gap-2 md:-mb-8">
          <div className="relative min-w-0 flex-1">
            <MountainHero className="h-auto w-full drop-shadow-[0_22px_22px_rgba(13,92,99,0.14)]" />
            <span className="absolute bottom-1 left-0 inline-flex -rotate-2 items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide text-brand-ink shadow-sm">
              <GemIcon size={12} className="shrink-0 text-brand" />
              {t("roadmap.hero.badge")}
            </span>
          </div>
          <div className="flex shrink-0 rotate-[-3deg] flex-col items-end justify-center gap-1 pr-1 md:pr-3">
            {tagline.map((word, i) => (
              <span
                key={word}
                className="font-serif text-[13px] italic text-brand md:text-lg"
                style={{ opacity: 0.55 + i * 0.15 }}
              >
                {word}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ---- What already works ---- */}
      <section className="relative z-10 mt-7 md:mt-2">
        <Card className="p-3 shadow-[0_16px_44px_rgba(8,47,54,0.10)] md:rounded-[22px] md:p-4">
          <div className="mb-3 flex items-center justify-between gap-4 px-1">
            <SectionTitle>{t("roadmap.live.title")}</SectionTitle>
            <p className="hidden text-sm text-muted md:block">Here&apos;s what you can do right now.</p>
          </div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5 md:gap-3">
            {LIVE.map(({ key, Icon }, i) => (
              <div key={key}
                // The last tile spans both columns when the count is odd
                // (cross-check, 2026-09-07) — otherwise a fixed 5-item list in
                // a 2-column grid leaves the final tile alone next to an empty
                // half-width gap.
                className={`relative flex min-h-[106px] flex-col items-center justify-center gap-2 rounded-xl bg-brand-tint/35 p-3 text-center ${
                  i === LIVE.length - 1 && LIVE.length % 2 === 1 ? "col-span-2 md:col-span-1" : ""
                }`}>
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand text-white">
                  <Icon size={17} />
                </span>
                <p className="text-xs font-semibold leading-snug text-brand-ink">{t(key)}</p>
              </div>
            ))}
          </div>
        </Card>
      </section>

      {/* ---- What is next ---- */}
      <section className="mt-10 md:mt-12">
        <div className="grid gap-4 md:grid-cols-2 md:items-center">
          <div>
            <p className="px-1 text-[11px] font-bold uppercase tracking-[0.14em] text-brand md:text-xs">{t("roadmap.roadmap.eyebrow")}</p>
            <h2 className="mt-1 px-1 text-2xl font-extrabold leading-tight tracking-[-0.025em] text-brand-ink md:text-4xl">
              {t("roadmap.roadmap.heading1")}<br />{t("roadmap.roadmap.heading2")}
            </h2>
            <span aria-hidden className="ml-1 mt-3 block h-1 w-12 rounded-full bg-brand" />
          </div>
          <p className="px-1 text-sm leading-relaxed text-muted md:text-base">{t("roadmap.roadmap.intro")}</p>
        </div>

        {/* A single vertical line down the left with a dot per step. The line is
            drawn by the border on each row rather than by an absolutely
            positioned element, so it can never drift out of line with the dots
            at a different font size. Dot style + badge now carry the step's
            state (done/active/upcoming/planned) — every row used to look
            identical, which is exactly why a page whose whole point is "when"
            gave no visual answer to "which one is now".
            ⚠️ THE DOT/LINE COLUMN STAYS OUTSIDE THE CARD, ON PURPOSE
            (cross-check, 2026-09-07). An earlier pass wrapped the WHOLE row
            (dot column included) in a bordered Card per step — which cut the
            connecting line off at each card's own edge, since a flex-stretch
            line can only run the height of ITS OWN box, and that box was now
            bounded by the card instead of the full `<li>`. Only the content
            (art/when/badge/title/body) gets the card treatment; the line still
            spans the full `<li>` (via `space-y-0` + `pb-5`, exactly as
            before) and reads as one continuous timeline again. */}
        <ol className="relative mt-5 space-y-0 md:mt-8">
          <span aria-hidden className="absolute bottom-[9%] left-1/2 top-[9%] hidden w-10 -translate-x-1/2 rounded-full bg-gradient-to-b from-brand-tint via-brand/15 to-brand-tint md:block" />
          {STEPS.map((step, i) => {
            const state = states[i];
            const StepIcon = STEP_ICON[step.key];
            return (
              <li key={step.key} className="flex gap-3 md:relative md:min-h-[300px] md:items-center md:gap-0">
                <div className="flex flex-col items-center md:absolute md:left-1/2 md:top-1/2 md:z-20 md:-translate-x-1/2 md:-translate-y-1/2">
                  {/* Margins are the ORIGINAL 0.5/1/1.5 offsets PLUS the
                      content Card's own p-3 (12px) padding (cross-check,
                      2026-09-07): moving the dot/line column outside the Card
                      fixed the connecting line, but left these tuned-for-zero-
                      padding offsets rendering each dot ~10-12px higher than
                      the "when"/badge line it's meant to sit level with. */}
                  {state === "done" ? (
                    <span
                      aria-hidden
                      className="mt-[14px] grid h-6 w-6 shrink-0 place-items-center rounded-full bg-success text-white md:mt-0 md:ring-8 md:ring-bg"
                    >
                      <CheckIcon size={14} />
                    </span>
                  ) : state === "active" ? (
                    <span className="mining-chamber mt-[16px] h-6 w-6 shrink-0 text-brand md:mt-0 md:ring-8 md:ring-bg">
                      <span className="mining-ring" aria-hidden="true" />
                      <span
                        aria-hidden
                        className="relative grid h-3 w-3 place-items-center rounded-full bg-brand"
                      />
                    </span>
                  ) : (
                    <span
                      aria-hidden
                      className={`mt-[18px] grid h-3 w-3 shrink-0 place-items-center rounded-full md:mt-0 md:h-5 md:w-5 md:ring-8 md:ring-bg ${
                        state === "upcoming"
                          ? "bg-card ring-2 ring-brand"
                          : "bg-card ring-2 ring-line"
                      }`}
                    />
                  )}
                  {i < STEPS.length - 1 && <span aria-hidden className="w-px flex-1 bg-line md:hidden" />}
                </div>
                <div className="min-w-0 flex-1 pb-5 md:grid md:grid-cols-2 md:items-center md:gap-20 md:pb-0">
                  <div className={`md:row-start-1 ${i % 2 === 0 ? "md:col-start-1" : "md:col-start-2"}`}>
                    <MilestoneArt kind={step.key} className="hidden h-auto w-full scale-110 drop-shadow-[0_22px_18px_rgba(13,92,99,0.16)] md:block" />
                  </div>
                  <Card className={`overflow-hidden shadow-[0_14px_36px_rgba(8,47,54,0.09)] md:row-start-1 ${i % 2 === 0 ? "md:col-start-2" : "md:col-start-1"} ${state === "active" ? "border-brand/40 ring-1 ring-brand/15" : ""}`}>
                    <div className="bg-brand-tint/25 md:hidden">
                      <MilestoneArt kind={step.key} className="h-auto w-full" />
                    </div>
                    <div className="p-3">
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
                      <p className="mt-0.5 flex items-center gap-1.5 font-bold text-brand-ink">
                        <StepIcon size={16} className="shrink-0 text-brand" />
                        {t(`roadmap.step.${step.key}.title`)}
                      </p>
                      <p className="mt-1 text-sm text-muted">{t(`roadmap.step.${step.key}.body`)}</p>
                    </div>
                  </Card>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {/* ---- Plans, not promises ---- */}
      <Card className="mx-auto mt-2 max-w-3xl p-4 md:flex md:items-center md:gap-3 md:px-6">
        <p className="flex items-center gap-2 font-bold text-brand-ink">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-tint text-brand">
            <InfoIcon size={16} />
          </span>
          {t("roadmap.note.title")}
        </p>
        <p className="mt-1.5 text-sm text-muted md:mt-0">{t("roadmap.note.body")}</p>
      </Card>

      {/* ---- Closing banner ---- */}
      <div className="relative mt-5 overflow-hidden rounded-2xl bg-brand p-5 text-white md:mt-6 md:flex md:items-center md:justify-between md:rounded-[22px] md:px-10 md:py-8">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-10 -top-14 h-40 w-40 rounded-full opacity-70"
          style={{ background: "radial-gradient(circle, var(--color-brand-ink), transparent 70%)" }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-16 -left-10 h-36 w-36 rounded-full opacity-40"
          style={{ background: "radial-gradient(circle, #7ff4ec, transparent 70%)" }}
        />
        <div className="relative">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-white/80">
            {t("roadmap.cta.eyebrow")}
          </p>
          <h2 className="mt-1 text-lg font-bold text-white">{t("roadmap.cta.title")}</h2>
          <p className="mt-1 text-sm text-white/90">{t("roadmap.cta.subtitle")}</p>
        </div>
          <Link
            href="/mine"
            className="relative mt-3 inline-flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-white px-7 text-base font-semibold text-brand transition hover:brightness-95 md:mt-0 md:w-auto md:min-w-[240px]"
          >
            <MineIcon size={20} />
            {t("roadmap.mine.cta")}
          </Link>
      </div>
    </div>
  );
}
