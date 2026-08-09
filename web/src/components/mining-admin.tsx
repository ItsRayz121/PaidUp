"use client";

// Admin control surface for the ROZI economy (docs/MINING_SPEC.md § 10).
// Internal tool: density over friendliness, jargon allowed. Every number here is
// live-tunable with no redeploy — and every write is audit-logged server-side,
// because an Admin who can open a conversion window can commit real Points.
import { useState } from "react";
import { useApi } from "@/lib/hooks";
import {
  fetchMiningSettings, updateMiningSettings, fetchMiningStats, settleMining,
  fetchAdminRigs, updateAdminRig, fetchConversion, openConversionWindow,
  settleConversionWindow, fetchStoreAdmin, createStoreItem, updateStoreItem,
  fetchRedemptions, decideRedemption,
  fetchAdminTopups, confirmTopup, rejectTopup,
  fetchAdminRefunds, payRefund, rejectRefund, type MiningStats,
} from "@/lib/api";
// The staff panel deliberately still shows POINTS, not USDT. This is where the
// ledger is reconciled, and hiding the underlying unit from the people checking
// the numbers would make them harder to check, not easier.
import { formatPoints, timeAgo } from "@/lib/format";

const n = (v: number) => v.toLocaleString();

// Grouped so the panel reads as the spec does, rather than as one flat wall of
// inputs. Labels spell out what the number actually does to the economy.
const GROUPS: { title: string; note?: string; keys: [string, string][] }[] = [
  {
    title: "Emission model",
    note: "\"pi\" = each miner earns their own base rate × their multipliers; nobody else's mining reduces it, and a halving is a clean 50% cut to the person. \"pool\" = the old Bitcoin-style fixed daily pot split pro-rata (a user's earnings then fall from halving AND dilution, stacked). Must be exactly \"pi\" or \"pool\" — the API refuses anything else, because a typo would silently re-price everyone.",
    keys: [
      ["emissionModel", "Model — \"pi\" or \"pool\""],
    ],
  },
  {
    title: "Pi model — rate & halving",
    note: "Base rate is what a BASELINE miner (no multipliers) earns for a full day. Multipliers multiply it. The rate HALVES each time the user base crosses a milestone — that is the throttle, and it is what stops growth draining the pool. Keep the effective rate above ~10: below that, someone who mined only part of a day rounds down to zero and earns nothing.",
    keys: [
      ["piBaseRate", "Base rate (ROZI/day, baseline miner)"],
      ["piHalvingUsers", "Halve at user counts (comma-separated)"],
      ["piReferenceHours", "A \"full day\" of mining = N hours"],
    ],
  },
  {
    title: "Pool model — emission",
    note: "Only used when the model above is \"pool\". Changing these affects FUTURE epochs only; settled epochs are immutable. The supply cap is a hard ceiling enforced at settlement under BOTH models, whatever you put in the other boxes.",
    keys: [
      ["baseEmission", "ROZI emitted per day (E₀)"],
      ["halvingEpochs", "Halve emission every N days"],
      ["supplyCap", "Hard supply cap (ROZI, ever)"],
    ],
  },
  {
    title: "Sessions & hashrate",
    keys: [
      ["sessionHours", "Session length (hours)"],
      ["baseHashrate", "Base hashrate (everyone)"],
      ["maxHashrate", "Max hashrate per user"],
      ["streakStepPct", "Streak bonus per day (%)"],
      ["streakCapDays", "Streak caps at (days)"],
    ],
  },
  {
    title: "Boosts",
    note: "The task boost is the line that makes mining feed the offerwall instead of competing with it. Lowering it to 0 turns mining into a pure cost. NOTE: ads need adsEnabled=1 AND an ad provider set — the flag alone does nothing, on purpose, so you cannot switch on free boosts before the real ad tag is integrated. Monetag websites get three formats: the VIGNETTE zone id (ad around the Start-mining tap; passive, no boost), the DIRECT LINK url (the watch-to-boost button; server dwell timer + daily cap decide the boost), and the BANNER zone id (an In-Page Push zone — small dismissible bar shown on the mining screen only; passive impressions, no boost). Each empty value disables its own part.",
    keys: [
      ["taskBoostPct", "Task boost (%)"],
      ["taskBoostHours", "Task boost lasts (hours)"],
      ["taskBoostMaxStack", "Max task boosts stacked"],
      ["adBoostPct", "Ad boost (%)"],
      ["adBoostHours", "Ad boost lasts (hours)"],
      ["adWatchDailyCap", "Ads per user per day"],
      ["adsEnabled", "Ads on (1) / off (0)"],
      ["adProvider", "Ad provider (monetag / adsterra)"],
      ["monetagZoneId", "Monetag vignette zone id"],
      ["monetagDirectLink", "Monetag direct link URL"],
      ["monetagBannerZone", "Monetag banner zone id (In-Page Push)"],
      ["monetagRewardedZone", "Monetag rewarded video zone id (Telegram Mini App only)"],
    ],
  },
  {
    title: "Referral hashrate",
    keys: [
      ["referralL1Pct", "Level 1 — % of invitee hashrate"],
      ["referralL2Pct", "Level 2 — % of indirect hashrate"],
      ["referralCapPct", "Referral cap (% of own hashrate)"],
      ["referralActiveHours", "Invitee counts only if mined within (hours)"],
    ],
  },
  {
    title: "Transfers",
    note: "Wallet-to-wallet only. There is no order book and there will not be one: matching trades or holding the money leg would make us an unlicensed exchange.",
    keys: [
      ["transfersEnabled", "Transfers on (1) / off (0)"],
      ["transferDailyCap", "Daily send cap (ROZI)"],
      ["transferMinAccountDays", "Min account age (days)"],
      ["transferFeePct", "Transfer fee, burned (%)"],
    ],
  },
  {
    title: "Conversion & admin",
    keys: [
      ["conversionEnabled", "Conversion on (1) / off (0)"],
      ["conversionSharePct", "Suggested pot = this % of margin"],
      // The per-user ceiling. The pot caps what the BUSINESS pays out in total;
      // this caps what any ONE account can ever extract, measured against what
      // that account mined over its whole life. 100 = no ceiling.
      ["conversionMaxPctOfMined", "Max % of mined ROZI one user can convert"],
      ["adminAdjustMaxRozi", "Max ROZI per manual adjustment"],
    ],
  },
  {
    title: "USDT top-up (deposits)",
    note: "Ships OFF, and stays off until BOTH usdtTopupEnabled=1 AND usdtTreasuryAddress are set — a top-up screen with no address to send to would take people's money nowhere. This is the setting the Receive/top-up screen checks; without it, no address (personal or shared) is ever shown to any user, regardless of whether the per-user deposit-address system (CUSTODY_XPUB_BEP20) is configured. usdtTreasuryChain must stay \"bep20\" — the API refuses anything else. usdtTreasuryAddress must be the TREASURY wallet's address (the one you funded), never a private key.",
    keys: [
      ["usdtTopupEnabled", "Top-ups on (1) / off (0)"],
      ["usdtTreasuryChain", "Chain (must be \"bep20\")"],
      ["usdtTreasuryAddress", "Treasury wallet address (0x...)"],
      ["usdtMinTopup", "Minimum deposit (whole USDT)"],
      ["usdtMaxTopup", "Max per claim before a human re-checks it (whole USDT)"],
    ],
  },
];

