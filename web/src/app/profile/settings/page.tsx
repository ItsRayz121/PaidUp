"use client";

// Edit your profile — name, @handle, picture.
//
// The @handle is the only field here that is not cosmetic: it is what other
// people type into "send ROZI to", and the server locks it for 30 days after a
// change (see api/src/routes/profile.ts for why that lock is a security control
// and not a preference).
//
// So this screen's job, before anything else, is to make sure nobody learns
// about the lock AFTER saving a typo. The cooldown is stated under the field
// while it is still editable, the field disables itself with the unlock date
// once spent, and Save is inert until something actually changed.
import { useState } from "react";
import Link from "next/link";
import { Card, Button, SectionTitle } from "@/components/ui";
import { Loading, ErrorState } from "@/components/state";
import { ArrowRightIcon, ProfileIcon, LockIcon, CheckIcon } from "@/components/icons";
import { NotificationsCard } from "@/components/NotificationsCard";
import { ConnectEmailCard } from "@/components/ConnectEmailCard";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useRequireAuth, useApi } from "@/lib/hooks";
import { useI18n } from "@/lib/i18n";
import {
  fetchProfile, updateProfile, fetchAvatar, uploadAvatar, removeAvatar,
  getStoredUser, setSession, getToken,
} from "@/lib/api";

// A profile picture is shown at 56px, so 256px on the long edge is already
// generous. Downscaling in the browser is what keeps this under the server's
// 150KB cap — a raw phone photo is 4-6MB and would simply bounce.
const MAX_EDGE = 256;
const JPEG_QUALITY = 0.85;

function toCompressedDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that photo."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That file is not a photo."));
      img.onload = () => {
        // Square crop from the centre, so a portrait photo does not arrive
        // squashed into the round frame the app shows it in.
        const side = Math.min(img.width, img.height);
        const size = Math.min(MAX_EDGE, side);
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Could not read that photo."));
        ctx.drawImage(
          img,
          (img.width - side) / 2, (img.height - side) / 2, side, side,
          0, 0, size, size,
        );
        resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export default function ProfileSettingsPage() {
  const { user, ready } = useRequireAuth();
  const { t } = useI18n();
  const profile = useApi(fetchProfile, []);
  const avatar = useApi(fetchAvatar, []);

  // The form starts as null and holds edits only once the user types. The
  // displayed value is then DERIVED — their edit if there is one, otherwise
  // whatever the server last told us.
  //
  // The obvious alternative (two useStates seeded from an effect when the fetch
  // resolves) is what this replaced: it re-renders twice on every load, and it
  // is the pattern the React Compiler lint rule refuses outright. Deriving needs
  // no effect and cannot go stale against a reload.
  const [edits, setEdits] = useState<{ name: string; handle: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const loaded = profile.data;

  if (!ready || profile.loading) return <div className="p-4 pt-6"><Loading /></div>;
  if (profile.error || !loaded) {
    return (
      <div className="p-4 pt-6">
        <ErrorState message={profile.error ?? "…"} onRetry={profile.reload} />
      </div>
    );
  }

  const name = edits ? edits.name : (loaded.displayName ?? "");
  const handle = edits ? edits.handle : (loaded.username ?? "");
  const setName = (v: string) => setEdits({ name: v, handle });
  const setHandle = (v: string) => setEdits({ name, handle: v });

  const locked = loaded.usernameLockedUntil !== null;
  const cleanHandle = handle.trim().toLowerCase();
  const nameChanged = name.trim() !== (loaded.displayName ?? "");
  const handleChanged = cleanHandle !== (loaded.username ?? "");
  const canSave = (nameChanged || (handleChanged && !locked)) && name.trim().length > 0;

  async function onSave() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      // Only send what actually changed. Posting the existing handle back would
      // be harmless (the server treats it as a no-op rather than burning the
      // window) but sending nothing at all is clearer about intent.
      const res = await updateProfile({
        ...(nameChanged ? { displayName: name.trim() } : {}),
        ...(handleChanged && !locked ? { username: cleanHandle } : {}),
      });
      // Keep the cached session in step, so the header and Profile screen show
      // the new name straight away instead of after the next login.
      const stored = getStoredUser();
      const token = getToken();
      if (stored && token) {
        setSession(token, { ...stored, displayName: res.displayName, username: res.username });
      }
      setSaved(true);
      profile.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await uploadAvatar(await toCompressedDataUrl(file));
      avatar.reload();
      profile.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onRemovePhoto() {
    setBusy(true);
    setError(null);
    try {
      await removeAvatar();
      avatar.reload();
      profile.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const picture = avatar.data?.image ?? null;
  const fallbackName = loaded.displayName || user?.email?.split("@")[0] || "";

  return (
    <div className="px-4 pt-5 pb-8 space-y-5">
      <header>
        <Link
          href="/profile"
          className="inline-flex items-center gap-1 text-sm font-semibold text-brand"
        >
          <ArrowRightIcon size={16} className="rotate-180" />
          {t("nav.profile")}
        </Link>
        <h1 className="mt-2 text-xl font-bold text-brand-ink">{t("settings.title")}</h1>
        <p className="text-sm text-muted">{t("settings.subtitle")}</p>
      </header>

      {error && (
        <p className="rounded-xl border border-danger/30 bg-danger-tint p-3 text-sm font-semibold text-danger">
          {error}
        </p>
      )}

      {/* ---- Picture ---- */}
      <div>
        <SectionTitle>{t("settings.photo")}</SectionTitle>
        <Card className="flex items-center gap-4 p-4">
          <span className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-full bg-brand-tint text-brand">
            {picture ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={picture} alt="" className="h-full w-full object-cover" />
            ) : (
              <ProfileIcon size={30} />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <label className="block">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={onPickPhoto}
                disabled={busy}
                className="hidden"
              />
              <span className="inline-block cursor-pointer rounded-xl border border-brand bg-brand-tint px-4 py-2 text-sm font-bold text-brand">
                {picture ? t("settings.photoChange") : t("settings.photoAdd")}
              </span>
            </label>
            {picture && (
              <button
                onClick={onRemovePhoto}
                disabled={busy}
                className="ml-3 text-sm font-semibold text-muted underline"
              >
                {t("settings.photoRemove")}
              </button>
            )}
            <p className="mt-2 text-xs text-muted">{t("settings.photoHint")}</p>
          </div>
        </Card>
      </div>

      {/* ---- Name ---- */}
      <div>
        <label htmlFor="p-name" className="mb-2 block px-1 font-semibold text-brand-ink">
          {t("settings.name")}
        </label>
        <input
          id="p-name"
          value={name}
          onChange={(e) => { setName(e.target.value); setSaved(false); }}
          placeholder={fallbackName || t("settings.namePlaceholder")}
          maxLength={30}
          className="w-full rounded-xl border border-line bg-card p-3 text-brand-ink outline-none focus:border-brand"
        />
        <p className="mt-1.5 px-1 text-xs text-muted">{t("settings.nameHint")}</p>
      </div>

      {/* ---- Handle ---- */}
      <div>
        <label htmlFor="p-handle" className="mb-2 block px-1 font-semibold text-brand-ink">
          {t("settings.username")}
        </label>
        <div className="flex items-center gap-2 rounded-xl border border-line bg-card px-3 focus-within:border-brand">
          <span className="text-muted">@</span>
          <input
            id="p-handle"
            value={handle}
            onChange={(e) => {
              // Normalise as they type, so what they see is exactly what will be
              // saved — and so the "taken" answer can never be a surprise about
              // capital letters.
              setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""));
              setSaved(false);
            }}
            placeholder={t("settings.usernamePlaceholder")}
            disabled={locked}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={20}
            className="w-full bg-transparent py-3 text-brand-ink outline-none disabled:text-muted"
          />
          {locked && <LockIcon size={18} className="shrink-0 text-muted" />}
        </div>
        <p className="mt-1.5 flex gap-1.5 px-1 text-xs text-muted">
          {locked
            ? t("settings.usernameLocked", {
                date: new Date(loaded.usernameLockedUntil!).toLocaleDateString(),
              })
            : t("settings.usernameHint", { days: String(loaded.cooldownDays) })}
        </p>
        {!locked && (
          <p className="mt-1 px-1 text-xs text-muted">{t("settings.usernameRules")}</p>
        )}
      </div>

      {/* ---- Account email ----
          Moved here from the main Profile tab (founder, 2026-08-28): every
          piece of UI about the account's email — the address itself, and the
          "add your email" flow for Telegram-only accounts — now lives in one
          place instead of two. */}
      <div>
        <SectionTitle>{t("settings.accountEmail")}</SectionTitle>
        {user?.hasEmail !== false && user?.email && (
          <Card className="p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">{t("profile.accountEmail")}</p>
            <p className="mt-1 break-all font-semibold text-brand-ink">{user.email}</p>
          </Card>
        )}
        {user && <ConnectEmailCard user={user} />}
      </div>

      {/* ---- Account security ----
          Payout wallet moved OFF this screen (founder, 2026-08-12): the
          withdraw screen already collects and saves the address inline —
          having a second place to set the same thing was the duplication, not
          a feature. Forgot password reuses the exact flow the login screen
          already has (login/page.tsx, ?mode=forgot) rather than a second copy
          of it living inside the signed-in app shell. */}
      <div>
        <SectionTitle>{t("settings.security")}</SectionTitle>
        <Link href="/login?mode=forgot" className="block">
          <Card className="flex items-center gap-3 p-4">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
              <LockIcon size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-brand-ink">{t("settings.forgotPassword")}</p>
              <p className="text-sm text-muted">{t("settings.forgotPasswordHint")}</p>
            </div>
            <ArrowRightIcon size={20} className="shrink-0 text-brand" />
          </Card>
        </Link>
      </div>

      {/* ---- Look ----
          Two design directions the founder asked to see built: the light app
          as shipped, and a dark "Wallet look". A per-device colour choice,
          applied the instant it is tapped (no Save) — see components/ThemeToggle
          and lib/theme.tsx. */}
      <div>
        <SectionTitle>{t("settings.theme")}</SectionTitle>
        <ThemeToggle />
        <p className="mt-1.5 px-1 text-xs text-muted">{t("settings.theme.hint")}</p>
      </div>

      {saved && (
        <p className="flex items-center gap-2 rounded-xl border border-success/30 bg-success-tint/60 p-3 text-sm font-semibold text-success">
          <CheckIcon size={18} />
          {t("settings.saved")}
        </p>
      )}

      <Button onClick={onSave} disabled={!canSave || busy} full>
        {busy ? t("settings.saving") : t("settings.save")}
      </Button>

      {/* Renders nothing if push can't work here (no VAPID keys, unsupported
          browser) — see NotificationsCard's own header for why. */}
      <NotificationsCard heading={t("settings.notifications")} />
    </div>
  );
}
