// Monetag rewarded interstitial.
//
// HOW IT WORKS, and its one hard limit: Monetag's rewarded format hands us a
// JavaScript promise that resolves when the user finishes the video. There is NO
// server-to-server callback. So "the user watched it" is a claim made by the
// browser, and a browser is a thing the user controls.
//
// We accept that, and here is the honest reason it is safe enough. Watching an ad
// grants a hashrate BOOST, never currency directly — so a faked view cannot mint
// ROZI out of nothing. Under the OLD pool model it truly minted nothing at all: a
// boost only reshuffled a fixed daily pot. Under the "pi" model that is now the
// default, that is no longer strictly true — a boost multiplies the faker's OWN
// payout, so a faked ad view does increase their own minted ROZI.
//
// What keeps it a non-issue rather than a hole: the boost is temporary (4h), the
// server caps redemptions per day (adWatchDailyCap), an honest heavy ad-watcher
// gets the exact same boost so this is "watch the ad you were offered" not an
// exploit, conversion to Points is OFF at launch, and the supply cap bounds the
// whole system regardless. The cost of a skipped ad is one lost impression and a
// slightly larger honest-sized boost — not a mint. If that ever stops being an
// acceptable trade, the fix is a server-verified ad network, not a code tweak here.
//
// The server still does the real work: it issues a nonce, enforces a minimum watch
// time, caps the number of ads per day, and consumes the nonce exactly once under
// a lock. This file is only the glue that puts a video on the screen.
//
// FAILS OPEN, ALWAYS. Every path below — no script, no fill, an SDK that never
// settles, an exception — resolves to `false` rather than rejecting. The caller
// then starts mining with no boost. Monetag having a bad night must never be the
// reason a user in Karachi cannot mine and loses the streak they earned.

declare global {
  interface Window {
    [key: string]: unknown;
  }
}

const SCRIPT_ID = "monetag-sdk";

// Monetag serves the zone's SDK from its own host and exposes a global named
// `show_<zoneId>`. Both come from the dashboard, so the zone id is config, not a
// constant.
function sdkUrl(zoneId: string): string {
  return `https://vemtoutcheeg.com/400/${zoneId}`;
}

function loadScript(zoneId: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return resolve(false);
    if (typeof window[`show_${zoneId}`] === "function") return resolve(true);

    const existing = document.getElementById(SCRIPT_ID);
    if (existing) {
      // Already loading from an earlier click. Give it a moment to finish rather
      // than injecting a second copy.
      existing.addEventListener("load", () => resolve(true), { once: true });
      existing.addEventListener("error", () => resolve(false), { once: true });
      return;
    }

    const el = document.createElement("script");
    el.id = SCRIPT_ID;
    el.src = sdkUrl(zoneId);
    el.async = true;
    el.dataset.zone = zoneId;
    el.onload = () => resolve(true);
    // An ad blocker will land here. That is not an error to report — it is a
    // normal Tuesday, and the user should simply mine without the boost.
    el.onerror = () => resolve(false);
    document.head.appendChild(el);
  });
}

// Show one rewarded video. Resolves TRUE only if the user actually finished it.
//
// The timeout is the important part. If the SDK loads but never settles its
// promise — no fill, a wedged iframe, a network stall — we would otherwise hang
// on a spinner forever with the user staring at a dead "Start mining" button.
// After 45 seconds we give up and let them mine.
export async function showRewardedAd(zoneId: string): Promise<boolean> {
  if (!zoneId) return false;

  const loaded = await loadScript(zoneId);
  if (!loaded) return false;

  const show = window[`show_${zoneId}`];
  if (typeof show !== "function") return false;

  try {
    const watched = await Promise.race([
      (show as () => Promise<unknown>)().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 45_000)),
    ]);
    return watched === true;
  } catch {
    // The SDK rejects when the user closes the video early, and when there is no
    // ad to serve. Neither is an error we should surface — they just get no boost.
    return false;
  }
}
