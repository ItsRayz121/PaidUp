"use client";

import { useState, useSyncExternalStore } from "react";
import { TaskFlow } from "@/components/TaskFlow";
import { Button } from "@/components/ui";
import { Loading, ErrorState, EmptyState } from "@/components/state";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchTasks, TASK_CATEGORY_LABELS, type TaskView, type Task } from "@/lib/api";

// "My tasks" and "History" show their cards under a heading for where each one
// stands. Order matters: what is waiting on the USER comes before what is
// waiting on us.
function groupsFor(view: TaskView, list: Task[]): { label: string; items: Task[] }[] {
  const pick = (...states: string[]) => list.filter((x) => states.includes(x.userState ?? ""));
  if (view === "mine") {
    return [
      { label: "Needs another try", items: pick("rejected_retryable") },
      { label: "In progress", items: pick("started", "not_started") },
      { label: "Under review", items: pick("pending_review") },
      { label: "Reward on the way", items: pick("reward_pending") },
    ].filter((g) => g.items.length > 0);
  }
  // history
  return [
    { label: "Completed", items: pick("completed") },
    { label: "Ended campaigns", items: list.filter((x) => x.userState !== "completed") },
  ].filter((g) => g.items.length > 0);
}

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

  if (!ready) return <div className="p-4 pt-6"><Loading /></div>;
  const all = tasks.data?.tasks ?? [];
  // ⚠️ THE CHIPS ARE BUILT FROM WHAT IS ACTUALLY IN THE LIST, never from the
  // full category list. A chip that filters to nothing is a screen telling a
  // user there is work in a category that is empty today — and on a quiet day
  // that is most of them.
  const present = [...new Set(all.map((x) => x.category).filter(Boolean))] as string[];
  const list = category ? all.filter((x) => x.category === category) : all;
  const switchView = (next: TaskView) => {
    setLimit(next === "history" ? 20 : 12); setCategory("");
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
          <Chip label="All" active={category === ""} onClick={() => setCategory("")} />
          {present.map((c) => (
            <Chip key={c} label={TASK_CATEGORY_LABELS[c] ?? c}
              active={category === c} onClick={() => setCategory(c)} />
          ))}
        </div>
      )}

      {tasks.loading ? (
        <Loading />
      ) : tasks.error ? (
        <ErrorState message={tasks.error} onRetry={tasks.reload} />
      ) : list.length === 0 ? (
        <EmptyState title={empty.title} body={empty.body} />
      ) : (
        <>
          {/* "Available" is one flat list. "My tasks" and "History" group the
              cards by where they stand, so a user can see at a glance what is
              waiting on them vs. waiting on us. */}
          {view === "available" ? (
            <TaskFlow tasks={list} />
          ) : (
            groupsFor(view, list).map((g) => (
              <section key={g.label} className="space-y-2">
                <h2 className="text-xs font-bold uppercase tracking-wide text-muted">{g.label}</h2>
                <TaskFlow tasks={g.items} />
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
