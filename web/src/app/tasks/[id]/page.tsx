"use client";

// The task detail page (Stage 7).
//
// A task used to open in a bottom sheet with one free-text box, because it only
// ever asked one question. Now an Admin can write several — "the email you
// signed up with", "your username", "which plan did you pick" — and a sheet is
// the wrong shape for a form: it covers the instructions the user is trying to
// read while typing, and there is nowhere to put per-question help.
//
// ⚠️ THE FORM'S VALIDATION IS A COURTESY. Everything here is re-decided on the
// server against the task's CURRENT fields (api/src/taskFields.ts) — required,
// length, shape, and the http(s) check on a link in particular. None of what
// this file does survives a curl, and none of it is relied on.
import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Card, PointsPill, Button, SponsoredTag } from "@/components/ui";
import { Loading, ErrorState } from "@/components/state";
import {
  offerIcon, taskIcon, ClockIcon, LockIcon, ArrowRightIcon, InfoIcon, CheckIcon,
} from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import {
  fetchTask, submitTaskProof, TASK_CATEGORY_LABELS, type TaskField,
} from "@/lib/api";

export default function TaskDetailPage() {
  const { ready } = useRequireAuth();
  const params = useParams<{ id: string }>();
  const id = String(params?.id ?? "");
  const res = useApi(() => fetchTask(id), [id], ready && id.length > 0);

  if (!ready) return <div className="p-4 pt-6"><Loading /></div>;

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <Link href="/tasks" className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand">
        <ArrowRightIcon size={16} className="rotate-180" /> All tasks
      </Link>

      {res.loading ? <Loading />
        : res.error ? <ErrorState message={res.error} onRetry={res.reload} />
        : !res.data?.ok || !res.data.task ? (
          <Card className="p-4">
            <p className="font-semibold text-brand-ink">
              {res.data?.error ?? "This task is not available."}
            </p>
            <Link href="/tasks" className="mt-3 inline-block text-sm font-semibold text-brand">
              See what else is here
            </Link>
          </Card>
        ) : (
          <TaskDetail
            task={res.data.task}
            fields={res.data.fields ?? []}
            onSent={res.reload}
          />
        )}
    </div>
  );
}

type DetailTask = NonNullable<Awaited<ReturnType<typeof fetchTask>>["task"]>;

function TaskDetail({ task, fields, onSent }: {
  task: DetailTask; fields: TaskField[]; onSent: () => void;
}) {
  const Icon = (task.icon && taskIcon[task.icon]) || offerIcon[task.type];
  const isOurs = task.source === "custom";
  const category = task.category ? TASK_CATEGORY_LABELS[task.category] : undefined;

  return (
    <>
      <Card className="p-4">
        <div className="flex items-start gap-3">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
            <Icon size={24} />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="font-bold leading-snug text-brand-ink">{task.title}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              <span className="flex items-center gap-1"><ClockIcon size={13} /> About {task.minutes} min</span>
              {category && <span className="rounded-full bg-brand-tint px-2 py-0.5 font-semibold text-brand">{category}</span>}
            </p>
          </div>
          <PointsPill points={task.points} />
        </div>

        {task.instructions && (
          <div className="mt-4 whitespace-pre-line rounded-xl bg-brand-tint/50 p-3 text-sm text-brand-ink">
            {task.instructions}
          </div>
        )}

        {/* Our own tasks aren't sponsored. A network task carries the disclosure
            (guardrail #3) — see the note on the start button below. */}
        <div className="mt-3 border-t border-line pt-2.5">
          {isOurs
            ? <span className="text-xs font-medium text-brand">RoziPay task</span>
            : <SponsoredTag network={task.network} />}
        </div>
      </Card>

      {task.actionUrl && (
        <a href={task.actionUrl} target="_blank" rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-3 font-semibold text-white">
          Open the task <ArrowRightIcon size={18} />
        </a>
      )}

      {/* A rule the user has NOT met but still can. Rules nobody can ever meet
          (wrong country) never reach this page at all — the API refuses them,
          same as it hides them from the feed (api/src/taskTargeting.ts). */}
      {task.lockedReason ? (
        <Card className="flex gap-3 border-pending/30 bg-pending-tint/50 p-4">
          <LockIcon size={20} className="mt-0.5 shrink-0 text-pending" />
          <div>
            <p className="font-semibold text-brand-ink">Not open for you yet</p>
            <p className="mt-1 text-sm text-muted">{task.lockedReason}</p>
          </div>
        </Card>
      ) : !isOurs ? (
        // ⚠️ A SPONSORED OFFER STILL STARTS IN ONE PLACE, AND IT IS NOT HERE.
        // The task list's disclosure sheet is deliberately the only screen an
        // ad-network offer can begin from (components/TaskFlow.tsx). This page
        // is reachable by typing a URL, so it shows the offer and sends the
        // user back rather than quietly becoming a second start button.
        <Card className="p-4">
          <p className="flex gap-2 text-sm text-muted">
            <InfoIcon size={18} className="mt-0.5 shrink-0 text-brand" />
            Start this one from the task list.
          </p>
          <Link href="/tasks" className="mt-3 inline-block text-sm font-semibold text-brand">
            Go to tasks
          </Link>
        </Card>
      ) : task.verifyMode === "proof" ? (
        <ProofForm task={task} fields={fields} onSent={onSent} />
      ) : (
        <Card className="p-4 text-sm text-muted">
          We check this one for you. Finish it and your ROZI is added by itself.
        </Card>
      )}
    </>
  );
}

