"use client";

import { useState } from "react";
import { Card, PointsPill, SponsoredTag, Button } from "./ui";
import { offerIcon, CheckIcon, ClockIcon, XIcon, StarIcon, ArrowRightIcon } from "./icons";
import { formatPoints } from "@/lib/format";
import type { Task } from "@/lib/mock";

// Renders the task list + the two interactive steps that build trust:
//   1. Sponsored disclosure sheet (guardrail #3) shown BEFORE a task starts.
//   2. The "points earned" confirmation — signature moment #1.
//
// NOTE: This is a demo. In production, points are NEVER added from this screen.
// The real credit happens server-side only after a verified postback from the
// ad network (guardrail #1, docs/ARCHITECTURE.md). The disclosure sheet says so
// in plain words so the demo doesn't teach a false expectation.

export function TaskFlow({ tasks }: { tasks: Task[] }) {
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const [earned, setEarned] = useState<Task | null>(null);

  return (
    <>
      <ul className="space-y-3">
        {tasks.map((task) => {
          const Icon = offerIcon[task.type];
          return (
            <li key={task.id}>
              <Card className="p-3.5">
                <button
                  onClick={() => setOpenTask(task)}
                  className="flex w-full items-center gap-3 text-left"
                >
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
                    <Icon size={22} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-brand-ink leading-snug">
                      {task.title}
                    </span>
                    <span className="mt-1 flex items-center gap-2 text-xs text-muted">
                      <ClockIcon size={13} />
                      About {task.minutes} min
                    </span>
                  </span>
                  <span className="flex flex-col items-end gap-1.5">
                    <PointsPill points={task.points} />
                    <ArrowRightIcon size={18} className="text-muted" />
                  </span>
                </button>
                <div className="mt-3 border-t border-line pt-2.5">
                  <SponsoredTag network={task.network} />
                </div>
              </Card>
            </li>
          );
        })}
      </ul>

      {openTask && (
        <DisclosureSheet
          task={openTask}
          onClose={() => setOpenTask(null)}
          onStart={() => {
            const t = openTask;
            setOpenTask(null);
            // Demo: instant tasks (video) show the earned moment right away.
            // Everything else would wait for a real postback in production.
            setEarned(t);
          }}
        />
      )}

      {earned && <EarnedConfirmation task={earned} onDone={() => setEarned(null)} />}
    </>
  );
}

// ---- Sponsored disclosure (shown BEFORE task start) ----------------------
function DisclosureSheet({
  task, onClose, onStart,
}: { task: Task; onClose: () => void; onStart: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center">
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        className="animate-rise relative w-full max-w-[480px] rounded-t-3xl bg-card p-5 pb-7"
      >
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-line" />
        <h2 id="sheet-title" className="text-lg font-bold text-brand-ink">{task.title}</h2>

        <div className="mt-3 flex items-center gap-2">
          <PointsPill points={task.points} />
          <span className="text-sm text-muted">for finishing this</span>
        </div>

        {task.requirement && (
          <p className="mt-4 flex gap-2 rounded-xl bg-pending-tint p-3 text-sm text-pending">
            <ClockIcon size={18} className="mt-0.5 shrink-0" />
            <span>{task.requirement}</span>
          </p>
        )}

        {/* Sponsored disclosure — plain words, no jargon (guardrail #3 / #6) */}
        <p className="mt-4 rounded-xl border border-line bg-brand-tint/50 p-3 text-sm text-muted">
          This is a sponsored offer. Your reward comes from{" "}
          <span className="font-semibold text-brand-ink">{task.advertiser}</span>{" "}
          through {task.network}. You get your points after they confirm you finished.
        </p>

        <div className="mt-5 space-y-2.5">
          <Button variant="primary" onClick={onStart}>
            Start now <ArrowRightIcon size={18} />
          </Button>
          <Button variant="ghost" onClick={onClose}>Not now</Button>
        </div>
      </div>
    </div>
  );
}

// ---- Signature moment #1: points earned ----------------------------------
function EarnedConfirmation({ task, onDone }: { task: Task; onDone: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Points added"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-brand-ink px-6 text-center"
    >
      <div className="animate-pop grid h-24 w-24 place-items-center rounded-full bg-accent">
        <CheckIcon size={52} className="text-brand-ink" />
      </div>

      <p className="animate-rise mt-6 text-sm font-medium uppercase tracking-wide text-accent">
        Nice work
      </p>
      <p className="animate-rise mt-1 flex items-center gap-2 text-white">
        <StarIcon size={26} className="text-accent" />
        <span className="num text-5xl font-bold">+{formatPoints(task.points)}</span>
      </p>
      <p className="animate-rise mt-2 text-lg text-white/80">points added</p>

      <p className="animate-rise mt-6 max-w-xs text-sm text-white/60">
        Your new points are in your wallet. Keep earning to get your money.
      </p>

      <div className="mt-8 w-full max-w-xs">
        <Button variant="accent" onClick={onDone}>Keep earning</Button>
      </div>
    </div>
  );
}

// A small legend used on empty states etc.
export function StatusLegend() {
  return (
    <div className="flex flex-wrap gap-3 text-xs text-muted">
      <span className="flex items-center gap-1"><CheckIcon size={13} /> Added</span>
      <span className="flex items-center gap-1"><ClockIcon size={13} /> Waiting</span>
      <span className="flex items-center gap-1"><XIcon size={13} /> Not added</span>
    </div>
  );
}
