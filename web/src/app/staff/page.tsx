"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useStaffSession, useApi } from "@/lib/hooks";
import { can, canAny, type UiPermission } from "@/lib/permissions";
import { LogoutButton } from "@/components/state";
import { fetchFraud, setUserStatus, resolveFraud } from "@/lib/api";
import { timeAgo, displayIdentity } from "@/lib/format";
import {
  KpiDashboard, NetworkPanel,
  WithdrawalFeePanel, RefreshBar, QUEUE_POLL_MS,
} from "@/components/staff";
import { SupportQueuePanel } from "@/components/staff/SupportQueue";
import { UsersPanel, StaffRolesPanel } from "@/components/admin";
import { MiningAdminSection } from "@/components/mining-admin";
import {
  WithdrawalsGroupPanel, DepositsGroupPanel, TreasuryGroupPanel,
} from "@/components/staff/MoneyQueues";
import { DisbursementsPanel } from "@/components/staff/Disbursements";
import { Panel } from "@/components/boundary";
import { LogoMark } from "@/components/Logo";
import { TasksAdminPanel, ProofReviewPanel } from "@/components/staff/TasksAdmin";
import { KycPanel } from "@/components/kyc-admin";
import { AuditPanel } from "@/components/audit-admin";
import { FeatureFlagsPanel, GlobalSettingsPanel, StaffAlertsPanel } from "@/components/settings-admin";
import { AnalyticsDashboard } from "@/components/analytics-admin";
import { ReferralPanel, LeaderboardPanel, PerNetworkPanel } from "@/components/growth-admin";
import { BroadcastPanel, ContentPanel } from "@/components/notify-admin";
import { StaffNavContext, useStaffNav, type SectionId } from "@/lib/staffNav";
import { StaffSearch } from "@/components/staff-search";
import { ToastProvider } from "@/components/staff/toast";
import { UserLookupScreen } from "@/components/staff/UserDetail";
import { DashboardOverview } from "@/components/staff/DashboardOverview";
import { MoneyOverview } from "@/components/staff/MoneyOverview";
import {
  ChartIcon, WalletIcon, ShieldIcon, TasksIcon, MineIcon, ReferIcon,
  InboxIcon, HelpIcon, ClockIcon, SlidersIcon, GearIcon, ProfileIcon,
} from "@/components/icons";

// Internal tool: information density + speed over friendliness (DESIGN_BRIEF).
// Jargon (postback, fraud, ledger) is allowed here — never in the earner app.

