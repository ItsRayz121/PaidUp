"use client";

import Link from "next/link";
import { TaskFlow } from "@/components/TaskFlow";
import { Card } from "@/components/ui";
import { Loading, ErrorState, EmptyState } from "@/components/state";
import { InfoIcon, ArrowRightIcon, StarIcon } from "@/components/icons";
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

      {/* Live surveys (CPX). The real earner — always show it above the feed. */}
      <Link href="/surveys" className="block">
        <Card className="flex items-center gap-3 p-4">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent-tint text-accent-ink">
            <StarIcon size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-brand-ink">{t("surveys.title")}</p>
            <p className="text-sm text-muted">{t("surveys.cta")}</p>
          </div>
          <ArrowRightIcon size={22} className="text-brand" />
        </Card>
      </Link>

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
