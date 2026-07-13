// Shown by the service worker when the phone has no internet. Kept as a plain
// server-rendered page with the copy inline: it has to be readable even if the
// JavaScript never loads, so it cannot depend on the client copy context.
export default function OfflinePage() {
  return (
    <div className="flex min-h-[80dvh] flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-tint text-3xl" aria-hidden>
        📶
      </div>
      <h1 className="font-display text-xl font-bold text-brand-ink">You are offline</h1>
      <p className="text-muted">Turn on your internet and try again. Your points are safe.</p>
    </div>
  );
}
