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
  settleConversionWindow, type MiningStats,
} from "@/lib/api";
import { formatPoints } from "@/lib/format";

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
    note: "The task boost is the line that makes mining feed the offerwall instead of competing with it. Lowering it to 0 turns mining into a pure cost. NOTE: ads need adsEnabled=1 AND an ad provider set — the flag alone does nothing, on purpose, so you cannot switch on free boosts before the real ad tag is integrated. Monetag websites get two formats: the VIGNETTE zone id (ad around the Start-mining tap; passive, no boost) and the DIRECT LINK url (the watch-to-boost button; server dwell timer + daily cap decide the boost). Each empty value disables its own half.",
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
      ["adminAdjustMaxRozi", "Max ROZI per manual adjustment"],
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

      <RigPanel />

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

  if (rigs.loading || !rigs.data) return null;

  return (
    <div className="rounded-lg border border-line bg-card p-3">
      <h3 className="font-bold text-brand-ink">Rigs (the ROZI sink)</h3>
      <p className="mt-1 text-xs text-muted">
        Cost growth must always exceed power growth, or each level gets cheaper per H/s and hashrate runs
        away. The API refuses to save a rig that inverts that.
      </p>
      {msg && <p className="mt-2 text-xs text-danger">{msg}</p>}

      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[560px] text-xs">
          <thead className="text-left uppercase text-muted">
            <tr>
              <th className="py-1">Rig</th><th>Base cost</th><th>Cost ×</th>
              <th>Base power</th><th>Power ×</th><th>Max lvl</th><th></th>
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
