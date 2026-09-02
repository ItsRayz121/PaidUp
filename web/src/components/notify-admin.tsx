"use client";

// Staff notifications (brief part 39) and home content (part 43).
//
// ⚠️ THESE TWO SCREENS PUT WORDS IN FRONT OF EVERY USER WITH NO REVIEW STEP.
// Everything else in /staff changes a number; this changes what the product
// SAYS. So both compose forms show the copy rules where the text is typed, and
// both preview the result rather than describing it — the fastest way to write
// a bad announcement is to never see it the way a user will.

import { useState } from "react";
import { useApi } from "@/lib/hooks";
import {
  fetchNotifyAdmin, sendBroadcast, editBroadcast, pauseBroadcast, resumeBroadcast, deleteBroadcast,
  fetchContentAdmin, createContentBlock, updateContentBlock, deleteContentBlock,
  type ContentBlock, type Broadcast,
} from "@/lib/api";
import { StatusBadge, TimeCell, DateField } from "@/components/staff/primitives";
import { useToast } from "@/components/staff/toast";

const n = (v: number) => v.toLocaleString("en-US");

// ---- Broadcasts -------------------------------------------------------------

export function BroadcastPanel() {
  const data = useApi(fetchNotifyAdmin, []);
  const [audience, setAudience] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [alsoPush, setAlsoPush] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const d = data.data;
  const picked = d?.audiences.find((a) => a.id === audience);

  async function send() {
    if (!picked) return;
    // A broadcast cannot be recalled. The confirmation names the audience SIZE,
    // because "Everyone" and "12,400 people" land very differently on the
    // person about to click.
    const ok = window.confirm(
      `Send to ${picked.label} — ${n(picked.size)} people?\n\n` +
      `"${title}"\n${body}\n\n` +
      (alsoPush ? "This WILL also buzz their phone.\n\n" : "") +
      "This cannot be undone.",
    );
    if (!ok) return;
    const link = url.trim();
    if (link && !link.startsWith("/")) {
      setMsg("The link must start with “/” — a message can only open a screen inside the app.");
      return;
    }
    setSending(true);
    setMsg(null);
    try {
      const res = await sendBroadcast({
        audience, title: title.trim(), body: body.trim(),
        url: link || null, alsoPush,
      });
      setTitle(""); setBody(""); setUrl(""); setAlsoPush(false);
      data.reload();
      setMsg(`Sent to ${n(res.recipients)} inbox(es).`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  if (data.loading) return <p className="p-4 text-sm text-muted">Loading…</p>;
  if (data.error || !d) return <p className="p-4 text-sm text-danger">{data.error}</p>;

  return (
    <div className="space-y-5">
      <div className="rounded-lg border-2 border-line-strong bg-card p-3">
        <h3 className="font-bold text-brand-ink">Send a message</h3>
        <p className="mt-1 text-xs text-muted">
          A one-off message to a chosen group of users. It lands in the app&apos;s <strong>inbox</strong>,
          where nothing interrupts anyone; ticking &ldquo;also buzz their phone&rdquo; sends a push
          notification on top. It is sent <strong>immediately and cannot be recalled</strong>. Plain,
          everyday English only — never promise money, a date or a price.
        </p>

        <div className="mt-3">
          <p className="mb-1.5 text-xs font-semibold uppercase text-muted">Who gets it</p>
          <div className="grid gap-1.5 sm:grid-cols-3">
            {d.audiences.map((a) => (
              <button key={a.id} onClick={() => setAudience(a.id)}
                className={`rounded-lg border p-2 text-left text-xs ${
                  audience === a.id ? "border-brand bg-brand-tint" : "border-line"
                }`}>
                <span className="block font-semibold text-brand-ink">{a.label}</span>
                <span className="block text-muted">{a.note}</span>
                <span className="num mt-0.5 block font-semibold text-brand">{n(a.size)} people</span>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3 space-y-2">
          <label className="block text-xs">
            <span className="text-muted">Title (short — this is the whole message on a small screen)</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80}
              className="mt-0.5 w-full rounded-md border border-line bg-card px-2 py-1.5 text-sm" />
          </label>
          <label className="block text-xs">
            <span className="text-muted">Message</span>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={500}
              className="mt-0.5 w-full rounded-md border border-line bg-card px-2 py-1.5 text-sm" />
          </label>
          <label className="block text-xs">
            {/* The API refuses anything else. Stated here so nobody types a
                Telegram link, gets a 400 and assumes the field is broken. */}
            <span className="text-muted">
              Where tapping it goes — <strong>inside the app only</strong>, e.g. <code>/wallet</code>
            </span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="/wallet"
              className="mt-0.5 w-full rounded-md border border-line bg-card px-2 py-1.5 font-mono text-sm" />
          </label>
        </div>

        {/* ⚠️ THE PUSH TICK BOX, AND WHY IT IS OFF BY DEFAULT. */}
        <div className="mt-3 rounded-lg border border-line p-2.5">
          <label className={`flex items-start gap-2 text-xs ${d.pushAvailable ? "" : "opacity-50"}`}>
            <input type="checkbox" checked={alsoPush} disabled={!d.pushAvailable}
              onChange={(e) => setAlsoPush(e.target.checked)} className="mt-0.5" />
            <span>
              <strong className="text-brand-ink">Also buzz their phone</strong>
              <span className="block text-muted">
                A push notification is revoked <strong>once and permanently</strong> by an annoyed
                user — and the message it exists for is &ldquo;your withdrawal was paid&rdquo;. Spend it
                on something that matters, not on an announcement.
                {!d.pushAvailable && " (Push is not set up on this server, so this does nothing.)"}
              </span>
            </span>
          </label>
        </div>

        {(title || body) && (
          <div className="mt-3">
            <p className="mb-1 text-xs font-semibold uppercase text-muted">What they will see</p>
            <div className="rounded-lg border border-line bg-brand-tint/30 p-2.5">
              <p className="text-sm font-semibold text-brand-ink">{title || "(no title yet)"}</p>
              <p className="text-sm text-muted">{body || "(no message yet)"}</p>
            </div>
          </div>
        )}

        {msg && <p className="mt-2 rounded-md border-2 border-line-strong p-2 text-xs text-brand-ink">{msg}</p>}

        {/* Say exactly what is still missing — the founder read a greyed-out
            button as "there is no send option" (2026-09-02). */}
        {(() => {
          const missing: string[] = [];
          if (!audience) missing.push("choose who gets it above");
          if (!title.trim()) missing.push("add a title");
          if (!body.trim()) missing.push("add a message");
          return missing.length > 0 ? (
            <p className="mt-3 text-xs text-pending">Still to do: {missing.join(" · ")}.</p>
          ) : null;
        })()}

        <button onClick={send} disabled={!audience || !title.trim() || !body.trim() || sending}
          className="mt-2 rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {sending ? "Sending…" : picked ? `Send to ${n(picked.size)} people` : "Send message"}
        </button>
      </div>

      <div className="rounded-lg border-2 border-line-strong bg-card p-3">
        <h3 className="font-bold text-brand-ink">Already sent</h3>
        {d.history.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Nothing has been sent yet.</p>
        ) : (
          <div className="mt-2 space-y-2">
            {d.history.map((h) => <SentRow key={h.id} h={h} onChange={data.reload} />)}
          </div>
        )}
      </div>
    </div>
  );
}

// One "already sent" row — read-only by default, with Edit / Pause·Resume /
// Delete (founder, 2026-09-02). Edit corrects the wording everywhere it
// already landed; Pause hides it from every inbox without losing the send
// record (Resume brings it back — the message is "retrieved"); Delete is the
// same hide, permanent, and the row stays here with a Deleted badge so the
// send is still on the record.
function SentRow({ h, onChange }: { h: Broadcast; onChange: () => void }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(h.title);
  const [body, setBody] = useState(h.body);
  const [url, setUrl] = useState(h.url ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!title.trim() || !body.trim()) return;
    setBusy(true);
    try {
      await editBroadcast(h.id, { title: title.trim(), body: body.trim(), url: url.trim() || null });
      toast.ok("Message updated.");
      setEditing(false);
      onChange();
    } catch (e) { toast.err((e as Error).message); }
    finally { setBusy(false); }
  }

  async function togglePause() {
    setBusy(true);
    try {
      await (h.paused ? resumeBroadcast(h.id) : pauseBroadcast(h.id));
      toast.ok(h.paused ? "Message brought back." : "Message paused — hidden from every inbox.");
      onChange();
    } catch (e) { toast.err((e as Error).message); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!window.confirm(`Delete "${h.title}"?\n\nIt disappears from every inbox that already has it. This cannot be undone.`)) return;
    setBusy(true);
    try { await deleteBroadcast(h.id); toast.ok("Message deleted."); onChange(); }
    catch (e) { toast.err((e as Error).message); }
    finally { setBusy(false); }
  }

  if (editing) {
    return (
      <div className="rounded-lg border-2 border-brand/40 bg-brand-tint/20 p-2 text-xs">
        <label className="block">
          <span className="text-muted">Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80}
            className="mt-0.5 w-full rounded-md border border-line bg-card px-2 py-1.5 text-sm" />
        </label>
        <label className="mt-1.5 block">
          <span className="text-muted">Message</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} maxLength={500}
            className="mt-0.5 w-full rounded-md border border-line bg-card px-2 py-1.5 text-sm" />
        </label>
        <label className="mt-1.5 block">
          <span className="text-muted">Where tapping it goes</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="/wallet"
            className="mt-0.5 w-full rounded-md border border-line bg-card px-2 py-1.5 font-mono text-sm" />
        </label>
        <div className="mt-2 flex gap-1.5">
          <button onClick={save} disabled={busy || !title.trim() || !body.trim()}
            className="rounded-md bg-brand px-2.5 py-1 font-semibold text-white disabled:opacity-50">
            {busy ? "Saving…" : "Save"}
          </button>
          <button onClick={() => { setEditing(false); setTitle(h.title); setBody(h.body); setUrl(h.url ?? ""); }}
            disabled={busy} className="rounded-md border border-line-strong px-2.5 py-1 font-semibold text-muted">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`rounded-lg border border-line p-2 text-xs ${h.deleted ? "opacity-50" : ""}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold text-brand-ink">{h.title}</span>
        <span className="shrink-0"><TimeCell iso={h.at} /></span>
      </div>
      <p className="text-muted">{h.body}</p>
      <p className="mt-1 text-muted">
        {h.audience} · <span className="num">{n(h.recipients)}</span> people
        {h.pushed && <span className="ms-1 rounded bg-pending-tint px-1 text-pending">pushed</span>}
        {h.paused && !h.deleted && <span className="ms-1 rounded bg-pending-tint px-1 text-pending">paused</span>}
        {h.deleted && <span className="ms-1 rounded bg-danger-tint px-1 text-danger">deleted</span>}
        {h.updatedAt && <span className="ms-1 rounded bg-brand-tint px-1 text-brand">edited</span>}
        {" · "}{h.sentBy}
      </p>
      {!h.deleted && (
        <div className="mt-1.5 flex gap-1.5">
          <button onClick={() => setEditing(true)} disabled={busy}
            className="rounded border border-line-strong px-2 py-0.5 font-semibold text-brand disabled:opacity-50">
            Edit
          </button>
          <button onClick={togglePause} disabled={busy}
            className="rounded border border-line-strong px-2 py-0.5 font-semibold text-brand disabled:opacity-50">
            {h.paused ? "Resume" : "Pause"}
          </button>
          <button onClick={remove} disabled={busy}
            className="rounded border border-line-strong px-2 py-0.5 font-semibold text-danger disabled:opacity-50">
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Home content -----------------------------------------------------------

const EMPTY = {
  title: "", body: "", icon: "info", linkUrl: "", linkLabel: "",
  tone: "info", status: "draft", startsAt: "", endsAt: "", sort: 0,
};

export function ContentPanel() {
  const data = useApi(fetchContentAdmin, []);
  const [form, setForm] = useState<Record<string, string | number>>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const set = (k: string, v: string | number) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    const payload = {
      title: String(form.title).trim(),
      body: String(form.body).trim(),
      icon: form.icon,
      linkUrl: String(form.linkUrl).trim() || null,
      linkLabel: String(form.linkLabel).trim() || null,
      tone: form.tone,
      status: form.status,
      startsAt: String(form.startsAt).trim() || null,
      endsAt: String(form.endsAt).trim() || null,
      sort: Number(form.sort) || 0,
    };
    try {
      if (editing) await updateContentBlock(editing, payload);
      else await createContentBlock(payload);
      setForm(EMPTY);
      setEditing(null);
      data.reload();
      setMsg(null);
    } catch (e) { setMsg((e as Error).message); }
  }

  async function toggle(b: ContentBlock) {
    try {
      await updateContentBlock(b.id, { status: b.status === "live" ? "draft" : "live" });
      data.reload();
    } catch (e) { setMsg((e as Error).message); }
  }

  async function remove(b: ContentBlock) {
    if (!window.confirm(`Delete "${b.title}"? This cannot be undone.`)) return;
    try { await deleteContentBlock(b.id); data.reload(); } catch (e) { setMsg((e as Error).message); }
  }

  function edit(b: ContentBlock) {
    setEditing(b.id);
    setForm({
      title: b.title, body: b.body, icon: b.icon,
      linkUrl: b.linkUrl ?? "", linkLabel: b.linkLabel ?? "",
      tone: b.tone, status: b.status,
      startsAt: b.startsAt ?? "", endsAt: b.endsAt ?? "", sort: b.sort,
    });
  }

  if (data.loading) return <p className="p-4 text-sm text-muted">Loading…</p>;
  if (data.error || !data.data) return <p className="p-4 text-sm text-danger">{data.error}</p>;

  return (
    <div className="space-y-5">
      <div className="rounded-lg border-2 border-line-strong bg-card p-3">
        <h3 className="font-bold text-brand-ink">{editing ? "Edit card" : "New home card"}</h3>
        <p className="mt-1 text-xs text-muted">
          A dismissible card at the top of every user&apos;s home screen — a tone colour, an optional
          button that deep-links inside the app, and an optional show-from / hide-after window. Unlike
          a message, it stays on screen until the user dismisses it. Keep it short and plain.
          {/* The two rules the road map keeps, restated where the text is typed. */}
          {" "}<strong>Never state a price for ROZI, and never give a date we have not met.</strong>
        </p>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="text-xs">
            <span className="text-muted">Title</span>
            <input value={String(form.title)} onChange={(e) => set("title", e.target.value)} maxLength={80}
              className="mt-0.5 w-full rounded-md border border-line bg-card px-2 py-1.5 text-sm" />
          </label>
          <label className="text-xs">
            <span className="text-muted">Icon</span>
            <select value={String(form.icon)} onChange={(e) => set("icon", e.target.value)}
              className="mt-0.5 w-full rounded-md border border-line bg-card px-2 py-1.5 text-sm">
              {data.data.icons.map((i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </label>
          <label className="text-xs sm:col-span-2">
            <span className="text-muted">Message</span>
            <textarea value={String(form.body)} onChange={(e) => set("body", e.target.value)} rows={2} maxLength={400}
              className="mt-0.5 w-full rounded-md border border-line bg-card px-2 py-1.5 text-sm" />
          </label>
          <label className="text-xs">
            <span className="text-muted">Link — /path inside the app, or https://…</span>
            <input value={String(form.linkUrl)} onChange={(e) => set("linkUrl", e.target.value)}
              placeholder="/mine" className="mt-0.5 w-full rounded-md border border-line bg-card px-2 py-1.5 font-mono text-sm" />
          </label>
          <label className="text-xs">
            <span className="text-muted">Button text</span>
            <input value={String(form.linkLabel)} onChange={(e) => set("linkLabel", e.target.value)}
              placeholder="Start mining" className="mt-0.5 w-full rounded-md border border-line bg-card px-2 py-1.5 text-sm" />
          </label>
          <label className="text-xs">
            <span className="text-muted">Colour</span>
            <select value={String(form.tone)} onChange={(e) => set("tone", e.target.value)}
              className="mt-0.5 w-full rounded-md border border-line bg-card px-2 py-1.5 text-sm">
              <option value="info">Normal</option>
              <option value="good">Good news</option>
              <option value="warn">Heads up</option>
            </select>
          </label>
          <label className="text-xs">
            <span className="text-muted">Order (smaller shows first)</span>
            <input type="number" value={Number(form.sort)} onChange={(e) => set("sort", Number(e.target.value))}
              className="mt-0.5 w-full rounded-md border border-line bg-card px-2 py-1.5 font-mono text-sm" />
          </label>
          {/* Optional window. Left blank, a card is live the moment it is
              switched on and stays until it is switched off. Native date
              picker — pick a day, done (founder, 2026-09-02). */}
          <DateField label="Show from (optional)" value={String(form.startsAt).slice(0, 10)}
            onChange={(v) => set("startsAt", v)} hint="Blank = live as soon as it's switched on" />
          <DateField label="Hide after (optional)" value={String(form.endsAt).slice(0, 10)}
            onChange={(v) => set("endsAt", v)} hint="Blank = stays until you switch it off" />
        </div>

        {(form.title || form.body) && (
          <div className="mt-3">
            <p className="mb-1 text-xs font-semibold uppercase text-muted">What they will see</p>
            <div className={`rounded-lg border p-2.5 ${
              form.tone === "good" ? "border-success/40 bg-success-tint/40"
                : form.tone === "warn" ? "border-pending/40 bg-pending-tint/40"
                : "border-line bg-brand-tint/30"
            }`}>
              <p className="text-sm font-semibold text-brand-ink">{String(form.title) || "(no title yet)"}</p>
              <p className="text-sm text-muted">{String(form.body)}</p>
              {form.linkLabel && (
                <p className="mt-1 text-sm font-semibold text-brand">{String(form.linkLabel)} →</p>
              )}
            </div>
          </div>
        )}

        {msg && <p className="mt-2 rounded-md bg-danger-tint p-2 text-xs text-danger">{msg}</p>}

        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={save} disabled={!String(form.title).trim() || !String(form.body).trim()}
            className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            {editing ? "Save changes" : "Create (as draft)"}
          </button>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={form.status === "live"}
              onChange={(e) => set("status", e.target.checked ? "live" : "draft")} />
            Show it to users now
          </label>
          {editing && (
            <button onClick={() => { setEditing(null); setForm(EMPTY); }}
              className="rounded-md bg-brand-tint px-3 py-1.5 text-xs font-semibold text-brand">Cancel</button>
          )}
        </div>
      </div>

      <div className="rounded-lg border-2 border-line-strong bg-card p-3">
        <h3 className="font-bold text-brand-ink">Cards</h3>
        {data.data.blocks.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No cards yet. The home screen shows none.</p>
        ) : (
          <div className="mt-2 space-y-2">
            {data.data.blocks.map((b) => (
              <div key={b.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-line p-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-brand-ink">
                    {b.title} <StatusBadge status={b.status} />
                  </p>
                  <p className="text-xs text-muted">{b.body}</p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    {b.icon} · order {b.sort}
                    {b.linkUrl && <> · {b.linkUrl}</>}
                    {(b.startsAt || b.endsAt) && (
                      <> · {b.startsAt?.slice(0, 10) ?? "now"} → {b.endsAt?.slice(0, 10) ?? "no end"}</>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button onClick={() => toggle(b)}
                    className="rounded bg-brand-tint px-2 py-0.5 text-[10px] font-semibold text-brand">
                    {b.status === "live" ? "Hide" : "Show"}
                  </button>
                  <button onClick={() => edit(b)}
                    className="rounded bg-brand-tint px-2 py-0.5 text-[10px] font-semibold text-brand">Edit</button>
                  <button onClick={() => remove(b)}
                    className="rounded bg-danger-tint px-2 py-0.5 text-[10px] font-semibold text-danger">Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
