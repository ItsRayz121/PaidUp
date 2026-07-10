import { TaskFlow } from "@/components/TaskFlow";
import { InfoIcon } from "@/components/icons";
import { tasks, user } from "@/lib/mock";

export default function TasksPage() {
  const hasTasks = tasks.length > 0;

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

      {hasTasks ? (
        <TaskFlow tasks={tasks} />
      ) : (
        // Empty state — say WHY and give a next step (DESIGN_BRIEF)
        <div className="rounded-2xl border border-line bg-card p-6 text-center">
          <p className="font-semibold text-brand-ink">No tasks right now for {user.country}</p>
          <p className="mt-1 text-sm text-muted">
            Check back soon. New tasks come every day. Meanwhile, invite a friend
            and earn more.
          </p>
        </div>
      )}
    </div>
  );
}
