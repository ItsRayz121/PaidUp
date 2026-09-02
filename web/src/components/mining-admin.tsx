"use client";

// Admin control surface for the ROZI economy (docs/MINING_SPEC.md § 10).
// Internal tool: density over friendliness, jargon allowed. Every number here is
// live-tunable with no redeploy — and every write is audit-logged server-side,
// because an Admin who can open a conversion window can commit real Points.
import { useState } from "react";
import { useApi } from "@/lib/hooks";
import {
  fetchMiningSettings, updateMiningSettings, fetchMiningStats, settleMining,
  fetchMiningEpochs,
  fetchAllocations, createAllocation, updateAllocation, deleteAllocation,
  fetchAdminRigs, updateAdminRig,
  fetchAdminBoosters, createAdminBooster, updateAdminBooster,
  fetchConversion, openConversionWindow,
  settleConversionWindow, fetchStoreAdmin, createStoreItem, updateStoreItem,
  fetchRedemptions, decideRedemption,
  type MiningStats, type AllocationBucket,
} from "@/lib/api";
// The staff panel deliberately still shows POINTS, not USDT. This is where the
// ledger is reconciled, and hiding the underlying unit from the people checking
// the numbers would make them harder to check, not easier.
import { formatPoints, displayIdentity } from "@/lib/format";
import { useStaffNav } from "@/lib/staffNav";

const n = (v: number) => v.toLocaleString();

