import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Only the two pages a logged-out visitor can actually see (robots.ts blocks
// the rest). Small on purpose — a sitemap full of login-redirects would only
// teach Google that our pages are thin.
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/login`, changeFrequency: "monthly", priority: 0.8 },
  ];
}
