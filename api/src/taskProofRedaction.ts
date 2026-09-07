// Delete old task-proof screenshots (founder, 2026-09-07: "so we do not build
// up excessive storage cost").
//
// Mirrors postbackRedaction.ts exactly, one column narrower: task_proof_images
// holds an AES-256-GCM encrypted photo per screenshot answer, and this blanks
// `encrypted_value` once a row is old enough that the storage cost stops being
// worth paying. Every OTHER column — on this table (field_id, mime) and on the
// task_proofs row it belongs to (who approved it, for how much, every text
// answer) — is completely untouched. A rejected or approved decision from six
// months ago stays exactly as auditable as it was the day it was made; only
// the picture itself is gone.
import { sql, now } from "./db.ts";
import { taskProofImageRetentionDaysNow } from "./settingsRuntime.ts";

export async function tickTaskProofRedaction(): Promise<{ redacted: number }> {
  const days = await taskProofImageRetentionDaysNow();
  if (days <= 0) return { redacted: 0 };
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // `encrypted_value IS NOT NULL` so an already-redacted row is never
  // rewritten on every tick — this runs every few hours, forever.
  const r = await sql.run(
    "UPDATE task_proof_images SET encrypted_value = NULL, redacted_at = ? WHERE created_at < ? AND encrypted_value IS NOT NULL",
    now(), cutoff,
  );
  return { redacted: r.rowCount };
}