// Grouped so the panel reads as the spec does, rather than as one flat wall of
// inputs. Each field is its own bordered box: label, a plain-English one-liner
// (docs/MINING_GLOSSARY.md), then the input. `keys` is [settingKey, label, help?].
const GROUPS: { title: string; note?: string; keys: [string, string, string?][] }[] = [
  {
    title: "Emission model",
    note: "\"pi\" = each miner earns their own base rate × their multipliers; nobody else's mining reduces it, and a halving is a clean 50% cut to the person. \"pool\" = the old Bitcoin-style fixed daily pot split pro-rata (a user's earnings then fall from halving AND dilution, stacked). Must be exactly \"pi\" or \"pool\" — the API refuses anything else, because a typo would silently re-price everyone.",
    keys: [
      ["emissionModel", "Model — \"pi\" or \"pool\"",
        "The rule that decides how much ROZI everyone earns each day. Leave on \"pi\"."],
    ],
  },
  {
    title: "Pi model — rate & halving",
    note: "Base rate is what a BASELINE miner (no multipliers) earns for a full day. Multipliers multiply it. The rate HALVES each time the user base crosses a milestone — that is the throttle, and it is what stops growth draining the pool.",
    keys: [
      ["piBaseRate", "Base rate (ROZI/day, baseline miner)",
        "The headline 'how fast is mining' number: ROZI a plain miner earns in a full day before any bonus. Rig prices are tied to this — change one, change the other."],
      ["piHalvingUsers", "Halve at user counts (comma-separated)",
        "Each time the verified-user count crosses one of these, the base rate is cut in half. People are what drain the pool, so people are what slow it."],
      ["piReferenceHours", "A \"full day\" of mining = N hours",
        "How many hours of mining count as one full day for the base-rate calc. 24 = a real day."],
    ],
  },
  {
    title: "Pool model — emission",
    note: "Only used when the model above is \"pool\". Changing these affects FUTURE epochs only; settled epochs are immutable. The supply cap is a hard ceiling enforced at settlement under BOTH models, whatever you put in the other boxes.",
    keys: [
      ["baseEmission", "ROZI emitted per day (E₀)"],
      ["halvingEpochs", "Halve emission every N days"],
      ["supplyCap", "Hard supply cap (ROZI, ever)",
        "The most ROZI mining can ever create. Enforced at settlement under both models. ⚠️ This number can go UP but never DOWN — cutting it after people mine devalues what they hold."],
    ],
  },
  {
    title: "Sessions & hashrate",
    note: "\"Hashrate\" is a user's personal mining power (shown to users as \"mining speed\"). It is base + rig power, then multiplied by streak and boosts. Higher hashrate = more ROZI per session.",
    keys: [
      ["sessionHours", "Session length (hours)",
        "How long one \"Start mining\" session runs before the user has to start another."],
      ["baseHashrate", "Base hashrate (everyone)",
        "The mining speed every miner starts with, before rigs, streak or boosts."],
      ["maxHashrate", "Max hashrate per user",
        "A ceiling on total mining speed — the one hard limit on how fast any single account can mine."],
      ["streakStepPct", "Streak bonus per day (%)",
        "Mining on consecutive days adds this % to speed each day (a \"boost\" that builds automatically)."],
      ["streakCapDays", "Streak caps at (days)",
        "The streak stops growing after this many days (e.g. 20 days × 5% = ×2 speed, then flat)."],
    ],
  },
  {
    title: "Boosts",
    note: "The task boost is the line that makes mining feed the offerwall instead of competing with it. Lowering it to 0 turns mining into a pure cost. THE AD BOOST IS FLAT, not a percentage (founder, 2026-08-30): each watched ad adds \"Ad boost (flat speed)\" to the miner's speed AFTER all multipliers, so one ad is +1 and four ads is +4 no matter how big the miner is. \"Ad boost (%)\" is kept as a separate knob but ships at 0 — set it above 0 only if you want a percentage ad boost back on top of the flat one. NOTE: ads need adsEnabled=1 AND an ad provider set — the flag alone does nothing, on purpose, so you cannot switch on free boosts before the real ad tag is integrated. Monetag websites get three formats: the VIGNETTE zone id (ad around the Start-mining tap; passive, no boost), the DIRECT LINK url (the watch-to-boost button; server dwell timer + daily cap decide the boost), and the BANNER zone id (an In-Page Push zone — small dismissible bar shown on the mining screen only; passive impressions, no boost). Each empty value disables its own part.",
    keys: [
      ["taskBoostPct", "Task boost (%)",
        "Finishing a credited task adds this % to mining speed for a while. Worked example: a miner earning 10 ROZI/day, one task at +25% → mines at ×1.25 → ~12.5 ROZI/day for the next 48h; two tasks (+50%) → ~15 ROZI/day. This is the line that makes mining feed the offerwall — set it to 0 and mining becomes a pure cost."],
      ["taskBoostHours", "Task boost lasts (hours)"],
      ["taskBoostMaxStack", "Max task boosts stacked"],
      ["adBoostFlat", "Ad boost (flat speed added per ad)",
        "Each ad a user watches adds this much to their speed AFTER all multipliers — one ad = +1, four ads = +4, regardless of how big the miner is."],
      ["adBoostPct", "Ad boost (%) — extra, ships at 0"],
      ["adBoostHours", "Ad boost lasts (hours)"],
      ["adBoostMaxStack", "Max ad boosts stacked"],
      ["adMinWatchSeconds", "Min seconds watching before the boost counts"],
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
    note: "An invite adds a slice of that friend's OWN mining speed to yours — not a slice of what they earn, so nobody loses anything. The friend must have passed the ID check AND mined recently to count.",
    keys: [
      ["referralL1Pct", "Level 1 — % of invitee mining speed",
        "For each direct invite: this % of their own mining speed is added to yours. Default 10 — invite someone mining at speed 30 and you gain 3."],
      ["referralL2Pct", "Level 2 — % of indirect mining speed",
        "Same, for friends of friends (the people your invites invited). Default 3."],
      ["referralCapPct", "Referral cap (% of your own mining speed)",
        "The whole referral bonus can never be more than this % of the speed you built yourself. 100 = a pure referral parasite can at most double their own speed, no matter how many people they invite."],
      ["referralActiveHours", "Invitee counts only if mined within (hours)",
        "An invite that hasn't started a mining session in this many hours contributes 0 — the bonus follows real activity, not signups."],
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
    title: "Cash-out window & admin limits",
    note: "The \"cash-out window\" (a.k.a. the Conversion Window) is the one way a user can turn mined ROZI into withdrawable balance. You commit a fixed pot of money up front; users spend (burn) ROZI into the window; when it closes, each person's share of the pot = their burn ÷ everyone's burn. There is deliberately NO fixed price — the more people burn, the smaller each share. Ships OFF until the lock period ends.",
    keys: [
      ["conversionEnabled", "Cash-out window on (1) / off (0)",
        "Master switch. Off until the founder opens the first window."],
      ["conversionSharePct", "Suggested pot = this % of margin",
        "When you open a window, the panel proposes a pot this big, as a share of the period's real margin — so you never commit money the business didn't earn. It's only a suggestion; you can override it."],
      ["conversionMaxPctOfMined", "Max % of mined ROZI one account can ever cash out",
        "The pot caps what the BUSINESS pays out per window; this caps what any ONE account can extract over its whole life. Default 30 = an account can cash out at most 30% of all the ROZI it has ever MINED (not received by transfer, not its current balance). 100 = no per-account limit."],
      ["adminAdjustMaxRozi", "Max ROZI per manual staff adjustment",
        "The biggest single hand-credit or hand-debit of ROZI a staff member can post to one account in one go. A guard against a fat-fingered adjustment, not a policy."],
    ],
  },
  {
    title: "ROZI value estimate (display only)",
    note: "Shown on a machine's detail page next to its ROZI cost, so a user pricing a rig sees an approximate dollar figure. NOT A REAL RATE — nothing backs it, ROZI still has no fixed price anywhere (guardrail #7), and it is never offered as a buy-back. 0.10 matches what the wallet's combined USDT balance already implies (100 points = 1 ROZI, 1000 points = 1 USDT), but the two numbers are independent — changing this does not change that ratio.",
    keys: [
      ["roziUsdtDisplayRate", "Estimated USDT per 1 ROZI"],
    ],
  },
];

// Moved out of the Economy settings tab into Money & payouts → USDT top-up
// (founder, 2026-09-02): it is money-in config, and belongs with deposits and
// withdrawals, not buried in mining knobs. It still writes the same
// `mining.*` app_settings keys via PATCH /staff/mining/settings.
const USDT_TOPUP_GROUP: { title: string; note?: string; keys: [string, string, string?][] } = {
  title: "USDT top-up (deposits)",
  note: "Real USDT a user sends in, to spend on mining machines. SPEND-ONLY — it can never be withdrawn, only used to buy rigs. Ships OFF, and stays off until BOTH \"Top-ups on\" = 1 AND a treasury address are set — a top-up screen with no address to send to would take people's money nowhere. Chain must stay \"bep20\" — the API refuses anything else. The address must be the TREASURY wallet's address (the one you funded), never a private key.",
  keys: [
    ["usdtTopupEnabled", "Top-ups on (1) / off (0)", "Master switch for the whole feature."],
    ["usdtTreasuryChain", "Chain (must be \"bep20\")", "Only BNB Smart Chain is supported; anything else is refused."],
    ["usdtTreasuryAddress", "Treasury wallet address (0x...)", "The funded treasury wallet users send USDT to. Never a private key."],
    ["usdtMinTopup", "Minimum deposit (whole USDT)", "Smaller deposits are rejected — a tiny transfer costs more in gas than it's worth."],
    ["usdtMaxTopup", "Max per claim before a human re-checks it (whole USDT)", "Claims above this always go to a staff member to confirm on-chain by hand."],
  ],
};

// ---- The Mining section, split into tabs (admin rebuild, Phase E) ----------
//
// This used to be ONE component that mounted six sub-panels at once, firing
// ~7 API calls the instant the Mining section opened — the exact thing the
// SECTIONS comment in staff/page.tsx says `mining.view` is kept off a section
// gate to avoid. Each tab now mounts on its own, so opening the section costs
// one request (the overview), not seven.
//
// ⚠️ THE SUB-PANELS ARE UNCHANGED. Every settings write, conversion window,
// store decision, rig toggle and booster edit calls the same endpoint it always
// did — this is a mount-splitting change, not a rewrite of any economy path.
const MINING_TABS = [
  { id: "overview", label: "Overview" },
  { id: "settings", label: "Economy settings" },
  { id: "guide", label: "How it works" },
  { id: "allocation", label: "Allocation" },
  { id: "conversion", label: "Conversion" },
  { id: "store", label: "Store" },
  { id: "rigs", label: "Rigs" },
  { id: "boosters", label: "Boosters" },
] as const;
type MiningTab = (typeof MINING_TABS)[number]["id"];

export function MiningAdminSection() {
  const [tab, setTab] = useState<MiningTab>("overview");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 overflow-x-auto border-b border-line pb-px">
        {MINING_TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`whitespace-nowrap rounded-t-md px-3 py-2 text-sm font-semibold ${
              tab === t.id ? "border-x border-t border-line bg-card text-brand-ink" : "text-muted hover:text-brand-ink"
            }`}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "overview" && <MiningOverviewPanel />}
      {tab === "settings" && <EconomySettingsPanel />}
      {tab === "guide" && <MiningGuidePanel />}
      {tab === "allocation" && <AllocationPanel />}
      {tab === "conversion" && <ConversionPanel />}
      {tab === "store" && <StorePanel />}
      {tab === "rigs" && <RigPanel />}
      {tab === "boosters" && <BoosterPanel />}
    </div>
  );
}

