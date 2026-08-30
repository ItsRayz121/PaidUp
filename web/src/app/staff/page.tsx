"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useStaffSession, useApi } from "@/lib/hooks";
import { can, canAny, type UiPermission } from "@/lib/permissions";
import { LogoutButton } from "@/components/state";
import { fetchFraud } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import {
  KpiDashboard, NetworkPanel, ResolveFlagButton,
  TreasuryPanel, WithdrawalFeePanel, RefreshBar, QUEUE_POLL_MS,
} from "@/components/staff";
import { SupportQueuePanel } from "@/components/staff/SupportQueue";
import { UsersPanel, StaffRolesPanel, MoneyPanel } from "@/components/admin";
import { MiningAdminSection } from "@/components/mining-admin";
import {
  WithdrawalsPanel, DepositsPanel, RefundsPanel, BnbWithdrawalsPanel,
  RelayJobsPanel, ReconciliationPanel,
} from "@/components/staff/MoneyQueues";
import { Panel } from "@/components/boundary";
import { LogoMark } from "@/components/Logo";
import { TasksAdminPanel, ProofReviewPanel } from "@/components/staff/TasksAdmin";
import { KycPanel } from "@/components/kyc-admin";
import { AuditPanel } from "@/components/audit-admin";
import { FeatureFlagsPanel, GlobalSettingsPanel, StaffAlertsPanel } from "@/components/settings-admin";
import { AnalyticsDashboard } from "@/components/analytics-admin";
import { ReferralPanel, LeaderboardPanel } from "@/components/growth-admin";
import { BroadcastPanel, ContentPanel } from "@/components/notify-admin";
import { StaffNavContext, useStaffNav, type SectionId } from "@/lib/staffNav";
import { StaffSearch, SectionToc } from "@/components/staff-search";
import { ToastProvider } from "@/components/staff/toast";
import { UserLookupScreen } from "@/components/staff/UserDetail";
import { DashboardOverview } from "@/components/staff/DashboardOverview";

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
  { id: "money", label: "Money & payouts", needs: ["withdrawals.view", "deposits.view", "refunds.view", "treasury.view", "money.view", "settings.manage"] },
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
  { id: "settings", label: "Features & settings", needs: ["flags.manage", "settings.manage", "infra.view"] },
  { id: "team", label: "Staff & roles", needs: ["staff.manage"] },
];

