import type { MetadataRoute } from "next";

// Web app manifest — this is what makes RoziPay installable on a phone's home
// screen straight from the browser (no APK, no Play Store, no download).
// Next serves it at /manifest.webmanifest and links it from <head> for us.
// Installability also needs HTTPS (Vercel gives us that) and a service worker
// that answers when offline — see public/sw.js.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "RoziPay — earn and get real money",
    short_name: "RoziPay",
    description: "Do simple tasks, earn points, and get real cash in your wallet.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f4f7f7", // --color-bg: the splash screen behind the icon
    theme_color: "#0d5c63", // --color-brand: the system bar tint
    categories: ["finance", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Android crops icons to the launcher's shape; the maskable art keeps the
      // mark inside the safe zone so nothing important gets cut off.
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Ways to earn", url: "/tasks" },
      { name: "My money", url: "/wallet" },
    ],
  };
}
