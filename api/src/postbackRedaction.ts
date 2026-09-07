// Redact old postback_log rows (audit finding A-08).
//
// A postback's `raw` column stores the network's ENTIRE request — its
// signature, its own transaction id, whatever else it echoed — plus the
// caller's IP, and nothing ever purged it. That is a real retention gap, but
// it is not a table to just DELETE from: `network` / `external_id` /
// `verified` / `outcome` / `created_at` are what an Agent uses to settle a
// dispute months later, and a network's fraud-reversal window (CPX's is up
// to ~60 days, see CLAUDE.md) is exactly the kind of dispute this table
// exists for. So this blanks `raw` — the echoed request body and the IP —
// once a row is old enough that a dispute over it is no longer plausible,
// and leaves every other column untouched.
import { sql, now } from "./db.ts";
import { config } from "./config.ts";

const REDACTED_MARKER = JSON.stringify({ redacted: true });

export async function tickPostbackRedaction(): Promise<{ redacted: number }> {
  const days = config.postbackLogRetentionDays;
  if (days <= 0) return { redacted: 0 };
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // `raw IS NOT NULL` so an already-redacted (or never-populated) row is not
  // rewritten on every tick — this runs every few hours, forever.
  const r = await sql.run(
    "UPDATE postback_log SET raw = ? WHERE created_at < ? AND raw IS NOT NULL AND raw <> ?",
    REDACTED_MARKER, cutoff, REDACTED_MARKER,
  );
  return { redacted: r.rowCount };
}