// The live economy numbers + the "Settle now" action + top miners.
export function MiningOverviewPanel() {
  const stats = useApi(fetchMiningStats, []);
  const [msg, setMsg] = useState<string | null>(null);

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

  if (stats.loading) return <p className="p-4 text-sm text-muted">Loading…</p>;
  if (stats.error) return <p className="p-4 text-sm text-danger">{stats.error}</p>;
  return (
    <div className="space-y-6">
      {msg && <p className="rounded-md border border-line bg-card p-2 text-xs text-brand-ink">{msg}</p>}
      {stats.data && <StatsHeader s={stats.data} onSettle={onSettle} />}
      {stats.data && <TopMinersTable rows={stats.data.topMiners} />}
    </div>
  );
}

// Editor for a comma-separated list of ascending milestone numbers
// (`piHalvingUsers`). Founder, 2026-09-02: one CSV box is "one mistake away from
// re-pricing everyone" — so it edits as rows, one number each, and only ever
// serialises back to the CSV string the API already expects.
function MilestoneEditor({ value, onChange }: { value: string; onChange: (csv: string) => void }) {
  const nums = value.split(",").map((s) => s.trim()).filter((s) => s !== "");
  const setAt = (i: number, v: string) => {
    const next = [...nums];
    next[i] = v.replace(/[^0-9]/g, "");
    onChange(next.join(","));
  };
  return (
    <div className="mt-1.5 space-y-1">
      {nums.map((v, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-[11px] text-muted">Halving #{i + 1}</span>
          <input value={v} inputMode="numeric" onChange={(e) => setAt(i, e.target.value)}
            className="w-32 rounded-md border-2 border-line-strong bg-card px-2 py-1 text-right font-mono text-sm" />
          <span className="text-[11px] text-muted">users</span>
          <button type="button" onClick={() => onChange(nums.filter((_, j) => j !== i).join(","))}
            className="rounded bg-danger-tint px-1.5 py-0.5 text-[10px] font-semibold text-danger">remove</button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...nums, ""].join(","))}
        className="rounded bg-brand-tint px-2 py-0.5 text-[10px] font-semibold text-brand">+ add a milestone</button>
      <p className="text-[10px] text-muted">
        Saved sorted, lowest first. Each time the ID-verified user count crosses one of these, the base
        rate is cut in half. Current list: <span className="font-mono">{nums.join(", ") || "(none)"}</span>
      </p>
    </div>
  );
}

