"use client";

// ---- Proof review dashboard (Stage 7) ------------------------------------
//
// The old queue was a status filter and a list. It could not answer the two
// questions a reviewer actually has — how much is waiting, and is this person a
// repeat offender — and with every task's proofs mixed together, reviewing one
// campaign meant reading past all the others.
//
// Split out of tasks-admin.tsx, which is where the campaign editor lives: the
// two screens are used by different people (an Agent reviews, an Admin writes
// campaigns) and the review side has grown its own filters, selection state and
// bulk actions.
//
// ⚠️ THE COUNTS COME FROM THE API AND ARE OVER ALL PROOFS, never over the rows
// on screen. A pending number that shrank because someone typed a search would
// be read as the backlog clearing.
import { useState } from "react";
import { useApi } from "@/lib/hooks";
import {
  fetchTaskProofs, decideTaskProof, decideTaskProofsBulk, taskAssetUrl, type TaskProof,
} from "@/lib/api";
import { formatPoints, formatUsdtMicro, timeAgo } from "@/lib/format";

export function ProofQueue() {
  const [status, setStatus] = useState<"pending" | "approved" | "rejected">("pending");
  const [taskId, setTaskId] = useState("");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const proofs = useApi(() => fetchTaskProofs(status, taskId, search), [status, taskId, search]);
  const [msg, setMsg] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const counts = proofs.data?.counts;
  const rows = proofs.data?.proofs ?? [];

  function refresh() { setPicked(new Set()); proofs.reload(); }

  async function decide(id: string, action: "approve" | "reject") {
    const note = action === "reject" ? askNote() : undefined;
    if (note === null) return;
    try {
      const res = await decideTaskProof(id, action, note);
      if (!res.ok) { setMsg(res.error ?? "Could not save."); return; }
      setMsg(action === "approve"
        ? `Approved — ${res.credited ?? 0} pts${res.creditedUsdtMicro ? ` + ${formatUsdtMicro(res.creditedUsdtMicro)}` : ""} credited.`
        : "Done.");
      refresh();
    } catch (e) { setMsg((e as Error).message); }
  }

  // ⚠️ A BULK DECISION IS N SEPARATE DECISIONS, and the result says so per row.
  // The interesting cases are individual: one user over a velocity cap, the
  // campaign running out of budget partway down the list, a row already decided
  // in another tab. Reporting a single "done" would leave a reviewer believing
  // they had cleared a queue they had not.
  async function decideMany(action: "approve" | "reject") {
    const ids = [...picked];
    if (ids.length === 0) return;
    const note = action === "reject" ? askNote(ids.length) : undefined;
    if (note === null) return;
    setBusy(true);
    try {
      const res = await decideTaskProofsBulk(ids, action, note);
      const failures = res.results.filter((r) => !r.ok);
      setMsg(
        `${res.done} done, ${res.failed} not done`
        + (res.creditedPoints ? ` — ${formatPoints(res.creditedPoints)} pts credited` : "")
        + (res.creditedUsdtMicro ? ` + ${formatUsdtMicro(res.creditedUsdtMicro)}` : "")
        + (failures.length ? `. First problem: ${failures[0].error}` : "."),
      );
      refresh();
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  }

  const toggle = (id: string) => setPicked((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const B = "rounded-md px-2.5 py-1 text-xs font-semibold";

  return (
    <section className="mb-8">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold text-brand-ink">Task proofs</h2>
        <div className="flex gap-1">
          {(["pending", "approved", "rejected"] as const).map((s) => (
            <button key={s} onClick={() => { setStatus(s); setPicked(new Set()); }}
              className={`${B} ${status === s ? "bg-brand text-white" : "bg-brand-tint text-brand"}`}>
              {s}
              {counts && <span className="num ml-1 opacity-80">{counts[s]}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-2 flex flex-wrap gap-2">
        {/* Built from tasks that actually have proofs waiting, so the filter
            never offers a choice that returns nothing. */}
        <select value={taskId} onChange={(e) => { setTaskId(e.target.value); setPicked(new Set()); }}
          className="rounded-md border border-line bg-card px-2 py-1.5 text-xs outline-none">
          <option value="">All tasks</option>
          {(proofs.data?.tasks ?? []).map((t) => (
            <option key={t.id} value={t.id}>{t.title} ({t.pending})</option>
          ))}
        </select>
        <form onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); setPicked(new Set()); }}
          className="flex gap-1">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="email or @handle"
            className="rounded-md border border-line bg-card px-2 py-1.5 text-xs outline-none" />
          <button type="submit" className={`${B} bg-brand-tint text-brand`}>Search</button>
          {search && (
            <button type="button" onClick={() => { setQ(""); setSearch(""); }}
              className={`${B} bg-brand-tint text-brand`}>Clear</button>
          )}
        </form>
      </div>

      {status === "pending" && rows.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-line bg-card p-2">
          <button onClick={() => setPicked(new Set(rows.map((r) => r.id)))}
            className={`${B} bg-brand-tint text-brand`}>Select all {rows.length}</button>
          <button onClick={() => setPicked(new Set())} className={`${B} bg-brand-tint text-brand`}>None</button>
          <span className="num text-xs text-muted">{picked.size} picked</span>
          <span className="flex-1" />
          <button disabled={picked.size === 0 || busy} onClick={() => decideMany("approve")}
            className={`${B} bg-success text-white disabled:opacity-40`}>Approve picked</button>
          <button disabled={picked.size === 0 || busy} onClick={() => decideMany("reject")}
            className={`${B} bg-danger text-white disabled:opacity-40`}>Reject picked</button>
        </div>
      )}

      {msg && <p className="mb-2 rounded-md border border-line bg-card p-2 text-xs text-brand-ink">{msg}</p>}

      {proofs.loading ? <p className="text-sm text-muted">Loading…</p>
        : rows.length === 0 ? (
          <p className="rounded-lg border border-line bg-card p-4 text-sm text-muted">Nothing {status}.</p>
        ) : (
          <div className="space-y-2">
            {rows.map((p) => (
              <div key={p.id} className="rounded-lg border border-line bg-card p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start gap-2">
                      {status === "pending" && (
                        <input type="checkbox" className="mt-1" checked={picked.has(p.id)}
                          onChange={() => toggle(p.id)} aria-label="Pick this proof" />
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          {p.task_logo_asset_id && <img src={taskAssetUrl(p.task_logo_asset_id)} alt=""
                            className="h-8 w-8 rounded-md border border-line object-cover" />}
                          <p className="font-semibold text-brand-ink">{p.task_title}</p>
                        </div>
                        <p className="text-xs text-muted">
                          {p.user_handle ? `@${p.user_handle} · ` : ""}{p.user_email} ·{" "}
                          <span className="num text-brand">
                            {p.task_points > 0 ? `${formatPoints(p.task_points)} pts` : ""}
                            {p.task_points > 0 && Number(p.task_usdt_micro) > 0 ? " + " : ""}
                            {Number(p.task_usdt_micro) > 0 ? formatUsdtMicro(Number(p.task_usdt_micro)) : ""}
                          </span> ·{" "}
                          {timeAgo(p.created_at)}
                          {p.user_country ? ` · ${p.user_country}` : ""}
                        </p>
                        {/* This user's own record. A repeat rejection is the
                            signal a reviewer would otherwise go looking for. */}
                        {(p.userHistory.approved > 0 || p.userHistory.rejected > 0) && (
                          <p className="mt-0.5 text-[11px] text-muted">
                            Before: <span className="text-success">{p.userHistory.approved} approved</span>
                            {p.userHistory.rejected > 0 && (
                              <span className="text-danger"> · {p.userHistory.rejected} rejected</span>
                            )}
                          </p>
                        )}
                      </div>
                    </div>

                    <ProofBody proof={p} />

                    {p.review_note && <p className="mt-1 text-xs text-muted">Note: {p.review_note}</p>}
                    {p.reviewer_email && (
                      <p className="mt-0.5 text-[11px] text-muted">
                        Decided by {p.reviewer_email}{p.reviewed_at ? ` · ${timeAgo(p.reviewed_at)}` : ""}
                      </p>
                    )}
                  </div>
                  {status === "pending" && (
                    <div className="flex shrink-0 flex-col gap-1.5">
                      <button onClick={() => decide(p.id, "approve")}
                        className="rounded-md bg-success px-2.5 py-1 text-xs font-semibold text-white">Approve</button>
                      <button onClick={() => decide(p.id, "reject")}
                        className="rounded-md bg-danger px-2.5 py-1 text-xs font-semibold text-white">Reject</button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
    </section>
  );
}

// The rejection note the user will read. Returns null when the reviewer backs
// out — which is why the callers test for null and not for falsy: an empty
// string is a real (if unhelpful) note, a cancel is not.
function askNote(n = 1): string | null {
  return window.prompt(
    n > 1
      ? `Why are you rejecting these ${n}? Every one of them will see this.`
      : "Why are you rejecting this? The user will see it.",
  );
}

// The evidence itself. Structured answers when the task asks questions; the
// original single box when it does not — every row still carries proof_text, so
// this never renders empty.
function ProofBody({ proof }: { proof: TaskProof }) {
  if (proof.answers.length === 0) {
    return (
      <p className="mt-2 whitespace-pre-line rounded-md bg-brand-tint/40 p-2 text-sm text-brand-ink">
        {proof.proof_label && (
          <span className="block text-[11px] font-semibold uppercase text-muted">{proof.proof_label}</span>
        )}
        {proof.proof_text}
      </p>
    );
  }
  return (
    <dl className="mt-2 space-y-1.5 rounded-md bg-brand-tint/40 p-2">
      {proof.answers.map((a, i) => (
        <div key={`${a.fieldId}-${i}`}>
          <dt className="text-[11px] font-semibold uppercase text-muted">{a.label}</dt>
          <dd className="text-sm text-brand-ink">
            {a.kind === "url" ? (
              // ⚠️ USER-SUPPLIED, AND THE WHOLE URL IS SHOWN RATHER THAN A
              // FRIENDLY WORD. The scheme was already forced to http(s)
              // server-side (api/src/taskFields.ts), so this href cannot be
              // javascript: — but a staff session is the session worth
              // stealing, and a reviewer should read where a link goes before
              // clicking it.
              <a href={a.value} target="_blank" rel="noreferrer noopener"
                className="break-all font-mono text-xs text-brand underline">{a.value}</a>
            ) : a.kind === "crypto_address" ? (
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-semibold uppercase text-muted">{a.validation ?? "wallet"}</span>
                <code className="break-all text-xs">{a.value}</code>
                <button onClick={() => navigator.clipboard?.writeText(a.value)}
                  className="rounded bg-card px-2 py-1 text-[10px] font-semibold text-brand">Copy</button>
              </span>
            ) : (
              <span className="whitespace-pre-line break-words">{a.value}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
