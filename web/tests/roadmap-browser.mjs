// Run against `npm run build && npm run start` using Node 22+ and Playwright.
// PLAYWRIGHT_MODULE may point to a bundled installation; no app dependency needed.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const base = process.env.ROADMAP_BASE_URL || "http://localhost:3000";
const browser = await chromium.launch({ headless: true });
let cases = 0;
try {
  for (const theme of ["vault", "light"]) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      timezoneId: theme === "vault" ? "Pacific/Auckland" : "America/Los_Angeles",
    });
    await context.addInitScript((value) => localStorage.setItem("rozipay-theme", value), theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (/hydration|hydrated|Minified React error/i.test(message.text())) errors.push(message.text());
    });
    // This is a frontend audit with no live account. Simulate unavailable API
    // responses instead of making requests to production services.
    await page.route("**/*", (route) => {
      if (new URL(route.request().url()).origin !== new URL(base).origin) {
        return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Audit: API unavailable"}' });
      }
      return route.continue();
    });
    await page.clock.install({ time: new Date("2026-09-07T12:00:00Z") });
    await page.goto(`${base}/mine/roadmap`);
    await page.locator(".roadmap-badge-active").waitFor();
    const contrast = await page.locator(".roadmap-badge-active").evaluate((e) => {
      const ctx = document.createElement("canvas").getContext("2d");
      const luminance = (color) => {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => {
          const n = v / 255;
          return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
        });
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      };
      const style = getComputedStyle(e);
      const a = luminance(style.color), b = luminance(style.backgroundColor);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    });
    assert.ok(contrast >= 4.5, `${theme}: small status text contrast ${contrast}`);
    assert.equal(await page.locator("main").count(), 1, "single main landmark");
    assert.equal(await page.locator("nav [aria-current=page]").getAttribute("href"), "/mine");
    assert.deepEqual(await page.locator("nav a").evaluateAll((links) => links.map((a) => a.getAttribute("href"))), ["/", "/tasks", "/mine", "/wallet", "/profile"]);

    for (const width of [320, 360, 390, 430, 599, 600, 767, 768, 1180]) {
      await page.setViewportSize({ width, height: 844 });
      const result = await page.evaluate(() => {
        const cards = [...document.querySelectorAll(".roadmap-card")];
        const stops = [...document.querySelectorAll(".roadmap-stop")];
        const roads = stops.map((e) => e.querySelector(".roadmap-road").getBoundingClientRect());
        const hero = document.querySelector(".roadmap-hero > div").getBoundingClientRect();
        const art = document.querySelector(".roadmap-hero-stage").getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          clipped: cards.some((e) => e.scrollWidth > e.clientWidth),
          alternating: stops.every((e, i) => {
            const card = e.querySelector(".roadmap-card").getBoundingClientRect();
            const island = e.querySelector(".roadmap-island").getBoundingClientRect();
            return i % 2 ? card.left >= island.right - 1 : card.right <= island.left + 1;
          }),
          joins: roads.slice(1).every((e, i) => Math.abs(e.top - roads[i].bottom) < 0.6),
          heroOverlap: hero.right > art.left + 1,
        };
      });
      assert.deepEqual(result, { overflow: false, clipped: false, alternating: true, joins: true, heroOverlap: false }, `${theme} ${width}px`);
      cases++;
    }

    // Emulate 200% text enlargement, leaving the phone viewport unchanged.
    await page.setViewportSize({ width: 320, height: 844 });
    await page.evaluate(() => {
      document.querySelectorAll(".roadmap-live p, .roadmap-live h1, .roadmap-live h2, .roadmap-live h3, .roadmap-live span").forEach((e) => {
        e.dataset.auditFont = getComputedStyle(e).fontSize;
      });
      document.querySelectorAll("[data-audit-font]").forEach((e) => e.style.fontSize = `${parseFloat(e.dataset.auditFont) * 2}px`);
    });
    assert.equal(await page.evaluate(() => [...document.querySelectorAll(".roadmap-card")].some((e) => e.scrollWidth > e.clientWidth)), false, "enlarged cards remain readable");
    await page.evaluate(() => document.querySelectorAll("[data-audit-font]").forEach((e) => e.style.removeProperty("font-size")));

    // A cached production page must update after month rollover without a reload.
    await page.clock.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForFunction(() => document.querySelector(".roadmap-stop-1 .roadmap-badge-active"));
    assert.equal(await page.locator(".roadmap-stop-0 .roadmap-badge-done").count(), 1);
    await page.clock.setSystemTime(new Date("2026-09-07T12:00:00Z"));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForFunction(() => document.querySelector(".roadmap-stop-0 .roadmap-badge-active"));

    await page.setViewportSize({ width: 390, height: 844 });
    for (const img of await page.locator(".roadmap-live img").all()) {
      await img.scrollIntoViewIfNeeded();
      await img.evaluate((e) => e.decode());
    }
    await page.locator(".roadmap-cta a").scrollIntoViewIfNeeded();
    assert.equal(await page.locator(".roadmap-cta a").evaluate((e) => {
      const r = e.getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest("a") === e;
    }), true, "CTA is not covered by bottom navigation");
    await page.evaluate(() => window.scrollTo(0, 0));
    if (theme === "vault" && process.env.ROADMAP_SCREENSHOT) {
      await page.screenshot({ path: process.env.ROADMAP_SCREENSHOT, fullPage: true });
    }
    await page.locator(".roadmap-cta a").click();
    await page.waitForURL((url) => ["/mine", "/login"].includes(url.pathname));
    assert.deepEqual(errors, [], `${theme}: no runtime or hydration errors`);
    await context.close();
  }
  console.log(`PASS: ${cases} theme/viewport combinations; images, joins, enlarged text, date rollover, landmarks, nav and CTA.`);
} finally {
  await browser.close();
}