// ---- Sidebar sections -------------------------------------------------------
// Grouped deliberately COARSE (founder request: "proper side panels, not too
// many"): one entry per job a staff member sits down to do, not one per widget.
// Sections a role can't use are hidden, and only the ACTIVE section mounts, so
// opening the panel no longer fires every panel's API calls at once.
//
// A section is visible when the user holds ANY of its permissions — the section
// is a drawer, and it is worth opening if there is one thing inside. The panels
// within it each gate themselves, so a Finance user opening "Users & IDs" sees
// lookup and IDs but not the suspend controls.
//
// ⚠️ THIS LIST IS PERMISSIONS, NOT ROLES, AND THAT IS THE POINT. The old form
// was `min: "manager"`, which only works while roles are a ladder. With nine
// job-shaped roles there is no "minimum" — Finance is not above or below Task
// Manager — and every new role would need this file edited before it could see
// anything. Now a role's sections fall out of what it may do.
const SECTIONS: { id: SectionId; label: string; needs: UiPermission[] }[] = [
  { id: "dashboard", label: "Dashboard", needs: ["analytics.view"] },
  // ⚠️ `deposits.view` / `refunds.view` are listed here and that is a FIX, not
  // decoration. Both queues used to render only inside the Mining section,
  // which is gated on `mining.manage` — a permission the Finance role does not
  // hold. Finance owns money in and money out and held `deposits.decide` +
  // `refunds.decide`, yet could not reach either screen. Deposits are money,
  // not mining.
  // `money.view` used to gate the old "Owed vs paid" panel; that panel's
  // numbers moved into Money → Overview (gated on withdrawals.view), so the
  // permission no longer maps to a panel and is dropped from this list — a
  // money.view-only role would otherwise land on an empty section.
  // `mining.manage` is here for the "USDT top-up" sub-tab only (founder,
  // 2026-09-02: money-in config belongs with Money, not buried in mining). A
  // mining-only admin sees the section with just that one tab.
  { id: "money", label: "Money & payouts", needs: ["withdrawals.view", "disbursements.manage", "deposits.view", "refunds.view", "treasury.view", "settings.manage", "mining.manage"] },
  { id: "users", label: "Users & IDs", needs: ["users.view", "users.list", "kyc.view", "fraud.view"] },
  { id: "tasks", label: "Tasks & networks", needs: ["tasks.view", "tasks.review", "networks.manage"] },
  // ⚠️ `mining.view` is deliberately NOT here. The Mining section's tabs
  // (MiningAdminSection, Phase E) each need `mining.manage` / `machines.manage`
  // — even though a tab now mounts on its own, listing the read permission would
  // still show the section to a manager and then fill every tab with 403s. The
  // read-only mining numbers belong on the Dashboard, which is where
  // `mining.view` is actually spent (GET /staff/mining/stats).
  { id: "mining", label: "Mining (ROZI)", needs: ["mining.manage", "machines.manage"] },
  // Referral rates and the leaderboard sit together because they are one job:
  // the board exists to make people invite friends, and the rates decide
  // whether inviting is worth doing. This is the section the `marketing` role
  // was created for — before it, that role held two permissions with nowhere to
  // spend them, which is the same defect Finance had in stage 4.
  { id: "growth", label: "Growth", needs: ["referrals.manage", "leaderboard.manage"] },
  // Everything that puts WORDS in front of users, in one place: announcements
  // to an inbox, and the cards on the home screen. Separate from Support,
  // which is answering one person who asked.
  { id: "messages", label: "Messages & content", needs: ["notifications.send", "content.manage"] },
  { id: "support", label: "Support tickets", needs: ["support.view"] },
  { id: "audit", label: "Audit log", needs: ["audit.view"] },
  // Founder, 2026-09-01: "a different page for each — flags, settings, alerts".
  // Each is its own sidebar entry now, gated on its own permission, instead of
  // three sub-tabs under one "Features & settings" section.
  { id: "flags", label: "Feature flags", needs: ["flags.manage"] },
  { id: "settings", label: "Global settings", needs: ["settings.manage"] },
  // Staff alerts is a sub-tab of "Staff & roles" now (founder, 2026-09-02) —
  // it is a staffing/ops concern, not its own top-level page.
  { id: "team", label: "Staff & roles", needs: ["staff.manage", "infra.view"] },
];

// One icon per section (founder, 2026-09-02: "add some professional icons
// across the admin panel"). Purely a nav wayfinding aid — every icon still
// sits next to its text label, never carrying meaning alone.
const SECTION_ICON: Record<SectionId, (p: { size?: number }) => ReactNode> = {
  dashboard: ChartIcon, money: WalletIcon, users: ShieldIcon, tasks: TasksIcon,
  mining: MineIcon, growth: ReferIcon, messages: InboxIcon, support: HelpIcon,
  audit: ClockIcon, flags: SlidersIcon, settings: GearIcon, team: ProfileIcon,
};

// ---- Sub-panels within a section ------------------------------------------
// Founder, 2026-09-01: "one thing per screen". A section that has more than one
// job to do (Money & payouts, Users & IDs, …) shows a horizontal sub-tab bar
// under its title and mounts exactly ONE panel at a time — never the old stack
// of every panel scrolled together. `need` gates a tab the same way a section
// is gated; a tab the role can't use is never shown, and picking a search
// deep-link jumps straight to the right tab (`#money/p-withdrawals`).
// `need` accepts an array for a grouped tab whose internal sub-tabs each
// carry a different permission (e.g. Deposits: deposits.view / refunds.view /
// mining.manage) — the outer tab shows if the role holds ANY of them, and
// each internal panel still gates itself before rendering content.
type PanelDef = { id: string; label: string; need?: UiPermission | UiPermission[]; node: ReactNode };
const needMet = (need: UiPermission | UiPermission[] | undefined, may: (p: UiPermission) => boolean): boolean =>
  need === undefined || (Array.isArray(need) ? need.some(may) : may(need));

