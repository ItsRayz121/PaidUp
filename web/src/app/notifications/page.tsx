"use client";

// My messages (brief part 39).
//
// This is the inbox that staff announcements land in. It exists so an
// announcement does NOT have to be a push notification: a browser push is
// revoked once and permanently by an annoyed user, and the message it exists
// for is "your withdrawal was paid" (api/src/notify.ts).
//
// ⚠️ EVERY WORD ON A CARD HERE WAS TYPED BY A STAFF MEMBER AND REVIEWED BY
// NOBODY. So the fixed copy around it stays strictly descriptive, and the cards
// render as plain text — no markup is interpreted, and the link is whatever the
// API allowed, which is an internal path only.
import Link from "next/link";
import { useEffect } from "react";
import { Card } from "@/components/ui";
import { Loading, ErrorState, EmptyState } from "@/components/state";
import { ArrowRightIcon } from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchNotifications, markNotificationsRead } from "@/lib/api";
import { timeAgo } from "@/lib/format";

export default function NotificationsPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const inbox = useApi(fetchNotifications, []);
  const unread = inbox.data?.unread ?? 0;

  // Opening the inbox IS reading it. Marking read on arrival is what stops the
  // badge from following someone around after they have already looked —
  // which teaches people to ignore it, and then the one message that mattered
  // is ignored too. Fire-and-forget: a failed mark must not break the list.
  useEffect(() => {
    if (unread > 0) void markNotificationsRead().catch(() => {});
  }, [unread]);

  if (!ready || inbox.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (inbox.error) {
    return <div className="p-4 pt-6"><ErrorState message={inbox.error} onRetry={inbox.reload} /></div>;
  }

  const list = inbox.data?.notifications ?? [];

  return (
    <div className="space-y-5 px-4 pt-5 pb-8">
      <header>
        <h1 className="text-xl font-bold text-brand-ink">{t("inbox.title")}</h1>
        <p className="text-sm text-muted">{t("inbox.subtitle")}</p>
      </header>

      {list.length === 0 ? (
        <EmptyState title={t("inbox.emptyTitle")} body={t("inbox.emptyBody")} />
      ) : (
        <section className="space-y-3">
          {list.map((item) => {
            const body = (
              <>
                <div className="flex items-start justify-between gap-3">
                  <p className="font-semibold text-brand-ink">{item.title}</p>
                  {!item.read && (
                    <span className="shrink-0 rounded-full bg-brand px-2 py-0.5 text-[11px] font-semibold text-white">
                      {t("inbox.new")}
                    </span>
                  )}
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{item.body}</p>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-xs text-muted">{timeAgo(item.at)}</span>
                  {item.url && (
                    <span className="flex items-center gap-1 text-sm font-semibold text-brand">
                      {t("inbox.open")} <ArrowRightIcon size={16} />
                    </span>
                  )}
                </div>
              </>
            );
            return item.url
              ? <Link key={item.id} href={item.url} className="block"><Card className="p-4">{body}</Card></Link>
              : <Card key={item.id} className="p-4">{body}</Card>;
          })}
        </section>
      )}
    </div>
  );
}
