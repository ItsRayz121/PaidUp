"use client";

// Internal staff panels: KPI dashboard (manager/admin), support-ticket queue
// (agent+), and ad-network config (admin). Density over friendliness — this is
// an internal tool, so jargon is allowed here (DESIGN_BRIEF), unlike the earner app.
import { useEffect, useState } from "react";
import { useApi } from "@/lib/hooks";
import {
  fetchKpis, fetchStaffTicket, replyStaffTicket, patchStaffTicket,
  fetchNetworks, updateNetwork, updateAllNetworkReferrals, fetchSettings, updateSettings,
  type StaffTicket, type NetworkConfig,
} from "@/lib/api";
import { formatPoints, formatMoney, timeAgo } from "@/lib/format";
import { useStaffNav } from "@/lib/staffNav";
import { useToast } from "@/components/staff/toast";
import { toTicketImageDataUrl } from "@/lib/imageUpload";
import { ImageIcon, XIcon } from "@/components/icons";
import { QrCode } from "@/components/QrCode";

// ---- Live refresh bar (founder, 2026-08-27) --------------------------------
// The money/fraud queues were pull-on-load only — open the panel, see a
// snapshot, and the only way to see anything new was a manual browser reload.
// During an active incident (a payout burst, a fraud spike) that is exactly
// the wrong moment to be stale. This bar drops into each of those queues: a
// manual Refresh button (always available, even with auto off) plus an
// auto-refresh toggle, ON by default, polling every `QUEUE_POLL_MS`.
//
// ⚠️ POLLING PAUSES WHEN THE TAB IS HIDDEN — see useApi's `pollMs` handling in
// hooks.ts. This app has shipped two real billing incidents from something
// polling forever in the background with nobody watching (CLAUDE.md's Alchemy
// entries); a staff tab left open overnight must not repeat that shape against
// our own API, even though the cost here is a cheap DB read, not a paid RPC.
export const QUEUE_POLL_MS = 20_000;

export function RefreshBar(
  { updatedAt, loading, onRefresh, auto, setAuto }:
  { updatedAt: number | null; loading: boolean; onRefresh: () => void; auto: boolean; setAuto: (v: boolean) => void },
) {
  // Forces a re-render once a second purely so the "Xs ago" text stays honest
  // between polls — the fetch itself only lands every QUEUE_POLL_MS.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  // The tick interval above re-renders us once a second precisely so this
  // render-time Date.now() is fresh — same pattern as useCountdown in hooks.ts.
  // eslint-disable-next-line react-hooks/purity
  const secs = updatedAt === null ? null : Math.max(0, Math.round((Date.now() - updatedAt) / 1000));

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
      <span className="num">{secs === null ? "" : secs < 3 ? "Updated just now" : `Updated ${secs}s ago`}</span>
      <button onClick={onRefresh} disabled={loading}
        className="rounded-md bg-brand-tint px-2 py-1 font-semibold text-brand disabled:opacity-50">
        {loading ? "Refreshing…" : "Refresh"}
      </button>
      <label className="flex items-center gap-1">
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
        Auto-refresh
      </label>
    </div>
  );
}