export function MiningPanel() {
  const settings = useApi(fetchMiningSettings, []);
  const stats = useApi(fetchMiningStats, []);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const cur = settings.data?.settings ?? {};
  const dirty = Object.keys(draft).length > 0;

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const patch: Record<string, number | string> = {};
      for (const [k, v] of Object.entries(draft)) {
        // String settings pass through as typed. Deciding by the CURRENT value's
        // type (not a hand-kept key list) is what keeps this from mangling the
        // next string setting someone adds — the old `k === "adProvider"` check
        // was quietly turning an edited emissionModel or piHalvingUsers into NaN.
        patch[k] = typeof cur[k] === "number" ? Number(v) : v;
      }
      await updateMiningSettings(patch);
      setDraft({});
      settings.reload();
      stats.reload();
      setMsg("Saved. Live immediately — no redeploy.");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function onSettle() {
    if (!window.confirm("Settle all closed, unsettled epochs now? This mints ROZI. It is idempotent, so a double-click is safe.")) return;
    try {
      await settleMining();
      stats.reload();
      setMsg("Settlement run.");
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      {stats.data && <StatsHeader s={stats.data} onSettle={onSettle} />}

      <ConversionPanel />

      <StorePanel />

      <RigPanel />

      {/* ⚠️ TopupPanel / RefundPanel USED TO RENDER HERE AND MUST NOT COME BACK.
          They are USDT deposits and deposit refunds — money in and money out —
          and their permissions say so (`deposits.*`, `refunds.*`, grouped under
          "Money in" in permissions.ts). This section is gated on
          `mining.manage`/`machines.manage`, which the Finance role does not
          hold, so sitting here made the deposit-confirm and refund-payout
          queues unreachable by the exact role that owns them. They live under
          Money & payouts now. See staff/page.tsx. */}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-bold text-brand-ink">Economy settings</h3>
          {dirty && (
            <button
              onClick={save}
              disabled={saving}
              className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              {saving ? "Saving…" : `Save ${Object.keys(draft).length} change(s)`}
            </button>
          )}
        </div>

        {msg && <p className="mb-2 rounded-md border border-line bg-card p-2 text-xs text-brand-ink">{msg}</p>}

        {settings.loading ? (
          <p className="p-4 text-sm text-muted">Loading…</p>
        ) : settings.error ? (
          <p className="p-4 text-sm text-danger">{settings.error}</p>
        ) : (
          <div className="space-y-4">
            {GROUPS.map((g) => (
              <div key={g.title} className="rounded-lg border border-line bg-card p-3">
                <h4 className="text-sm font-bold text-brand-ink">{g.title}</h4>
                {g.note && <p className="mt-1 text-xs text-muted">{g.note}</p>}
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {g.keys.map(([key, label]) => (
                    <label key={key} className="flex items-center justify-between gap-3 text-xs">
                      <span className="min-w-0 flex-1 text-muted">{label}</span>
                      <input
                        value={draft[key] ?? String(cur[key] ?? "")}
                        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                        className={`w-32 shrink-0 rounded-md border px-2 py-1 text-right font-mono ${
                          draft[key] !== undefined ? "border-brand bg-brand-tint" : "border-line"
                        }`}
                      />
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatsHeader({ s, onSettle }: { s: MiningStats; onSettle: () => void }) {
  const pctEmitted = (s.supply.emitted / s.supply.cap) * 100;
  const isPi = s.emissionModel === "pi";

  return (
    <div className="rounded-lg border border-line bg-card p-3">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-bold text-brand-ink">ROZI economy · day {s.epoch}</h3>
        <button onClick={onSettle} className="rounded-md bg-brand-tint px-2.5 py-1 text-xs font-semibold text-brand">
          Settle now
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {isPi ? (
          <Stat
            label="Rate now"
            value={s.pi.effectiveRate.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            sub={`ROZI/day · ${s.pi.halvingsSoFar} halving${s.pi.halvingsSoFar === 1 ? "" : "s"}`}
          />
        ) : (
          <Stat label="Today's emission" value={n(s.todayEmission)} sub="ROZI" />
        )}
        <Stat label="Miners today" value={n(s.today.miners)} sub={`${n(s.today.activeSessions)} mining now`} />
        <Stat label="Circulating" value={n(s.supply.circulating)} sub={`${n(s.supply.burned)} burned`} />
        <Stat label="Emitted of cap" value={`${pctEmitted.toFixed(2)}%`} sub={`${n(s.supply.remaining)} left`} />
      </div>

      {isPi && (
        <div className="mt-3 rounded-md border border-line bg-card p-2 text-xs">
          <p className="text-muted">
            <strong className="text-brand-ink">Pi model.</strong>{" "}
            A baseline miner earns{" "}
            <strong className="font-mono text-brand-ink">
              {s.pi.effectiveRate.toLocaleString(undefined, { maximumFractionDigits: 2 })} ROZI
            </strong>{" "}
            for a full day (base {n(s.pi.baseRate)}, halved {s.pi.halvingsSoFar}×).
            Multipliers multiply this. Verified users{" "}
            <strong className="font-mono text-brand-ink">{n(s.pi.population)}</strong>
            {s.pi.nextMilestone !== null ? (
              <> — next halving at <strong className="font-mono text-brand-ink">{n(s.pi.nextMilestone)}</strong> verified users.</>
            ) : (
              <> — all milestones passed; the rate no longer halves.</>
            )}
          </p>
          <p className="mt-1 text-[11px] text-muted">
            Only ID-verified users count toward a halving, so a wave of fake signups
            cannot force one.
          </p>
          {/* The rate is so low that even a FULL day rounds to nothing. Since the
              ledger holds millionths now, this needs the rate near zero — it is no
              longer the old "single digits" whole-ROZI bug. */}
          {s.pi.rateTooLow && (
            <p className="mt-1.5 rounded bg-danger-tint p-1.5 font-semibold text-danger">
              The rate is so low that even a full day of mining now rounds to ZERO.
              Raise the base rate or widen the milestones.
            </p>
          )}
        </div>
      )}

      {/* MINING POOL TRACKER — total pool, mined so far, and what's left, as raw
          numbers plus a bar. This is the "how much of the whole thing is gone"
          view: when the bar is near full, the mineable supply is nearly spent. */}
      <div className="mt-3 rounded-md border border-line bg-brand-tint/40 p-3">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-brand-ink">Mining pool</span>
          <span className="font-mono text-muted">{pctEmitted.toFixed(2)}% mined</span>
        </div>
        <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-line">
          <div
            className="h-full rounded-full bg-brand transition-all"
            style={{ width: `${Math.min(100, pctEmitted)}%` }}
          />
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted">Total pool</p>
            <p className="font-mono text-sm font-bold text-brand-ink">{n(s.supply.cap)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted">Mined so far</p>
            <p className="font-mono text-sm font-bold text-brand-ink">{n(s.supply.emitted)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted">Remaining</p>
            <p className="font-mono text-sm font-bold text-brand-ink">{n(s.supply.remaining)}</p>
          </div>
        </div>
      </div>

      {/* THE number to watch. If the ROZI float would cost, at the last window's
          rate, anything approaching your real margin, the next conversion window
          will be brutal — shrink emission BEFORE that happens, not after. */}
      {s.poolCoveragePoints !== null && (
        <p className="mt-3 rounded-md bg-pending-tint/50 p-2 text-xs text-brand-ink">
          <strong>Pool coverage:</strong> the whole circulating ROZI float would cost{" "}
          <strong className="font-mono">{formatPoints(s.poolCoveragePoints)} points</strong> at the last
          window&rsquo;s clearing rate. If this approaches your real margin, cut emission now.
        </p>
      )}

      {s.epochs.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[520px] text-xs">
            <thead className="text-left uppercase text-muted">
              <tr>
                <th className="py-1">Day</th><th>Emission</th><th>Miners</th>
                <th>Emitted</th><th>Withheld</th>
              </tr>
            </thead>
            <tbody>
              {s.epochs.map((e) => (
                <tr key={e.epoch} className="border-t border-line font-mono">
                  <td className="py-1">{e.epoch}</td>
                  <td>{n(e.emission)}</td>
                  <td>{n(e.miners)}</td>
                  <td>{n(e.emitted)}</td>
                  <td className={e.withheld > 0 ? "text-danger" : ""}>{n(e.withheld)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md bg-brand-tint/50 p-2">
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p className="font-mono text-lg font-bold text-brand-ink">{value}</p>
      {sub && <p className="text-[10px] text-muted">{sub}</p>}
    </div>
  );
}

function ConversionPanel() {
  const conv = useApi(fetchConversion, []);
  const [pot, setPot] = useState("");
  const [hours, setHours] = useState("168");
  const [msg, setMsg] = useState<string | null>(null);

  const d = conv.data;
  const open = d?.windows.find((w) => w.status === "open");

  async function onOpen() {
    const potN = Number(pot);
    if (!potN || potN <= 0) return setMsg("Enter a pot size in points.");
    if (!window.confirm(
      `Open a window with a pot of ${formatPoints(potN)} POINTS?\n\n` +
      `This commits real, cash-redeemable points. Users burn ROZI into the pot and split it pro-rata. ` +
      `The pot is a hard ceiling — the system cannot pay out more than this — but it CAN pay out all of it.`,
    )) return;
    try {
      await openConversionWindow(potN, Number(hours) || 168);
      setPot("");
      conv.reload();
      setMsg("Window open.");
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function onSettle(id: string) {
    if (!window.confirm("Settle this window? Points are credited to everyone who burned, pro-rata. This cannot be undone.")) return;
    try {
      const r = await settleConversionWindow(id);
      conv.reload();
      setMsg(`Settled: ${formatPoints(r.pointsPaid)} points to ${r.users} users for ${n(r.totalBurned)} ROZI burned.`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  if (conv.loading || !d) return null;

  return (
    <div className="rounded-lg border border-line bg-card p-3">
      <h3 className="font-bold text-brand-ink">
        ROZI → Points conversion{" "}
        <span className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
          d.enabled ? "bg-success-tint text-success" : "bg-brand-tint text-muted"
        }`}>
          {d.enabled ? "on" : "off"}
        </span>
      </h3>

      <p className="mt-1 text-xs text-muted">
        The only bridge between the two ledgers. Users burn ROZI into a fixed pot of points and split it
        pro-rata — the rate floats, and there is no fixed ROZI→points rate anywhere by design.
        Turn it on in the settings below when the lock period ends.
      </p>

      {msg && <p className="mt-2 rounded-md border border-line p-2 text-xs text-brand-ink">{msg}</p>}

      {/* Computed from the margin we ACTUALLY earned, so a pot cannot be committed
          out of money the business never made. */}
      <div className="mt-3 rounded-md bg-brand-tint/50 p-2 text-xs">
        <p className="text-muted">
          Margin, last 7 days: <strong className="font-mono text-brand-ink">{formatPoints(d.marginPointsLast7Days)} points</strong>
        </p>
        <p className="text-muted">
          Suggested pot ({d.conversionSharePct}% of margin):{" "}
          <strong className="font-mono text-brand-ink">{formatPoints(d.suggestedPotPoints)} points</strong>
          {d.suggestedPotPoints > 0 && (
            <button
              onClick={() => setPot(String(d.suggestedPotPoints))}
              className="ml-2 rounded bg-brand px-1.5 py-0.5 text-[10px] font-semibold text-white"
            >
              use
            </button>
          )}
        </p>
      </div>

      {open ? (
        <div className="mt-3 rounded-md border border-brand/30 bg-brand-tint/40 p-2 text-xs">
          <p className="font-semibold text-brand-ink">
            Window open · pot {formatPoints(open.pot_points)} points · {n(open.total_burned)} ROZI burned so far
          </p>
          <p className="text-muted">Closes {new Date(open.closes_at).toLocaleString()}</p>
          <button
            onClick={() => onSettle(open.id)}
            className="mt-2 rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white"
          >
            Settle window & pay out
          </button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs">
            <span className="block text-muted">Pot (points)</span>
            <input value={pot} onChange={(e) => setPot(e.target.value)}
              className="w-32 rounded-md border border-line px-2 py-1 text-right font-mono" />
          </label>
          <label className="text-xs">
            <span className="block text-muted">Open for (hours)</span>
            <input value={hours} onChange={(e) => setHours(e.target.value)}
              className="w-24 rounded-md border border-line px-2 py-1 text-right font-mono" />
          </label>
          <button onClick={onOpen} className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white">
            Open window
          </button>
        </div>
      )}

      {d.windows.filter((w) => w.status === "settled").length > 0 && (
        // Scrolls inside its own box on a phone, like every other staff table.
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[460px] text-xs">
            <thead className="text-left uppercase text-muted">
              <tr><th className="py-1">Settled</th><th>Pot</th><th>ROZI burned</th><th>Paid</th><th>Rate</th></tr>
            </thead>
            <tbody>
              {d.windows.filter((w) => w.status === "settled").map((w) => (
                <tr key={w.id} className="border-t border-line font-mono">
                  <td className="py-1">{w.settled_at ? new Date(w.settled_at).toLocaleDateString() : "—"}</td>
                  <td>{formatPoints(w.pot_points)}</td>
                  <td>{n(w.total_burned)}</td>
                  <td>{formatPoints(w.points_paid)}</td>
                  <td>{w.total_burned > 0 ? (w.points_paid / w.total_burned).toFixed(4) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- ROZI store: catalogue + the fulfilment queue --------------------------
//
// This is a SINK, and the panel is written to keep it one. What an Admin sets is
// a PRICE IN ROZI for a fixed number of items — never a rate at which we buy
// ROZI back. Exposure is bounded by stock, which is why stock is a required
// field and not an optional nicety.
//
// A redemption is a human job like a withdrawal: the ROZI was taken when the
// user asked, so the only outcomes are "done" or "give it back". Reject refunds
// the exact amount snapshotted on the row and returns the item to stock.
function StorePanel() {
  const items = useApi(fetchStoreAdmin, []);
  const [queueFilter, setQueueFilter] = useState<string>("pending");
  const queue = useApi(() => fetchRedemptions(queueFilter), [queueFilter]);
  const [msg, setMsg] = useState<string | null>(null);
  const [draft, setDraft] = useState({ title: "", costRozi: "", stock: "", inputLabel: "", description: "" });

  async function add() {
    try {
      await createStoreItem({
        title: draft.title.trim(),
        description: draft.description.trim() || undefined,
        costRozi: Number(draft.costRozi),
        inputLabel: draft.inputLabel.trim() || undefined,
        stock: Number(draft.stock),
      });
      setDraft({ title: "", costRozi: "", stock: "", inputLabel: "", description: "" });
      setMsg("Added.");
      items.reload();
    } catch (e) { setMsg((e as Error).message); }
  }

  async function patch(id: string, p: Parameters<typeof updateStoreItem>[1]) {
    try { await updateStoreItem(id, p); items.reload(); }
    catch (e) { setMsg((e as Error).message); }
  }

  async function decide(id: string, action: "fulfil" | "reject") {
    const note = window.prompt(
      action === "reject"
        ? "Why? The user sees this, and their ROZI goes back."
        : "Any note for the record? (optional)",
    );
    if (action === "reject" && note === null) return; // cancelled
    try {
      await decideRedemption(id, action, note ?? undefined);
      queue.reload();
      items.reload();
    } catch (e) { setMsg((e as Error).message); }
  }

  const inp = "rounded border border-line bg-card p-1 text-sm outline-none";
  const ready = draft.title.trim() !== "" && Number(draft.costRozi) > 0 && draft.stock !== "";

  return (
    <div className="rounded-lg border border-line bg-card p-3">
      <h3 className="font-bold text-brand-ink">ROZI store</h3>
      <p className="mt-1 text-xs text-muted">
        A ROZI sink: users spend mined ROZI on real goods at a price you set and can raise. This is
        deliberately not a buy-back rate — exposure is capped by <strong>stock</strong>, so the most this
        can ever cost is stock × your unit cost. Rejecting a redemption refunds the exact ROZI taken
        and returns the item to stock.
      </p>
      {msg && <p className="mt-2 text-xs text-brand">{msg}</p>}

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[760px] text-xs [&_td]:p-1.5 [&_th]:p-1.5 [&_th]:text-left">
          <thead className="text-[10px] uppercase text-muted">
            <tr><th>Item</th><th>Cost (ROZI)</th><th>Stock</th><th>Asks user for</th><th>Status</th></tr>
          </thead>
          <tbody>
            {(items.data?.items ?? []).map((i) => (
              <tr key={i.id} className="border-t border-line">
                <td className="font-medium text-brand-ink">{i.title}
                  {i.description && <div className="text-[10px] text-muted">{i.description}</div>}
                </td>
                <td>
                  <input type="number" min={1} defaultValue={i.costRozi} className={`${inp} num w-24`}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v > 0 && v !== i.costRozi) patch(i.id, { costRozi: v });
                    }} />
                </td>
                <td>
                  <input type="number" min={0} defaultValue={i.stock} className={`${inp} num w-20`}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v >= 0 && v !== i.stock) patch(i.id, { stock: v });
                    }} />
                </td>
                <td className="text-muted">{i.inputLabel ?? "—"}</td>
                <td>
                  <button
                    onClick={() => patch(i.id, { status: i.status === "active" ? "hidden" : "active" })}
                    className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                      i.status === "active" ? "bg-success-tint text-success" : "bg-danger-tint text-danger"
                    }`}>
                    {i.status}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
        <input placeholder="Item name" value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })} className={`${inp} w-40`} />
        <input placeholder="Description" value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })} className={`${inp} w-44`} />
        <input type="number" placeholder="Cost ROZI" value={draft.costRozi}
          onChange={(e) => setDraft({ ...draft, costRozi: e.target.value })} className={`${inp} num w-24`} />
        <input type="number" placeholder="Stock" value={draft.stock}
          onChange={(e) => setDraft({ ...draft, stock: e.target.value })} className={`${inp} num w-20`} />
        <input placeholder="Ask user for… (e.g. Phone number)" value={draft.inputLabel}
          onChange={(e) => setDraft({ ...draft, inputLabel: e.target.value })} className={`${inp} w-52`} />
        <button onClick={add} disabled={!ready}
          className="rounded bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
          Add item
        </button>
      </div>

      <div className="mt-4 border-t border-line pt-3">
        <div className="mb-2 flex items-center gap-2">
          <h4 className="font-semibold text-brand-ink">Orders to fulfil</h4>
          <select value={queueFilter} onChange={(e) => setQueueFilter(e.target.value)}
            className={`${inp} text-xs`}>
            <option value="pending">Pending</option>
            <option value="fulfilled">Fulfilled</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>
        {queue.loading ? <p className="text-xs text-muted">Loading…</p>
          : (queue.data?.redemptions ?? []).length === 0
            ? <p className="text-xs text-muted">Nothing here.</p>
            : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-xs [&_td]:p-1.5 [&_th]:p-1.5 [&_th]:text-left">
                  <thead className="text-[10px] uppercase text-muted">
                    <tr><th>When</th><th>User</th><th>Item</th><th>ROZI</th><th>Send to</th><th></th></tr>
                  </thead>
                  <tbody>
                    {(queue.data?.redemptions ?? []).map((r) => (
                      <tr key={r.id} className="border-t border-line">
                        <td className="text-muted">{new Date(r.at).toLocaleString()}</td>
                        <td className="text-brand-ink">{r.email}</td>
                        <td>{r.title}</td>
                        <td className="num">{n(r.costRozi)}</td>
                        <td className="font-mono text-brand-ink">{r.target ?? "—"}</td>
                        <td>
                          {r.status === "pending" ? (
                            <div className="flex gap-1.5">
                              <button onClick={() => decide(r.id, "fulfil")}
                                className="rounded bg-success px-2 py-0.5 text-[10px] font-semibold text-white">Done</button>
                              <button onClick={() => decide(r.id, "reject")}
                                className="rounded bg-danger px-2 py-0.5 text-[10px] font-semibold text-white">Refund</button>
                            </div>
                          ) : (
                            <span className="text-muted">{r.status}{r.staffNote ? ` — ${r.staffNote}` : ""}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
      </div>
    </div>
  );
}

function RigPanel() {
  const rigs = useApi(fetchAdminRigs, []);
  const [msg, setMsg] = useState<string | null>(null);

  async function toggle(id: string, status: string) {
    try {
      await updateAdminRig(id, { status: status === "active" ? "disabled" : "active" });
      rigs.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  // Set (or clear) the USDT price on one rig. Blank/0 means ROZI only.
  async function setUsdt(id: string, raw: string) {
    const v = raw.trim();
    try {
      await updateAdminRig(id, { baseCostUsdt: v === "" ? null : Number(v) });
      rigs.reload();
      setMsg(null);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  if (rigs.loading || !rigs.data) return null;

  return (
    <div className="rounded-lg border border-line bg-card p-3">
      <h3 className="font-bold text-brand-ink">Rigs (the ROZI sink)</h3>
      <p className="mt-1 text-xs text-muted">
        Cost growth must always exceed power growth, or each level gets cheaper per H/s and hashrate runs
        away. The API refuses to save a rig that inverts that.
      </p>
      {/* The trap, stated where the field is. An admin setting this number is
          publishing a ROZI valuation whether they mean to or not. */}
      <p className="mt-1.5 rounded bg-pending-tint p-1.5 text-[11px] text-pending">
        <strong>USDT price:</strong> blank = ROZI only, which is the default for every rig.
        Setting one publishes an <strong>implied ROZI rate</strong> — a rig at 100 ROZI or $10 tells
        every user that ROZI is $0.10, for a token we say has no price. Price the USDT option well
        ABOVE what the ROZI price implies: real money buys convenience, not a discount.
      </p>
      {msg && <p className="mt-2 text-xs text-danger">{msg}</p>}

      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[640px] text-xs">
          <thead className="text-left uppercase text-muted">
            <tr>
              <th className="py-1">Rig</th><th>Base cost</th><th>Cost ×</th>
              <th>Base power</th><th>Power ×</th><th>Max lvl</th><th>USDT</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rigs.data.rigs.map((r) => (
              <tr key={r.id} className="border-t border-line">
                <td className="py-1.5 font-semibold text-brand-ink">{r.name}</td>
                <td className="font-mono">{n(r.base_cost)}</td>
                <td className="font-mono">{(r.cost_growth / 100).toFixed(2)}</td>
                <td className="font-mono">{n(r.base_power)}</td>
                <td className="font-mono">{(r.power_growth / 100).toFixed(2)}</td>
                <td className="font-mono">{r.max_level}</td>
                <td>
                  <input
                    type="number" min={0} step={0.5}
                    defaultValue={r.base_cost_usdt ?? ""}
                    placeholder="—"
                    onBlur={(e) => {
                      const next = e.target.value.trim();
                      const cur = r.base_cost_usdt === null ? "" : String(r.base_cost_usdt);
                      if (next !== cur) setUsdt(r.id, next);
                    }}
                    className="w-20 rounded border border-line bg-card px-1.5 py-0.5 font-mono"
                  />
                </td>
                <td>
                  <button onClick={() => toggle(r.id, r.status)}
                    className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                      r.status === "active" ? "bg-success-tint text-success" : "bg-danger-tint text-danger"
                    }`}>
                    {r.status}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// The USDT refund queue — sending a user's own unspent deposit back to them
// (founder, 2026-08-01).
//
// ⚠️ THE MONEY HAS ALREADY LEFT THEIR BALANCE. It was debited the moment they
// asked, so that they could not spend it on a machine while this queued. That
// makes the two buttons here asymmetric, and it is worth knowing which is which
// before clicking either:
//
//   "Sent"     — you have ALREADY sent the USDT by hand from the treasury and
//                are recording the proof. It moves no balance.
//   "Reject"   — you are not sending it, so the money goes BACK to their credit.
//
// So: send the USDT first, then click Sent. Clicking Sent before sending means
// a user is told their money is on the way when it is not.
export function RefundPanel() {
  const refunds = useApi(() => fetchAdminRefunds("pending"), []);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // ⚠️ SENDS netAmount, NOT amount. `amount` is what was debited from the
  // user; the gas fee (founder, 2026-08-08) comes out of what actually gets
  // sent, so sending the gross figure here would give the fee back to the
  // user for free instead of recovering the platform's gas cost.
  async function pay(id: string, netAmount: number, address: string) {
    const txHash = window.prompt(
      `Send ${netAmount} USDT to:\n\n${address}\n\n` +
      "Do that FIRST, from the treasury wallet. Then paste the transaction hash here " +
      "as proof — the user will see it.",
    );
    if (!txHash) return;
    setBusy(id);
    try {
      await payRefund(id, txHash.trim());
      setMsg(`Recorded ${netAmount} USDT as sent.`);
      refunds.reload();
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(null); }
  }

  async function decline(id: string) {
    const reason = window.prompt(
      "Why is this being rejected? The user will see this, and their USDT credit goes back.",
    );
    if (!reason) return;
    setBusy(id);
    try {
      await rejectRefund(id, reason);
      setMsg("Rejected — the money went back to their balance.");
      refunds.reload();
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(null); }
  }

  if (refunds.loading || !refunds.data) return null;
  const rows = refunds.data.refunds;

  return (
    <div className="rounded-lg border border-line bg-card p-3">
      <h3 className="font-bold text-brand-ink">USDT refunds waiting to be sent</h3>
      <p className="mt-1 text-xs text-muted">
        This is a user asking for the deposit they have not spent. It is their own money
        coming back, not their task earnings — those go out through the withdrawal queue.
        The amount has already been taken off their credit.
      </p>
      {msg && <p className="mt-2 text-xs text-brand-ink">{msg}</p>}

      {rows.length === 0 ? (
        <p className="mt-2 text-xs text-muted">Nothing waiting.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs">
            <thead className="text-left uppercase text-muted">
              <tr><th className="py-1">User</th><th>Requested</th><th>Send</th><th>Send to</th><th>When</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line align-top">
                  <td className="py-1.5">
                    <div className="font-semibold text-brand-ink">{r.username ? `@${r.username}` : r.email}</div>
                  </td>
                  <td className="font-mono">{r.amount} USDT</td>
                  <td className="font-mono font-semibold text-brand-ink">
                    {r.netAmount} USDT
                    {/* Only show the fee line when there is one — most requests
                        today have gasFeePercent/gasFeeFixedMicro at 0. */}
                    {r.feeAmount > 0 && (
                      <div className="font-sans text-[10px] text-muted">− {r.feeAmount} gas fee</div>
                    )}
                  </td>
                  <td className="max-w-[220px] break-all font-mono text-[10px]">
                    {r.address}
                    <div className="mt-0.5 font-sans text-[10px]">
                      {/* Same signal the withdrawal queue carries: a signature
                          proves the wallet is theirs; a typed address proves
                          nothing, and a refund cannot be undone either. */}
                      {r.addressVerified
                        ? <span className="text-success">signed by the user&apos;s wallet</span>
                        : <span className="text-pending">not checked — typed in</span>}
                    </div>
                  </td>
                  <td className="text-muted">{timeAgo(r.created_at)}</td>
                  <td className="whitespace-nowrap">
                    <button disabled={busy === r.id} onClick={() => pay(r.id, r.netAmount, r.address)}
                      className="rounded bg-success px-2 py-0.5 text-[10px] font-semibold text-white disabled:opacity-50">
                      Sent
                    </button>
                    <button disabled={busy === r.id} onClick={() => decline(r.id)}
                      className="ml-1.5 rounded bg-danger-tint px-2 py-0.5 text-[10px] font-semibold text-danger disabled:opacity-50">
                      Reject
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// The USDT deposit review queue.
//
// A user has told us they sent money. NOBODY IS CREDITED UNTIL A HUMAN CONFIRMS,
// and the amount that gets credited is the one typed HERE — what the reviewer
// read off the chain — never the amount the user claimed. That distinction is
// the entire reason this screen exists: without it a user sends $1, claims $500,
// and the review step is a rubber stamp on a number nobody checked.
export function TopupPanel() {
  const topups = useApi(() => fetchAdminTopups("pending"), []);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function confirm(id: string, claimed: number) {
    const raw = window.prompt(
      "How much USDT did you actually SEE on the chain?\n\n" +
      `The user claimed ${claimed}. Type what the block explorer shows — that is ` +
      "what will be credited.",
      String(claimed),
    );
    if (raw === null) return;
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) { setMsg("That is not an amount."); return; }
    setBusy(id);
    try {
      await confirmTopup(id, amount);
      setMsg(`Credited ${amount} USDT.`);
      topups.reload();
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(null); }
  }

  async function reject(id: string) {
    const reason = window.prompt("Why is this being rejected? The user will see this.");
    if (!reason) return;
    setBusy(id);
    try {
      await rejectTopup(id, reason);
      topups.reload();
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(null); }
  }

  if (topups.loading || !topups.data) return null;
  const { treasuryAddress, treasuryChain, topups: rows } = topups.data;

  return (
    <div className="rounded-lg border border-line bg-card p-3">
      <h3 className="font-bold text-brand-ink">USDT deposits waiting to be checked</h3>
      {treasuryAddress ? (
        <p className="mt-1 text-xs text-muted">
          Deposits should land at{" "}
          <span className="font-mono text-brand-ink">{treasuryAddress}</span> on{" "}
          <strong>{treasuryChain}</strong>. Open the block explorer, confirm the transaction
          exists AND landed at that address, then type the amount you saw.
        </p>
      ) : (
        <p className="mt-1 rounded bg-pending-tint p-1.5 text-xs text-pending">
          No treasury address is set, so top-ups are off. Set{" "}
          <span className="font-mono">usdtTreasuryChain</span> and{" "}
          <span className="font-mono">usdtTreasuryAddress</span> above first.
        </p>
      )}
      {msg && <p className="mt-2 text-xs text-brand-ink">{msg}</p>}

      {rows.length === 0 ? (
        <p className="mt-2 text-xs text-muted">Nothing waiting.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs">
            <thead className="text-left uppercase text-muted">
              <tr><th className="py-1">User</th><th>Claimed</th><th>Transaction</th><th>When</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line align-top">
                  <td className="py-1.5">
                    <div className="font-semibold text-brand-ink">{r.username ? `@${r.username}` : r.email}</div>
                  </td>
                  <td className="font-mono">{r.amount} USDT</td>
                  <td className="max-w-[220px] break-all font-mono text-[10px]">{r.tx_hash}</td>
                  <td className="text-muted">{timeAgo(r.created_at)}</td>
                  <td className="whitespace-nowrap">
                    <button disabled={busy === r.id} onClick={() => confirm(r.id, r.amount)}
                      className="rounded bg-success px-2 py-0.5 text-[10px] font-semibold text-white disabled:opacity-50">
                      Confirm
                    </button>
                    <button disabled={busy === r.id} onClick={() => reject(r.id)}
                      className="ml-1.5 rounded bg-danger-tint px-2 py-0.5 text-[10px] font-semibold text-danger disabled:opacity-50">
                      Reject
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