// ---- The proof form -------------------------------------------------------
// Nothing here credits anything (guardrail #1): it files evidence into the staff
// review queue, and a person approves it.
function ProofForm({ task, fields, onSent }: {
  task: DetailTask; fields: TaskField[]; onSent: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [proof, setProof] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(task.proofStatus === "pending");

  // No configured fields => the original single box, and whether it is asked for
  // at all is still the Admin's per-task setting.
  const asksForText = fields.length === 0 && task.proofRequired !== false;

  async function send() {
    setError(null);
    const missing = fields.find((f) => f.required && (values[f.id] ?? "").trim().length === 0);
    if (missing) { setError(`Please fill in “${missing.label}”.`); return; }
    if (asksForText && proof.trim().length === 0) { setError("Please write your proof first."); return; }

    setBusy(true);
    try {
      const r = await submitTaskProof(task.id, proof.trim(), fields.length > 0 ? values : undefined);
      if (r.ok) { setSent(true); onSent(); }
      else setError(r.error ?? "Could not send. Try again.");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  if (task.proofStatus === "approved") {
    return (
      <Card className="flex gap-3 border-success/30 bg-success-tint/60 p-4">
        <CheckIcon size={20} className="mt-0.5 shrink-0 text-success" />
        <p className="text-sm text-success">You finished this task and your ROZI was added. Thank you!</p>
      </Card>
    );
  }
  if (sent) {
    return (
      <Card className="border-pending/30 bg-pending-tint/50 p-4">
        <p className="font-semibold text-brand-ink">We got your answer.</p>
        <p className="mt-1 text-sm text-muted">
          Our team will check it and add your ROZI. This can take a little time.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2">
        <PointsPill points={task.points} />
        <span className="text-sm text-muted">when we check your answer</span>
      </div>

      {task.proofStatus === "rejected" && task.proofNote && (
        <p className="mt-3 rounded-xl bg-danger-tint p-3 text-sm text-danger">
          Last time: {task.proofNote}. Please fix it and send again.
        </p>
      )}

      {fields.length > 0 ? (
        <div className="mt-4 space-y-4">
          {fields.map((f) => (
            <FieldInput key={f.id} field={f} value={values[f.id] ?? ""}
              onChange={(v) => setValues((s) => ({ ...s, [f.id]: v }))} />
          ))}
        </div>
      ) : asksForText ? (
        <>
          <label className="mt-4 block text-sm font-semibold text-brand-ink" htmlFor="proof-box">
            {task.proofLabel || "Send your proof"}
          </label>
          <textarea
            id="proof-box" rows={3} value={proof} onChange={(e) => setProof(e.target.value)}
            placeholder="Type your proof here (for example your username, or what you did)."
            className="mt-2 w-full rounded-xl border border-line bg-bg p-3 text-sm outline-none focus:border-brand"
          />
        </>
      ) : (
        // Must not pretend the ROZI is instant: this still goes to a person.
        <p className="mt-4 rounded-xl bg-brand-tint/50 p-3 text-sm text-brand-ink">
          Finished it? Tell us, and our team will check and add your ROZI.
        </p>
      )}

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      <div className="mt-4">
        <Button variant="primary" onClick={send} disabled={busy}>
          {busy ? "Sending…" : fields.length > 0 || asksForText ? "Send" : "I did it"}
        </Button>
      </div>
    </Card>
  );
}

function FieldInput({ field, value, onChange }: {
  field: TaskField; value: string; onChange: (v: string) => void;
}) {
  const box = "mt-1.5 w-full rounded-xl border border-line bg-bg p-3 text-sm outline-none focus:border-brand";
  // The keyboard the phone opens. On a $60 Android, being handed the number pad
  // for a number question is most of the difference between a form people finish
  // and one they abandon.
  const inputType = ({
    number: "text", email: "email", url: "url", phone: "tel", text: "text",
    longtext: "text", choice: "text",
  } as const)[field.kind];
  const inputMode = field.kind === "number" ? "decimal" : field.kind === "phone" ? "tel" : undefined;

  return (
    <div>
      <label className="block text-sm font-semibold text-brand-ink" htmlFor={`f-${field.id}`}>
        {field.label}
        {!field.required && <span className="ml-1.5 text-xs font-normal text-muted">(you can skip this)</span>}
      </label>
      {field.help && <p className="mt-0.5 text-xs text-muted">{field.help}</p>}

      {field.kind === "longtext" ? (
        <textarea id={`f-${field.id}`} rows={3} value={value} maxLength={field.maxLen}
          placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} className={box} />
      ) : field.kind === "choice" ? (
        <select id={`f-${field.id}`} value={value} onChange={(e) => onChange(e.target.value)} className={box}>
          <option value="">Pick one…</option>
          {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input id={`f-${field.id}`} type={inputType} inputMode={inputMode} value={value}
          maxLength={field.maxLen} placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)} className={box} />
      )}
    </div>
  );
}
