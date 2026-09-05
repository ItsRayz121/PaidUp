"use client";

// Feature flags + global settings (brief parts 44 and 45).
// Internal tool: density over friendliness, jargon allowed (DESIGN_BRIEF).

import { useEffect, useState } from "react";
import { useApi } from "@/lib/hooks";
import {
  fetchFlags, setFlag, fetchSettings, updateSettings, testStaffAlert,
  fetchAlertRecipients, checkAlertRecipient, addAlertRecipient, removeAlertRecipient,
  type FeatureFlag, type AlertRecipient,
} from "@/lib/api";
import { StatusBadge } from "@/components/staff/primitives";
import { useToast } from "@/components/staff/toast";

// ---- Ticket auto-close -----------------------------------------------------
// Moved here from Global settings (founder, 2026-09-02: "shift it... as a sub
// tab of the feature flags"). It stays a plain numeric setting under the hood
// — same PATCH /staff/settings call, same 0-disables-it behavior — rather
// than becoming a real FeatureFlag row: `FeatureFlag.enabled` is strictly
// boolean (a label + on/off badge + one toggle button), and forcing a number
// into that shape would ripple into every other flag row. This card just
// physically lives on the Feature flags screen now, above the boolean list.
function TicketAutoCloseCard() {
  const settings = useApi(fetchSettings, []);
  const toast = useToast();
  const [hours, setHours] = useState(3);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings.data) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHours(settings.data.ticketAutoCloseHours);
    }
  }, [settings.data]);

  async function save() {
    setSaving(true); setSaved(false);
    try {
      await updateSettings({ ticketAutoCloseHours: hours });
      setSaved(true);
      settings.reload();
    } catch (e) {
      toast.err((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mb-6 rounded-lg border-2 border-line-strong bg-card p-3">
      <h3 className="font-bold text-brand-ink">Ticket auto-close</h3>
      <p className="mt-0.5 text-xs text-muted">
        Once staff answer a support ticket and the user does not reply, it
        closes itself after this many hours. 0 turns auto-close off.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <input type="number" min={0} max={720} value={hours}
          onChange={(e) => setHours(Number(e.target.value))}
          className="w-28 rounded-md border border-line bg-card p-2 text-sm outline-none" />
        <span className="text-xs text-muted">hours</span>
        <button onClick={save} disabled={saving || settings.loading}
          className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="text-xs text-success">Saved.</span>}
      </div>
    </section>
  );
}

// ---- Feature flags ---------------------------------------------------------
export function FeatureFlagsPanel() {
  const flags = useApi(fetchFlags, []);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function toggle(f: FeatureFlag) {
    // Turning something OFF is the dangerous direction and the one people do in
    // a hurry, so it is the one that asks. Turning something back ON does not:
    // the fix for an over-eager switch should never have friction in front of it.
    if (f.enabled && !window.confirm(`Turn OFF "${f.label}"?\n\n${f.effect}`)) return;
    setBusy(f.id);
    try {
      await setFlag(f.id, !f.enabled);
      toast.ok(`"${f.label}" turned ${f.enabled ? "off" : "on"}.`);
      flags.reload();
    } catch (e) {
      toast.err((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mb-8">
      <h2 className="mb-1 font-bold text-brand-ink">Features</h2>
      <p className="mb-3 text-xs text-muted">
        Switch a feature off without a deploy. Turning something off never takes
        away money already earned or paid — each row says exactly what it does.
      </p>

      <TicketAutoCloseCard />

      {flags.loading ? <p className="text-sm text-muted">Loading…</p>
        : flags.error ? <p className="text-sm text-danger">{flags.error}</p> : (
          <div className="space-y-2">
            {(flags.data?.flags ?? []).map((f) => (
              <div key={f.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border-2 border-line-strong bg-card p-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-brand-ink">
                    {f.label} <StatusBadge status={f.enabled ? "on" : "off"} />
                  </p>
                  <p className="mt-0.5 text-xs text-muted">{f.effect}</p>
                  {/* The honest note. A BNB deposit is somebody sending to an
                      address on a public chain — nothing we deploy stops that,
                      and a switch that implies otherwise is worse than none. */}
                  {f.displayOnly && (
                    <p className="mt-1 text-xs font-semibold text-pending">
                      Hides it in the app only — this cannot be blocked on our side.
                    </p>
                  )}
                  <p className="mt-1 font-mono text-[10px] text-muted">{f.enforcedAt}</p>
                </div>
                <button onClick={() => toggle(f)} disabled={busy === f.id}
                  className={`shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50 ${
                    f.enabled ? "bg-danger" : "bg-success"
                  }`}>
                  {busy === f.id ? "…" : f.enabled ? "Turn off" : "Turn on"}
                </button>
              </div>
            ))}
          </div>
        )}
    </section>
  );
}

// ---- Staff alert recipients: named Telegram DMs, not a group --------------
// Replaces the old shared-group design (founder, 2026-09-05): a group risks
// being (or becoming) more public than a fraud/reconciliation alert should
// ever reach. A super admin instead picks named individuals here, the same
// shape as the admin-email allowlist. A Telegram bot cannot be asked "has
// this username ever started me?" on demand — there is no such API for a
// private chat — so "Check" looks the person up in our own directory, built
// from real messages the bot has actually received (routes/telegramWebhook.ts).
// Only someone found there, and not currently blocking the bot, can be added.
function AlertRecipientsCard() {
  const list = useApi(fetchAlertRecipients, []);
  const toast = useToast();
  const [username, setUsername] = useState("");
  const [label, setLabel] = useState("");
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<
    { found: boolean; note?: string; telegramId?: string; username?: string | null; name?: string | null; blocked?: boolean } | null
  >(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  async function check() {
    if (!username.trim()) return;
    setChecking(true);
    setChecked(null);
    try {
      setChecked(await checkAlertRecipient(username));
    } catch (e) {
      toast.err((e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  async function add() {
    if (!checked?.found || checked.blocked) return;
    setAdding(true);
    try {
      await addAlertRecipient(username, label.trim() || undefined);
      toast.ok(`Added @${checked.username ?? username}.`);
      setUsername(""); setLabel(""); setChecked(null);
      list.reload();
    } catch (e) {
      toast.err((e as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function remove(r: AlertRecipient) {
    if (!window.confirm(`Stop paging @${r.username ?? r.telegramId}?`)) return;
    setRemoving(r.telegramId);
    try {
      await removeAlertRecipient(r.telegramId);
      list.reload();
    } catch (e) {
      toast.err((e as Error).message);
    } finally {
      setRemoving(null);
    }
  }

  return (
    <section className="mb-6 rounded-lg border-2 border-line-strong bg-card p-3">
      <h3 className="font-bold text-brand-ink">Who gets paged</h3>
      <p className="mt-0.5 text-xs text-muted">
        A high-severity fraud or reconciliation flag DMs each person below on
        Telegram, the instant it is first raised. Someone can only be added
        once they have started the bot — ask them to open the bot in Telegram
        and press Start, then check their username here.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-[10px] font-semibold text-muted">Telegram username</label>
          <input value={username} onChange={(e) => { setUsername(e.target.value); setChecked(null); }}
            placeholder="e.g. fazalelahi_1"
            className="w-48 rounded-md border border-line bg-card p-2 text-sm outline-none" />
        </div>
        <div>
          <label className="block text-[10px] font-semibold text-muted">Label (optional)</label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Founder"
            className="w-40 rounded-md border border-line bg-card p-2 text-sm outline-none" />
        </div>
        <button onClick={check} disabled={checking || !username.trim()}
          className="rounded-md border border-line bg-bg px-3 py-2 text-xs font-semibold text-brand-ink disabled:opacity-50">
          {checking ? "Checking…" : "Check"}
        </button>
        {checked?.found && !checked.blocked && (
          <button onClick={add} disabled={adding}
            className="rounded-md bg-brand px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">
            {adding ? "Adding…" : `Add @${checked.username ?? username}`}
          </button>
        )}
      </div>

      {checked && (
        <p className={`mt-2 text-xs ${checked.found && !checked.blocked ? "text-success" : "text-danger"}`}>
          {!checked.found && (checked.note ?? "Not found.")}
          {checked.found && checked.blocked && `Found — @${checked.username ?? username} (${checked.name ?? "no name on file"}), but they have blocked the bot and cannot be added.`}
          {checked.found && !checked.blocked && `Found — ${checked.name ?? "no name on file"}. Ready to add.`}
        </p>
      )}

      <div className="mt-3">
        {list.loading ? <p className="text-xs text-muted">Loading…</p>
          : list.error ? <p className="text-xs text-danger">{list.error}</p>
          : (list.data?.recipients.length ?? 0) === 0 ? (
            <p className="text-xs text-muted">Nobody is set up yet — add someone above.</p>
          ) : (
            <div className="space-y-1.5">
              {list.data!.recipients.map((r) => (
                <div key={r.telegramId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-bg/40 p-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-brand-ink">
                      @{r.username ?? r.telegramId} {r.label && <span className="font-normal text-muted">· {r.label}</span>}
                      {r.blocked && <StatusBadge status="off" />}
                    </p>
                    <p className="text-[10px] text-muted">
                      {r.name ?? "no name on file"} · added {new Date(r.addedAt).toLocaleDateString()}
                      {r.blocked && " · has blocked the bot — will not be paged until they message it again"}
                    </p>
                  </div>
                  <button onClick={() => remove(r)} disabled={removing === r.telegramId}
                    className="shrink-0 rounded-md bg-danger px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">
                    {removing === r.telegramId ? "…" : "Remove"}
                  </button>
                </div>
              ))}
            </div>
          )}
      </div>
    </section>
  );
}

// ---- Staff paging over Telegram (alerts.ts) --------------------------------
// There is no on-call system in this codebase (Sentry declined) — a HIGH-
// severity fraud or reconciliation flag pages the recipients above by Telegram
// DM the instant it is first raised. This button only confirms the wiring; it
// does not raise a real flag.
export function StaffAlertsPanel() {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "off">("idle");
  const [note, setNote] = useState("");

  async function send() {
    setState("sending");
    try {
      const r = await testStaffAlert();
      if (r.ok) { setState("sent"); setNote(""); }
      else { setState("off"); setNote(r.note ?? "Not configured."); }
    } catch (e) {
      setState("off");
      setNote((e as Error).message);
    }
  }

  return (
    <section className="mb-8">
      <h2 className="mb-1 font-bold text-brand-ink">Staff alerts</h2>
      <p className="mb-3 text-xs text-muted">
        A high-severity fraud or reconciliation flag pages the people below by
        Telegram DM the instant it is first raised. Reuses the same bot as
        Telegram login — no second bot to create.
      </p>

      <AlertRecipientsCard />

      <div className="flex flex-wrap items-center gap-3">
        <button onClick={send} disabled={state === "sending"}
          className="rounded-md bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {state === "sending" ? "Sending…" : "Send test alert"}
        </button>
        {state === "sent" && <span className="text-sm text-success">Sent — check Telegram.</span>}
        {state === "off" && <span className="text-sm text-danger">{note}</span>}
        {state === "idle" && <span className="text-xs text-muted">Not tested yet this session.</span>}
      </div>
    </section>
  );
}

// ---- Global settings -------------------------------------------------------
export function GlobalSettingsPanel() {
  const settings = useApi(fetchSettings, []);
  const toast = useToast();
  const [form, setForm] = useState({
    appName: "", supportEmail: "", supportTelegram: "",
    minWithdrawPoints: 0, maintenanceMessage: "",
    welcomeRepeatDays: 0 as 0 | 1 | 7 | 30 | 365,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Seed the form once the server's values arrive. This is the "sync from an
  // external system after load" case — the values cannot be state's initial
  // value because they are not known at first render.
  useEffect(() => {
    const d = settings.data;
    if (!d) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setForm({
      appName: d.appName, supportEmail: d.supportEmail,
      supportTelegram: d.supportTelegram,
      minWithdrawPoints: d.minWithdrawPoints,
      maintenanceMessage: d.maintenanceMessage,
      welcomeRepeatDays: (d.welcomeRepeatDays as 0 | 1 | 7 | 30 | 365) ?? 0,
    });
  }, [settings.data]);

  async function save() {
    setSaving(true); setSaved(false);
    try {
      await updateSettings(form);
      setSaved(true);
      settings.reload();
    } catch (e) {
      toast.err((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleMaintenance() {
    const on = !settings.data?.maintenanceMode;
    if (on && !window.confirm(
      "Close the app to everyone except staff?\n\n" +
      "Earners will see a 'back soon' message. Ad-network postbacks keep " +
      "working, so nobody loses earnings they already made.",
    )) return;
    try {
      await updateSettings({ maintenanceMode: on });
      settings.reload();
    } catch (e) { toast.err((e as Error).message); }
  }

  if (settings.loading) return <p className="mb-8 text-sm text-muted">Loading settings…</p>;
  if (settings.error) return <p className="mb-8 text-sm text-danger">{settings.error}</p>;
  const d = settings.data!;

  const field = "w-full rounded-md border border-line bg-card p-2 text-sm outline-none";

  return (
    <section className="mb-8">
      <h2 className="mb-1 font-bold text-brand-ink">Settings</h2>
      <p className="mb-3 text-xs text-muted">
        Fees, treasury, mining rates, networks and referral rates each have their
        own panel — they are not repeated here, so there is only ever one place
        that sets a given value.
      </p>

      {/* Maintenance is first and loud: it is the only control here that turns
          the whole product off, and burying it under four text inputs would be
          exactly wrong in the moment someone needs it. */}
      <div className={`mb-4 rounded-lg border-2 p-3 ${
        d.maintenanceMode ? "border-danger bg-danger-tint" : "border-line-strong bg-card"
      }`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="font-semibold text-brand-ink">
              Maintenance mode {d.maintenanceMode ? "— ON, the app is closed" : "— off"}
            </p>
            <p className="text-xs text-muted">
              Staff sign-in and the staff panel keep working. Ad-network postbacks
              keep crediting, so nobody loses work they already did.
            </p>
          </div>
          <button onClick={toggleMaintenance}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold text-white ${
              d.maintenanceMode ? "bg-success" : "bg-danger"
            }`}>
            {d.maintenanceMode ? "Reopen the app" : "Close the app"}
          </button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-semibold text-muted">App name</span>
          <input className={field} value={form.appName}
            onChange={(e) => setForm({ ...form, appName: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-muted">Minimum cash-out (points)</span>
          <input className={field} type="number" min={1} value={form.minWithdrawPoints}
            onChange={(e) => setForm({ ...form, minWithdrawPoints: Number(e.target.value) })} />
          {/* Guardrail #4. The one setting on this screen that can quietly make
              the product useless for the people it is for. */}
          <span className="mt-0.5 block text-xs text-muted">
            1000 points = 1 USDT. Raising this makes cashing out slower for
            everyone — check it is still reachable in a week of ordinary earning.
          </span>
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-muted">Support email</span>
          <input className={field} value={form.supportEmail}
            onChange={(e) => setForm({ ...form, supportEmail: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-muted">Support Telegram</span>
          <input className={field} value={form.supportTelegram} placeholder="@rozipay_support"
            onChange={(e) => setForm({ ...form, supportTelegram: e.target.value })} />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs font-semibold text-muted">
            What earners see during maintenance
          </span>
          <input className={field} value={form.maintenanceMessage}
            placeholder="We are doing some work on the app. Please check back soon."
            onChange={(e) => setForm({ ...form, maintenanceMessage: e.target.value })} />
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs font-semibold text-muted">
            Welcome screen — show it again after
          </span>
          <select className={field} value={form.welcomeRepeatDays}
            onChange={(e) => setForm({ ...form, welcomeRepeatDays: Number(e.target.value) as 0 | 1 | 7 | 30 | 365 })}>
            <option value={0}>Never — once per account (default)</option>
            <option value={1}>Every 24 hours</option>
            <option value={7}>Every 7 days</option>
            <option value={30}>Every 30 days</option>
            <option value={365}>Every year</option>
          </select>
          <span className="mt-0.5 block text-xs text-muted">
            The animated welcome a new user sees once, right after signing in.
            This controls whether it comes back — and how often — after they
            have already dismissed it once.
          </span>
        </label>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button onClick={save} disabled={saving}
          className="rounded-md bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="text-sm text-success">Saved.</span>}
      </div>
    </section>
  );
}
