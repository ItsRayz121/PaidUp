// Configurable input fields on a task, and the checking of what a user typed
// into them (Stage 7).
//
// A field is a question an Admin writes ("Your username", "The email you signed
// up with"). It replaces the single free-text proof box, which could ask for
// exactly one thing and could not say what shape the answer should take — so
// the review queue filled with unreviewable paragraphs and the rejection note
// became the instruction.
//
// ⚠️ THE ANSWERS ARE CHECKED HERE, ON THE SERVER, AND THE CLIENT'S CHECK IS A
// COURTESY. The earner form marks a field required and validates as you type;
// none of that survives a curl. Everything that matters — required, length,
// shape, and the URL scheme in particular — is re-decided in `validateAnswers`.
import { sql } from "./db.ts";

/** The closed list. A kind decides how an answer is CHECKED, so an unknown kind
 *  would mean an unchecked answer — which is why it is refused at the admin
 *  boundary and again here, and why the DB has a CHECK constraint too. */
export const FIELD_KINDS = ["text", "longtext", "number", "email", "url", "phone", "choice"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** More than this and nobody finishes the form. A hard stop rather than advice:
 *  the task page is a phone screen, and a twelve-question form on it is a task
 *  that gets started and abandoned, which costs us the campaign either way. */
export const MAX_FIELDS_PER_TASK = 8;

const DEFAULT_MAX_LEN: Record<FieldKind, number> = {
  text: 200, longtext: 2000, number: 24, email: 160, url: 500, phone: 32, choice: 120,
};

export type TaskField = {
  id: string;
  task_id: string;
  label: string;
  kind: FieldKind;
  required: number;
  placeholder: string | null;
  help: string | null;
  options: string | null;
  max_len: number | null;
  sort_order: number;
};

/** What the earner app is given. Same shape for the staff editor, minus nothing
 *  — there is no secret on a field. */
export type PublicField = {
  id: string; label: string; kind: FieldKind; required: boolean;
  placeholder?: string; help?: string; options?: string[]; maxLen: number;
};

export const publicField = (f: TaskField): PublicField => ({
  id: f.id,
  label: f.label,
  kind: f.kind,
  required: f.required !== 0,
  placeholder: f.placeholder ?? undefined,
  help: f.help ?? undefined,
  options: f.kind === "choice" ? splitOptions(f.options) : undefined,
  maxLen: f.max_len ?? DEFAULT_MAX_LEN[f.kind],
});

/** One option per line. Newlines rather than JSON so an Admin types a list and
 *  nothing has to parse — a malformed JSON array in that box would otherwise be
 *  a field that renders with no choices and cannot be answered. */
export const splitOptions = (raw: string | null): string[] =>
  (raw ?? "").split("\n").map((s) => s.trim()).filter((s) => s.length > 0);

export async function fieldsForTask(taskId: string): Promise<TaskField[]> {
  return sql.all<TaskField>(
    `SELECT id, task_id, label, kind, required, placeholder, help, options, max_len, sort_order
     FROM task_fields WHERE task_id = ? ORDER BY sort_order, created_at`,
    taskId,
  );
}

/** One answer as stored. The LABEL AND KIND ARE SNAPSHOTTED alongside the value
 *  — see the column note in db.ts. An Admin who later renames the question must
 *  not be able to relabel evidence a reviewer has already read. */
export type StoredAnswer = { fieldId: string; label: string; kind: FieldKind; value: string };

export type AnswerResult =
  | { ok: true; answers: StoredAnswer[]; text: string }
  | { ok: false; error: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Deliberately loose: our markets write numbers with spaces, dashes and country
// codes in whatever order, and a strict pattern here rejects real people.
const PHONE_CHARS = /^[0-9+\-()\s]+$/;

/**
 * Check a submitted map of fieldId -> value against the task's CURRENT fields.
 *
 * Checked against the current fields on purpose: a field added after the user
 * opened the page is a question they were never asked, and it will simply be
 * missing — so a required one refuses the submit and the user is told which
 * answer is missing rather than having a silent half-submission filed.
 */
export function validateAnswers(fields: TaskField[], input: Record<string, unknown>): AnswerResult {
  const answers: StoredAnswer[] = [];
  for (const f of fields) {
    const raw = input[f.id];
    const value = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw).trim();
    const maxLen = f.max_len ?? DEFAULT_MAX_LEN[f.kind];

    if (value.length === 0) {
      if (f.required !== 0) return { ok: false, error: `Please fill in “${f.label}”.` };
      continue; // An empty optional answer is left out entirely, not stored blank.
    }
    if (value.length > maxLen) {
      return { ok: false, error: `“${f.label}” is too long. Please keep it under ${maxLen} letters.` };
    }

    switch (f.kind) {
      case "number":
        if (!/^-?\d+(\.\d+)?$/.test(value)) {
          return { ok: false, error: `“${f.label}” must be a number.` };
        }
        break;
      case "email":
        if (!EMAIL.test(value)) return { ok: false, error: `“${f.label}” must be an email address.` };
        break;
      case "url": {
        // ⚠️ THE SCHEME CHECK IS THE POINT, exactly as it is on a task's own
        // action URL (routes/staffTasks.ts). This value is user-supplied and it
        // is rendered as a link in the STAFF review queue — an admin session is
        // the session worth stealing, and `javascript:`/`data:` in an href
        // there is stored XSS aimed straight at it. `new URL()` accepts both
        // happily, so the protocol has to be tested separately.
        let u: URL;
        try { u = new URL(value); } catch { return { ok: false, error: `“${f.label}” must be a full link starting with https://` }; }
        if (!/^https?:$/.test(u.protocol)) {
          return { ok: false, error: `“${f.label}” must be a link starting with http:// or https://` };
        }
        break;
      }
      case "phone":
        if (!PHONE_CHARS.test(value) || value.replace(/\D/g, "").length < 6) {
          return { ok: false, error: `“${f.label}” must be a phone number.` };
        }
        break;
      case "choice": {
        const opts = splitOptions(f.options);
        // No options configured = nothing is a valid answer, so say that rather
        // than storing whatever arrived. It is an Admin mistake, not a user one.
        if (opts.length === 0) return { ok: false, error: `“${f.label}” has no choices set up yet. Please tell support.` };
        if (!opts.some((o) => o.toLowerCase() === value.toLowerCase())) {
          return { ok: false, error: `Please pick one of the choices for “${f.label}”.` };
        }
        break;
      }
      default:
        break;
    }
    answers.push({ fieldId: f.id, label: f.label, kind: f.kind, value });
  }
  return { ok: true, answers, text: renderAnswers(answers) };
}

/** The readable rendering written to task_proofs.proof_text.
 *
 *  Every row keeps a populated proof_text so nothing that reads it needs a
 *  branch for "structured or not" — the answers column is the richer copy of
 *  the same thing, never a replacement for it. */
export function renderAnswers(answers: StoredAnswer[]): string {
  if (answers.length === 0) return "The user says they finished this task.";
  return answers.map((a) => `${a.label}: ${a.value}`).join("\n");
}

/** Read back what was stored. Tolerates the older rows that have no answers
 *  column value at all — those simply have none, and the queue falls back to
 *  proof_text, which is what it always showed. */
export function parseAnswers(raw: string | null | undefined): StoredAnswer[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((a): a is StoredAnswer =>
      !!a && typeof a.label === "string" && typeof a.value === "string");
  } catch { return []; }
}
