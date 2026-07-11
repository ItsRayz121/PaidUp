"use client";

import { TaskFlow } from "@/components/TaskFlow";
import { Loading, ErrorState, EmptyState } from "@/components/state";
import { InfoIcon } from "@/components/icons";
import { LangToggle } from "@/components/LangToggle";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchTasks } from "@/lib/api";

export default function TasksPage() {
  const { user, ready } = useRequireAuth();
  const { t } = useI18n();
  const tasks = useApi(fetchTasks, []);

  if (!ready) return <div className="p-4 pt-6"><Loading /></div>;
  const list = tasks.data?.tasks ?? [];

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-brand-ink">{t("tasks.title")}</h1>
          <p className="text-sm text-muted">{t("tasks.subtitle")}</p>
        </div>
        <LangToggle className="shrink-0" />
      </header>

      <p className="flex gap-2 rounded-xl border border-line bg-brand-tint/50 p-3 text-sm text-muted">
        <InfoIcon size={18} className="mt-0.5 shrink-0 text-brand" />
        {t("tasks.disclosure")}
      </p>

      {tasks.loading ? (
        <Loading />
      ) : tasks.error ? (
        <ErrorState message={tasks.error} onRetry={tasks.reload} />
      ) : list.length === 0 ? (
        <EmptyState
          title={t("tasks.empty.title", { country: user?.country ?? t("common.yourCountry") })}
          body={t("tasks.empty.body")}
        />
      ) : (
        <TaskFlow tasks={list} />
      )}
    </div>
  );
}
