// Monetag glue — the two formats a real website account actually gets.
//
// The first version of this file was written for Monetag's rewarded SDK: a
// `show_<zone>()` promise that resolves when the user finishes the video. When
// the real account arrived (2026-07-17) that format turned out to be Telegram-
// Mini-App-only, and the SDK host we had coded against no longer even resolves.
// A website gets two humbler tools, and this file adapts to them:
//
//   1. VIGNETTE (ensureVignette). A script that, once loaded, shows a full-screen
//      ad around the user's next taps. Purely passive: there is no "the user
//      watched it" signal, no promise, nothing to await. We load it on /mine
//      (the tap it decorates is "Start mining") and the rig shop (buying a rig
//      — a ROZI spend, not real money). Because it cannot prove a watch, it
//      grants NO boost; it is an impression, full stop.
//
//   2. DIRECT LINK (openAdTab). A plain URL that shows ads when visited. The
//      boost button opens it in a new tab. Verification is the server's job and
//      always was: it issues a nonce BEFORE the tab opens, enforces a minimum
//      dwell time, caps redemptions per day, and consumes the nonce exactly once
//      under a lock. That is the same trust level the old SDK promise gave us —
//      a client-side claim bounded by server-side teeth — see the long honesty
//      note in api/src/routes/mining.ts: toll evasion, not theft.
//
// FAILS OPEN, ALWAYS. An ad blocker (very common — even the founder's own DNS
// blocks Monetag hosts), no fill, a blocked pop-up: none of these may ever stop
// a user mining or cost them a streak. Every failure path here is a quiet no-op.

// The host comes from the tag Monetag generated for our zone. They rotate these
// domains; if vignette ads silently stop appearing, regenerate the tag in the
// dashboard and update this one constant.
const VIGNETTE_SRC = "https://n6wxm.com/vignette.min.js";
const SCRIPT_ID = "monetag-vignette";

// Load the vignette script once. Safe to call on every render — it bails if the
// tag is already there. Nothing to await: the script decides for itself when an
// ad is due (Monetag's own frequency capping applies).
export function ensureVignette(zoneId: string): void {
  if (typeof window === "undefined" || !zoneId) return;
  if (document.getElementById(SCRIPT_ID)) return;

  const el = document.createElement("script");
  el.id = SCRIPT_ID;
  el.src = VIGNETTE_SRC;
  el.async = true;
  el.dataset.zone = zoneId;
  // An ad blocker lands here. Not an error — mining works the same without it.
  el.onerror = () => el.remove();
  document.head.appendChild(el);
}

// IN-PAGE PUSH — Monetag's "banner": a small dismissible bar their script
// floats over the page. Same passive contract as the vignette: no watch signal,
// no boost, just impressions. Loaded on /mine only — never on money or login
// screens, where an ad would read as part of the product.
//
// Host taken from the tag Monetag generates for the zone; like the vignette
// host it rotates, so if banners silently stop, regenerate the tag in the
// dashboard and update this constant.
const BANNER_SRC = "https://n6wxm.com/tag.min.js";
const BANNER_ID = "monetag-banner";

export function ensureBanner(zoneId: string): void {
  if (typeof window === "undefined" || !zoneId) return;
  if (document.getElementById(BANNER_ID)) return;

  const el = document.createElement("script");
  el.id = BANNER_ID;
  el.src = BANNER_SRC;
  el.async = true;
  el.dataset.zone = zoneId;
  el.dataset.cfasync = "false";
  // Ad blocker: fine — the screen works the same without the banner.
  el.onerror = () => el.remove();
  document.head.appendChild(el);
}

// REWARDED INTERSTITIAL — the real video ad with a completion signal. Monetag
// only serves this format inside Telegram Mini Apps (their SDK checks), which
// is the whole reason the Telegram build exists. The SDK exposes a global
// `show_<zone>()` returning a promise that resolves when the user finishes.
//
// The promise is still only a CLIENT-side claim: the server's nonce + minimum
// dwell + daily cap decide the boost, exactly as for the direct link. Host from
// the tag Monetag generates; rotates like the others — update if it changes.
const REWARDED_SRC = "https://libtl.com/sdk.js";
const REWARDED_ID = "monetag-rewarded";

export function ensureRewarded(zoneId: string): void {
  if (typeof window === "undefined" || !zoneId) return;
  if (document.getElementById(REWARDED_ID)) return;

  const el = document.createElement("script");
  el.id = REWARDED_ID;
  el.src = REWARDED_SRC;
  el.async = true;
  el.dataset.zone = zoneId;
  el.dataset.sdk = `show_${zoneId}`;
  el.onerror = () => el.remove();
  document.head.appendChild(el);
}

// Play the rewarded video; resolves when the SDK says the user finished.
// False = SDK missing/blocked/no fill — callers fail open (the server dwell
// timer still gates the boost, so nothing is lost but the nicer ad).
export async function showRewarded(zoneId: string): Promise<boolean> {
  if (typeof window === "undefined" || !zoneId) return false;
  const fn = (window as unknown as Record<string, unknown>)[`show_${zoneId}`];
  if (typeof fn !== "function") return false;
  try {
    await (fn as () => Promise<unknown>)();
    return true;
  } catch {
    return false;
  }
}

// Open a tab for the direct-link ad, dodging the pop-up blocker.
//
// Browsers only allow window.open inside a user gesture — an `await` between the
// tap and the open is enough to get it blocked. So the caller opens the tab
// FIRST, synchronously in the click handler, and points it at the ad only after
// the nonce request succeeds (or closes it if that request fails).
export function openAdTab(): { navigate: (url: string) => void; close: () => void } | null {
  if (typeof window === "undefined") return null;
  const tab = window.open("about:blank", "_blank");
  if (!tab) return null; // pop-up blocked — the caller tells the user
  return {
    navigate: (url: string) => { tab.location.href = url; },
    close: () => tab.close(),
  };
}
