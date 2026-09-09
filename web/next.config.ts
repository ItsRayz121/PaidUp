import type { NextConfig } from "next";

// Everything under public/ is served by Next with `Cache-Control: public,
// max-age=0` by default, which means the browser revalidates EVERY logo, icon
// and illustration on every single page load. It gets a 304 back, so no bytes
// move — but on a 400ms mobile round trip in the markets this app is built
// for, four assets is most of a second of dead time before the screen settles,
// on every reload. This header is what makes a repeat visit instant.
//
// `stale-while-revalidate` rather than `immutable`, deliberately. These files
// have no content hash in their names: the logos and PWA icons are replaced in
// place, and even the version-suffixed illustrations (`-v1`, `-v2`) could be
// re-encoded under the same name. `immutable` tells the browser never to ask
// again for up to a year, so getting that wrong pins a replaced logo on every
// existing user's phone with no way to push a fix. SWR gives up the same
// thing in practice — served instantly from cache with no round trip for a
// week, refreshed in the background — while a bad asset still clears itself
// within a day. The one-year tier is only correct for content-hashed files,
// which is exactly what Next already applies it to under /_next/static.
//
// ⚠️ NEVER ADD /sw.js TO THIS. A cached service worker is a stuck service
// worker; its own no-store rule below is load-bearing.
const STATIC_ART = "public, max-age=86400, stale-while-revalidate=604800";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // A cached service worker is a stuck service worker: the browser keeps
        // running the old copy and installed users never get the new build.
        // Always revalidate this one file.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
      {
        // Brand art, the PWA icon set, and the roadmap illustrations.
        //
        // Note the roadmap pair is drawn through `next/image`, so in practice
        // the browser asks for /_next/image?url=%2Froadmap%2F... and gets the
        // optimiser's own header (also a day) rather than this one. The rule
        // still covers them if they are ever requested directly, and /brand/
        // and /icons/ — the /mine hero is a plain CSS background-image and the
        // PWA icons are fetched by their own URLs — are what it really serves.
        source: "/:dir(brand|icons|roadmap)/:file*",
        headers: [{ key: "Cache-Control", value: STATIC_ART }],
      },
    ];
  },
};

export default nextConfig;
