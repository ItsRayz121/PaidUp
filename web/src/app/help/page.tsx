"use client";

// Help & support — ONE CHAT with RoziPay Official (founder, 2026-09-03).
//
// This screen used to be a ticket system: tap "Ask for help", invent a subject,
// write a message, then find the ticket again in a list of collapsed cards. The
// founder's ask was to make it work the way every messaging app already does —
// "user just come, type the message, get the reply, be happy, and then close
// the chat".
//
// ⚠️ THE TICKETS ARE STILL THERE, UNDERNEATH. A ticket is now an invisible
// SEGMENT of one continuous thread: staff still assign / close / get rated per
// segment, and the internal-note filter still lives on the API. What changed is
// only what the user is asked to do. See the header comment on GET /support/chat.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loading, ErrorState } from "@/components/state";
// The push-notification toggle lives in /profile/settings. It used to sit on
// this screen; a settings card inside a chat is the kind of furniture the
// founder asked to get rid of here.
import { CheckIcon, HelpIcon, ImageIcon, SendIcon, StarIcon, XIcon } from "@/components/icons";
import { useRequireAuth } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import {
  fetchSupportChat, sendSupportChat, closeSupportChat, rateTicket,
  type ChatMessage, type ChatSegment, type TicketRating,
} from "@/lib/api";
import { toTicketImageDataUrl } from "@/lib/imageUpload";

// Poll only while the tab is actually being looked at. A support screen left
// open in a background tab must not keep asking the API for a reply that has
// not come — the same rule the staff queues follow.
const POLL_MS = 15_000;

// ---------------------------------------------------------------------------
// The thread is built by INTERLEAVING messages with the segment boundaries they
// fall between, so a "Chat closed" line lands exactly where the conversation was
// closed rather than being appended to the end.
type Row =
  | { kind: "date"; key: string; label: string }
  | { kind: "msg"; key: string; m: ChatMessage }
  | { kind: "newChat"; key: string; at: string }
  | { kind: "closed"; key: string; segment: ChatSegment };

function dayLabel(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}
function timeLabel(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ⚠️ WALK THE MESSAGES IN TIME ORDER, NEVER SEGMENT BY SEGMENT. Grouping by
// segment looks equivalent and is not: staff can REOPEN a closed ticket
// (PATCH /staff/tickets/:id accepts status "open"), so a reply can land on an
// older conversation after the user has already started a newer one. Iterating
// segments would then render that reply above messages the user sent days
// later, and the running date separator would emit an older date pill below a
// newer one. Time is the only ordering a reader can follow.
function buildRows(segments: ChatSegment[], messages: ChatMessage[]): Row[] {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const ordered = [...messages].sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1);

  const rows: Row[] = [];
  let day = "";
  let prevSeg: string | null = null;
  const closedShown = new Set<string>();

  // Close off the conversation we were in, if it is finished, before moving on.
  const closeOff = (id: string | null) => {
    if (!id || closedShown.has(id)) return;
    const seg = byId.get(id);
    if (seg?.status === "closed") {
      closedShown.add(id);
      rows.push({ kind: "closed", key: `c:${id}`, segment: seg });
    }
  };

  for (const m of ordered) {
    if (m.ticketId !== prevSeg) {
      closeOff(prevSeg);
      // A "New chat" marker only makes sense BETWEEN conversations — the very
      // first one is just the start of the thread.
      if (prevSeg !== null) {
        const seg = byId.get(m.ticketId);
        rows.push({ kind: "newChat", key: `n:${m.ticketId}:${m.id}`, at: seg?.at ?? m.created_at });
      }
      prevSeg = m.ticketId;
    }
    const d = dayLabel(m.created_at);
    if (d !== day) { day = d; rows.push({ kind: "date", key: `d:${m.id}`, label: d }); }
    rows.push({ kind: "msg", key: `m:${m.id}`, m });
  }
  closeOff(prevSeg);
  return rows;
}

