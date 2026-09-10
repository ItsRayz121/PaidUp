"use client";

import { useState, useSyncExternalStore } from "react";
import { TaskFlow } from "@/components/TaskFlow";
import { Button } from "@/components/ui";
import { Loading, ErrorState, EmptyState } from "@/components/state";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchTasks, TASK_CATEGORY_LABELS, type TaskView, type Task } from "@/lib/api";

// "My tasks" and "History" show their cards under a heading for where each one
// stands.
//
// ⚠️ ORDER (founder, 2026-09-05): "Under review" then "Pending reward" then
// "Completed" — what is waiting on OUR review comes first, then what has been
// approved and is waiting to be paid out, then what is fully done. On an
// ordinary day "Needs another try" and "Pending" (below) are both empty, so
// what the user actually SEES is exactly that three-step order; they still
// surface, further down, on the days they have something in them — a task
// genuinely needing the user's own action is never hidden, just not put ahead
// of the two states the founder asked to lead.
//
// ⚠️ "In progress" -> "Pending" (founder, 2026-09-05): from the person doing
// the task, tapping Start and confirming IS finishing their part — what is
// actually "in progress" from here is our own review, not their work, so
// "in progress" read as if the app had forgotten they were done. "Pending"
// says the same thing without implying the ball is still in their court.
//
// ⚠️ "Pending reward" (renamed from "Reward on the way", founder, 2026-09-05)
// is a task that has been APPROVED but whose reward has not been released/paid
// out yet (userState 'reward_pending' — see docs/DISBURSEMENT_PLAN.md and the
// staff Disbursements panel, "Waiting to be paid"). This is a different wait
// than "Under review" (not yet decided) and a different one again from "Pending"
// (not yet submitted) — three distinct states, never collapsed into one.
//
// ⚠️ "Completed" here is a SEPARATE, SMALL fetch from the History view
// (recentCompleted, capped at 5) — the "mine" view's own API response
// deliberately EXCLUDES done tasks (routes/app.ts: `isDone` tasks are dropped
// from `view=mine`, since that view's whole job used to be "what is still
// unfinished"). Reusing the tested History query for a quick glance here,
// rather than changing what `view=mine` itself returns, keeps that existing
// contract untouched — History remains the real, complete Completed list.
//
// ⚠️ THIS RETURNS EVERY GROUP, INCLUDING EMPTY ONES (founder, 2026-09-10) —
// filtering empty groups out used to happen INSIDE this function, which was
// fine while every group was also a section heading (an empty section is
// just skipped). It no longer works once "Under review" / "Pending reward" /
// "Completed" are fixed, always-visible chips: the caller needs to tell "this
// chip is empty" apart from "this label doesn't exist", so filtering is now
// the caller's job.
function groupsFor(
  view: TaskView, list: Task[], recentCompleted: Task[] = [],
): { label: string; items: Task[] }[] {
  const pick = (...states: string[]) => list.filter((x) => states.includes(x.userState ?? ""));
  if (view === "mine") {
    return [
      { label: "Under review", items: pick("pending_review") },
      { label: "Pending reward", items: pick("reward_pending") },
      { label: "Needs another try", items: pick("rejected_retryable") },
      { label: "Pending", items: pick("started", "not_started") },
      { label: "Completed", items: recentCompleted.slice(0, 5) },
    ];
  }
  // history
  return [
    { label: "Completed", items: pick("completed") },
    { label: "Ended campaigns", items: list.filter((x) => x.userState !== "completed") },
  ];
}

// ⚠️ FIXED, ALWAYS-SHOWN CHIPS FOR "My activity" (founder, 2026-09-10): "Under
// review" / "Pending reward" / "Completed" are the three stages the founder
// called "the most suitable category at the present moment" — shown as a
// fixed row (plus "All") regardless of whether a given one has anything in it
// right now, unlike every other chip row in this file (category, History's
// own group row), which only ever lists what's actually present. "Needs
// another try" and "Pending" (not yet submitted) are real states that must
// still surface — see groupsFor's own header comment — so they are not
// dropped, just folded into "All" rather than given a fourth/fifth chip of
// their own; the founder's ask was for exactly four chips.
const MINE_CHIPS = ["Under review", "Pending reward", "Completed"];

