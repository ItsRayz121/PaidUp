"use client";

import Link from "next/link";
import Image from "next/image";
import { useSyncExternalStore } from "react";
import { useI18n } from "@/lib/i18n";
import { ROADMAP_STEPS, roadmapStates } from "@/lib/roadmap";
import {
  ArrowRightIcon, ArrowUpIcon, CheckIcon, ChipIcon, InfoIcon,
  MineIcon, ReferIcon, TasksIcon,
} from "@/components/icons";

const LIVE = [
  { key: "roadmap.live.mining", Icon: MineIcon },
  { key: "roadmap.live.tasks", Icon: TasksIcon },
  { key: "roadmap.live.rigs", Icon: ChipIcon },
  { key: "roadmap.live.send", Icon: ArrowUpIcon },
  { key: "roadmap.live.invite", Icon: ReferIcon },
] as const;

function subscribeToDay(onChange: () => void) {
  const timer = window.setInterval(onChange, 60_000);
  window.addEventListener("focus", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("focus", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
}

const currentDay = () => new Date().toISOString().slice(0, 10);
// A stable server snapshot avoids baking the build date into cached HTML.
const serverDay = () => null;

export default function RoadmapPage() {
  const { t } = useI18n();
  const day = useSyncExternalStore(subscribeToDay, currentDay, serverDay);
  const states = roadmapStates(day);
  return (
    <div className="roadmap-live relative overflow-hidden px-4 pb-8 md:px-10 lg:px-14">
      <div className="roadmap-stars" aria-hidden />
      <section className="roadmap-hero grid min-h-[300px] items-center gap-3 pt-7 md:grid-cols-[.86fr_1.14fr] md:pt-10">
        <div className="relative z-10">
          <p className="text-[11px] font-extrabold uppercase tracking-[.15em] text-brand">{t("roadmap.hero.eyebrow")}</p>
          <h1 className="mt-2 font-display text-[38px] font-extrabold leading-[.98] tracking-[-.045em] text-brand-ink md:text-[54px]">The road <span>ahead</span></h1>
          <p className="mt-2 text-lg font-medium text-brand-ink">{t("roadmap.subtitle")}</p>
          <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted">{t("roadmap.hero.description")}</p>
        </div>
        <div className="roadmap-hero-stage relative min-w-0">
          <Image src="/roadmap/hero-mountain-v2.png" alt="A luminous road climbing RoziPay mountain" width={1536} height={1024} priority sizes="(max-width: 599px) 55vw, 560px" className="roadmap-hero-art h-auto w-full" />
        </div>
      </section>

      <section className="roadmap-live-panel relative z-10 rounded-[22px] border border-line bg-card/95 p-4 shadow-[0_18px_50px_rgba(8,47,54,.12)] backdrop-blur">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-3 text-xl font-extrabold text-brand-ink">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand text-white"><MineIcon size={18} /></span>
            {t("roadmap.live.title")}
          </h2>
          <p className="hidden text-xs text-muted sm:block">{t("roadmap.live.description")}</p>
        </div>
        <div className="roadmap-features">
          {LIVE.map(({ key, Icon }) => (
            <div key={key} className="roadmap-feature">
              <span className="grid h-11 w-11 place-items-center rounded-2xl bg-card text-brand shadow-sm"><Icon size={22} /></span>
              <span className="text-xs font-bold leading-snug text-brand-ink">{t(key)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="roadmap-world-section relative pt-10">
        <div className="roadmap-intro grid gap-3 md:grid-cols-2 md:items-center">
          <div>
            <p className="text-[11px] font-extrabold uppercase tracking-[.15em] text-brand">{t("roadmap.roadmap.eyebrow")}</p>
            <h2 className="mt-1 font-display text-3xl font-extrabold leading-[1.05] tracking-[-.035em] text-brand-ink">{t("roadmap.roadmap.heading1")}<br />{t("roadmap.roadmap.heading2")}</h2>
            <span className="mt-3 block h-0.5 w-12 bg-brand" />
          </div>
          <p className="text-sm leading-relaxed text-muted">{t("roadmap.roadmap.intro")}</p>
        </div>

        <div className="roadmap-journey relative mt-10 md:mt-8">
          <Image
            src="/roadmap/connected-world-v1.png"
            alt="A glowing road connecting mining, identity verification, public trading and a global exchange"
            width={836}
            height={1882}
            sizes="(max-width: 599px) 100vw, 1100px"
            className="roadmap-world-image"
          />
          {ROADMAP_STEPS.map((step, index) => {
            const state = states[index];
            return (
              <article key={step.key} className={`roadmap-stop roadmap-stop-${index}`}>
                <span className={`roadmap-node roadmap-node-${state}`} aria-hidden>{state === "done" ? <CheckIcon size={12} /> : index + 1}</span>
                <div className="roadmap-card-position">
                  <div className={`roadmap-card rounded-[20px] border bg-card/95 p-5 shadow-[0_16px_40px_rgba(8,47,54,.11)] backdrop-blur ${state === "active" ? "border-brand/60 ring-2 ring-brand/10" : "border-line"}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] font-extrabold uppercase tracking-wide text-brand">{t(`roadmap.step.${step.key}.when`)}</span>
                      <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold roadmap-badge-${state}`}>{t(`roadmap.state.${state}`)}</span>
                    </div>
                    <h3 className="mt-2 flex items-center gap-2 text-lg font-extrabold text-brand-ink">{t(`roadmap.step.${step.key}.title`)}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted">{t(`roadmap.step.${step.key}.body`)}</p>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <div className="roadmap-finale relative">
        {/* The note and the CTA share one max-width and one corner radius so the
            page closes on a matched pair, not two differently-sized slabs. */}
        <section className="roadmap-note relative mx-auto mt-8 flex max-w-[560px] gap-2.5 rounded-2xl border border-line bg-card px-3.5 py-3 shadow-sm">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-tint text-brand"><InfoIcon size={16} /></span>
          <div><h2 className="text-sm font-bold text-brand-ink">{t("roadmap.note.title")}</h2><p className="mt-0.5 text-[11px] leading-relaxed text-muted">{t("roadmap.note.body")}</p></div>
        </section>

        {/* Colours come from .roadmap-cta in globals.css, not from bg-brand /
            text-white: this panel shares the dark-glass system with every
            card above it, and the cyan is spent on the button alone. */}
        <section className="roadmap-cta relative mx-auto mt-3 flex max-w-[560px] items-center gap-4 overflow-hidden rounded-2xl px-3.5 py-3">
          <div className="relative z-10 min-w-0">
            <p className="text-[9px] font-bold uppercase tracking-[.14em] text-brand">{t("roadmap.cta.eyebrow")}</p>
            <h2 className="mt-0.5 text-base font-extrabold leading-tight text-brand-ink">{t("roadmap.cta.title")}</h2>
            <p className="mt-0.5 text-pretty text-[11px] leading-snug text-muted">{t("roadmap.cta.subtitle")}</p>
          </div>
          {/* min-h-11 is the 44px tap-target floor — the size came off the padding
              and type around it, never off the button itself. */}
          <Link href="/mine" className="relative z-10 inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl px-4 text-[13px] font-bold">{t("roadmap.mine.cta")} <ArrowRightIcon size={15} /></Link>
        </section>
      </div>
    </div>
  );
}