// ---- KPI dashboard --------------------------------------------------------
export function KpiDashboard() {
  const kpis = useApi(fetchKpis, []);
  const { goToSection } = useStaffNav();
  if (kpis.loading) return <p className="p-4 text-sm text-muted">Loading numbers…</p>;
  if (kpis.error) return <p className="p-4 text-sm text-danger">{kpis.error}</p>;
  const k = kpis.data!;
  const maxDay = Math.max(1, ...k.series.map((d) => d.completions));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Tile label="Verified users" value={String(k.users.total)} sub={`+${k.users.new7d} this week`} onClick={() => goToSection("users")} />
        <Tile label="Pending payouts" value={String(k.withdrawals.pendingCount)} sub={`${formatPoints(k.withdrawals.pendingPoints)} pts held`} warn={k.withdrawals.pendingCount > 0} onClick={() => goToSection("money")} />
        <Tile label="Paid (7 days)" value={String(k.withdrawals.paidCount7d)} sub={formatMoney(k.withdrawals.paidPoints7d)} onClick={() => goToSection("money")} />
        <Tile label="Completions today" value={String(k.earning.completionsToday)} onClick={() => goToSection("tasks")} />
        <Tile label="Points to users" value={formatPoints(k.earning.taskPointsAll)} sub="from tasks, all time" onClick={() => goToSection("money")} />
        <Tile label="Referral points" value={formatPoints(k.earning.referralPointsAll)} sub="all time" onClick={() => goToSection("growth")} />
        <Tile label="Open fraud flags" value={String(k.risk.openFraud)} warn={k.risk.openFraud > 0} onClick={() => goToSection("users")} />
        <Tile label="Open tickets" value={String(k.risk.openTickets)} warn={k.risk.openTickets > 0} onClick={() => goToSection("support")} />
      </div>

      <div className="rounded-lg border-2 border-line-strong bg-card p-4">
        <p className="mb-3 text-xs font-semibold uppercase text-muted">Credited completions · last 7 days</p>
        {k.series.length === 0 ? (
          <p className="text-sm text-muted">No completions in this window yet.</p>
        ) : (
          <div className="flex items-end gap-2" style={{ height: 120 }}>
            {k.series.map((d) => (
              <div key={d.day} className="flex flex-1 flex-col items-center gap-1">
                <span className="num text-xs text-brand-ink">{d.completions}</span>
                <div className="w-full rounded-t bg-brand" style={{ height: `${(d.completions / maxDay) * 90}px`, minHeight: 2 }}
                  title={`${d.completions} completions · ${formatPoints(d.points)} pts`} />
                <span className="text-[10px] text-muted">{d.day.slice(5)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Tile(
  { label, value, sub, warn, onClick }:
  { label: string; value: string; sub?: string; warn?: boolean; onClick?: () => void },
) {
  const cls = `rounded-lg border-2 p-3 text-left ${warn ? "border-danger bg-danger-tint/40" : "border-line-strong bg-card"} ${onClick ? "transition-colors hover:border-brand" : ""}`;
  const inner = (
    <>
      <p className="num text-2xl font-bold text-brand-ink">{value}</p>
      <p className="text-xs font-medium text-brand-ink">{label}</p>
      {sub && <p className="text-[11px] text-muted">{sub}</p>}
    </>
  );
  return onClick ? <button onClick={onClick} className={cls}>{inner}</button> : <div className={cls}>{inner}</div>;
}

// ---- Support-ticket thread (agent+, brief part 40) -----------------------
//
// The queue that lists tickets moved onto the shared <DataTable> in Phase E
// (components/staff/SupportQueue.tsx); this thread — the "who is this / read the
// history / reply" panel — is unchanged and reused there inside a <DetailLayout>.
export const TICKET_STATUSES = ["all", "open", "answered", "closed"];

// A long message collapses so one wall of text doesn't push the reply box (and
// the buttons beside it) off screen — tap it to read the whole thing in place.
const LONG_MESSAGE_CHARS = 320;

export function TicketThread({ t, onChange }: { t: StaffTicket; onChange: () => void }) {
  const id = t.id;
  const thread = useApi(() => fetchStaffTicket(id), [id]);
  const [reply, setReply] = useState("");
  const [internal, setInternal] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  async function send(close: boolean) {
    setBusy(true); setErr(null);
    try {
      await replyStaffTicket(id, reply.trim(), close, internal, image);
      setReply(""); setInternal(false); setImage(null); thread.reload(); onChange();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function pickImage(file: File | undefined) {
    if (!file) return;
    try { setImage(await toTicketImageDataUrl(file)); }
    catch (e) { setErr((e as Error).message); }
  }

  async function patch(p: { assignedTo?: string | null; status?: string }) {
    setBusy(true); setErr(null);
    try { await patchStaffTicket(id, p); thread.reload(); onChange(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  if (thread.loading) return <p className="border-t border-line p-3 text-sm text-muted">Loading…</p>;
  if (thread.error) return <p className="border-t border-line p-3 text-sm text-danger">{thread.error}</p>;
  const info = thread.data!.ticket as Record<string, unknown>;

  return (
    <div className="space-y-3 border-t border-line p-3">
      {/* WHO this is now leads the page (DetailLayout's title, in
          SupportQueue.tsx) — this line is the context a reply needs beyond
          the name: country, ID status, account status. */}
      <p className="text-xs text-muted">
        {info.country ? String(info.country) : "Country unknown"}
        {` · id: ${String(info.kycStatus ?? "none")}`}
        {String(info.userStatus) !== "active" && (
          <span className="ms-1 font-semibold text-danger">account {String(info.userStatus)}</span>
        )}
      </p>

      <div className="space-y-2">
        {thread.data!.messages.map((m, i) => {
          // ⚠️ AN INTERNAL NOTE LOOKS NOTHING LIKE A REPLY, ON PURPOSE. It is
          // never sent to the user, and a staff member skimming a thread must
          // not mistake one for something the user has already been told.
          const isNote = m.author_role === "internal";
          const isStaff = m.author_role === "staff";
          const isLong = m.body.length > LONG_MESSAGE_CHARS;
          const isOpen = expanded.has(i);
          return (
            <div key={i} className={
              isNote
                ? "rounded-lg border border-dashed border-pending bg-pending-tint/40 p-2 text-sm"
                : `max-w-[85%] rounded-lg p-2 text-sm ${isStaff ? "ml-auto bg-brand text-white" : "bg-brand-tint text-brand-ink"}`
            }>
              <p className={`whitespace-pre-wrap ${isLong && !isOpen ? "line-clamp-4" : ""}`}>{m.body}</p>
              {isLong && (
                <button type="button"
                  onClick={() => setExpanded((s) => { const n = new Set(s); if (isOpen) n.delete(i); else n.add(i); return n; })}
                  className={`mt-0.5 text-[11px] font-semibold underline ${isStaff && !isNote ? "text-white/90" : "text-brand"}`}>
                  {isOpen ? "Show less" : "Show more"}
                </button>
              )}
              {m.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={m.image} alt="" className="mt-1.5 max-h-56 w-auto rounded" />
              )}
              <p className={`mt-1 text-[11px] ${isStaff && !isNote ? "text-white/70" : "text-muted"}`}>
                {isNote ? "Internal note — the user cannot see this" : isStaff ? "Staff" : "User"}
                {" · "}{timeAgo(m.created_at)}
              </p>
            </div>
          );
        })}
        {/* The closed state used to just hide the reply box with nothing
            marking WHEN it closed (founder, 2026-09-02: a proper "chat
            closed" divider). updatedAt is the ticket's own last-touched
            time, which for a closed ticket is exactly the close moment —
            nothing can update a closed ticket without reopening it first. */}
        {String(info.status) === "closed" && (
          <div className="flex items-center gap-2 py-1 text-[11px] text-muted">
            <span className="h-px flex-1 bg-line" aria-hidden />
            Chat closed{info.updatedAt ? ` · ${timeAgo(String(info.updatedAt))}` : ""}
            {info.rating ? ` · rated ${String(info.rating)}` : " · not rated yet"}
            <span className="h-px flex-1 bg-line" aria-hidden />
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5 text-xs">
        {info.assignedTo
          ? <button onClick={() => patch({ assignedTo: null })} disabled={busy}
              className="rounded bg-brand-tint px-2 py-1 font-semibold text-brand disabled:opacity-50">
              Hand back to the pool
            </button>
          : <button onClick={() => patch({ assignedTo: "me" })} disabled={busy}
              className="rounded bg-brand-tint px-2 py-1 font-semibold text-brand disabled:opacity-50">
              Take this ticket
            </button>}
        {String(info.status) === "closed" && (
          <button onClick={() => patch({ status: "open" })} disabled={busy}
            className="rounded bg-brand-tint px-2 py-1 font-semibold text-brand disabled:opacity-50">Reopen</button>
        )}
      </div>

      {/* The input and its own send buttons sit together as one bar (founder,
          2026-09-02: "add these buttons... near it"). The photo attach and
          internal-note controls — read less often, changed less often — are a
          smaller row underneath rather than sitting between the box and its
          own buttons. */}
      <div className="flex items-end gap-2">
        <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={2}
          placeholder={internal ? "Note for staff only — the user never sees this…" : "Reply to the user…"}
          className={`flex-1 rounded-md border p-2 text-sm outline-none ${
            internal ? "border-dashed border-pending bg-pending-tint/30" : "border-line bg-card"
          }`} />
        <div className="flex shrink-0 flex-col gap-1">
          <button disabled={!reply.trim() || busy} onClick={() => send(false)}
            className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            {internal ? "Save note" : "Send reply"}
          </button>
          {!internal && (
            <button disabled={!reply.trim() || busy} onClick={() => send(true)}
              className="rounded-md bg-success px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Send &amp; close</button>
          )}
        </div>
      </div>
      {err && <p className="text-sm text-danger">{err}</p>}
      <div className="flex flex-wrap items-center gap-3">
        {image ? (
          <div className="flex items-center gap-2 text-xs">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image} alt="" className="h-12 w-12 rounded object-cover" />
            <span className="text-muted">Photo attached</span>
            <button type="button" onClick={() => setImage(null)} disabled={busy}
              className="rounded-full bg-brand-tint p-1 text-brand disabled:opacity-50"><XIcon size={13} /></button>
          </div>
        ) : (
          <label className="inline-flex w-fit cursor-pointer items-center gap-1.5 rounded border border-line px-2 py-1 text-xs font-semibold text-brand">
            <ImageIcon size={14} /> Attach a photo
            <input type="file" accept="image/*" className="hidden" disabled={busy}
              onChange={(e) => pickImage(e.target.files?.[0])} />
          </label>
        )}
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
          Internal note — not sent to the user, and it leaves the ticket open
        </label>
      </div>
    </div>
  );
}

// ---- Treasury / hot wallet (admin only) ------------------------------------
// The wallet the founder funds with USDT and every manual payout is sent FROM.
// The API stores only the ADDRESS (never a key), so this screen can't move
// funds — it exists so (a) the founder records where the treasury lives, (b)
// whoever pays a withdrawal sends from the right wallet, and (c) the deposit
// address is one scan or copy away when topping up.
//
// ⚠️ BEP20 ONLY ON SCREEN (founder, 2026-09-03: "you can remove these Aptos ...
// and even you can remove this base address"). One chain in, one chain out is
// already the live rule (CLAUDE.md, 2026-07-29) — Base and Aptos were two empty
// boxes inviting a treasury to be recorded on a chain nothing pays out on.
//
// ⚠️ `KNOWN_CHAINS` in chains.ts IS NOT TOUCHED BY THIS. Historical withdrawal
// rows on those chains must keep labelling, and payout.ts must keep recognising
// its own past work. This is a display narrowing on one panel, nothing else —
// the settings endpoint still accepts all three.
const TREASURY_CHAINS = [
  { id: "bep20" as const, label: "BNB Smart Chain (BEP20)" },
];
type TreasuryChain = (typeof TREASURY_CHAINS)[number]["id"];

export function TreasuryPanel() {
  const s = useApi(fetchSettings, []);
  const toast = useToast();
  const [draft, setDraft] = useState<Partial<Record<TreasuryChain, string>>>({});
  const [busy, setBusy] = useState(false);

  async function save(chain: TreasuryChain) {
    const address = (draft[chain] ?? "").trim();
    setBusy(true);
    try {
      await updateSettings({ treasury: { [chain]: address } });
      toast.ok("Treasury address saved.");
      s.reload();
      setDraft((d) => ({ ...d, [chain]: undefined }));
    } catch (e) {
      toast.err((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-8">
      <h2 className="mb-2 font-bold text-brand-ink">Treasury wallet (hot wallet)</h2>
      <p className="mb-2 text-xs text-muted">
        This is the wallet you fund with USDT and send every payout from. Only the address is
        stored here (never a key), and every change is written to the audit log.
      </p>
      {s.loading ? <p className="p-4 text-sm text-muted">Loading…</p>
        : s.error ? <p className="p-4 text-sm text-danger">{s.error}</p>
        : (
          <div className="space-y-3 rounded-lg border-2 border-line-strong p-3">
            {/* The COIN and the NETWORK are two separate labelled facts, never
                one sentence. The earner deposit screen already follows this
                rule for the reason that matters: BNB is a real token in the
                same wallet, and sending it instead of USDT is unrecoverable. */}
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
              <span><span className="text-muted">Coin to send:</span> <b className="text-brand-ink">USDT</b></span>
              <span><span className="text-muted">Network:</span> <b className="text-brand-ink">BNB Smart Chain (BEP20)</b></span>
            </div>
            {TREASURY_CHAINS.map((c) => {
              const saved = s.data?.treasury?.[c.id] ?? "";
              const value = draft[c.id] ?? saved;
              const dirty = draft[c.id] !== undefined && draft[c.id] !== saved;
              return (
                <div key={c.id} className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-48 shrink-0 text-sm font-semibold text-brand-ink">{c.label}</span>
                    <input
                      value={value}
                      onChange={(e) => setDraft((d) => ({ ...d, [c.id]: e.target.value }))}
                      placeholder="0x… (not set yet)"
                      className="num min-w-0 flex-1 rounded border border-line bg-card p-1.5 text-xs outline-none"
                    />
                    {saved && !dirty && (
                      <button onClick={() => navigator.clipboard?.writeText(saved)}
                        className="rounded bg-brand-tint px-2.5 py-1.5 text-xs font-semibold text-brand" title="Copy the deposit address">
                        Copy
                      </button>
                    )}
                    {dirty && (
                      <button disabled={busy} onClick={() => save(c.id)}
                        className="rounded bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                        Save
                      </button>
                    )}
                  </div>
                  {/* Scan to send (founder, 2026-09-03). Rendered client-side —
                      a treasury address never leaves the browser to become a
                      picture. Only the SAVED address is ever encoded, never a
                      half-typed draft, or the code would say to send money to
                      an address that does not exist yet. */}
                  {saved && !dirty && (
                    <div className="flex items-center gap-3">
                      <QrCode value={saved} size={132} />
                      <p className="text-xs text-muted">
                        Scan to send <b className="text-brand-ink">USDT</b> on{" "}
                        <b className="text-brand-ink">BEP20</b> to the treasury.
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
    </section>
  );
}

// ---- Withdrawal fee (admin only) -----------------------------------------
// Flat fee (points) taken out of every withdrawal, deducted from the payout so
// it covers on-chain gas / protects margin. Snapshotted onto each request.
export function WithdrawalFeePanel() {
  const s = useApi(fetchSettings, []);
  const toast = useToast();
  const [fee, setFee] = useState<number | null>(null);
  // Gas fee (founder, 2026-08-08): percent + a fixed floor, applied to BOTH
  // withdrawals (on top of the flat fee above) and deposit refunds
  // ("Get your USDT back") — the two flows the founder wants a real-gas-cost
  // fee on. See api/src/fees.ts.
  const [gasPercent, setGasPercent] = useState<number | null>(null);
  const [gasFixedUsdt, setGasFixedUsdt] = useState<number | null>(null);
  // Auto-settle ceilings (founder, 2026-08-08): a request AT OR UNDER this
  // amount settles itself with no staff click at all; above it, into the
  // unchanged manual queue. In USDT for both fields on screen — withdrawals
  // are stored in points, converted at save/display time.
  const [autoWithdrawUsdt, setAutoWithdrawUsdt] = useState<number | null>(null);
  const [autoRefundUsdt, setAutoRefundUsdt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const current = s.data?.withdrawalFeePoints ?? 0;
  const value = fee ?? current;
  const currentGasPercent = s.data?.gasFeePercent ?? 0;
  const currentGasFixedUsdt = (s.data?.gasFeeFixedMicro ?? 0) / 1_000_000;
  const gasPercentValue = gasPercent ?? currentGasPercent;
  const gasFixedValue = gasFixedUsdt ?? currentGasFixedUsdt;
  // 1000 points = 1 USDT (see web/src/lib/format.ts POINTS_PER_USDT) — kept
  // as a literal here rather than importing it, since this panel already
  // works in raw points/micros everywhere else and one more unit conversion
  // import would obscure more than it clarifies.
  const currentAutoWithdrawUsdt = (s.data?.autoWithdrawMaxPoints ?? 0) / 1000;
  const currentAutoRefundUsdt = (s.data?.autoRefundMaxMicro ?? 0) / 1_000_000;
  const autoWithdrawValue = autoWithdrawUsdt ?? currentAutoWithdrawUsdt;
  const autoRefundValue = autoRefundUsdt ?? currentAutoRefundUsdt;
  const dirty = (fee !== null && fee !== current)
    || (gasPercent !== null && gasPercent !== currentGasPercent)
    || (gasFixedUsdt !== null && gasFixedUsdt !== currentGasFixedUsdt)
    || (autoWithdrawUsdt !== null && autoWithdrawUsdt !== currentAutoWithdrawUsdt)
    || (autoRefundUsdt !== null && autoRefundUsdt !== currentAutoRefundUsdt);

  async function save() {
    setBusy(true);
    try {
      await updateSettings({
        withdrawalFeePoints: value,
        gasFeePercent: gasPercentValue,
        gasFeeFixedMicro: Math.round(gasFixedValue * 1_000_000),
        autoWithdrawMaxPoints: Math.round(autoWithdrawValue * 1000),
        autoRefundMaxMicro: Math.round(autoRefundValue * 1_000_000),
      });
      s.reload();
      setFee(null); setGasPercent(null); setGasFixedUsdt(null);
      setAutoWithdrawUsdt(null); setAutoRefundUsdt(null);
      toast.ok("Saved. Live immediately.");
    }
    catch (e) { toast.err((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <section className="mb-8">
      <h2 className="mb-2 font-bold text-brand-ink">Withdrawal fee &amp; auto-approve limits</h2>
      <p className="mb-3 rounded-lg border border-line bg-brand-tint/40 p-2 text-xs text-muted">
        This panel controls: the <b>flat withdrawal fee</b>, the <b>gas fee</b> (% + fixed) on
        withdrawals and deposit refunds, and the <b>auto-approve limit</b> — a withdrawal or refund
        at or under this amount is sent with no staff step; above it, it waits for manual approval.
      </p>
      <h3 className="mb-1 font-bold text-brand-ink">Flat withdrawal fee</h3>
      <p className="mb-2 text-xs text-muted">Flat points fee taken out of every withdrawal (covers network/gas cost). 0 = no fee. The user sees the fee and the net amount before they confirm.</p>
      <div className="flex items-center gap-2 rounded-lg border-2 border-line-strong p-3">
        <input type="number" min={0} max={1000000} value={value}
          onChange={(e) => setFee(Number(e.target.value))}
          className="num w-28 rounded border border-line bg-card p-1.5 text-sm outline-none" />
        <span className="text-sm text-muted">points per withdrawal</span>
      </div>

      <h3 className="mb-2 mt-4 font-bold text-brand-ink">Gas fee (withdrawals + deposit refunds)</h3>
      <p className="mb-2 text-xs text-muted">
        Percent of the amount plus a fixed floor, taken out of what actually gets SENT — never out of
        what gets debited. Applies on top of the flat fee above on withdrawals, and is the only fee on
        deposit refunds (&quot;Get your USDT back&quot;), which had none before. 0% / $0 = off.
      </p>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border-2 border-line-strong p-3">
        <input type="number" min={0} max={100} step={0.1} value={gasPercentValue}
          onChange={(e) => setGasPercent(Number(e.target.value))}
          className="num w-20 rounded border border-line bg-card p-1.5 text-sm outline-none" />
        <span className="text-sm text-muted">% +</span>
        <input type="number" min={0} step={0.01} value={gasFixedValue}
          onChange={(e) => setGasFixedUsdt(Number(e.target.value))}
          className="num w-24 rounded border border-line bg-card p-1.5 text-sm outline-none" />
        <span className="text-sm text-muted">USDT fixed</span>
        {dirty && (
          <button disabled={busy} onClick={save}
            className="ms-auto rounded bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Save</button>
        )}
      </div>

      <h3 className="mb-2 mt-4 font-bold text-brand-ink">Send automatically, below this amount</h3>
      <p className="mb-2 text-xs text-muted">
        It is the user&apos;s own money — a request at or under this amount is sent with no staff click at
        all, and its transaction hash shows straight in the user&apos;s history. Above it, a request still
        needs a staff member to approve and send it, same as today.
      </p>
      {s.data && !s.data.autoSendLive && (
        <p className="mb-2 rounded-lg bg-pending-tint p-2.5 text-xs text-pending">
          Not live yet — these numbers save, but nothing sends itself until a real treasury signer is
          set up and proven on testnet (see CUSTODY_SPEC.md § 5c). Every request still goes through the
          manual queue below regardless of what you set here.
        </p>
      )}
      <div className="flex flex-wrap gap-4 rounded-lg border-2 border-line-strong p-3">
        <label className="flex items-center gap-2 text-sm">
          Withdrawals (task/referral money) ≤
          <input type="number" min={0} step={0.01} value={autoWithdrawValue}
            onChange={(e) => setAutoWithdrawUsdt(Number(e.target.value))}
            className="num w-24 rounded border border-line bg-card p-1.5 text-sm outline-none" />
          USDT
        </label>
        <label className="flex items-center gap-2 text-sm">
          Deposit refunds ≤
          <input type="number" min={0} step={0.01} value={autoRefundValue}
            onChange={(e) => setAutoRefundUsdt(Number(e.target.value))}
            className="num w-24 rounded border border-line bg-card p-1.5 text-sm outline-none" />
          USDT
        </label>
        {dirty && (
          <button disabled={busy} onClick={save}
            className="ms-auto rounded bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Save</button>
        )}
      </div>
    </section>
  );
}

// ---- Ad-network config (admin only) --------------------------------------
export function NetworkPanel() {
  const nets = useApi(fetchNetworks, []);

  return (
    <>
    <section className="mb-8">
      <h2 className="mb-2 font-bold text-brand-ink">Ad networks &amp; commission</h2>
      <p className="mb-2 text-xs text-muted">Split and referral bonus are configured here — never in code. Disabling a network stops its postbacks crediting and hides its offers.</p>
      {nets.loading ? <p className="p-4 text-sm text-muted">Loading…</p>
        : nets.error ? <p className="p-4 text-sm text-danger">{nets.error}</p>
        : (
          <div className="overflow-x-auto rounded-lg border-2 border-line-strong">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-brand-tint text-left text-xs uppercase text-brand">
                <tr>
                  <th className="p-2.5">Network</th><th className="p-2.5">Type</th>
                  <th className="p-2.5">Split % to user</th>
                  <th className="p-2.5">Referral L1 %</th><th className="p-2.5">Referral L2 %</th>
                  <th className="p-2.5">1st-task bonus</th>
                  <th className="p-2.5">Referral days</th>
                  <th className="p-2.5">Offers</th><th className="p-2.5">Credited</th><th className="p-2.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {nets.data!.networks.map((n) => <NetworkRow key={n.id} net={n} onSaved={nets.reload} />)}
              </tbody>
            </table>
          </div>
        )}
      {!nets.loading && !nets.error && <BulkReferralRates onSaved={nets.reload} />}
    </section>
    </>
  );
}

function NetworkRow({ net, onSaved }: { net: NetworkConfig; onSaved: () => void }) {
  const toast = useToast();
  const [split, setSplit] = useState(net.commissionSplitPct);
  const [refPct, setRefPct] = useState(net.referralBonusPct);
  const [refPctL2, setRefPctL2] = useState(net.referralBonusPctL2);
  const [firstBonus, setFirstBonus] = useState(net.referralFirstTaskBonus);
  const [refDays, setRefDays] = useState(net.referralBonusDays);
  const [busy, setBusy] = useState(false);
  const dirty = split !== net.commissionSplitPct || refPct !== net.referralBonusPct
    || refPctL2 !== net.referralBonusPctL2 || firstBonus !== net.referralFirstTaskBonus
    || refDays !== net.referralBonusDays;

  async function patch(patchObj: Parameters<typeof updateNetwork>[1]) {
    setBusy(true);
    try { await updateNetwork(net.id, patchObj); onSaved(); }
    catch (e) { toast.err((e as Error).message); }
    finally { setBusy(false); }
  }

  const numInput = "num w-16 rounded border border-line bg-card p-1 text-sm outline-none";
  return (
    <tr className="border-t border-line">
      <td className="p-2.5 font-medium text-brand-ink">{net.name}<div className="text-[11px] text-muted">{net.id}</div></td>
      <td className="p-2.5">{net.type === "rewarded_video" ? "Rewarded video" : "Offerwall"}</td>
      <td className="p-2.5"><input type="number" min={0} max={100} value={split} onChange={(e) => setSplit(Number(e.target.value))} className={numInput} /></td>
      <td className="p-2.5"><input type="number" min={0} max={100} value={refPct} onChange={(e) => setRefPct(Number(e.target.value))} className={numInput} title="Direct referral %" /></td>
      <td className="p-2.5"><input type="number" min={0} max={100} value={refPctL2} onChange={(e) => setRefPctL2(Number(e.target.value))} className={numInput} title="Level-2 (indirect) referral %. 0 = off" /></td>
      <td className="p-2.5"><input type="number" min={0} max={1000000} value={firstBonus} onChange={(e) => setFirstBonus(Number(e.target.value))} className="num w-20 rounded border border-line bg-card p-1 text-sm outline-none" title="Points bonus when an invite finishes their first task. 0 = off" /></td>
      <td className="p-2.5"><input type="number" min={0} max={3650} value={refDays} onChange={(e) => setRefDays(Number(e.target.value))} className={numInput} title="0 = lifetime (no window)" /></td>
      <td className="num p-2.5">{net.taskCount}</td>
      <td className="num p-2.5">{net.creditedCount}</td>
      <td className="p-2.5">
        <div className="flex items-center gap-1.5">
          {dirty && (
            <button disabled={busy} onClick={() => patch({ commissionSplitPct: split, referralBonusPct: refPct, referralBonusPctL2: refPctL2, referralFirstTaskBonus: firstBonus, referralBonusDays: refDays })}
              className="rounded bg-brand px-2 py-1 text-xs font-semibold text-white disabled:opacity-50">Save</button>
          )}
          <button disabled={busy} onClick={() => patch({ status: net.status === "active" ? "disabled" : "active" })}
            className={`rounded px-2 py-1 text-xs font-semibold text-white disabled:opacity-50 ${net.status === "active" ? "bg-success" : "bg-danger"}`}>
            {net.status === "active" ? "Active" : "Disabled"}
          </button>
        </div>
      </td>
    </tr>
  );
}

// Set referral rewards on every network in one go.
//
// The per-row inputs above are still the right tool for tuning ONE deal. This is
// for the other job — "make inviting pay more" — which the per-row editor does
// badly: the invite screens advertise the MINIMUM across active networks, so
// bumping four rows and missing the fifth changes nothing users can see, and
// nothing tells you that. Blank means "leave this one alone".
function BulkReferralRates({ onSaved }: { onSaved: () => void }) {
  const toast = useToast();
  const [l1, setL1] = useState("");
  const [l2, setL2] = useState("");
  const [first, setFirst] = useState("");
  const [busy, setBusy] = useState(false);

  const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
  const patch = {
    referralBonusPct: num(l1),
    referralBonusPctL2: num(l2),
    referralFirstTaskBonus: num(first),
  };
  const anything = Object.values(patch).some((v) => v !== undefined);

  async function save() {
    // Every network at once, including disabled ones. Worth a confirm: it is the
    // one control here that rewrites rows the operator is not looking at.
    if (!window.confirm("Set these referral rewards on EVERY network? Blank fields are left unchanged.")) return;
    setBusy(true);
    try {
      const res = await updateAllNetworkReferrals(patch);
      toast.ok(`Updated ${res.updated} networks.`);
      setL1(""); setL2(""); setFirst("");
      onSaved();
    } catch (e) {
      // The API refuses L1+L2 above the margin — that message is the useful one.
      toast.err((e as Error).message);
    } finally { setBusy(false); }
  }

  const inp = "num w-20 rounded border border-line bg-card p-1 text-sm outline-none";
  return (
    <div className="mt-3 rounded-lg border-2 border-line-strong p-3">
      <p className="text-sm font-semibold text-brand-ink">Set referral rewards on all networks</p>
      <p className="mb-2 text-xs text-muted">
        Users are shown the LOWEST rate across active networks, so raising one network alone changes
        nothing they can see. Referral pay comes out of our margin — L1 + L2 above the margin is refused.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-muted">L1 %<br />
          <input type="number" min={0} max={100} value={l1} onChange={(e) => setL1(e.target.value)} className={inp} placeholder="—" />
        </label>
        <label className="text-xs text-muted">L2 %<br />
          <input type="number" min={0} max={100} value={l2} onChange={(e) => setL2(e.target.value)} className={inp} placeholder="—" />
        </label>
        <label className="text-xs text-muted">1st-task bonus<br />
          <input type="number" min={0} max={1000000} value={first} onChange={(e) => setFirst(e.target.value)} className={inp} placeholder="—" />
        </label>
        <button disabled={busy || !anything} onClick={save}
          className="rounded bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
          Apply to all
        </button>
      </div>
    </div>
  );
}

// ResolveFlagButton was replaced by FlagActions in staff/page.tsx (founder,
// 2026-09-02) — the fraud row now offers Resolve AND Suspend, not just Resolve.