export default function TasksPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const view = useSyncExternalStore(
    (notify) => { window.addEventListener("popstate", notify); return () => window.removeEventListener("popstate", notify); },
    readTaskView,
    () => "available" as TaskView,
  );
  const [limit, setLimit] = useState(12);
  const tasks = useApi(() => fetchTasks(view, 0, limit), [view, limit]);
  const [category, setCategory] = useState("");
  // The status headings ("Under review" / "Pending" / "Completed", etc.) used
  // to only ever stack vertically, one full section after another. This is
  // the same chip-row filter the category row above already uses — "All"
  // (the default) keeps today's stacked-sections behaviour; picking one
  // status shows just that section, so the statuses read as a horizontal
  // row instead of a scroll.
  const [group, setGroup] = useState("");
  // A small, separate fetch — just enough for "My activity"'s Completed
  // group to show something without duplicating the History screen. See
  // groupsFor's own comment for why this is a second call, not a bigger
  // change to what `view=mine` returns.
  const recentDone = useApi(
    () => (view === "mine"
      ? fetchTasks("history", 0, 5)
      : Promise.resolve({ tasks: [] as Task[], nextCursor: null, total: 0, view: "history" as TaskView })),
    [view],
  );

  if (!ready) return <div className="p-4 pt-6"><Loading /></div>;
  const all = tasks.data?.tasks ?? [];
  const recentlyCompleted = (recentDone.data?.tasks ?? []).filter((x) => x.userState === "completed");
  // ⚠️ THE CHIPS ARE BUILT FROM WHAT IS ACTUALLY IN THE LIST, never from the
  // full category list. A chip that filters to nothing is a screen telling a
  // user there is work in a category that is empty today — and on a quiet day
  // that is most of them.
  const present = [...new Set(all.map((x) => x.category).filter(Boolean))] as string[];
  const list = category ? all.filter((x) => x.category === category) : all;
  const rawGroups = view !== "available" ? groupsFor(view, list, recentlyCompleted) : [];
  const nonEmptyGroups = rawGroups.filter((g) => g.items.length > 0);
  // "My activity" gets the fixed four (All + the three named stages, always
  // offered); History keeps the old behaviour of only ever listing whichever
  // groups actually have something in them right now.
  const chipLabels = view === "mine" ? MINE_CHIPS : nonEmptyGroups.map((g) => g.label);
  const activeGroup = chipLabels.includes(group) ? group : "";
  const groupsToShow = activeGroup === ""
    ? nonEmptyGroups
    : [{ label: activeGroup, items: rawGroups.find((g) => g.label === activeGroup)?.items ?? [] }];
  const switchView = (next: TaskView) => {
    setLimit(next === "history" ? 20 : 12); setCategory(""); setGroup("");
    const url = next === "available" ? "/tasks" : `/tasks?view=${next}`;
    window.history.replaceState(null, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  const empty = view === "mine"
    ? { title: "Nothing here yet", body: "Start an available task and it will show up here while you finish it." }
    : view === "history"
      ? { title: "No task history yet", body: "Your completed tasks will appear here." }
      : { title: t("tasks.empty.title"), body: t("tasks.empty.body") };

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-brand-ink">{t("tasks.title")}</h1>
          <p className="text-sm text-muted">{t("tasks.subtitle")}</p>
        </div>
      </header>

      <nav aria-label="Task views" className="grid grid-cols-3 rounded-xl border border-brand/10 bg-brand-tint p-1">
        {(["available", "mine", "history"] as TaskView[]).map((item) => (
          <button key={item} onClick={() => switchView(item)} aria-current={view === item ? "page" : undefined}
            className={`min-h-11 rounded-lg px-2 text-sm font-semibold transition ${view === item ? "border border-brand/15 bg-card text-brand shadow-sm" : "border border-transparent text-muted"}`}>
            {item === "available" ? "Available" : item === "mine" ? "My activity" : "History"}
          </button>
        ))}
      </nav>

      {/* ⚠️ THE GENERIC BANNER THAT USED TO SIT HERE IS GONE (founder,
          2026-08-12), NOT THE DISCLOSURE ITSELF. Guardrail #3 ("disclose that
          offers are sponsored, before a user starts a task") is still met — it
          lives in TaskFlow.tsx's per-offer sheet, which is the one that
          actually fires immediately before a sponsored task starts, is closer
          to what the rule requires, and cannot be skipped the way a banner on
          a list screen can be scrolled past. Removing that sheet too was
          explicitly NOT part of this change; it is the load-bearing one. */}

      {/* The Surveys (CPX) entry point is hidden here (founder, 2026-08-28) —
          /surveys itself is untouched, just not linked from this list. */}

      {present.length > 1 && (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          <Chip label="All" active={category === ""} onClick={() => { setCategory(""); setGroup(""); }} />
          {present.map((c) => (
            <Chip key={c} label={TASK_CATEGORY_LABELS[c] ?? c}
              active={category === c} onClick={() => { setCategory(c); setGroup(""); }} />
          ))}
        </div>
      )}

      {/* ⚠️ "My activity" gets its OWN, equal-width row (founder, 2026-09-10)
          — NOT the shrink-to-content, horizontally-scrollable Chip row every
          other filter in this file uses. That row lets the widest label
          (here, "Pending reward") push the last chip half off the right edge
          of the screen, which is exactly the "first eyesight" cutoff the
          founder pointed at. Measured against real phone widths (358-380px
          of content, i.e. a 390-412px screen): four equal `flex-1` chips at
          `text-xs` wrap "Under review"/"Pending reward" to two lines and fit
          every chip fully on screen with no scrolling and no clipping — see
          the GroupChip component below for the full reasoning. History keeps
          the old scrollable row (only shown once it has >1 group to switch
          between), since its labels are short enough to never need this. */}
      {view === "mine" ? (
        <div className="flex gap-1.5">
          <GroupChip label="All" active={activeGroup === ""} onClick={() => setGroup("")} />
          {chipLabels.map((label) => (
            <GroupChip key={label} label={label} active={activeGroup === label} onClick={() => setGroup(label)} />
          ))}
        </div>
      ) : chipLabels.length > 1 ? (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          <Chip label="All" active={activeGroup === ""} onClick={() => setGroup("")} />
          {chipLabels.map((label) => (
            <Chip key={label} label={label} active={activeGroup === label} onClick={() => setGroup(label)} />
          ))}
        </div>
      ) : null}

      {tasks.loading ? (
        <Loading />
      ) : tasks.error ? (
        <ErrorState message={tasks.error} onRetry={tasks.reload} />
      ) : list.length === 0 && !(view === "mine" && recentlyCompleted.length > 0) ? (
        <EmptyState title={empty.title} body={empty.body} />
      ) : (
        <>
          {/* "Available" is one flat list. "My tasks" and "History" group the
              cards by where they stand, so a user can see at a glance what is
              waiting on them vs. waiting on us. */}
          {view === "available" ? (
            <TaskFlow tasks={list} />
          ) : (
            groupsToShow.map((g) => (
              <section key={g.label} className="space-y-2">
                {/* The chip row above already names the active status when one
                    is picked — repeating it as a heading here would be the
                    same word twice. The heading only earns its place when
                    "All" is selected and several sections are stacked. */}
                {activeGroup === "" && (
                  <h2 className="text-xs font-bold uppercase tracking-wide text-muted">{g.label}</h2>
                )}
                {/* A fixed "My activity" chip (unlike every other chip in this
                    file) can be picked while it genuinely has nothing in it —
                    TaskFlow renders an empty list as literally nothing, which
                    would read as a broken screen rather than "nothing here
                    right now". */}
                {g.items.length === 0 ? (
                  <p className="px-1 text-sm text-muted">Nothing here right now.</p>
                ) : (
                  <TaskFlow tasks={g.items} />
                )}
              </section>
            ))
          )}
          {tasks.data?.nextCursor !== null && !category && (
            <div className="mt-4"><Button variant="ghost" size="md" onClick={() => setLimit((n) => n + 12)}>
              Load more tasks
            </Button></div>
          )}
        </>
      )}
    </div>
  );
}

