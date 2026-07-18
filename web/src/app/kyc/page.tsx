"use client";

// "Verify your ID" — the earner side of KYC.
//
// The word "KYC" appears nowhere on this screen. It is jargon, and most of our
// users would not know it. Everything here is said in plain English: three
// photos, why we want them, and what they unlock.
//
// Photos are downscaled in the browser BEFORE upload. A modern phone camera
// produces a 4-6MB JPEG, which would bounce straight off the server's 4MB cap and
// leave the user staring at "too big" with no way to fix it. Downscaling to
// 1600px on the long edge keeps an ID card easily readable for a human reviewer
// while landing comfortably under the limit.
import { useState } from "react";
import Link from "next/link";
import { Card, Button, SectionTitle } from "@/components/ui";
import { Loading, ErrorState } from "@/components/state";
import { LockIcon, InfoIcon, ArrowRightIcon } from "@/components/icons";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import { fetchKyc, submitKyc, type KycState } from "@/lib/api";

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.82;

// Read a File, downscale it, and hand back a data: URL the server will accept.
// Everything goes out as JPEG regardless of what came in, so the server's magic-
// byte sniff always sees a real JPEG.
function toCompressedDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that photo."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That file is not a photo."));
      img.onload = () => {
        const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Could not read that photo."));
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

type Shot = { label: string; hint: string; value: string | null };

function PhotoInput({
  shot, onPick, t,
}: {
  shot: Shot;
  onPick: (dataUrl: string) => void;
  t: (k: string) => string;
}) {
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      onPick(await toCompressedDataUrl(file));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Card className="p-4">
      <p className="font-bold text-brand-ink">{shot.label}</p>
      <p className="mt-0.5 text-sm text-muted">{shot.hint}</p>

      {shot.value && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={shot.value}
          alt=""
          className="mt-3 max-h-48 w-full rounded-xl border border-line object-contain"
        />
      )}

      <label className="mt-3 block">
        {/* `capture` opens the camera directly on a phone rather than the file
            picker — fewer taps, and it nudges people toward a live photo of a real
            card instead of a screenshot they already had lying around. */}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          onChange={onFile}
          className="hidden"
        />
        <span className="block cursor-pointer rounded-xl border border-brand bg-brand-tint px-4 py-2.5 text-center text-sm font-bold text-brand">
          {shot.value ? t("kyc.retake") : t("kyc.take")}
        </span>
      </label>

      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </Card>
  );
}

export default function KycPage() {
  const { ready } = useRequireAuth();
  const { t } = useI18n();
  const kyc = useApi(fetchKyc, []);

  const [selfie, setSelfie] = useState<string | null>(null);
  const [front, setFront] = useState<string | null>(null);
  const [back, setBack] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resubmitting, setResubmitting] = useState(false);

  if (!ready || kyc.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (kyc.error || !kyc.data) {
    return <div className="p-4 pt-6"><ErrorState message={kyc.error ?? "…"} onRetry={kyc.reload} /></div>;
  }

  const s: KycState = kyc.data;
  const showForm = s.status === "none" || (s.status === "rejected" && resubmitting);

  async function onSubmit() {
    if (!selfie || !front || !back) {
      setError(t("kyc.error.missing"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await submitKyc(selfie, front, back);
      setResubmitting(false);
      kyc.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header>
        {/* Profile is this screen's home in the tab bar (it stays lit here),
            so "back" goes there — even when arriving from the Wallet nudge. */}
        <Link href="/profile" className="inline-flex items-center gap-1 text-sm font-semibold text-brand">
          <ArrowRightIcon size={16} className="rotate-180" />
          {t("nav.profile")}
        </Link>
        <h1 className="mt-2 text-xl font-bold text-brand-ink">{t("kyc.title")}</h1>
        <p className="text-sm text-muted">{t("kyc.subtitle")}</p>
      </header>

      {/* ---- Already done ---- */}
      {s.status === "approved" && (
        <Card className="border-success/30 bg-success-tint p-4">
          <p className="font-bold text-success">{t("kyc.status.approved.title")}</p>
          <p className="mt-1 text-sm text-brand-ink">{t("kyc.status.approved.body")}</p>
        </Card>
      )}

      {/* ---- Waiting for a human ---- */}
      {s.status === "pending" && (
        <Card className="border-pending/30 bg-pending-tint p-4">
          <p className="font-bold text-pending">{t("kyc.status.pending.title")}</p>
          <p className="mt-1 text-sm text-brand-ink">{t("kyc.status.pending.body")}</p>
        </Card>
      )}

      {/* ---- Rejected: say WHY, and let them fix it ---- */}
      {s.status === "rejected" && !resubmitting && (
        <Card className="border-danger/30 bg-danger-tint p-4">
          <p className="font-bold text-danger">{t("kyc.status.rejected.title")}</p>
          <p className="mt-1 text-sm text-brand-ink">{t("kyc.status.rejected.body")}</p>
          {s.rejectReason && (
            <p className="mt-2 rounded-lg bg-card p-3 text-sm font-semibold text-brand-ink">
              {s.rejectReason}
            </p>
          )}
          <div className="mt-3">
            <Button full onClick={() => setResubmitting(true)}>
              {t("kyc.status.rejected.again")}
            </Button>
          </div>
        </Card>
      )}

      {showForm && (
        <>
          <Card className="p-4">
            <p className="font-bold text-brand-ink">{t("kyc.why.title")}</p>
            <p className="mt-1 text-sm text-muted">{t("kyc.why.body")}</p>
          </Card>

          {/* The promise we make about their documents, made where they can see it
              at the moment they are deciding whether to trust us with them. */}
          <p className="flex gap-2 rounded-xl border border-line bg-card p-3 text-sm text-muted">
            <LockIcon size={18} className="mt-0.5 shrink-0 text-success" />
            <span>{t("kyc.safe")}</span>
          </p>

          <div>
            <SectionTitle>{t("kyc.need")}</SectionTitle>
            <div className="space-y-3">
              <PhotoInput
                t={t}
                shot={{ label: t("kyc.selfie"), hint: t("kyc.selfie.hint"), value: selfie }}
                onPick={setSelfie}
              />
              <PhotoInput
                t={t}
                shot={{ label: t("kyc.front"), hint: t("kyc.front.hint"), value: front }}
                onPick={setFront}
              />
              <PhotoInput
                t={t}
                shot={{ label: t("kyc.back"), hint: t("kyc.back.hint"), value: back }}
                onPick={setBack}
              />
            </div>
          </div>

          {error && (
            <p className="rounded-xl border border-danger/30 bg-danger-tint p-3 text-sm font-semibold text-danger">
              {error}
            </p>
          )}

          <Button full onClick={onSubmit} disabled={busy || !selfie || !front || !back}>
            {busy ? t("kyc.sending") : t("kyc.submit")}
          </Button>
        </>
      )}

      {/* What it actually buys them. Shown last, and shown always — including to
          someone who is still waiting, because it is the reason to keep waiting. */}
      <Card className="p-4">
        <p className="font-bold text-brand-ink">{t("kyc.unlocks.title")}</p>
        <ul className="mt-2 space-y-1.5 text-sm text-muted">
          {[t("kyc.unlocks.withdraw"), t("kyc.unlocks.referral"), t("kyc.unlocks.trust")].map((line) => (
            <li key={line} className="flex gap-2">
              <InfoIcon size={16} className="mt-0.5 shrink-0 text-brand" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
