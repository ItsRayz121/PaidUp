"use client";

import { useState } from "react";
import { Card, Button } from "@/components/ui";
import { Loading, ErrorState, EmptyState } from "@/components/state";
import { HelpIcon, CheckIcon, ClockIcon, ShieldIcon } from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchMyTickets, createTicket, replyToMyTicket, type MyTicket } from "@/lib/api";
import { timeAgo } from "@/lib/format";

const inputClass =
  "w-full rounded-xl border border-line bg-card p-3 text-brand-ink outline-none placeholder:text-muted/60";

export default function HelpPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const tickets = useApi(fetchMyTickets, []);
  const [asking, setAsking] = useState(false);

  if (!ready || tickets.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (tickets.error) return <div className="p-4 pt-6"><ErrorState message={tickets.error} onRetry={tickets.reload} /></div>;

  const list = tickets.data?.tickets ?? [];

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header>
        <h1 className="text-xl font-bold text-brand-ink">{t("help.title")}</h1>
        <p className="text-sm text-muted">{t("help.subtitle")}</p>
      </header>

      {!asking && (
        <Button variant="primary" onClick={() => setAsking(true)}>
          <HelpIcon size={18} /> {t("help.askForHelp")}
        </Button>
      )}

      {asking && <NewTicket onDone={() => { setAsking(false); tickets.reload(); }} onCancel={() => setAsking(false)} />}

      {list.length === 0 && !asking ? (
        <EmptyState
          title={t("help.noQuestionsTitle")}
          body={t("help.noQuestionsBody")}
        />
      ) : (
        <section className="space-y-3">
          {list.map((t) => <TicketCard key={t.id} ticket={t} onReplied={tickets.reload} />)}
        </section>
      )}

      <Card className="flex items-center gap-3 bg-brand-tint p-4">
        <ShieldIcon size={20} className="shrink-0 text-brand" />
        <p className="text-sm text-brand-ink">{t("help.pointsNote")}</p>
      </Card>
    </div>
  );
}

function TicketStatus({ status }: { status: MyTicket["status"] }) {
  const { t } = useI18n();
  const map = {
    open: { label: t("help.statusWaiting"), Icon: ClockIcon, cls: "bg-pending-tint text-pending" },
    answered: { label: t("help.statusReplied"), Icon: CheckIcon, cls: "bg-success-tint text-success" },
    closed: { label: t("help.statusClosed"), Icon: CheckIcon, cls: "bg-brand-tint text-brand" },
  }[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${map.cls}`}>
      <map.Icon size={14} /> {map.label}
    </span>
  );
}

function TicketCard({ ticket, onReplied }: { ticket: MyTicket; onReplied: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send() {
    setBusy(true); setErr(null);
    try { await replyToMyTicket(ticket.id, reply.trim()); setReply(""); onReplied(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Card className="overflow-hidden">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-3 p-4 text-left">
        <div className="min-w-0">
          <p className="truncate font-semibold text-brand-ink">{ticket.subject}</p>
          <p className="text-xs text-muted">{t("help.lastUpdate", { time: timeAgo(ticket.updatedAt) })}</p>
        </div>
        <TicketStatus status={ticket.status} />
      </button>

      {open && (
        <div className="border-t border-line p-4 space-y-3">
          <div className="space-y-2">
            {ticket.messages.map((m, i) => (
              <div key={i} className={`max-w-[85%] rounded-xl p-2.5 text-sm ${
                m.author_role === "user" ? "ml-auto bg-brand text-white" : "bg-brand-tint text-brand-ink"
              }`}>
                <p className="whitespace-pre-wrap">{m.body}</p>
                <p className={`mt-1 text-[11px] ${m.author_role === "user" ? "text-white/70" : "text-muted"}`}>
                  {m.author_role === "user" ? t("help.you") : t("help.support")} · {timeAgo(m.created_at)}
                </p>
              </div>
            ))}
          </div>

          {ticket.status !== "closed" && (
            <div className="space-y-2">
              <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={2}
                placeholder={t("help.writeReply")} className={inputClass} />
              {err && <p className="text-sm text-danger">{err}</p>}
              <Button variant="ghost" size="md" full={false} disabled={!reply.trim() || busy} onClick={send}>
                {busy ? t("help.sending") : t("help.sendReply")}
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function NewTicket({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setErr(null);
    try { await createTicket(subject.trim(), message.trim()); onDone(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Card className="p-4 space-y-3">
      <p className="font-semibold text-brand-ink">{t("help.whatHelp")}</p>
      <input value={subject} onChange={(e) => setSubject(e.target.value)}
        placeholder={t("help.subjectPlaceholder")} className={inputClass} maxLength={120} />
      <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4}
        placeholder={t("help.messagePlaceholder")} className={inputClass} maxLength={2000} />
      {err && <p className="text-sm text-danger">{err}</p>}
      <div className="flex gap-2.5">
        <Button variant="ghost" size="md" onClick={onCancel}>{t("common.cancel")}</Button>
        <Button variant="primary" size="md" disabled={!subject.trim() || !message.trim() || busy} onClick={submit}>
          {busy ? t("help.sending") : t("help.send")}
        </Button>
      </div>
    </Card>
  );
}
