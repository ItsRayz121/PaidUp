"use client";

// Internal staff panels: KPI dashboard (manager/admin), support-ticket queue
// (agent+), and ad-network config (admin). Density over friendliness — this is
// an internal tool, so jargon is allowed here (DESIGN_BRIEF), unlike the earner app.
import { useState } from "react";
import { useApi } from "@/lib/hooks";
import {
  fetchKpis, fetchStaffTickets, fetchStaffTicket, replyStaffTicket,
  fetchNetworks, updateNetwork, resolveFraud, fetchSettings, updateSettings,
  type StaffTicket, type NetworkConfig,
} from "@/lib/api";
import { formatPoints, formatMoney, timeAgo } from "@/lib/format";

// ---- KPI dashboard --------------------------------------------------------
export function KpiDashboard() {
  const kpis = useApi(fetchKpis, []);
  if (kpis.loading) return <p className="p-4 text-sm text-muted">Loading numbers…</p>;
  if (kpis.error) return <p className="p-4 text-sm text-danger">{kpis.error}</p>;
  const k = kpis.data!;
  const maxDay = Math.max(1, ...k.series.map((d) => d.completions));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Tile label="Verified users" value={String(k.users.total)} sub={`+${k.users.new7d} this week`} />
        <Tile label="Pending payouts" value={String(k.withdrawals.pendingCount)} sub={`${formatPoints(k.withdrawals.pendingPoints)} pts held`} warn={k.withdrawals.pendingCount > 0} />
        <Tile label="Paid (7 days)" value={String(k.withdrawals.paidCount7d)} sub={formatMoney(k.withdrawals.paidPoints7d)} />
        <Tile label="Completions today" value={String(k.earning.completionsToday)} />
        <Tile label="Points to users" value={formatPoints(k.earning.taskPointsAll)} sub="from tasks, all time" />
        <Tile label="Referral points" value={formatPoints(k.earning.referralPointsAll)} sub="all time" />
        <Tile label="Open fraud flags" value={String(k.risk.openFraud)} warn={k.risk.openFraud > 0} />
        <Tile label="Open tickets" value={String(k.risk.openTickets)} warn={k.risk.openTickets > 0} />
      </div>

      <div className="rounded-lg border border-line bg-card p-4">
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

function Tile({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${warn ? "border-danger/30 bg-danger-tint/40" : "border-line bg-card"}`}>
      <p className="num text-2xl font-bold text-brand-ink">{value}</p>
      <p className="text-xs font-medium text-brand-ink">{label}</p>
      {sub && <p className="text-[11px] text-muted">{sub}</p>}
    </div>
  );
}

// ---- Support-ticket queue (agent+) ---------------------------------------
const TICKET_STATUSES = ["open", "answered", "closed"];

export function TicketQueue() {
  const [status, setStatus] = useState("open");
  const [openId, setOpenId] = useState<string | null>(null);
  const queue = useApi(() => fetchStaffTickets(status), [status]);

  return (
    <section className="mb-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-bold text-brand-ink">Support tickets</h2>
        <div className="flex flex-wrap gap-1">
          {TICKET_STATUSES.map((s) => (
            <button key={s} onClick={() => setStatus(s)}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold ${status === s ? "bg-brand text-white" : "bg-brand-tint text-brand"}`}>
              {s}
            </button>
          ))}
        </div>
      </div>

      {queue.loading ? <p className="p-4 text-sm text-muted">Loading…</p>
        : queue.error ? <p className="p-4 text-sm text-danger">{queue.error}</p>
        : (queue.data?.tickets.length ?? 0) === 0 ? (
          <p className="rounded-lg border border-line bg-card p-4 text-sm text-muted">No {status} tickets.</p>
        ) : (
          <div className="space-y-2">
            {queue.data!.tickets.map((t: StaffTicket) => (
              <div key={t.id} className="rounded-lg border border-line bg-card">
                <button onClick={() => setOpenId(openId === t.id ? null : t.id)}
                  className="flex w-full items-center justify-between gap-3 p-3 text-left">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-brand-ink">{t.subject}</p>
                    <p className="text-xs text-muted">{t.userEmail} · {t.messageCount} message(s) · {timeAgo(t.updatedAt)}</p>
                  </div>
                  <span className="shrink-0 text-xs font-semibold uppercase text-brand">{openId === t.id ? "Close" : "Open"}</span>
                </button>
                {openId === t.id && <TicketThread id={t.id} onChange={queue.reload} />}
              </div>
            ))}
          </div>
        )}
    </section>
  );
}