function SubTabs({ items, active, onPick }: {
  items: { id: string; label: string }[]; active: string; onPick: (id: string) => void;
}) {
  return (
    <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-line pb-2">
      {items.map((t) => (
        <button key={t.id} onClick={() => onPick(t.id)}
          className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
            active === t.id ? "bg-brand text-white" : "text-brand hover:bg-brand-tint"
          }`}>
          {t.label}
        </button>
      ))}
    </nav>
  );
}

export default function StaffPage() {
  const { user, ready } = useStaffSession();
  const [lookupTarget, setLookupTarget] = useState<string | null>(null);
  const may = (p: UiPermission) => can(user, p);

  // Which sections this user can see, in order.
  const visible = SECTIONS.filter((s) => canAny(user, s.needs));
  const [section, setSection] = useState<SectionId | null>(null);
  // The active sub-tab within the section (founder, 2026-09-01: "one thing per
  // screen"). null = fall back to the section's first visible panel.
  const [panelId, setPanelId] = useState<string | null>(null);
  // Restore section + sub-tab from the URL hash (`#money/p-withdrawals`) so a
  // reload or a shared link lands on the same screen. The hash isn't readable
  // during the static prerender, so it can't be state's initial value.
  useEffect(() => {
    if (!ready || section !== null || visible.length === 0) return;
    const [h, p] = window.location.hash.replace("#", "").split("/");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSection(visible.some((s) => s.id === h) ? (h as SectionId) : visible[0].id);
    if (p) setPanelId(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, visible.length]);
  function applyHash(hash: string) {
    const [h, p] = hash.replace(/^#/, "").split("/");
    setSection(visible.some((s) => s.id === h) ? (h as SectionId) : (visible[0]?.id ?? null));
    setPanelId(p || null);
  }
  function go(id: SectionId, pid?: string) {
    const next = pid ? `#${id}/${pid}` : `#${id}`;
    setSection(id);
    setPanelId(pid ?? null);
    // pushState (not replaceState) so the browser Back button walks back through
    // the sections the user visited and only LEAVES /staff once there is nothing
    // left to go back to — instead of Back always exiting the panel on the first
    // press. Same-target clicks don't stack an entry.
    if (`#${window.location.hash.replace(/^#/, "")}` !== next) {
      window.history.pushState(null, "", next);
    }
  }
  // Browser Back/Forward within the panel: re-apply section + sub-tab from the
  // hash rather than unmounting /staff.
  useEffect(() => {
    const onPop = () => applyHash(window.location.hash);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.length]);
  // Search result / stat tile picked: switch to that section and sub-tab, then
  // scroll to the top — there is only one panel per screen now, nothing to
  // scroll *to* within it.
  function goToDest(id: SectionId, pid?: string) {
    go(id, pid);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  // "view ledger" on a withdrawal jumps to the Users section, Look-up sub-tab,
  // with the search pre-filled.
  function openLedger(userId: string) {
    setLookupTarget(userId);
    go("users", "p-lookup");
  }

  if (!ready) return <div className="p-6 text-muted">Loading…</div>;
  if (user && !user.role) {
    return (
      <div className="mx-auto max-w-md p-8 text-center">
        <h1 className="text-xl font-bold text-brand-ink">Staff only</h1>
        <p className="mt-2 text-muted">This area is for support staff. You do not have access.</p>
        <Link href="/" className="mt-4 inline-block font-semibold text-brand">Back to the app</Link>
      </div>
    );
  }
  // A staff role with nothing switched on. Says so, rather than rendering an
  // empty shell that reads as a broken page — the fix is an admin's job, and
  // this is the message that tells the user to go and ask for it.
  if (user?.role && visible.length === 0) {
    return (
      <div className="mx-auto max-w-md p-8 text-center">
        <h1 className="text-xl font-bold text-brand-ink">Nothing assigned yet</h1>
        <p className="mt-2 text-muted">
          Your role ({user.roleLabel ?? user.role}) does not have any sections turned on.
          Ask an admin to update it.
        </p>
        <Link href="/" className="mt-4 inline-block font-semibold text-brand">Back to the app</Link>
      </div>
    );
  }

  const nav = (
    <>
      {visible.map((s) => {
        const Icon = SECTION_ICON[s.id];
        return (
          <button key={s.id} onClick={() => go(s.id)}
            className={`flex w-full items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-left text-sm font-semibold transition-colors ${
              section === s.id ? "bg-brand text-white" : "text-brand hover:bg-brand-tint"
            }`}>
            <Icon size={16} />
            {s.label}
          </button>
        );
      })}
    </>
  );

  // The multi-panel sections, each as an ordered list of sub-tabs. Built here
  // (not a module constant) because the panel nodes close over `may`,
  // `lookupTarget` etc. Only the ACTIVE panel is placed in the tree below, so
  // only its data fetches fire.
  const SECTION_PANELS: Partial<Record<SectionId, PanelDef[]>> = {
    money: [
      { id: "p-overview", label: "Overview", need: "withdrawals.view", node: <MoneyOverview /> },
      // Grouped 2026-09-02 (founder: 11 flat tabs was too many) — each group
      // below is one PanelDef whose node owns its own internal sub-tabs
      // (WithdrawalsGroupPanel / DepositsGroupPanel / TreasuryGroupPanel in
      // MoneyQueues.tsx), same pattern MiningAdminSection already uses.
      {
        id: "p-withdrawals-group", label: "Withdrawals", need: "withdrawals.view",
        node: <WithdrawalsGroupPanel has={may} />,
      },
      {
        id: "p-deposits-group", label: "Deposits", need: ["deposits.view", "refunds.view", "mining.manage"],
        node: <DepositsGroupPanel has={may} canDecideDeposits={may("deposits.decide")} canDecideRefunds={may("refunds.decide")} />,
      },
      { id: "p-disbursements", label: "Disbursements", need: "disbursements.manage", node: <DisbursementsPanel canManage={may("disbursements.manage")} /> },
      {
        id: "p-treasury-group", label: "Treasury", need: ["treasury.view", "analytics.view"],
        node: <TreasuryGroupPanel has={may} canRecheck={may("analytics.view")} />,
      },
      { id: "p-withdrawal-fee", label: "Fees & limits", need: "settings.manage", node: <WithdrawalFeePanel /> },
    ],
    users: [
      { id: "p-users", label: "Users", need: "users.list", node: <UsersPanel /> },
      { id: "p-kyc", label: "Verify IDs", need: "kyc.view", node: <KycPanel /> },
      { id: "p-lookup", label: "Look up a user", need: "users.view", node: <UserLookupScreen target={lookupTarget} onCleared={() => setLookupTarget(null)} canDisburse={may("disbursements.manage")} /> },
      { id: "p-fraud", label: "Fraud flags", need: "fraud.view", node: <FraudPanel canResolve={may("fraud.resolve")} /> },
    ],
    tasks: [
      // ⚠️ One panel is mounted at a time (see the single `active.node` below) —
      // "Our tasks" never renders network / commission config, and "Ad networks"
      // never renders the task editor. The tabs just switch which is on screen.
      { id: "p-tasks", label: "Our tasks", need: "tasks.view", node: <TasksAdminPanel /> },
      { id: "p-proofs", label: "Proofs", need: "tasks.review", node: <ProofReviewPanel /> },
      { id: "p-networks", label: "Ad networks", need: "networks.manage", node: <NetworkPanel /> },
    ],
    growth: [
      { id: "p-referrals", label: "Referrals", need: "referrals.manage", node: <ReferralPanel /> },
      // Founder, 2026-09-02: the per-network rate breakdown is its own job, not
      // part of the advertised-rate summary.
      { id: "p-referral-networks", label: "Per network", need: "referrals.manage", node: <PerNetworkPanel /> },
      { id: "p-leaderboard", label: "Leaderboard", need: "leaderboard.manage", node: <LeaderboardPanel /> },
    ],
    messages: [
      { id: "p-broadcast", label: "Send a message", need: "notifications.send", node: <BroadcastPanel /> },
      { id: "p-content", label: "Home screen cards", need: "content.manage", node: <ContentPanel /> },
    ],
    team: [
      { id: "p-staff-roles", label: "Staff & roles", need: "staff.manage", node: <StaffRolesPanel /> },
      { id: "p-alerts", label: "Alerts", need: "infra.view", node: <StaffAlertsPanel /> },
    ],
  };

  return (
    <ToastProvider>
    <div className="mx-auto max-w-6xl px-4 py-5">
      <header className="sticky top-0 z-20 -mx-4 mb-5 flex items-center justify-between gap-3 border-b border-line bg-bg/95 px-4 py-3 backdrop-blur">
        {/* min-w-0 + break-all: a long staff email must wrap on a phone, not
            shove the Sign out button off the edge. */}
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-bold text-brand-ink">
            <LogoMark size={24} /> RoziPay — Staff
          </h1>
          <p className="break-all text-xs text-muted">
            Signed in as {user?.email} · role:{" "}
            <span className="font-semibold">{user?.roleLabel ?? user?.role}</span>
          </p>
        </div>
        <div className="shrink-0"><LogoutButton /></div>
      </header>

      {/* Jump straight to any section or panel (founder request). Only rendered
          once the role has at least one visible section. */}
      {visible.length > 0 && (
        <div className="mb-4">
          <StaffSearch
            visibleSections={visible.map((s) => s.id)}
            has={may}
            onGo={goToDest}
            onRecord={(hit) => {
              if (hit.type === "user") openLedger(hit.id);
              else goToDest(hit.section as SectionId);
            }}
          />
        </div>
      )}

      {/* Mobile: sections as a horizontal chip bar */}
      <nav className="mb-4 flex gap-1 overflow-x-auto pb-1 md:hidden">{nav}</nav>

      <div className="flex items-start gap-6">
        {/* Desktop: sticky sidebar */}
        <nav className="sticky top-20 hidden w-44 shrink-0 space-y-1 md:block">{nav}</nav>

        <main className="min-w-0 flex-1">
        <StaffNavContext.Provider value={{ goToSection: goToDest, openUser: openLedger }}>
          {/* Dashboard is a deliberate single scroll — an overview, not a queue. */}
          {section === "dashboard" && may("analytics.view") && (
            <>
              <Panel id="p-attention" title="Needs attention"><DashboardOverview /></Panel>
              <Panel title="Dashboard"><AnalyticsDashboard /></Panel>
              {/* The original at-a-glance strip, kept below the full report:
                  it reads from /staff/kpis, which several people already have
                  bookmarked expectations of, and it costs one small request. */}
              <Panel title="At a glance">
                <section className="mb-8">
                  <h2 className="mb-2 font-bold text-brand-ink">At a glance</h2>
                  <KpiDashboard />
                </section>
              </Panel>
            </>
          )}

          {section === "mining" && (
            <Panel id="p-mining" title="Mining (ROZI)">
              <section className="mb-8">
                <h2 className="mb-2 font-bold text-brand-ink">Mining (ROZI)</h2>
                <MiningAdminSection />
              </section>
            </Panel>
          )}

          {section === "support" && may("support.view") && (
            <Panel id="p-support" title="Support tickets"><SupportQueuePanel /></Panel>
          )}

          {section === "audit" && may("audit.view") && (
            <Panel title="Audit log"><AuditPanel /></Panel>
          )}

          {section === "flags" && may("flags.manage") && (
            <Panel id="p-flags" title="Feature flags"><FeatureFlagsPanel /></Panel>
          )}

          {section === "settings" && may("settings.manage") && (
            <Panel id="p-settings" title="Global settings"><GlobalSettingsPanel /></Panel>
          )}


          {/* Multi-panel sections: one sub-tab bar, one mounted panel. */}
          {section && SECTION_PANELS[section] && (() => {
            const defs = SECTION_PANELS[section]!.filter((d) => needMet(d.need, may));
            if (defs.length === 0) return null;
            const active = defs.find((d) => d.id === panelId) ?? defs[0];
            return (
              <>
                {defs.length > 1 && (
                  <SubTabs items={defs} active={active.id} onPick={(pid) => go(section, pid)} />
                )}
                {/* key on the panel id so switching sub-tabs gives a fresh error
                    boundary — a crash in one panel must not stick to the next. */}
                <Panel key={active.id} id={active.id} title={active.label}>{active.node}</Panel>
              </>
            );
          })()}
        </StaffNavContext.Provider>
        </main>
      </div>
    </div>
    </ToastProvider>
  );
}


const FRAUD_PREVIEW = 6;

// Founder, 2026-09-02: the fraud row needs a real judgement, not just
// "Resolve". Suspending the account auto-closes its flags server-side, so this
// is one action, not two.
function FlagActions({ id, userId, label, onDone }: {
  id: string; userId: string | null; label: string; onDone: () => void;
}) {
  const [busy, setBusy] = useState<"" | "resolve" | "suspend">("");
  async function resolve() {
    const note = window.prompt("Resolve this flag — why? (recorded)");
    if (note === null) return;
    setBusy("resolve");
    try { await resolveFraud(id, note.trim() || undefined); onDone(); }
    catch (e) { window.alert((e as Error).message); } finally { setBusy(""); }
  }
  async function suspend() {
    if (!userId) return;
    const reason = window.prompt(`Suspend ${label}? This stops them mining, earning and withdrawing, and closes their open flags.\n\nReason (recorded):`);
    if (reason === null || reason.trim() === "") return;
    setBusy("suspend");
    try { await setUserStatus(userId, "suspended", reason.trim()); onDone(); }
    catch (e) { window.alert((e as Error).message); } finally { setBusy(""); }
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      <button onClick={resolve} disabled={busy !== ""}
        className="rounded bg-brand-tint px-2 py-0.5 text-[11px] font-semibold text-brand disabled:opacity-50">
        {busy === "resolve" ? "…" : "Resolve"}
      </button>
      {userId && (
        <button onClick={suspend} disabled={busy !== ""}
          className="rounded bg-danger-tint px-2 py-0.5 text-[11px] font-semibold text-danger disabled:opacity-50">
          {busy === "suspend" ? "…" : "Suspend user"}
        </button>
      )}
    </div>
  );
}

function FraudPanel({ canResolve }: { canResolve: boolean }) {
  const [auto, setAuto] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const fraud = useApi(fetchFraud, [], true, auto ? QUEUE_POLL_MS : undefined);
  const { openUser } = useStaffNav();
  const all = fraud.data?.flags ?? [];
  // Preview the newest handful; the rest sit behind "See more" (founder,
  // 2026-09-01: "show five or six then let me click for more").
  const shown = showAll ? all : all.slice(0, FRAUD_PREVIEW);
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold text-brand-ink">Open fraud flags{all.length > 0 ? ` (${all.length})` : ""}</h2>
        <RefreshBar updatedAt={fraud.updatedAt} loading={fraud.loading} onRefresh={fraud.reload} auto={auto} setAuto={setAuto} />
      </div>
      {fraud.loading ? <p className="text-sm text-muted">Loading…</p>
        : fraud.error ? <p className="text-sm text-danger">{fraud.error}</p>
        : all.length === 0 ? (
          <p className="rounded-lg border-2 border-line-strong bg-card p-4 text-sm text-muted">No open flags. Good.</p>
        ) : (
          <>
          <div className="overflow-x-auto rounded-lg border-2 border-line-strong">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-brand-tint text-left text-xs uppercase text-brand">
                <tr><th className="p-2.5">User</th><th className="p-2.5">Type</th><th className="p-2.5">Severity</th><th className="p-2.5">Detail</th><th className="p-2.5">When</th><th className="p-2.5">Action</th></tr>
              </thead>
              <tbody>
                {shown.map((f, i) => {
                  // Real @handle / Telegram name instead of a raw email — and
                  // for a Telegram-only account, instead of
                  // `tg…@telegram.local` (founder, 2026-09-02).
                  const identity = f.user_id
                    ? displayIdentity({
                        email: f.user_email as string | null, username: f.user_username as string | null,
                        displayName: f.user_display_name as string | null,
                        telegramUsername: f.user_telegram_username as string | null,
                        telegramName: f.user_telegram_name as string | null,
                      })
                    : String(f.user_email ?? "—");
                  return (
                  <tr key={i} className="border-t border-line">
                    <td className="p-2.5">
                      {f.user_id ? (
                        <button onClick={() => openUser(String(f.user_id))} className="text-brand hover:underline">
                          {identity}
                        </button>
                      ) : (
                        identity
                      )}
                    </td>
                    <td className="p-2.5">{String(f.flag_type)}</td>
                    <td className="p-2.5">{String(f.severity)}</td>
                    <td className="p-2.5 text-muted">{String(f.detail ?? "")}</td>
                    <td className="p-2.5 text-muted">{timeAgo(String(f.created_at))}</td>
                    <td className="p-2.5">
                      {canResolve
                        ? <FlagActions id={String(f.id)} userId={f.user_id ? String(f.user_id) : null}
                            label={identity} onDone={fraud.reload} />
                        : <span className="text-xs text-muted">view only</span>}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {(all.length > FRAUD_PREVIEW) && (
            <button onClick={() => setShowAll(!showAll)}
              className="mt-2 text-xs font-semibold text-brand hover:underline">
              {showAll ? "Show less" : `See more (${all.length - FRAUD_PREVIEW})`}
            </button>
          )}
          </>
        )}
    </section>
  );
}
