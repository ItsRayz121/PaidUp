// Auto-close support tickets nobody came back to.
//
// A ticket in status 'answered' means staff replied last and the status has
// not moved since — a user reply flips it straight back to 'open'
// (routes/app.ts). So an 'answered' ticket whose `updated_at` is older than
// the admin-tunable auto-close window is, by construction, "we answered, and they
// never replied again." That is not the same thing as an unresolved ticket,
// and leaving it open forever just inflates the "open tickets" number the
// dashboard and every support agent watches.
//
// Closing writes an INTERNAL note first (visible to staff, never to the
// user — same author_role='internal' the reply screen already uses for a
// staff-only note) so the ticket's own thread explains why it closed itself,
// rather than a ticket just going quiet with no record of what happened.
import { sql, now, newId } from "./db.ts";
import { ticketAutoCloseHoursNow } from "./settingsRuntime.ts";

const SYSTEM_AUTHOR = "system:auto-close";

export async function tickTicketAutoClose(): Promise<{ closed: number }> {
  const hours = await ticketAutoCloseHoursNow();
  if (hours <= 0) return { closed: 0 };
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const stale = await sql.all<{ id: string }>(
    "SELECT id FROM support_tickets WHERE status = 'answered' AND updated_at < ?",
    cutoff,
  );
  if (stale.length === 0) return { closed: 0 };

  for (const t of stale) {
    await sql.tx(async (tx) => {
      // Re-check status inside the transaction: a staff reply or a user
      // reply between the SELECT above and this write must win over the
      // auto-close, not race it.
      const row = await tx.get<{ status: string }>(
        "SELECT status FROM support_tickets WHERE id = ? FOR UPDATE", t.id,
      );
      if (!row || row.status !== "answered") return;
      await tx.run(
        "INSERT INTO ticket_messages (id, ticket_id, author_role, author_id, body, created_at) VALUES (?,?,?,?,?,?)",
        newId(), t.id, "internal", SYSTEM_AUTHOR,
        `Closed automatically — no reply from the user for ${hours} hour${hours === 1 ? "" : "s"} after our answer.`,
        now(),
      );
      await tx.run(
        "UPDATE support_tickets SET status = 'closed', updated_at = ? WHERE id = ?",
        now(), t.id,
      );
    });
  }
  return { closed: stale.length };
}
