"use client";

// The ID review queue. ADMIN ONLY — see routes/staffKyc.ts for why the role is
// narrower here than anywhere else in the panel: agents and managers have no
// business looking at a stranger's national ID card, and the smallest number of
// people who can is the right number.
//
// The photos are NOT in the queue payload. They are fetched one at a time, only
// when a reviewer opens a submission, and every single view is written to the
// audit log. "Who looked at my ID" is a question we must be able to answer.
import { useState } from "react";
import { useApi } from "@/lib/hooks";
import {
  fetchKycQueue, decideKyc, fetchSettings, API_BASE, getToken,
  type KycSubmission,
} from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useToast } from "@/components/staff/toast";
import { StatusTabs } from "@/components/staff/primitives";
import { useStaffNav } from "@/lib/staffNav";

// The image endpoint is authenticated, so it cannot be a plain <img src>. We fetch
// it with the bearer token, turn it into an object URL, and revoke that URL as
// soon as the reviewer closes the submission — an ID card should not linger in
// browser memory any longer than the moment it is being looked at.
//
// Uses the shared API_BASE and getToken() from lib/api rather than re-deriving
// them, so a trailing slash on NEXT_PUBLIC_API_URL (which api.ts strips) cannot
// produce a broken `//staff/kyc/...` URL here.
async function loadImage(id: string, which: "selfie" | "front" | "back"): Promise<string> {
  const token = getToken();
  const res = await fetch(`${API_BASE}/staff/kyc/${id}/${which}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error("Could not load that photo.");
  return URL.createObjectURL(await res.blob());
}

function Review({ sub, onDone }: { sub: KycSubmission; onDone: () => void }) {
  const toast = useToast();
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function reveal() {
    setOpen(true);
    setErr(null);
    try {
      const [selfie, front, back] = await Promise.all([
        loadImage(sub.id, "selfie"),
        loadImage(sub.id, "front"),
        loadImage(sub.id, "back"),
      ]);
      setUrls({ selfie, front, back });
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  function close() {
    // Revoke the object URLs. Without this the decrypted ID images stay alive in
    // the tab's memory for as long as it is open.
    Object.values(urls).forEach((u) => URL.revokeObjectURL(u));
    setUrls({});
    setOpen(false);
  }

  async function decide(decision: "approved" | "rejected") {
    let reason: string | undefined;
    if (decision === "rejected") {
      const r = window.prompt("Why? The user will see this, so say what to fix (e.g. 'ID photo is blurry').");
      if (r === null) return;
      if (!r.trim()) { toast.err("A reason is required."); return; }
      reason = r.trim();
    }
    setBusy(true);
    try {
      await decideKyc(sub.id, decision, reason);
      toast.ok(decision === "approved" ? "ID approved." : "ID rejected.");
      close();
      onDone();
    } catch (e) {
      toast.err((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold text-brand-ink">{sub.email}</p>
          <p className="text-xs text-muted">
            {sub.country} · submitted {timeAgo(sub.created_at)} · {sub.user_id.slice(0, 8)}
          </p>
        </div>
        {!open ? (
          <button
            onClick={reveal}
            className="rounded-lg border border-brand px-3 py-1.5 text-sm font-semibold text-brand"
          >
            Open documents
          </button>
        ) : (
          <button onClick={close} className="rounded-lg border border-line px-3 py-1.5 text-sm font-semibold text-muted">
            Close
          </button>
        )}
      </div>

      {open && (
        <div className="mt-3">
          {err && <p className="mb-2 rounded-lg bg-danger-tint p-2 text-sm text-danger">{err}</p>}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {(["selfie", "front", "back"] as const).map((k) => (
              <figure key={k}>
                <figcaption className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                  {k === "selfie" ? "Face" : k === "front" ? "ID front" : "ID back"}
                </figcaption>
                {urls[k] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={urls[k]}
                    alt=""
                    className="max-h-64 w-full rounded-lg border border-line bg-bg object-contain"
                  />
                ) : (
                  <div className="grid h-40 place-items-center rounded-lg border border-dashed border-line text-sm text-muted">
                    Loading…
                  </div>
                )}
              </figure>
            ))}
          </div>

          <div className="mt-3 rounded-lg bg-bg p-2.5 text-xs text-muted">
            Check: the face matches the ID photo, the card is not expired, all four
            corners are visible, and nothing looks edited. Every view of these
            images is logged against your account.
          </div>

          {sub.status === "pending" && (
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => decide("approved")}
                disabled={busy}
                className="flex-1 rounded-lg bg-success px-3 py-2 text-sm font-bold text-white disabled:opacity-50"
              >
                Approve
              </button>
              <button
                onClick={() => decide("rejected")}
                disabled={busy}
                className="flex-1 rounded-lg border border-danger px-3 py-2 text-sm font-bold text-danger disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- The master on/off switch (founder, 2026-08-01) ------------------------
//
// Turns the whole ID check on or off with no redeploy. OFF hides the tab in the
// earner app ("Coming soon") and closes POST /kyc.
//
// ⚠️ AND IT WAIVES THE ID REQUIREMENT EVERYWHERE, which is why the warning below
// is not decoration. Sending ROZI, withdrawing and refunding a deposit all
// require an approved ID today; if this switch merely HID the only screen that
// can produce that approval, those three features would become impossible while
// still telling users to go and verify. So the rule is: the check is either
// running, or it is not being asked for. Never "required but unobtainable".
// See kycFeatureEnabled() in api/src/kyc.ts.
// The ON/OFF control for the ID check used to live here too, as its own
// banner + button — the exact same `kyc_enabled` setting is also a row in
// Feature Flags (flagsCore.ts's `kyc` flag). Two independent switches on one
// setting is how a room disagrees with itself, so the control now lives ONLY
// in Feature Flags; this is a read-only status line pointing there (founder,
// 2026-09-02: "shift it from the outer box into feature flags").
function KycStatusLine() {
  const s = useApi(fetchSettings, []);
  const nav = useStaffNav();
  const on = s.data?.kycEnabled !== false;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border-2 border-line-strong bg-card p-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-brand-ink">
          ID check: {s.loading ? "…" : on ? "ON" : "OFF — shown to users as “Coming soon”"}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          {on
            ? "Users can send documents, and an approved ID is required to send ROZI, withdraw, or get a deposit back."
            : "The /kyc screen is closed and no feature asks for an ID. Nothing is blocked behind a tab users cannot open."}
        </p>
      </div>
      <button
        type="button"
        onClick={() => nav.goToSection("flags")}
        className="shrink-0 rounded-md border-2 border-line-strong bg-brand-tint px-3 py-1.5 text-xs font-semibold text-brand"
      >
        Manage in Feature flags →
      </button>
    </div>
  );
}

export function KycPanel() {
  const [status, setStatus] = useState("pending");
  const queue = useApi(() => fetchKycQueue(status), [status]);

  return (
    <div>
      <KycStatusLine />

      <div className="mb-3">
        <StatusTabs options={["pending", "approved", "rejected"]} value={status} onChange={setStatus} />
      </div>

      <p className="mb-3 rounded-lg bg-pending-tint p-2.5 text-xs text-pending">
        Approving a user counts them toward the next mining halving and starts
        paying their inviter a referral bonus. It also lets them withdraw money.
      </p>

      {queue.loading && <p className="text-muted">Loading…</p>}
      {queue.error && <p className="text-danger">{queue.error}</p>}

      {queue.data?.submissions.length === 0 && (
        <p className="text-muted">Nothing {status}.</p>
      )}

      <div className="space-y-2">
        {queue.data?.submissions.map((sub) => (
          <Review key={sub.id} sub={sub} onDone={queue.reload} />
        ))}
      </div>
    </div>
  );
}
