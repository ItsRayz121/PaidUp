"use client";

// Feature flags + global settings (brief parts 44 and 45).
// Internal tool: density over friendliness, jargon allowed (DESIGN_BRIEF).

import { useEffect, useState } from "react";
import { useApi } from "@/lib/hooks";
import {
  fetchFlags, setFlag, fetchSettings, updateSettings, testStaffAlert, type FeatureFlag,
} from "@/lib/api";
import { StatusBadge } from "@/components/staff/primitives";
import { useToast } from "@/components/staff/toast";

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

      {flags.loading ? <p className="text-sm text-muted">Loading…</p>
        : flags.error ? <p className="text-sm text-danger">{flags.error}</p> : (
          <div className="space-y-2">
            {(flags.data?.flags ?? []).map((f) => (
              <div key={f.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-line bg-card p-3">
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

// ---- Staff paging over Telegram (alerts.ts) --------------------------------
// There is no on-call system in this codebase (Sentry declined) — a HIGH-
// severity fraud or reconciliation flag pages a staff Telegram group instead,
// the instant it is first raised. This button only confirms the wiring; it
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
        A high-severity fraud or reconciliation flag pages a staff Telegram group
        the instant it is first raised. Reuses the same bot as Telegram login —
        no second bot to create.
      </p>

      <div className="mb-3 rounded-lg border-2 border-line-strong bg-bg/40 p-3 text-xs text-muted">
        <p className="font-semibold text-brand-ink">How to switch it on (5 minutes)</p>
        <ol className="mt-1 list-decimal space-y-0.5 pl-5">
          <li>Create a Telegram group (or reuse a private staff one).</li>
          <li>Add your existing RoziPay bot to that group.</li>
          <li>Send any message in the group.</li>
          <li>Open <code>https://api.telegram.org/bot&lt;YOUR_BOT_TOKEN&gt;/getUpdates</code> in a browser
            and copy the <code>chat.id</code> — a group id is negative (e.g. <code>-1001234567890</code>).</li>
          <li>On Railway set <code>TELEGRAM_ALERT_CHAT_ID</code> to that id
            (<code>TELEGRAM_BOT_TOKEN</code> is already set for Telegram login), then redeploy.</li>
          <li>Come back here and hit &ldquo;Send test alert&rdquo;.</li>
        </ol>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button onClick={send} disabled={state === "sending"}
          className="rounded-md bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {state === "sending" ? "Sending…" : "Send test alert"}
        </button>
        {state === "sent" && <span className="text-sm text-success">Sent — check the group.</span>}
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
    minWithdrawPoints: 0, ticketAutoCloseHours: 3, maintenanceMessage: "",
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
      ticketAutoCloseHours: d.ticketAutoCloseHours,
      maintenanceMessage: d.maintenanceMessage,
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
      <div className={`mb-4 rounded-lg border p-3 ${
        d.maintenanceMode ? "border-danger bg-danger-tint" : "border-line bg-card"
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
          <span className="text-xs font-semibold text-muted">Close a chat with no reply after (hours)</span>
          <input className={field} type="number" min={0} max={720} value={form.ticketAutoCloseHours}
            onChange={(e) => setForm({ ...form, ticketAutoCloseHours: Number(e.target.value) })} />
          <span className="mt-0.5 block text-xs text-muted">
            Once staff answer a ticket and the user does not reply, it closes itself
            after this many hours. 0 turns auto-close off.
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
