"use client";

// Real surveys, served by the CPX Research survey wall. The wall itself is
// rendered in an iframe whose URL is SIGNED by our backend for this specific
// user — the browser never sees the app secret. Points are credited only when
// CPX sends us a verified server-to-server postback (guardrail #1), never from
// anything that happens on this page.
import Link from "next/link";
import { Loading, ErrorState, EmptyState } from "@/components/state";
import { InfoIcon, ArrowRightIcon } from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchSurveyWall } from "@/lib/api";

export default function SurveysPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const wall = useApi(fetchSurveyWall, []);

  if (!ready || wall.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (wall.error) return <div className="p-4 pt-6"><ErrorState message={wall.error} onRetry={wall.reload} /></div>;

  const url = wall.data?.url;

  return (
    <div className="pb-8">
      <header className="flex items-center gap-2 px-4 pt-5 pb-3">
        <Link href="/tasks" aria-label="Back" className="text-brand">
          <ArrowRightIcon size={22} className="rotate-180" />
        </Link>
        <div>
          <h1 className="text-xl font-bold text-brand-ink">{t("surveys.title")}</h1>
          <p className="text-sm text-muted">{t("surveys.subtitle")}</p>
        </div>
      </header>

      {/* Sponsored disclosure BEFORE the user starts (guardrail #3). */}
      <p className="mx-4 mb-3 flex gap-2 rounded-xl border border-line bg-brand-tint/50 p-3 text-sm text-muted">
        <InfoIcon size={18} className="mt-0.5 shrink-0 text-brand" />
        {t("surveys.disclosure")}
      </p>

      {!wall.data?.enabled || !url ? (
        <div className="px-4">
          <EmptyState title={t("surveys.offTitle")} body={t("surveys.offBody")} />
        </div>
      ) : (
        // Tall iframe that the page scrolls — CPX's own recommended pattern.
        <iframe
          src={url}
          title={t("surveys.title")}
          height={1800}
          className="w-full border-0"
          // Third-party survey content needs its own JS, forms and navigation.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer-when-downgrade"
        />
      )}
    </div>
  );
}
