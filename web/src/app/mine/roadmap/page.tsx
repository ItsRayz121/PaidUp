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
        <section className="roadmap-note relative mx-auto mt-12 flex max-w-[650px] gap-3 rounded-2xl border border-line bg-card p-4 shadow-sm">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand"><InfoIcon size={20} /></span>
          <div><h2 className="font-bold text-brand-ink">{t("roadmap.note.title")}</h2><p className="mt-1 text-xs leading-relaxed text-muted">{t("roadmap.note.body")}</p></div>
        </section>

        <section className="roadmap-cta relative mt-6 overflow-hidden rounded-[22px] bg-brand px-6 py-7 text-white md:flex md:items-center md:justify-between md:px-10">
          <div className="relative z-10"><p className="text-[10px] font-bold uppercase tracking-[.15em] text-white/80">{t("roadmap.cta.eyebrow")}</p><h2 className="mt-1 text-3xl font-extrabold">{t("roadmap.cta.title")}</h2><p className="mt-1 text-sm text-white/85">{t("roadmap.cta.subtitle")}</p></div>
          <Link href="/mine" className="relative z-10 mt-5 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-white px-7 font-bold text-brand md:mt-0 md:w-auto">{t("roadmap.mine.cta")} <ArrowRightIcon size={18} /></Link>
        </section>
      </div>
    </div>
  );
}
