"use client";

import { useState } from "react";
import Link from "next/link";
import { TaskFlow } from "@/components/TaskFlow";
import { Card } from "@/components/ui";
import { Loading, ErrorState, EmptyState } from "@/components/state";
import { InfoIcon, ArrowRightIcon, StarIcon } from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchTasks, TASK_CATEGORY_LABELS } from "@/lib/api";

export default function TasksPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const tasks = useApi(fetchTasks, []);
  const [category, setCategory] = useState("");

  if (!ready) return <div className="p-4 pt-6"><Loading /></div>;
  const all = tasks.data?.tasks ?? [];
  // ⚠️ THE CHIPS ARE BUILT FROM WHAT IS ACTUALLY IN THE LIST, never from the
  // full category list. A chip that filters to nothing is a screen telling a
  // user there is work in a category that is empty today — and on a quiet day
  // that is most of them.
  const present = [...new Set(all.map((x) => x.category).filter(Boolean))] as string[];
  const list = category ? all.filter((x) => x.category === category) : all;

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-brand-ink">{t("tasks.title")}</h1>
          <p className="text-sm text-muted">{t("tasks.subtitle")}</p>
        </div>
      </header>

      <p className="flex gap-2 rounded-xl border border-line bg-brand-tint/50 p-3 text-sm text-muted">
        <InfoIcon size={18} className="mt-0.5 shrink-0 text-brand" />
        {t("tasks.disclosure")}
      </p>

      {/* Surveys (CPX) are the live earner — they pay real points today, while
          the task catalog below may be empty. Lead with them, don't bury them. */}
      <Link href="/surveys" className="block">
        <Card className="flex items-center gap-3 border-brand/30 bg-brand-tint/60 p-4">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand text-white">
            <StarIcon size={24} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-bold text-brand-ink">{t("surveys.title")}</p>
            <p className="text-sm text-muted">{t("surveys.cta")}</p>
          </div>
          <ArrowRightIcon size={22} className="text-brand" />
        </Card>
      </Link>

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
        <EmptyState title={t("tasks.empty.title")} body={t("tasks.empty.body")} />
      ) : (
        <TaskFlow tasks={list} />
      )}
    </div>
  );
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
