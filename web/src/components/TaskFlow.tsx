"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, PointsPill, SponsoredTag, Button } from "./ui";
import { offerIcon, taskIcon, CheckIcon, ClockIcon, XIcon, StarIcon, ArrowRightIcon } from "./icons";
import { formatPointsAsRozi } from "@/lib/format";
import { submitTaskProof, type Task } from "@/lib/api";

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
  const [started, setStarted] = useState<Task | null>(null);

  return (
    <>
      <ul className="space-y-3">
        {tasks.map((task) => (
          <li key={task.id}>
            <Card className="p-3.5">
              <button
                onClick={() => setOpenTask(task)}
                className="flex w-full items-center gap-3 text-left"
              >
                <TaskRowBody task={task} />
              </button>
              <TaskCardFooter task={task} />
            </Card>
          </li>
        ))}
      </ul>

      {openTask && openTask.source === "custom" && openTask.verifyMode === "proof" ? (
        <ProofSheet task={openTask} onClose={() => setOpenTask(null)} />
      ) : openTask ? (
        <DisclosureSheet
          task={openTask}
          onClose={() => setOpenTask(null)}
          onStart={() => {
            const t = openTask;
            setOpenTask(null);
            setStarted(t);
          }}
        />
      ) : null}

      {started && <TaskStartedInfo task={started} onDone={() => setStarted(null)} />}
    </>
  );
}

// ---- The task card, split in two so home and /tasks cannot drift -----------
//
// The row (logo, title, time, reward) and the footer line are shared between the
// interactive list above and the single preview card on home. They are one
// definition on purpose: the home card is meant to look like the thing it leads
// to, and a second hand-copied version of this markup would be identical for
// about a week.

function TaskRowBody({ task }: { task: Task }) {
  // An Admin-picked logo wins; otherwise fall back to the task type's icon.
  // `taskIcon[...]` can still miss if the API ever learns a name the web app has
  // not shipped yet, so the fallback is not optional.
  const Icon = (task.icon && taskIcon[task.icon]) || offerIcon[task.type];
  return (
    <>
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
        {task.proofStatus ? <ProofBadge status={task.proofStatus} /> : <ArrowRightIcon size={18} className="text-muted" />}
      </span>
    </>
  );
}

function TaskCardFooter({ task }: { task: Task }) {
  return (
    <div className="mt-3 border-t border-line pt-2.5">
      {/* Our own tasks aren't sponsored — no third-party disclosure. */}
      {task.source === "custom"
        ? <span className="text-xs font-medium text-brand">RoziPay task</span>
        : <SponsoredTag network={task.network} />}
    </div>
  );
}

// ONE TASK ON HOME, AND TAPPING IT GOES TO /tasks (founder, 2026-08-01).
//
// It looks like a task card and it is deliberately NOT one: there is no sheet,
// no proof box, no start. Home showed three fully interactive cards, so a user
// could open a sponsored offer, read the disclosure and start it without ever
// meeting the screen that lists what else is on offer — and the two screens
// then held two copies of the same in-progress state. Home's job is to say
// "there is work here"; /tasks is where work gets done.
//
// ⚠️ THE DISCLOSURE IS WHY THIS MUST STAY A LINK. Guardrail #3 says a user sees
// the sponsored notice BEFORE starting a task, and that notice lives in the
// sheet this card no longer opens. A card here that could start an offer would
// have to carry the disclosure itself. Sending the user to /tasks keeps exactly
// one place where an offer can begin, with the disclosure in front of it.
export function TaskPreview({ task }: { task: Task }) {
  return (
    <Card className="p-3.5">
      <Link href="/tasks" className="flex w-full items-center gap-3 text-left">
        <TaskRowBody task={task} />
      </Link>
      <TaskCardFooter task={task} />
    </Card>
  );
}