function TicketThread({ id, onChange }: { id: string; onChange: () => void }) {
  const thread = useApi(() => fetchStaffTicket(id), [id]);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send(close: boolean) {
    setBusy(true); setErr(null);
    try { await replyStaffTicket(id, reply.trim(), close); setReply(""); thread.reload(); onChange(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  if (thread.loading) return <p className="border-t border-line p-3 text-sm text-muted">Loading…</p>;
  if (thread.error) return <p className="border-t border-line p-3 text-sm text-danger">{thread.error}</p>;

  return (
    <div className="border-t border-line p-3 space-y-3">
      <div className="space-y-2">
        {thread.data!.messages.map((m, i) => (
          <div key={i} className={`max-w-[85%] rounded-lg p-2 text-sm ${m.author_role === "staff" ? "ml-auto bg-brand text-white" : "bg-brand-tint text-brand-ink"}`}>
            <p className="whitespace-pre-wrap">{m.body}</p>
            <p className={`mt-1 text-[11px] ${m.author_role === "staff" ? "text-white/70" : "text-muted"}`}>
              {m.author_role === "staff" ? "Staff" : "User"} · {timeAgo(m.created_at)}
            </p>
          </div>
        ))}
      </div>
      <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={2}
        placeholder="Reply to the user…" className="w-full rounded-md border border-line bg-card p-2 text-sm outline-none" />
      {err && <p className="text-sm text-danger">{err}</p>}
      <div className="flex gap-2">
        <button disabled={!reply.trim() || busy} onClick={() => send(false)}
          className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Send reply</button>
        <button disabled={!reply.trim() || busy} onClick={() => send(true)}
          className="rounded-md bg-success px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Send &amp; close</button>
      </div>
    </div>
  );
}

// ---- Treasury / hot wallet (admin only) ------------------------------------
// The wallet the founder funds with USDT and every manual payout is sent FROM.
// One address per chain. The API stores only the ADDRESS (never a key), so this
// screen can't move funds — it exists so (a) the founder records where the
// treasury lives, (b) whoever pays a withdrawal sends from the right wallet,
// and (c) the deposit address is one copy-click away when topping up.
const TREASURY_CHAINS = [
  { id: "bep20" as const, label: "BEP20 (BNB Chain)" },
  { id: "base" as const, label: "Base" },
  { id: "aptos" as const, label: "Aptos" },
];

export function TreasuryPanel() {
  const s = useApi(fetchSettings, []);
  const [draft, setDraft] = useState<Partial<Record<"bep20" | "base" | "aptos", string>>>({});
  const [busy, setBusy] = useState(false);

  async function save(chain: "bep20" | "base" | "aptos") {
    const address = (draft[chain] ?? "").trim();
    setBusy(true);
    try {
      await updateSettings({ treasury: { [chain]: address } });
      s.reload();
      setDraft((d) => ({ ...d, [chain]: undefined }));
    } catch (e) {
      window.alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-8">
      <h2 className="mb-2 font-bold text-brand-ink">Treasury wallet (hot wallet)</h2>
      <p className="mb-2 text-xs text-muted">
        This is the wallet you fund with USDT and send every payout from — one address per
        network. Deposit USDT to it from your exchange; when you mark a withdrawal paid, send
        from this wallet. Only the address is stored here (never a key), and every change is
        written to the audit log.
      </p>
      {s.loading ? <p className="p-4 text-sm text-muted">Loading…</p>
        : s.error ? <p className="p-4 text-sm text-danger">{s.error}</p>
        : (
          <div className="space-y-2 rounded-lg border border-line p-3">
            {TREASURY_CHAINS.map((c) => {
              const saved = s.data?.treasury?.[c.id] ?? "";
              const value = draft[c.id] ?? saved;
              const dirty = draft[c.id] !== undefined && draft[c.id] !== saved;
              return (
                <div key={c.id} className="flex flex-wrap items-center gap-2">
                  <span className="w-36 shrink-0 text-sm font-semibold text-brand-ink">{c.label}</span>
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
  const [fee, setFee] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const current = s.data?.withdrawalFeePoints ?? 0;
  const value = fee ?? current;

  async function save() {
    setBusy(true);
    try { await updateSettings({ withdrawalFeePoints: value }); s.reload(); setFee(null); }
    catch (e) { window.alert((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <section className="mb-8">
      <h2 className="mb-2 font-bold text-brand-ink">Withdrawal fee</h2>
      <p className="mb-2 text-xs text-muted">Flat points fee taken out of every withdrawal (covers network/gas cost). 0 = no fee. The user sees the fee and the net amount before they confirm.</p>
      <div className="flex items-center gap-2 rounded-lg border border-line p-3">
        <input type="number" min={0} max={1000000} value={value}
          onChange={(e) => setFee(Number(e.target.value))}
          className="num w-28 rounded border border-line bg-card p-1.5 text-sm outline-none" />
        <span className="text-sm text-muted">points per withdrawal</span>
        {fee !== null && fee !== current && (
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
          <div className="overflow-x-auto rounded-lg border border-line">
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
    </section>
    </>
  );
}

function NetworkRow({ net, onSaved }: { net: NetworkConfig; onSaved: () => void }) {
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
    catch (e) { window.alert((e as Error).message); }
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

// ---- Fraud resolve action (used by the fraud panel) ----------------------
export function ResolveFlagButton({ id, onResolved }: { id: string; onResolved: () => void }) {
  const [busy, setBusy] = useState(false);
  async function resolve() {
    const note = window.prompt("How was this resolved? (optional)") ?? undefined;
    setBusy(true);
    try { await resolveFraud(id, note); onResolved(); }
    catch (e) { window.alert((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <button disabled={busy} onClick={resolve}
      className="rounded-md bg-brand px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">Resolve</button>
  );
}
