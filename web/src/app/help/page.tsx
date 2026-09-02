"use client";

import { useState } from "react";
import { Card, Button } from "@/components/ui";
import { Loading, ErrorState, EmptyState } from "@/components/state";
import { NotificationsCard } from "@/components/NotificationsCard";
import { HelpIcon, CheckIcon, ClockIcon, ShieldIcon, StarIcon, ImageIcon, XIcon } from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchMyTickets, createTicket, replyToMyTicket, rateTicket, type MyTicket, type TicketRating } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { toTicketImageDataUrl } from "@/lib/imageUpload";

// A picker button + a preview strip, shared by the new-ticket form and every
// reply box on this page (founder, 2026-09-02: "upload of the images, so
// that on both sides"). One image per message — matches the API, which
// stores exactly one `image` column per ticket_messages row.
function PhotoPicker({ image, onChange, disabled }: {
  image: string | null; onChange: (v: string | null) => void; disabled?: boolean;
}) {
  const { t } = useI18n();
  const [err, setErr] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setErr(null);
    try { onChange(await toTicketImageDataUrl(file)); }
    catch (e) { setErr((e as Error).message); }
  }

  if (image) {
    return (
      <div className="flex items-center gap-2">
        {/* Already a base64 data: URL — an <img>, not next/image, which needs
            a real remote/static source, not an in-memory blob. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={image} alt="" className="h-14 w-14 rounded-lg object-cover" />
        <span className="text-xs text-muted">{t("help.photoAttached")}</span>
        <button type="button" onClick={() => onChange(null)} disabled={disabled}
          className="rounded-full bg-brand-tint p-1 text-brand disabled:opacity-50">
          <XIcon size={14} />
        </button>
      </div>
    );
  }
  return (
    <div>
      <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-semibold text-brand ${disabled ? "opacity-50" : ""}`}>
        <ImageIcon size={15} /> {t("help.attachPhoto")}
        <input type="file" accept="image/*" className="hidden" disabled={disabled}
          onChange={(e) => pick(e.target.files?.[0])} />
      </label>
      {err && <p className="mt-1 text-xs text-danger">{err}</p>}
    </div>
  );
}

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

      {/* Turn notifications on/off — the founder's "settings" home for it. */}
      <NotificationsCard />

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
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send() {
    setBusy(true); setErr(null);
    try { await replyToMyTicket(ticket.id, reply.trim(), image); setReply(""); setImage(null); onReplied(); }
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
                {m.image && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.image} alt="" className="mt-1.5 max-h-56 w-auto rounded-lg" />
                )}
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
              <PhotoPicker image={image} onChange={setImage} disabled={busy} />
              {err && <p className="text-sm text-danger">{err}</p>}
              <Button variant="ghost" size="md" full={false} disabled={!reply.trim() || busy} onClick={send}>
                {busy ? t("help.sending") : t("help.sendReply")}
              </Button>
            </div>
          )}

          {ticket.status === "closed" && <RatingPrompt ticket={ticket} onRated={onReplied} />}
        </div>
      )}
    </Card>
  );
}

// "How was our support?" — shown once a ticket closes, until rated (founder,
// 2026-09-02). One tap, one rating, ever — the API refuses a second one, and
// this component just stops offering the buttons once `ticket.rating` comes
// back non-null on the next reload.
function RatingPrompt({ ticket, onRated }: { ticket: MyTicket; onRated: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<TicketRating | null>(null);

  if (ticket.rating) {
    return <p className="text-sm text-muted">{t("help.rateThanks")}</p>;
  }

  async function rate(r: TicketRating) {
    setBusy(r);
    try { await rateTicket(ticket.id, r); onRated(); }
    catch { /* the reload will show the current state either way */ }
    finally { setBusy(null); }
  }

  const options: { value: TicketRating; label: string; cls: string }[] = [
    { value: "bad", label: t("help.rateBad"), cls: "border-danger/40 text-danger" },
    { value: "okay", label: t("help.rateOkay"), cls: "border-line-strong text-muted" },
    { value: "great", label: t("help.rateGreat"), cls: "border-success/40 text-success" },
  ];

  return (
    <div className="space-y-1.5">
      <p className="text-sm font-semibold text-brand-ink">{t("help.howWasSupport")}</p>
      <div className="flex gap-2">
        {options.map((o) => (
          <button key={o.value} onClick={() => rate(o.value)} disabled={busy !== null}
            className={`flex flex-1 items-center justify-center gap-1 rounded-xl border-2 py-2 text-sm font-semibold disabled:opacity-50 ${o.cls}`}>
            <StarIcon size={16} /> {busy === o.value ? "…" : o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function NewTicket({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setErr(null);
    try { await createTicket(subject.trim(), message.trim(), image); onDone(); }
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
      <PhotoPicker image={image} onChange={setImage} disabled={busy} />
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