// A small coloured word showing where a submitted proof stands.
//
// "Under review", not "Checking": a proof sits in a human staff queue
// (staffTasks.ts), and "Checking" reads as something automatic that finishes in
// a moment. The wait here is hours. "Rejected" keeps the standard word the rest
// of the app now uses for the same outcome, and the sheet underneath already
// tells the user they can fix it and send again.
function ProofBadge({ status }: { status: "pending" | "approved" | "rejected" }) {
  const map = {
    pending: { label: "Under review", cls: "bg-pending-tint text-pending" },
    approved: { label: "Completed", cls: "bg-success-tint text-success" },
    rejected: { label: "Rejected", cls: "bg-danger-tint text-danger" },
  }[status];
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${map.cls}`}>{map.label}</span>;
}

// ---- Proof task (OUR OWN task, verified by staff) ------------------------
// The user does the thing (join, follow, sign up), then sends us proof. No
// points are added here — a staff member checks the proof and adds the points.
// That is guardrail #1: the app never credits itself.
function ProofSheet({ task, onClose }: { task: Task; onClose: () => void }) {
  const already = task.proofStatus;
  const [proof, setProof] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(already === "pending");

  // Does this task ask for evidence, or only for a confirmation? An Admin picks
  // this per task: "send us your username" is worth typing, "join our WhatsApp
  // channel" is not, and asking anyway is where people quit at the last step.
  //
  // ⚠️ THE TWO BRANCHES END IN THE SAME PLACE. Both POST to the same route, both
  // create a PENDING row, and a staff member approves either one before a single
  // point moves (guardrail #1). Undefined means an older API, read as "asks".
  const asksForProof = task.proofRequired !== false;

  async function send() {
    if (asksForProof && proof.trim().length === 0) {
      setError("Please write your proof first.");
      return;
    }
    setBusy(true); setError(null);
    try {
      const r = await submitTaskProof(task.id, proof.trim());
      if (r.ok) setSent(true);
      else setError(r.error ?? "Could not send. Try again.");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center">
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div role="dialog" aria-modal="true" aria-labelledby="proof-title"
        className="animate-rise relative w-full max-w-[480px] rounded-t-3xl bg-card p-5 pb-7">
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-line" />
        <h2 id="proof-title" className="text-lg font-bold text-brand-ink">{task.title}</h2>

        <div className="mt-3 flex items-center gap-2">
          <PointsPill points={task.points} />
          <span className="text-sm text-muted">when we check your proof</span>
        </div>

        {task.instructions && (
          <div className="mt-4 rounded-xl bg-brand-tint/50 p-3 text-sm text-brand-ink">
            {task.instructions}
          </div>
        )}

        {task.actionUrl && (
          <a href={task.actionUrl} target="_blank" rel="noopener noreferrer"
            className="mt-3 flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-3 font-semibold text-white">
            Open the task <ArrowRightIcon size={18} />
          </a>
        )}

        {already === "approved" ? (
          <p className="mt-4 rounded-xl bg-success-tint p-3 text-sm text-success">
            You finished this task and your ROZI was added. Thank you!
          </p>
        ) : sent ? (
          <div className="mt-4 rounded-xl bg-pending-tint p-3 text-sm text-pending">
            <p className="font-semibold">We got your proof.</p>
            <p className="mt-1">Our team will check it and add your ROZI. This can take a little time.</p>
          </div>
        ) : (
          <>
            {already === "rejected" && task.proofNote && (
              <p className="mt-4 rounded-xl bg-danger-tint p-3 text-sm text-danger">
                Last time: {task.proofNote}. Please fix it and send again.
              </p>
            )}
            {asksForProof ? (
              <>
                <label className="mt-4 block text-sm font-semibold text-brand-ink">
                  {task.proofLabel || "Send your proof"}
                </label>
                <textarea
                  value={proof}
                  onChange={(e) => setProof(e.target.value)}
                  rows={3}
                  placeholder="Type your proof here (for example your username, or what you did)."
                  className="mt-2 w-full rounded-xl border border-line bg-bg p-3 text-sm outline-none focus:border-brand"
                />
              </>
            ) : (
              // No text box, and the copy must not pretend the ROZI is instant:
              // this still goes to a person. "We will check" is the honest verb
              // and it is the same one the with-proof branch uses after sending.
              <p className="mt-4 rounded-xl bg-brand-tint/50 p-3 text-sm text-brand-ink">
                Finished it? Tell us, and our team will check and add your ROZI.
              </p>
            )}
            {error && <p className="mt-2 text-sm text-danger">{error}</p>}
            <div className="mt-4 space-y-2.5">
              <Button variant="primary" onClick={send} disabled={busy}>
                {busy ? "Sending…" : asksForProof ? "Send proof" : "I did it"}
              </Button>
              <Button variant="ghost" onClick={onClose}>Close</Button>
            </div>
          </>
        )}
      </div>
    </div>
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
          through {task.network}. You get your ROZI after they confirm you finished.
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

// Shown after a user starts a task. HONEST: points are NOT added here — they
// arrive only after the ad network confirms (verified postback, guardrail #1).
// The real "points added" moment fires when the wallet balance goes up.
function TaskStartedInfo({ task, onDone }: { task: Task; onDone: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Task started"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-brand-ink px-6 text-center"
    >
      <div className="animate-pop grid h-24 w-24 place-items-center rounded-full bg-brand-tint">
        <ArrowRightIcon size={48} className="text-brand" />
      </div>

      <p className="animate-rise mt-6 text-lg font-bold text-white">Task started</p>
      <p className="animate-rise mt-2 flex items-center gap-2 text-white/90">
        <StarIcon size={20} className="text-accent" />
        <span>You will get <span className="num font-bold">{formatPointsAsRozi(task.points)}</span></span>
      </p>

      <div className="animate-rise mt-6 w-full max-w-xs space-y-2.5 text-left">
        <div className="flex items-center gap-3 rounded-xl bg-white/10 p-3 text-white/90">
          <CheckIcon size={18} className="shrink-0 text-accent" />
          <span className="text-sm">Finish the task in the app.</span>
        </div>
        <div className="flex items-center gap-3 rounded-xl bg-white/10 p-3 text-white/90">
          <ClockIcon size={18} className="shrink-0 text-accent" />
          <span className="text-sm">We add your ROZI after the partner confirms. This can take a little time.</span>
        </div>
      </div>

      <div className="mt-8 w-full max-w-xs">
        <Button variant="accent" onClick={onDone}>OK, got it</Button>
      </div>
    </div>
  );
}

// A small legend used on empty states etc. Words match ui.tsx's `statusMap` —
// see the note there before changing either.
export function StatusLegend() {
  return (
    <div className="flex flex-wrap gap-3 text-xs text-muted">
      <span className="flex items-center gap-1"><CheckIcon size={13} /> Completed</span>
      <span className="flex items-center gap-1"><ClockIcon size={13} /> Pending</span>
      <span className="flex items-center gap-1"><XIcon size={13} /> Rejected</span>
    </div>
  );
}
