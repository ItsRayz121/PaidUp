"use client";

import { TaskFlow } from "@/components/TaskFlow";
import { Loading, ErrorState, EmptyState } from "@/components/state";
import { InfoIcon } from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { fetchTasks } from "@/lib/api";

export default function TasksPage() {
  const { user, ready } = useRequireAuth();
  const tasks = useApi(fetchTasks, []);

  if (!ready) return <div className="p-4 pt-6"><Loading /></div>;
  const list = tasks.data?.tasks ?? [];

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header>
        <h1 className="text-xl font-bold text-brand-ink">Ways to earn</h1>
        <p className="text-sm text-muted">Finish a task and get points.</p>
      </header>

      <p className="flex gap-2 rounded-xl border border-line bg-brand-tint/50 p-3 text-sm text-muted">
        <InfoIcon size={18} className="mt-0.5 shrink-0 text-brand" />
        These are sponsored offers from our partners. We tell you who gives the
        reward before you start.
      </p>

      {tasks.loading ? (
        <Loading />
      ) : tasks.error ? (
        <ErrorState message={tasks.error} onRetry={tasks.reload} />
      ) : list.length === 0 ? (
        <EmptyState
          title={`No tasks right now for ${user?.country ?? "your country"}`}
          body="Check back soon. New tasks come every day. Meanwhile, invite a friend and earn more."
        />
      ) : (
        <TaskFlow tasks={list} />
      )}
    </div>
  );
}