export default function StaffPage() {
  const { user, ready } = useStaffSession();
  const [lookupTarget, setLookupTarget] = useState<string | null>(null);
  const may = (p: UiPermission) => can(user, p);

  // Which sections this user can see, in order.
  const visible = SECTIONS.filter((s) => canAny(user, s.needs));
  const [section, setSection] = useState<SectionId | null>(null);
  // Restore the section from the URL hash so a reload (or a shared link) lands
  // on the same screen. Falls back to the first section the role can see.
  useEffect(() => {
    if (!ready || section !== null || visible.length === 0) return;
    const fromHash = window.location.hash.replace("#", "") as SectionId;
    // Syncing FROM the URL hash (an external system) once auth resolves — the
    // hash isn't readable during the static prerender, so it can't be state's
    // initial value.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSection(visible.some((s) => s.id === fromHash) ? fromHash : visible[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, visible.length]);
  function go(id: SectionId) {
    setSection(id);
    window.history.replaceState(null, "", `#${id}`);
  }
  // Search result picked: switch section, then (once the new section's panels
  // have mounted) scroll the chosen panel into view. The timeout waits out the
  // state update + remount — the target does not exist in the DOM yet when go()
  // returns.
  function goToDest(id: SectionId, anchor?: string) {
    go(id);
    if (anchor) {
      setTimeout(() => {
        document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 80);
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }
  // "view ledger" on a withdrawal jumps to the Users section with the search
  // pre-filled — the lookup lives there now.
  function openLedger(userId: string) {
    setLookupTarget(userId);
    go("users");
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
      {visible.map((s) => (
        <button key={s.id} onClick={() => go(s.id)}
          className={`block w-full whitespace-nowrap rounded-md px-3 py-2 text-left text-sm font-semibold transition-colors ${
            section === s.id ? "bg-brand text-white" : "text-brand hover:bg-brand-tint"
          }`}>
          {s.label}
        </button>
      ))}
    </>
  );

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
          {/* Map of what's in the current section — jumps to each panel. */}
          {section && <SectionToc section={section} has={may} onJump={(a) => goToDest(section, a)} />}
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

          {section === "money" && (
            <>
              {may("withdrawals.view") && (
                <Panel id="p-withdrawals" title="Withdrawals"><WithdrawalsPanel canOpenLedger={may("users.view")} /></Panel>
              )}
              {/* Money IN. Confirming a pasted tx hash credits real USDT, so it
                  is gated on `deposits.view` and the buttons inside on
                  `deposits.decide` — a read-only role sees the queue and cannot
                  act on it.
                  ⚠️ `canDecide` IS NOT DECORATION. Manager and Operations hold
                  `deposits.view`/`refunds.view` but NOT the matching `.decide`
                  (permissions.ts), and moving these panels here is what first
                  showed them to those roles. Without the prop they render live
                  Confirm/Reject buttons that 403 on click — a staff member told
                  they can act on real money, then refused after clicking. */}
              {may("deposits.view") && (
                <Panel id="p-usdt-deposits" title="USDT deposits"><DepositsPanel canDecide={may("deposits.decide")} /></Panel>
              )}
              {/* Money back OUT: a user's own unspent deposit, returned. */}
              {may("refunds.view") && (
                <Panel id="p-usdt-refunds" title="USDT refunds"><RefundsPanel canDecide={may("refunds.decide")} /></Panel>
              )}
              {/* Failed-money surfaces that never had a screen before Phase C —
                  the dashboard only ever counted them. Read-only: a failed
                  native send / relay job is terminal and needs a human on the
                  chain, not a retry button. */}
              {may("withdrawals.view") && (
                <Panel id="p-bnb-withdrawals" title="BNB withdrawals"><BnbWithdrawalsPanel canHandle={may("withdrawals.decide")} /></Panel>
              )}
              {may("withdrawals.view") && (
                <Panel id="p-relay-jobs" title="Payout relay jobs"><RelayJobsPanel canHandle={may("withdrawals.decide")} /></Panel>
              )}
              {/* The treasury (hot) wallet: where payouts are sent from. */}
              {may("treasury.view") && <Panel id="p-treasury" title="Treasury wallet"><TreasuryPanel /></Panel>}
              {/* Treasury vs. what the ledger says we owe, one row per hourly check. */}
              {may("analytics.view") && <Panel id="p-reconciliation" title="Reconciliation history"><ReconciliationPanel /></Panel>}
              {may("settings.manage") && <Panel id="p-withdrawal-fee" title="Withdrawal fee & auto-approve limits"><WithdrawalFeePanel /></Panel>}
              {/* What you owe users vs what you've paid. */}
              {may("money.view") && <Panel id="p-money" title="Money"><MoneyPanel /></Panel>}
            </>
          )}

          {section === "users" && (
            <>
              {/* Find, pay, suspend a user. */}
              {may("users.list") && <Panel id="p-users" title="Users"><UsersPanel /></Panel>}
              {/* ID review. Deliberately narrower than the rest of the panel:
                  nobody else needs to see a stranger's national ID card. */}
              {may("kyc.view") && <Panel id="p-kyc" title="Verify IDs"><KycPanel /></Panel>}
              {/* Dispute lookup. */}
              {may("users.view") && <Panel id="p-lookup" title="Look up a user"><UserLookupScreen target={lookupTarget} onCleared={() => setLookupTarget(null)} /></Panel>}
              {may("fraud.view") && <Panel id="p-fraud" title="Fraud flags"><FraudPanel canResolve={may("fraud.resolve")} /></Panel>}
            </>
          )}

          {section === "tasks" && (
            <>
              {/* Our own custom tasks. */}
              {may("tasks.view") && <Panel id="p-tasks" title="Our own tasks"><TasksAdminPanel /></Panel>}
              {/* Task proof review. */}
              {may("tasks.review") && <Panel id="p-proofs" title="Task proofs"><ProofReviewPanel /></Panel>}
              {/* Ad-network config. */}
              {may("networks.manage") && <Panel id="p-networks" title="Ad networks"><NetworkPanel /></Panel>}
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

          {section === "growth" && (
            <>
              {may("referrals.manage") && <Panel id="p-referrals" title="Referrals"><ReferralPanel /></Panel>}
              {may("leaderboard.manage") && <Panel id="p-leaderboard" title="Leaderboard"><LeaderboardPanel /></Panel>}
            </>
          )}

          {section === "messages" && (
            <>
              {may("notifications.send") && <Panel id="p-broadcast" title="Send a message"><BroadcastPanel /></Panel>}
              {may("content.manage") && <Panel id="p-content" title="Home screen cards"><ContentPanel /></Panel>}
            </>
          )}

          {section === "support" && may("support.view") && (
            <Panel id="p-support" title="Support tickets"><SupportQueuePanel /></Panel>
          )}

          {section === "audit" && may("audit.view") && (
            <Panel title="Audit log"><AuditPanel /></Panel>
          )}

          {section === "settings" && (
            <>
              {may("flags.manage") && <Panel id="p-flags" title="Features"><FeatureFlagsPanel /></Panel>}
              {may("settings.manage") && <Panel id="p-settings" title="Settings"><GlobalSettingsPanel /></Panel>}
              {may("infra.view") && <Panel id="p-alerts" title="Staff alerts"><StaffAlertsPanel /></Panel>}
            </>
          )}

          {section === "team" && may("staff.manage") && (
            <Panel title="Staff & roles"><StaffRolesPanel /></Panel>
          )}
        </StaffNavContext.Provider>
        </main>
      </div>
    </div>
    </ToastProvider>
  );
}


function FraudPanel({ canResolve }: { canResolve: boolean }) {
  const [auto, setAuto] = useState(true);
  const fraud = useApi(fetchFraud, [], true, auto ? QUEUE_POLL_MS : undefined);
  const { openUser } = useStaffNav();
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold text-brand-ink">Open fraud flags</h2>
        <RefreshBar updatedAt={fraud.updatedAt} loading={fraud.loading} onRefresh={fraud.reload} auto={auto} setAuto={setAuto} />
      </div>
      {fraud.loading ? <p className="text-sm text-muted">Loading…</p>
        : fraud.error ? <p className="text-sm text-danger">{fraud.error}</p>
        : (fraud.data?.flags.length ?? 0) === 0 ? (
          <p className="rounded-lg border border-line bg-card p-4 text-sm text-muted">No open flags. Good.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-brand-tint text-left text-xs uppercase text-brand">
                <tr><th className="p-2.5">User</th><th className="p-2.5">Type</th><th className="p-2.5">Severity</th><th className="p-2.5">Detail</th><th className="p-2.5">When</th><th className="p-2.5">Action</th></tr>
              </thead>
              <tbody>
                {fraud.data!.flags.map((f, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="p-2.5">
                      {f.user_id ? (
                        <button onClick={() => openUser(String(f.user_id))} className="text-brand hover:underline">
                          {String(f.user_email ?? f.user_id)}
                        </button>
                      ) : (
                        String(f.user_email ?? "—")
                      )}
                    </td>
                    <td className="p-2.5">{String(f.flag_type)}</td>
                    <td className="p-2.5">{String(f.severity)}</td>
                    <td className="p-2.5 text-muted">{String(f.detail ?? "")}</td>
                    <td className="p-2.5 text-muted">{timeAgo(String(f.created_at))}</td>
                    <td className="p-2.5">
                      {canResolve
                        ? <ResolveFlagButton id={String(f.id)} onResolved={fraud.reload} />
                        : <span className="text-xs text-muted">view only</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}
