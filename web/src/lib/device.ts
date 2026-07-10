// Best-effort device fingerprint (NO PII): a stable hash of coarse browser
// signals, cached in localStorage. Sent as the x-device-id header so the backend
// fraud layer can spot one device farming many accounts (guardrail #5). This is
// a deterrent signal, not an identity — a user can clear it; that's acceptable.

// FNV-1a, 32-bit. Two passes (forward + reversed) give 16 hex chars, enough to
// keep accidental collisions between real devices rare.
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const KEY = "paidup_device";

export function getDeviceId(): string {
  if (typeof window === "undefined") return "";
  try {
    const cached = window.localStorage.getItem(KEY);
    if (cached) return cached;
    const n = navigator as Navigator & { hardwareConcurrency?: number; deviceMemory?: number };
    const signals = [
      n.userAgent, n.language,
      `${screen.width}x${screen.height}`, screen.colorDepth,
      new Date().getTimezoneOffset(),
      n.hardwareConcurrency ?? "", n.deviceMemory ?? "",
    ].join("|");
    const id = fnv1a(signals) + fnv1a(signals.split("").reverse().join(""));
    window.localStorage.setItem(KEY, id);
    return id;
  } catch {
    return ""; // storage blocked (private mode) — send nothing rather than crash
  }
}