// The tunable-number wall, grouped as the spec reads. Every write is
// audit-logged server-side. String settings pass through as typed; numbers are
// coerced by the CURRENT value's type, never a hand-kept key list.
// `groups` defaults to GROUPS; UsdtTopupConfigPanel reuses this with its own.
export function EconomySettingsPanel({
  groups = GROUPS, heading = "Economy settings",
}: { groups?: typeof GROUPS; heading?: string } = {}) {
  const settings = useApi(fetchMiningSettings, []);
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
        patch[k] = typeof cur[k] === "number" ? Number(v) : v;
      }
      await updateMiningSettings(patch);
      setDraft({});
      settings.reload();
      setMsg("Saved. Live immediately — no redeploy.");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-bold text-brand-ink">{heading}</h3>
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

      {msg && <p className="mb-2 rounded-md border-2 border-line-strong bg-card p-2 text-xs text-brand-ink">{msg}</p>}

      {settings.loading ? (
        <p className="p-4 text-sm text-muted">Loading…</p>
      ) : settings.error ? (
        <p className="p-4 text-sm text-danger">{settings.error}</p>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g.title} className="rounded-lg border-2 border-line-strong bg-bg/40 p-3">
              <h4 className="text-sm font-bold text-brand-ink">{g.title}</h4>
              {g.note && <p className="mt-1 text-xs text-muted">{g.note}</p>}
              {/* Each setting is its own bordered box — label, one-line
                  explainer, then the input — so the fields read as distinct
                  controls rather than a wall of rows (founder, 2026-09-01). */}
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {g.keys.map(([key, label, help]) => (
                  <label key={key} className={`block rounded-md border-2 bg-card p-2.5 ${
                    draft[key] !== undefined ? "border-brand" : "border-line-strong"
                  } ${key === "piHalvingUsers" ? "sm:col-span-2" : ""}`}>
                    <span className="block text-xs font-semibold text-brand-ink">{label}</span>
                    {help && <span className="mt-0.5 block text-[11px] leading-snug text-muted">{help}</span>}
                    {key === "piHalvingUsers" ? (
                      <MilestoneEditor
                        value={draft[key] ?? String(cur[key] ?? "")}
                        onChange={(csv) => setDraft((d) => ({ ...d, [key]: csv }))}
                      />
                    ) : (
                      <input
                        value={draft[key] ?? String(cur[key] ?? "")}
                        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                        className={`mt-1.5 w-full rounded-md border-2 px-2 py-1 text-right font-mono text-sm ${
                          draft[key] !== undefined ? "border-brand bg-brand-tint" : "border-line-strong bg-bg/50"
                        }`}
                      />
                    )}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Money & payouts → USDT top-up (founder, 2026-09-02). Same settings machinery,
// just the money-in group, surfaced where deposits/withdrawals live.
export function UsdtTopupConfigPanel() {
  return (
    <div className="space-y-3">
      <p className="rounded-lg border-2 border-line-strong bg-brand-tint/30 p-2.5 text-xs text-muted">
        These are mining-settings keys (they gate the &ldquo;buy a rig with real USDT&rdquo; feature), shown
        here because it is money coming in. Saving writes the same place the Mining tab did.
      </p>
      <EconomySettingsPanel groups={[USDT_TOPUP_GROUP]} heading="USDT top-up (deposits)" />
    </div>
  );
}

// ---- "How it works" + a live simulator (founder, 2026-09-02) --------------
// A plain-English explainer of the mining economy plus a calculator that uses
// the CURRENT tunable values, so you can see whether a change keeps the economy
// sane as the user base grows (does a halving actually halve? does a referral
// parasite get capped?). The maths mirrors api/src/mining/core.ts computeHashrate
// + piBaseRateFor — if that changes, change this.
function parseMilestonesCsv(csv: string): number[] {
  return String(csv ?? "").split(",").map((s) => Number(s.trim()))
    .filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
}

function simulate(s: Record<string, number | string>, i: {
  rigPower: number; streakDays: number; taskBoosts: number; adsWatched: number;
  refL1Speed: number; refL2Speed: number; userCount: number; hoursMined: number;
}) {
  const num = (k: string, d: number) => { const v = Number(s[k]); return Number.isFinite(v) ? v : d; };
  const base = num("baseHashrate", 10);
  const streakStep = num("streakStepPct", 5);
  const streakCap = num("streakCapDays", 20);
  const taskPct = num("taskBoostPct", 25);
  const taskCap = num("taskBoostMaxStack", 8);
  const adFlat = num("adBoostFlat", 1);
  const adCap = num("adBoostMaxStack", 4);
  const capPct = num("referralCapPct", 100);
  const l1Pct = num("referralL1Pct", 10);
  const l2Pct = num("referralL2Pct", 3);
  const maxHash = num("maxHashrate", 100000);
  const piBase = num("piBaseRate", 2.5);
  const refHours = num("piReferenceHours", 24);
  const milestones = parseMilestonesCsv(String(s.piHalvingUsers ?? "2000,10000,50000,250000,900000"));

  const flat = base + Math.max(0, i.rigPower);
  const streakMult = 1 + (streakStep / 100) * Math.min(Math.max(0, i.streakDays), streakCap);
  const boostMult = 1 + (Math.min(Math.max(0, i.taskBoosts), taskCap) * taskPct) / 100;
  const adBonus = Math.min(Math.max(0, i.adsWatched), adCap) * adFlat;
  const own = flat * streakMult * boostMult + adBonus;
  const referralRaw = (i.refL1Speed * l1Pct) / 100 + (i.refL2Speed * l2Pct) / 100;
  const referral = Math.min(referralRaw, own * (capPct / 100));
  const hashrate = Math.floor(Math.min(own + referral, maxHash));

  const halvings = milestones.filter((m) => m <= i.userCount).length;
  const effRate = piBase / 2 ** halvings;
  const roziPerDay = effRate * (hashrate / base) * (i.hoursMined / refHours);
  const roziPerFullDay = effRate * (hashrate / base) * (24 / refHours);

  return { flat, streakMult, boostMult, adBonus, own, referral, hashrate, halvings, effRate, roziPerDay, roziPerFullDay };
}

function MiningSimulator({ s }: { s: Record<string, number | string> }) {
  const [i, setI] = useState({
    rigPower: 7, streakDays: 10, taskBoosts: 2, adsWatched: 0,
    refL1Speed: 0, refL2Speed: 0, userCount: 1000, hoursMined: 8,
  });
  const set = (k: keyof typeof i, v: string) => setI((p) => ({ ...p, [k]: Number(v.replace(/[^0-9.]/g, "")) || 0 }));
  const r = simulate(s, i);
  const F = (label: string, k: keyof typeof i, hint?: string) => (
    <label className="block rounded-md border-2 border-line-strong bg-card p-2">
      <span className="block text-[11px] font-semibold text-brand-ink">{label}</span>
      {hint && <span className="block text-[10px] text-muted">{hint}</span>}
      <input value={String(i[k])} inputMode="decimal" onChange={(e) => set(k, e.target.value)}
        className="mt-1 w-full rounded border-2 border-line-strong bg-bg/50 px-2 py-1 text-right font-mono text-sm" />
    </label>
  );
  return (
    <div className="rounded-lg border-2 border-line-strong bg-bg/40 p-3">
      <h4 className="text-sm font-bold text-brand-ink">Try a miner</h4>
      <p className="mt-0.5 text-xs text-muted">
        Uses your current saved settings. Change the user count and watch the halvings bite.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-4">
        {F("Rig power", "rigPower", "extra speed from rigs")}
        {F("Streak days", "streakDays")}
        {F("Task boosts active", "taskBoosts")}
        {F("Ads watched", "adsWatched")}
        {F("Invitees' total speed (L1)", "refL1Speed", "sum of direct invites")}
        {F("Invitees' total speed (L2)", "refL2Speed", "friends of friends")}
        {F("ID-verified users", "userCount", "drives halving")}
        {F("Hours mined that day", "hoursMined")}
      </div>
      <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <div className="rounded-md border-2 border-line-strong bg-card p-2">
          <p className="font-semibold text-brand-ink">Mining speed</p>
          <p className="num text-lg font-bold text-brand">{r.hashrate}</p>
          <p className="text-[11px] text-muted">
            ({r.flat} base+rigs × {r.streakMult.toFixed(2)} streak × {r.boostMult.toFixed(2)} task
            {r.adBonus ? ` + ${r.adBonus} ads` : ""}
            {r.referral ? ` + ${Math.round(r.referral)} referral (capped)` : ""})
          </p>
        </div>
        <div className="rounded-md border-2 border-line-strong bg-card p-2">
          <p className="font-semibold text-brand-ink">ROZI this day</p>
          <p className="num text-lg font-bold text-success">{r.roziPerDay.toFixed(3)}</p>
          <p className="text-[11px] text-muted">
            base rate {r.effRate.toFixed(4)}/day after {r.halvings} halving{r.halvings === 1 ? "" : "s"}
            {" · "}a full 24h would be {r.roziPerFullDay.toFixed(3)}
          </p>
        </div>
      </div>
    </div>
  );
}

function MiningGuidePanel() {
  const settings = useApi(fetchMiningSettings, []);
  const s = settings.data?.settings ?? {};
  return (
    <div className="space-y-4 text-sm">
      <div className="rounded-lg border-2 border-line-strong bg-card p-3">
        <h3 className="font-bold text-brand-ink">How mining pays out</h3>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-xs text-muted">
          <li><strong>Mining speed</strong> (&ldquo;hashrate&rdquo;) is personal. Everyone starts at the
            base speed while a session runs; <strong>rigs</strong> add a permanent amount; a
            <strong> streak</strong> multiplies it (+{String(s.streakStepPct ?? 5)}%/day, up to ×2 at
            {" "}{String(s.streakCapDays ?? 20)} days); each <strong>credited task</strong> multiplies it
            {" "}(+{String(s.taskBoostPct ?? 25)}% for {String(s.taskBoostHours ?? 48)}h, up to
            {" "}{String(s.taskBoostMaxStack ?? 8)} stacked); each <strong>watched ad</strong> adds a flat
            {" "}+{String(s.adBoostFlat ?? 1)} (up to {String(s.adBoostMaxStack ?? 4)}).</li>
          <li><strong>Referral speed</strong>: {String(s.referralL1Pct ?? 10)}% of each direct invite&apos;s
            own speed and {String(s.referralL2Pct ?? 3)}% of each indirect one&apos;s — but the whole
            referral part can never exceed {String(s.referralCapPct ?? 100)}% of the speed you built
            yourself, so it can&apos;t be farmed.</li>
          <li><strong>ROZI per day</strong> = base rate × (your speed ÷ base speed) × (hours you mined ÷
            {" "}{String(s.piReferenceHours ?? 24)}). No dilution — other people mining does not shrink
            your payout.</li>
          <li><strong>Halving</strong>: the base rate is cut in half each time the ID-verified user count
            crosses a milestone ({String(s.piHalvingUsers ?? "2000,10000,50000,250000,900000")}). That is
            the throttle that stops growth draining the 21M cap. A ×2 multiplier exactly cancels one
            halving.</li>
          <li>Mined ROZI sits unclaimed until the user taps <strong>Claim</strong>. It still counts
            against the supply cap the moment it&apos;s settled.</li>
        </ol>
      </div>
      {settings.loading ? <p className="p-2 text-xs text-muted">Loading current settings…</p>
        : settings.error ? <p className="p-2 text-xs text-danger">{settings.error}</p>
        : <MiningSimulator s={s} />}
    </div>
  );
}

// ---- Token allocation (planning / bookkeeping) --------------------------
// ⚠️ NOTHING HERE MINTS OR MOVES ROZI. ROZI is not on-chain; a non-mining
// bucket has no balance behind it. supplyCap stays the one enforced number and
// equals the mining bucket. This screen records the PLAN and lets it be edited.
const EMPTY_ALLOC = { bucket: "", label: "", amountRozi: 0, cliffMonths: 0, vestMonths: 0, startDate: "", notes: "" };

function AllocationPanel() {
  const a = useApi(fetchAllocations, []);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<typeof EMPTY_ALLOC>(EMPTY_ALLOC);
  const [msg, setMsg] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setMsg(null);
    try { await fn(); a.reload(); setEditing(null); setAdding(false); }
    catch (e) { setMsg((e as Error).message); }
  }

  const d = a.data;
  const AL = "block text-[11px] font-semibold uppercase text-muted";
  const AI = "mt-1 w-full rounded-md border-2 border-line-strong bg-card px-2 py-1 text-sm outline-none";
  const editRow = (b: AllocationBucket) => setForm({
    bucket: b.bucket, label: b.label, amountRozi: b.amountRozi,
    cliffMonths: b.cliffMonths, vestMonths: b.vestMonths,
    startDate: b.startDate ?? "", notes: b.notes ?? "",
  });
  const payload = () => ({
    bucket: form.bucket.trim(), label: form.label.trim(), amountRozi: Number(form.amountRozi),
    cliffMonths: Number(form.cliffMonths), vestMonths: Number(form.vestMonths),
    startDate: form.startDate.trim() || null, notes: form.notes.trim() || null,
  });

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-pending/40 bg-pending-tint/20 p-2.5 text-xs text-brand-ink">
        A <strong>plan</strong>, not a wallet. Nothing here mints or moves ROZI — the token is not on-chain,
        and a non-mining bucket has no balance behind it. The <strong>Community mining</strong> bucket is the
        one real number: it equals the enforced supply cap, and its &ldquo;released&rdquo; figure is actual mining
        emission, not a schedule.
      </div>

      {msg && <p className="rounded-md border border-line bg-card p-2 text-xs text-danger">{msg}</p>}
      {!d ? <p className="text-sm text-muted">Loading…</p> : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Total supply (plan)" value={n(d.totalRozi)} sub="ROZI across all buckets" />
            <Stat label="Mining cap" value={n(d.supplyCap)} sub="the enforced number" />
            <Stat label="Mined so far" value={n(d.minedEmitted)} sub={`${n(d.minedRemaining)} left`} />
            <Stat label="Buckets add to" value={`${d.pctSum}%`} sub={d.pctSum === 100 ? "balanced" : "should be 100%"} />
          </div>
          {d.pctSum !== 100 && (
            <p className="rounded bg-pending-tint/40 p-1.5 text-[11px] font-semibold text-pending">
              The buckets do not add up to 100% of the plan total. Adjust the amounts.
            </p>
          )}

          <div className="space-y-2">
            {d.buckets.map((b) => (
              <div key={b.id} className="rounded-md border-2 border-line-strong bg-card p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-bold text-brand-ink">{b.label}
                    <span className="ms-2 font-normal text-muted">{b.pctOfTotal}% · {n(b.amountRozi)} ROZI</span>
                  </span>
                  <div className="flex gap-1.5">
                    <button onClick={() => { setEditing(editing === b.id ? null : b.id); editRow(b); }}
                      className="rounded bg-brand-tint px-2 py-0.5 font-semibold text-brand">
                      {editing === b.id ? "Close" : "Edit"}
                    </button>
                    {b.bucket !== "mining" && (
                      <button onClick={() => { if (window.confirm(`Remove the "${b.label}" bucket from the plan?`)) run(() => deleteAllocation(b.id)); }}
                        className="rounded bg-danger px-2 py-0.5 font-semibold text-white">Delete</button>
                    )}
                  </div>
                </div>
                <div className="mt-1 text-muted">
                  {b.isLive
                    ? <>Released (mined): <span className="font-mono text-brand-ink">{n(b.releasedRozi)}</span> ({b.releasedPct}%)</>
                    : <>Vested to date: <span className="font-mono text-brand-ink">{n(b.releasedRozi)}</span> ({b.releasedPct}%)
                        {" · "}{b.cliffMonths}mo cliff, {b.vestMonths}mo linear{b.startDate ? `, from ${b.startDate.slice(0, 10)}` : ", not started"}</>}
                </div>
                {b.notes && <p className="mt-1 text-[11px] text-muted">{b.notes}</p>}
                {editing === b.id && (
                  <div className="mt-2 grid gap-2 border-t border-line pt-2 sm:grid-cols-3">
                    <label><span className={AL}>Label</span>
                      <input className={AI} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></label>
                    <label><span className={AL}>Amount (whole ROZI)</span>
                      <input type="number" className={AI} value={form.amountRozi} onChange={(e) => setForm({ ...form, amountRozi: Number(e.target.value) })} /></label>
                    <label><span className={AL}>Start date</span>
                      <input type="date" className={AI} value={form.startDate.slice(0, 10)} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></label>
                    <label><span className={AL}>Cliff (months)</span>
                      <input type="number" className={AI} value={form.cliffMonths} onChange={(e) => setForm({ ...form, cliffMonths: Number(e.target.value) })} /></label>
                    <label><span className={AL}>Vest (months, linear)</span>
                      <input type="number" className={AI} value={form.vestMonths} onChange={(e) => setForm({ ...form, vestMonths: Number(e.target.value) })} /></label>
                    <label className="sm:col-span-3"><span className={AL}>Notes</span>
                      <input className={AI} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
                    <div className="sm:col-span-3">
                      <button onClick={() => run(() => updateAllocation(b.id, payload()))}
                        className="rounded-md bg-brand px-3 py-1 text-xs font-semibold text-white">Save</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {adding ? (
            <div className="rounded-md border border-brand/40 bg-brand-tint/20 p-3">
              <div className="grid gap-2 sm:grid-cols-3">
                <label><span className={AL}>Bucket key</span>
                  <input className={AI} value={form.bucket} onChange={(e) => setForm({ ...form, bucket: e.target.value })} placeholder="e.g. advisors" /></label>
                <label><span className={AL}>Label</span>
                  <input className={AI} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></label>
                <label><span className={AL}>Amount (whole ROZI)</span>
                  <input type="number" className={AI} value={form.amountRozi} onChange={(e) => setForm({ ...form, amountRozi: Number(e.target.value) })} /></label>
                <label><span className={AL}>Cliff (months)</span>
                  <input type="number" className={AI} value={form.cliffMonths} onChange={(e) => setForm({ ...form, cliffMonths: Number(e.target.value) })} /></label>
                <label><span className={AL}>Vest (months)</span>
                  <input type="number" className={AI} value={form.vestMonths} onChange={(e) => setForm({ ...form, vestMonths: Number(e.target.value) })} /></label>
                <label><span className={AL}>Start date</span>
                  <input type="date" className={AI} value={form.startDate.slice(0, 10)} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></label>
              </div>
              <div className="mt-2 flex gap-2">
                <button onClick={() => run(() => createAllocation(payload()))}
                  className="rounded-md bg-brand px-3 py-1 text-xs font-semibold text-white">Add bucket</button>
                <button onClick={() => { setAdding(false); setForm(EMPTY_ALLOC); }}
                  className="rounded-md bg-brand-tint px-3 py-1 text-xs font-semibold text-brand">Cancel</button>
              </div>
            </div>
          ) : (
            <button onClick={() => { setForm(EMPTY_ALLOC); setAdding(true); }}
              className="rounded-md bg-brand-tint px-3 py-1.5 text-xs font-semibold text-brand">+ Add a bucket</button>
          )}
        </>
      )}
    </div>
  );
}

export function StatsHeader({ s, onSettle }: { s: MiningStats; onSettle: () => void }) {
  const pctEmitted = (s.supply.emitted / s.supply.cap) * 100;
  const isPi = s.emissionModel === "pi";

  return (
    <div className="rounded-lg border-2 border-line-strong bg-card p-3">
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

      <EpochHistory recent={s.epochs} />
    </div>
  );
}

// The day-by-day economy history. Starts with the 14 days the stats endpoint
// already returned; "Show all days" pages the rest in (day 1 to now).
function EpochHistory({ recent }: { recent: MiningStats["epochs"] }) {
  const [rows, setRows] = useState(recent);
  const [total, setTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const PAGE = 60;

  async function loadMore() {
    setBusy(true);
    try {
      const page = await fetchMiningEpochs(PAGE, rows.length);
      setTotal(page.total);
      // Merge, keeping unique epochs, newest first.
      const seen = new Set(rows.map((e) => e.epoch));
      setRows([...rows, ...page.epochs.filter((e) => !seen.has(e.epoch))]);
    } finally { setBusy(false); }
  }

  if (recent.length === 0) return null;
  const more = total == null ? rows.length >= 14 : rows.length < total;
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[520px] text-xs">
        <thead className="text-left uppercase text-muted">
          <tr>
            <th className="py-1">Day</th><th>Emission</th><th>Miners</th>
            <th>Emitted</th><th>Withheld</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
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
      {more && (
        <button onClick={loadMore} disabled={busy}
          className="mt-2 rounded-md bg-brand-tint px-3 py-1 text-xs font-semibold text-brand disabled:opacity-50">
          {busy ? "Loading…" : total == null ? "Show all days" : `Show more (${rows.length} of ${total})`}
        </button>
      )}
    </div>
  );
}

// Top 10 by lifetime mined ROZI (never transfers-in, never current balance —
// see the query's own comment in staffMining.ts). Rows jump to the same user
// detail screen every other clickable row in this panel jumps to.
export function TopMinersTable({ rows }: { rows: MiningStats["topMiners"] }) {
  const { openUser } = useStaffNav();
  return (
    <div className="rounded-lg border-2 border-line-strong bg-card p-3">
      <h3 className="font-bold text-brand-ink">Top miners</h3>
      <p className="mt-1 text-xs text-muted">By lifetime mined ROZI — not current balance, so a rig purchase or a burn doesn&apos;t move a rank.</p>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Nobody has mined anything yet.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[360px] text-xs">
            <thead className="text-left uppercase text-muted"><tr><th className="py-1">#</th><th>Miner</th><th>Mined (lifetime)</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="py-1.5 font-mono text-muted">{r.rank}</td>
                  <td><button onClick={() => openUser(r.id)} className="text-brand-ink hover:underline">{displayIdentity(r, { full: true })}</button></td>
                  <td className="font-mono">{r.mined.toLocaleString(undefined, { maximumFractionDigits: 3 })} ROZI</td>
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

export function ConversionPanel() {
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
    <div className="rounded-lg border-2 border-line-strong bg-card p-3">
      <h3 className="font-bold text-brand-ink">
        Cash out mined ROZI (conversion window){" "}
        <span className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
          d.enabled ? "bg-success-tint text-success" : "bg-brand-tint text-muted"
        }`}>
          {d.enabled ? "on" : "off"}
        </span>
      </h3>

      <p className="mt-1 text-xs text-muted">
        The one way a user turns mined ROZI into withdrawable balance. You commit a fixed pot of money;
        users spend (burn) ROZI into the window; when it closes, each person&apos;s share of the pot =
        their burn ÷ everyone&apos;s burn. There is no fixed price — the more people burn, the smaller
        each share. Leave it OFF until the lock period ends.
      </p>

      {msg && <p className="mt-2 rounded-md border-2 border-line-strong p-2 text-xs text-brand-ink">{msg}</p>}

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
export function StorePanel() {
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
    <div className="rounded-lg border-2 border-line-strong bg-card p-3">
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

export function RigPanel() {
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
    <div className="rounded-lg border-2 border-line-strong bg-card p-3">
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
              <th>Base power</th><th>Power ×</th><th>Max lvl</th>
              {/* What it actually did. A price column alone answers "what did I
                  set?" and says nothing about whether the sink ever ran. */}
              <th>Owners</th><th>Levels</th><th>ROZI burned</th>
              <th>USDT</th><th></th>
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
                {/* Zero owners on an active rig is the finding, not a gap in the
                    data — so it is dimmed rather than hidden. */}
                <td className={`font-mono ${r.owners === 0 ? "text-muted" : "text-brand-ink"}`}>{n(r.owners)}</td>
                <td className="font-mono text-muted">{n(r.levelsSold)}</td>
                <td className="font-mono text-brand-ink">
                  {n(r.roziBurned)}
                  {r.usdtSpent > 0 && <span className="ms-1 text-[10px] text-muted">+${n(r.usdtSpent)}</span>}
                </td>
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

// Points-priced boosters (brief part 38).
//
// ⚠️ THESE ENDPOINTS SHIPPED WITH NO SCREEN AT ALL. `POST/PATCH
// /staff/mining/boosters` have existed and been permission-gated since the
// mining build; nothing in the panel ever called them, so the only way to price
// a booster was a hand-written request. A feature nobody can reach is a feature
// that does not exist.
//
// WHY THIS ONE MATTERS MORE THAN THE RIG TABLE ABOVE IT: a booster is a sink for
// the CASH currency. Every point spent here is a point that will not be
// withdrawn from a treasury we have to fund, so "points spent" is the closest
// thing mining has to a revenue line.
//
// Ships DISABLED by default, deliberately — a booster with a price nobody chose
// is a price we did not mean to publish.
export function BoosterPanel() {
  const boosters = useApi(fetchAdminBoosters, []);
  const [msg, setMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", pricePoints: "", multiplierPct: "", hours: "" });

  async function toggle(id: string, status: string) {
    try {
      await updateAdminBooster(id, { status: status === "active" ? "disabled" : "active" });
      boosters.reload();
      setMsg(null);
    } catch (e) { setMsg((e as Error).message); }
  }

  async function edit(id: string, patch: Record<string, unknown>) {
    try {
      await updateAdminBooster(id, patch);
      boosters.reload();
      setMsg(null);
    } catch (e) { setMsg((e as Error).message); }
  }

  async function create() {
    try {
      await createAdminBooster({
        name: form.name.trim(),
        pricePoints: Number(form.pricePoints),
        multiplierPct: Number(form.multiplierPct),
        hours: Number(form.hours),
        // Always off on creation. Whoever set the numbers should look at them
        // once more before users can buy it.
        status: "disabled",
      });
      setForm({ name: "", pricePoints: "", multiplierPct: "", hours: "" });
      setAdding(false);
      boosters.reload();
      setMsg("Added, switched OFF. Turn it on when the price is right.");
    } catch (e) { setMsg((e as Error).message); }
  }

  if (boosters.loading || !boosters.data) return null;
  const rows = boosters.data.boosters;

  return (
    <div className="rounded-lg border-2 border-line-strong bg-card p-3">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-brand-ink">Speed boosters</h3>
        <button onClick={() => setAdding((v) => !v)}
          className="rounded-md bg-brand px-2.5 py-1 text-xs font-semibold text-white">
          {adding ? "Cancel" : "Add booster"}
        </button>
      </div>
      <p className="mt-1 text-xs text-muted">
        A booster multiplies mining speed for a fixed number of hours. Users pay for it with their
        <strong> task earnings</strong> (they see the price as ROZI on screen; internally it&apos;s the
        cash-backed balance). So every sale is money that will <strong>not</strong> be withdrawn from
        the treasury — that&apos;s the whole point of it. Ships disabled; new boosters start disabled too.
      </p>
      {msg && <p className="mt-2 rounded-md border-2 border-line-strong p-2 text-xs text-brand-ink">{msg}</p>}

      {adding && (
        <div className="mt-3 grid gap-2 rounded-lg border border-brand bg-brand-tint/30 p-2.5 sm:grid-cols-4">
          {([
            ["name", "Name", "text"],
            ["pricePoints", "Price (points)", "number"],
            ["multiplierPct", "Boost % (100 = ×2)", "number"],
            ["hours", "Lasts (hours)", "number"],
          ] as const).map(([key, label, type]) => (
            <label key={key} className="text-xs">
              <span className="text-muted">{label}</span>
              <input type={type} value={form[key]}
                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                className="mt-0.5 w-full rounded-md border border-line bg-card px-2 py-1 font-mono" />
            </label>
          ))}
          <div className="sm:col-span-4">
            <button onClick={create}
              disabled={!form.name.trim() || !form.pricePoints || !form.multiplierPct || !form.hours}
              className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
              Create (switched off)
            </button>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted">
          No boosters yet. Until one exists and is switched on, points have no mining sink at all.
        </p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[560px] text-xs">
            <thead className="text-left uppercase text-muted">
              <tr>
                <th className="py-1">Booster</th><th>Price</th><th>Boost</th><th>Hours</th>
                <th>Sold</th><th>Points taken</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} className="border-t border-line">
                  <td className="py-1.5 font-semibold text-brand-ink">{b.name}</td>
                  {/* Editable in place: repricing is the whole job here, and a
                      modal for one number is friction on the common case. */}
                  {([
                    ["pricePoints", b.price_points],
                    ["multiplierPct", b.multiplier_pct],
                    ["hours", b.hours],
                  ] as const).map(([key, value]) => (
                    <td key={key}>
                      <input type="number" defaultValue={value}
                        onBlur={(e) => {
                          const next = Number(e.target.value);
                          if (next !== value && next > 0) edit(b.id, { [key]: next });
                        }}
                        className="w-20 rounded border border-line bg-card px-1.5 py-0.5 font-mono" />
                    </td>
                  ))}
                  <td className="font-mono text-muted">{n(b.purchases)}</td>
                  <td className="font-mono text-brand-ink">{formatPoints(b.pointsSpent)}</td>
                  <td>
                    <button onClick={() => toggle(b.id, b.status)}
                      className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                        b.status === "active" ? "bg-success-tint text-success" : "bg-danger-tint text-danger"
                      }`}>
                      {b.status}
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
