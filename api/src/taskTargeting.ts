// Who is a task for? (Stage 7 — targeting.)
//
// ⚠️ THIS IS AN ELIGIBILITY GATE, NOT A FEED FILTER, AND THAT DISTINCTION IS THE
// WHOLE POINT OF THE FILE. Leaving a task out of GET /tasks hides it; it does
// not stop a user who has the id — from a screenshot, a shared link, an older
// cached feed — from POSTing a proof to it. So the rules live here, once, and
// the feed, the task detail page and the submit path all ask the same function.
// A rule added to the SQL of one of those three and not to this file produces a
// task that is invisible everywhere and still claimable.
//
// Every rule is NULL-means-no-limit, so every task row that existed before this
// feature keeps exactly the behaviour it had.
import { sql } from "./db.ts";

export type TargetingRow = {
  /** Comma-WRAPPED list: ',Pakistan,India,'. ',ALL,' = everywhere. */
  target_countries: string | null;
  /** The older single-country column. Only used when target_countries is
   *  missing — i.e. a row written by something that predates the backfill. */
  country: string;
  target_min_account_days: number | null;
  target_max_account_days: number | null;
  target_min_completed: number | null;
};

export type UserContext = {
  country: string;
  /** Whole days since signup. Floored, so an account 23 hours old is 0 days. */
  accountDays: number;
  /** CREDITED completions only. A pending claim is not evidence of anything,
   *  and counting it would let someone unlock a gated task by submitting
   *  proofs they never get approved. */
  completedTasks: number;
};

/** Read once per request and pass to `eligibility` for every task in the feed —
 *  the alternative is a query per task, on the app's most-opened screen. */
export async function userContext(userId: string): Promise<UserContext> {
  const u = await sql.get<{ country: string; created_at: string }>(
    "SELECT country, created_at FROM users WHERE id = ?", userId,
  );
  const done = await sql.get<{ n: string | number }>(
    "SELECT COUNT(*) AS n FROM task_completions WHERE user_id = ? AND status = 'credited'", userId,
  );
  const created = u?.created_at ? Date.parse(u.created_at) : Date.now();
  const days = Number.isFinite(created)
    ? Math.max(0, Math.floor((Date.now() - created) / 86_400_000))
    : 0;
  return {
    country: u?.country ?? "",
    accountDays: days,
    completedTasks: Number(done?.n ?? 0),
  };
}

/** Compare on a trimmed, lower-cased list. The stored form keeps the Admin's
 *  capitalisation because it is shown back to them; matching must not care. */
export function countryMatches(row: Pick<TargetingRow, "target_countries" | "country">, country: string): boolean {
  const raw = row.target_countries && row.target_countries.replace(/,/g, "").trim().length > 0
    ? row.target_countries
    : `,${row.country ?? ""},`;
  const list = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) return true;          // targeted at nothing = targeted at everyone
  if (list.includes("all")) return true;
  return list.includes((country ?? "").trim().toLowerCase());
}

/**
 * `hide` splits the two kinds of "no" apart, and the split is a product
 * decision, not a technicality:
 *
 *   hide: true  — this user can NEVER qualify (wrong country; the task is for
 *                 new members and they are not). Showing it is noise, and worse,
 *                 it is a reward dangled where no amount of effort reaches it.
 *   hide: false — a gate they can pass by doing something ("finish 2 more
 *                 tasks"). Shown, locked, with the reason. That is a goal.
 */
export type Eligibility = { ok: true } | { ok: false; reason: string; hide: boolean };

/**
 * ⚠️ THE REASON IS SHOWN TO THE USER, so it is plain English with no jargon
 * (guardrail #6). Saying why is deliberate: a task that silently disappears
 * teaches people the app is broken, while "finish 3 tasks first" is a thing they
 * can act on — and this is the only place the rule is ever explained.
 */
export function eligibility(task: TargetingRow, ctx: UserContext): Eligibility {
  if (!countryMatches(task, ctx.country)) {
    return { ok: false, hide: true, reason: "This task is not open in your country." };
  }
  if (task.target_max_account_days != null && ctx.accountDays > task.target_max_account_days) {
    return { ok: false, hide: true, reason: "This task is only for new members." };
  }
  if (task.target_min_account_days != null && ctx.accountDays < task.target_min_account_days) {
    const left = task.target_min_account_days - ctx.accountDays;
    return {
      ok: false, hide: false,
      reason: `Your account is too new for this one. Come back in ${left} day${left === 1 ? "" : "s"}.`,
    };
  }
  if (task.target_min_completed != null && ctx.completedTasks < task.target_min_completed) {
    const left = task.target_min_completed - ctx.completedTasks;
    return {
      ok: false, hide: false,
      reason: `Finish ${left} more task${left === 1 ? "" : "s"} first, then this one opens.`,
    };
  }
  return { ok: true };
}

/** The comma-wrapped storage form. One country, many, or ALL. */
export function packCountries(input: string[] | string): string {
  const parts = (Array.isArray(input) ? input : input.split(","))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return ",ALL,";
  // 'ALL' beside a country list is a contradiction; the wider one wins, because
  // the alternative is a task that says "everywhere" in the panel and shows in
  // one country.
  if (parts.some((p) => p.toLowerCase() === "all")) return ",ALL,";
  return `,${[...new Set(parts)].join(",")},`;
}

/** Storage form -> the list an Admin sees. `,ALL,` comes back as ['ALL']. */
export function unpackCountries(stored: string | null, fallback = ""): string[] {
  const raw = stored && stored.replace(/,/g, "").trim().length > 0 ? stored : fallback;
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}
