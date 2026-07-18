import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// What search engines may crawl. Only the front door is public: every other
// screen needs a login, so to a crawler each one is just a duplicate of /login.
// /staff is the internal panel and must never show up in search results.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/login"],
      disallow: [
        "/staff",
        "/profile",
        "/wallet",
        "/kyc",
        "/mine",
        "/surveys",
        "/tasks",
        "/refer",
        "/help",
        "/leaderboard",
        "/offline",
      ],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