// ---------------------------------------------------------------------------
// The thread, loaded once and then kept up to date with a DELTA.
//
// ⚠️ THIS DELIBERATELY DOES NOT USE useApi. That hook replaces its data
// wholesale on every tick, which for this screen means re-downloading every
// message — including every attached photo, as a base64 data URL — once every
// 15 seconds. A user who has sent three screenshots would pull about a megabyte
// a tick, on mobile data, in the markets this app is built for. So: one full
// load, then `?since=<newest message>` for everything after it, merged by id.
function useSupportChat(ready: boolean) {
  const [segments, setSegments] = useState<ChatSegment[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read inside the interval, so the timer never has to be torn down and
  // rebuilt every time a message arrives.
  const sinceRef = useRef<string | null>(null);

  const apply = useCallback((d: Awaited<ReturnType<typeof fetchSupportChat>>) => {
    setSegments(d.segments);
    setMessages((prev) => {
      // `delta` comes from the server, never inferred here — the client must
      // not decide to append a response that was actually a full reload.
      const merged = d.delta ? [...prev, ...d.messages] : d.messages;
      const seen = new Set<string>();
      const out = merged.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
      const newest = out[out.length - 1];
      sinceRef.current = newest ? newest.created_at : sinceRef.current;
      return out;
    });
  }, []);

  // Nothing here sets state before the first await, and `loading` already
  // starts true — so the first paint is the loading state, with no extra render
  // to get there.
  const load = useCallback(async () => {
    try {
      const d = await fetchSupportChat();
      sinceRef.current = null;
      apply(d);
      setLoaded(true);
      setError(null);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [apply]);

  // The retry button — a click, not an effect, so putting the screen back into
  // its loading state here is fine and is what a person expects to see.
  const reload = useCallback(() => {
    setLoading(true); setError(null);
    void load();
  }, [load]);

  // Fetch whatever is new. Also used right after sending, so the message you
  // just sent appears without pulling the whole thread back down.
  const refresh = useCallback(async () => {
    try { apply(await fetchSupportChat(sinceRef.current ?? undefined)); }
    catch (e) { setError((e as Error).message); }
  }, [apply]);

  // The initial fetch. Same shape (and same disable) as useApi's own load
  // effect in lib/hooks.ts: an effect that starts a fetch and settles state
  // when it returns is exactly what the rule's "subscribe to an external
  // system" case describes, but the compiler traces the call and cannot see
  // that every setState is behind an await.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (ready) void load(); }, [ready, load]);

  useEffect(() => {
    if (!ready) return;
    const id = setInterval(() => {
      // Only while the tab is actually being looked at — the same rule the
      // staff queues follow, and the reason two real billing incidents in this
      // codebase are not three.
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [ready, refresh]);

  return { segments, messages, loading, loaded, error, reload, refresh };
}

export default function HelpPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const chat = useSupportChat(ready);

  const [text, setText] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const endRef = useRef<HTMLDivElement | null>(null);
  const { segments, messages } = chat;
  const rows = useMemo(() => buildRows(segments, messages), [segments, messages]);
  // Something to close: an open conversation that has at least one message in
  // it. `segments` is ordered oldest-first, so the live one is the last.
  const hasLiveChat = segments.length > 0
    && segments[segments.length - 1].status !== "closed"
    && messages.some((m) => m.ticketId === segments[segments.length - 1].id);

  // Jump to the newest message whenever the thread grows — on first load and
  // after every send. A chat that opens at the top is a chat you have to scroll
  // before you can read the answer you came for.
  const count = messages.length;
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [count]);

  async function send() {
    const body = text.trim();
    // A photo on its own is a valid message — for most people here a screenshot
    // of the error IS the report. The API agrees (see chatSchema).
    if ((!body && !image) || busy) return;
    setBusy(true); setErr(null);
    try {
      await sendSupportChat(body, image);
      setText(""); setImage(null);
      await chat.refresh();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function pick(file: File | undefined) {
    if (!file) return;
    setErr(null);
    try { setImage(await toTicketImageDataUrl(file)); }
    catch (e) { setErr((e as Error).message); }
  }

  async function closeChat() {
    if (!window.confirm(t("help.closeChatConfirm"))) return;
    setClosing(true); setErr(null);
    try { await closeSupportChat(); await chat.refresh(); }
    catch (e) { setErr((e as Error).message); }
    finally { setClosing(false); }
  }

  if (!ready || chat.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (chat.error && !chat.loaded) {
    return <div className="p-4 pt-6"><ErrorState message={chat.error} onRetry={chat.reload} /></div>;
  }

  return (
    // Exactly the space between the two sticky bars, so the composer holds
    // still and only the messages scroll — a real chat screen, on a phone and
    // on a desktop where the frame is a 480px column.
    <div className="flex h-[calc(100dvh-var(--topbar-h)-var(--bottomnav-h)-env(safe-area-inset-bottom))] flex-col">
      {/* Closing is offered only while there is something to close AND the
          user has actually said something — an empty chat has no conversation
          to end, and offering to close one reads as "go away". */}
      <ChatHeader onClose={hasLiveChat ? closeChat : undefined} closing={closing} />

      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {rows.length === 0 && (
          <p className="mx-auto max-w-[85%] rounded-xl bg-card p-3 text-center text-sm text-muted">
            {t("help.chatEmpty")}
          </p>
        )}
        {rows.map((r) => {
          if (r.kind === "date") return <Pill key={r.key}>{r.label}</Pill>;
          if (r.kind === "newChat") return <Pill key={r.key}>{t("help.newChat")} · {timeLabel(r.at)}</Pill>;
          if (r.kind === "closed") return <ClosedRow key={r.key} segment={r.segment} onRated={chat.refresh} />;
          return <Bubble key={r.key} m={r.m} />;
        })}
        <div ref={endRef} />
      </div>

      {err && <p className="px-3 pb-1 text-xs text-danger">{err}</p>}

      <Composer
        text={text} setText={setText}
        image={image} setImage={setImage} onPick={pick}
        busy={busy} onSend={send}
      />
    </div>
  );
}

// ---- pieces ---------------------------------------------------------------

function ChatHeader({ onClose, closing }: { onClose?: () => void; closing?: boolean }) {
  const { t } = useI18n();
  return (
    <header className="flex items-center gap-3 border-b border-line bg-card px-3 py-2.5">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-tint text-brand">
        <HelpIcon size={20} />
      </span>
      <div className="min-w-0">
        <p className="flex items-center gap-1 font-semibold text-brand-ink">
          {t("help.officialName")}
          {/* The tick says "this is really us" — the one thing a support chat
              has to establish before anyone will send it their problem. */}
          <span className="grid h-4 w-4 place-items-center rounded-full bg-brand text-white">
            <CheckIcon size={10} />
          </span>
        </p>
        <p className="truncate text-xs text-muted">{t("help.officialTagline")}</p>
      </div>
      {onClose && (
        <button type="button" onClick={onClose} disabled={closing}
          className="ms-auto shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-xs font-semibold text-muted disabled:opacity-50">
          {t("help.closeChat")}
        </button>
      )}
    </header>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <p className="mx-auto w-fit rounded-full bg-card px-2.5 py-1 text-[11px] text-muted">{children}</p>
  );
}

function Bubble({ m }: { m: ChatMessage }) {
  const mine = m.author_role === "user";
  return (
    <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
      mine ? "ml-auto rounded-br-md bg-brand text-white" : "mr-auto rounded-bl-md bg-card text-brand-ink"
    }`}>
      <p className="whitespace-pre-wrap break-words">{m.body}</p>
      {m.image && (
        // Already a base64 data: URL from our own API — an <img>, not
        // next/image, which needs a real remote or static source.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={m.image} alt="" className="mt-1.5 max-h-56 w-auto rounded-lg" />
      )}
      <p className={`mt-0.5 text-[11px] ${mine ? "text-white/70" : "text-muted"}`}>
        {timeLabel(m.created_at)}
      </p>
    </div>
  );
}

// The close divider AND, while it has never been rated, the rating row. Both
// belong at the point in the thread where the chat actually closed — a rating
// card pinned to the bottom of the screen would be asking about whichever
// conversation happens to be last.
function ClosedRow({ segment, onRated }: { segment: ChatSegment; onRated: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<TicketRating | null>(null);

  async function rate(r: TicketRating) {
    setBusy(r);
    try { await rateTicket(segment.id, r); onRated(); }
    catch { /* the reload shows the real state either way */ }
    finally { setBusy(null); }
  }

  const options: { value: TicketRating; label: string; cls: string }[] = [
    { value: "bad", label: t("help.rateBad"), cls: "border-danger/40 text-danger" },
    { value: "okay", label: t("help.rateOkay"), cls: "border-line-strong text-muted" },
    { value: "great", label: t("help.rateGreat"), cls: "border-success/40 text-success" },
  ];

  return (
    <div className="space-y-2 py-1">
      <div className="flex items-center gap-2 text-[11px] text-muted">
        <span className="h-px flex-1 bg-line" aria-hidden />
        {t("help.chatClosed")}{segment.closedAt ? ` · ${timeLabel(segment.closedAt)}` : ""}
        <span className="h-px flex-1 bg-line" aria-hidden />
      </div>
      {segment.rating ? (
        <p className="text-center text-[11px] text-muted">{t("help.rateThanks")}</p>
      ) : (
        <div className="rounded-xl border border-line bg-card p-2.5">
          <p className="mb-1.5 text-center text-xs font-semibold text-brand-ink">{t("help.howWasSupport")}</p>
          <div className="flex gap-2">
            {options.map((o) => (
              <button key={o.value} onClick={() => rate(o.value)} disabled={busy !== null}
                className={`flex flex-1 items-center justify-center gap-1 rounded-lg border-2 py-1.5 text-xs font-semibold disabled:opacity-50 ${o.cls}`}>
                <StarIcon size={14} /> {busy === o.value ? "…" : o.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Composer({ text, setText, image, setImage, onPick, busy, onSend }: {
  text: string; setText: (v: string) => void;
  image: string | null; setImage: (v: string | null) => void;
  onPick: (f: File | undefined) => void;
  busy: boolean; onSend: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="border-t border-line bg-card px-2.5 py-2">
      {image && (
        <div className="mb-1.5 flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image} alt="" className="h-12 w-12 rounded-lg object-cover" />
          <span className="text-xs text-muted">{t("help.photoAttached")}</span>
          <button type="button" onClick={() => setImage(null)} disabled={busy}
            className="rounded-full bg-brand-tint p-1 text-brand disabled:opacity-50">
            <XIcon size={13} />
          </button>
        </div>
      )}
      <div className="flex items-end gap-2">
        <label className="grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-full bg-brand-tint text-brand"
          title={t("help.attachPhoto")}>
          <ImageIcon size={18} />
          <input type="file" accept="image/*" className="hidden" disabled={busy}
            onChange={(e) => onPick(e.target.files?.[0])} />
        </label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends on a real keyboard; Shift+Enter is a newline. On a
            // phone the on-screen Enter key reports shiftKey false too, which is
            // why the send button is always there — this is the shortcut, not
            // the only way.
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); }
          }}
          rows={1}
          placeholder={t("help.typeMessage")}
          className="max-h-28 min-h-[40px] flex-1 resize-none rounded-2xl border border-line bg-bg px-3 py-2.5 text-sm text-brand-ink outline-none placeholder:text-muted/60"
        />
        <button
          type="button" onClick={onSend} disabled={(!text.trim() && !image) || busy}
          aria-label={t("help.send")}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand text-white disabled:opacity-40">
          <SendIcon size={18} />
        </button>
      </div>
    </div>
  );
}