function readTaskView(): TaskView {
  const requested = new URLSearchParams(window.location.search).get("view");
  return requested === "mine" || requested === "history" ? requested : "available";
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-pressed={active}
      className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-semibold ${
        active ? "bg-brand text-white" : "bg-brand-tint text-brand"}`}>
      {label}
    </button>
  );
}

// ⚠️ `min-w-0` IS LOAD-BEARING, NOT DECORATION (founder, 2026-09-10). A flex
// item defaults to `min-width: auto`, which floors its width at its own
// content's intrinsic width — with 4 equal `flex-1` chips that default would
// make each one exactly as wide as the LONGEST label ("Pending reward"),
// overflowing the row instead of sharing it. `min-w-0` is what actually lets
// a chip shrink below its own text and wrap to two lines. Confirmed by
// rendering this exact markup at 358px and 380px of content width (a
// 390-412px phone) — every chip lands at `scrollWidth === clientWidth`
// (nothing clipped), two lines for the longer labels, one for "All" and
// "Completed". Do not "simplify" this back to `Chip`'s shrink-to-content,
// horizontally-scrollable layout — that is the exact style that cut
// "Completed" off the edge of the screen.
function GroupChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-pressed={active}
      className={`min-w-0 flex-1 rounded-full px-1 py-1.5 text-center text-xs font-semibold leading-tight ${
        active ? "bg-brand text-white" : "bg-brand-tint text-brand"}`}>
      {label}
    </button>
  );
}
