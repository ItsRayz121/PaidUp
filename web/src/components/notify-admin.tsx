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
  fetchNotifyAdmin, sendBroadcast,
  fetchContentAdmin, createContentBlock, updateContentBlock, deleteContentBlock,
  type ContentBlock,
} from "@/lib/api";
import { StatusBadge, TimeCell } from "@/components/staff/primitives";

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
    setSending(true);
    setMsg(null);
    try {
      const res = await sendBroadcast({
        audience, title: title.trim(), body: body.trim(),
        url: url.trim() || null, alsoPush,
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
      <div className="rounded-lg border border-line bg-card p-3">
        <h3 className="font-bold text-brand-ink">Send a message</h3>
        <p className="mt-1 text-xs text-muted">
          It lands in the app&apos;s <strong>inbox</strong>, where nothing interrupts anyone. Plain,
          everyday English only — the same rule as the rest of the app. Never promise money, a date
          or a price.
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

        {msg && <p className="mt-2 rounded-md border border-line p-2 text-xs text-brand-ink">{msg}</p>}

        <button onClick={send} disabled={!audience || !title.trim() || !body.trim() || sending}
          className="mt-3 rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {sending ? "Sending…" : picked ? `Send to ${n(picked.size)} people` : "Pick who gets it"}
        </button>
      </div>

      <div className="rounded-lg border border-line bg-card p-3">
        <h3 className="font-bold text-brand-ink">Already sent</h3>
        {d.history.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Nothing has been sent yet.</p>
        ) : (
          <div className="mt-2 space-y-2">
            {d.history.map((h) => (
              <div key={h.id} className="rounded-lg border border-line p-2 text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-semibold text-brand-ink">{h.title}</span>
                  <span className="shrink-0"><TimeCell iso={h.at} /></span>
                </div>
                <p className="text-muted">{h.body}</p>
                <p className="mt-1 text-muted">
                  {h.audience} · <span className="num">{n(h.recipients)}</span> people
                  {h.pushed && <span className="ms-1 rounded bg-pending-tint px-1 text-pending">pushed</span>}
                  {" · "}{h.sentBy}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
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
      <div className="rounded-lg border border-line bg-card p-3">
        <h3 className="font-bold text-brand-ink">{editing ? "Edit card" : "New home card"}</h3>
        <p className="mt-1 text-xs text-muted">
          These show on the app&apos;s home screen, above everything else. Keep them short and plain.
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
              switched on and stays until it is switched off. */}
          <label className="text-xs">
            <span className="text-muted">Show from (optional, ISO date)</span>
            <input value={String(form.startsAt)} onChange={(e) => set("startsAt", e.target.value)}
              placeholder="2026-09-01" className="mt-0.5 w-full rounded-md border border-line bg-card px-2 py-1.5 font-mono text-sm" />
          </label>
          <label className="text-xs">
            <span className="text-muted">Hide after (optional, ISO date)</span>
            <input value={String(form.endsAt)} onChange={(e) => set("endsAt", e.target.value)}
              placeholder="2026-09-30" className="mt-0.5 w-full rounded-md border border-line bg-card px-2 py-1.5 font-mono text-sm" />
          </label>
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

      <div className="rounded-lg border border-line bg-card p-3">
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
