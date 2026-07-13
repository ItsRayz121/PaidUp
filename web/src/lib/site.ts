// The public origin of the deployed site — used for SEO plumbing that must be
// an absolute URL (metadataBase for social-share tags, sitemap.xml, robots.txt).
//
// Set NEXT_PUBLIC_SITE_URL in Vercel to whatever origin is actually live
// (today the *.vercel.app URL; rozipay.xyz once the domain is pointed). Baked
// in at build time like every NEXT_PUBLIC_* value — see DEPLOY.md. The fallback
// is the final domain so a missed env var degrades to "right after the domain
// switch" rather than to localhost.
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://rozipay.xyz")
  .trim()
  .replace(/\/+$/, "");
