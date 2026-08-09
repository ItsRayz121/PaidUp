export type StoredTaskStatus =
  | "draft" | "scheduled" | "active" | "paused" | "disabled" | "exhausted" | "ended";
export type CampaignState = Exclude<StoredTaskStatus, "disabled">;

export type LifecycleRow = {
  status: string;
  starts_at?: string | null;
  ends_at?: string | null;
};

const time = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
};

/** One definition used by feeds, task detail, starts, proof submissions and
 * crediting. A scheduled/ended task must never be merely hidden client-side. */
export function campaignState(row: LifecycleRow, at = Date.now()): CampaignState {
  const status = row.status === "disabled" ? "paused" : row.status as CampaignState;
  if (status === "draft" || status === "paused" || status === "exhausted" || status === "ended") {
    return status;
  }
  const starts = time(row.starts_at);
  const ends = time(row.ends_at);
  if (ends !== null && at >= ends) return "ended";
  if (starts !== null && at < starts) return "scheduled";
  return "active";
}

export function unavailableMessage(state: CampaignState): string {
  if (state === "paused") return "This task is temporarily paused.";
  if (state === "scheduled") return "This task is not open yet.";
  if (state === "exhausted") return "All available rewards for this task have been claimed.";
  if (state === "ended") return "This task has ended and can no longer be submitted.";
  return "This task is not available.";
}

