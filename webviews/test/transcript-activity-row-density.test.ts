// PROBE (temporary): logs every row of agent-pane.activity-row-density and writes screenshots.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { galleryFrame, warmGalleryFrame } from "./support/galleryFrame";
import { requireBrowserLane } from "./support/requireBrowserLane";

await requireBrowserLane("transcript-activity-row-density.test.ts", async () => {
  setDefaultTimeout(300_000);
  const ENTRY = "agent-pane.activity-row-density";
  const VARIANTS = ["expanded", "folded", "density-roomy", "density-compact", "density-dense"];
  const OUT = process.env.FAST_CHECKS_OUT;
  try {
    await (await chromium.launch({ headless: true })).close();
  } catch {
    describe.skip("activity row density", () => test("browser", () => {}));
    return;
  }
  const { createServer } = await import("vite");
  const webviews = path.resolve(import.meta.dir, "..");
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: Browser;
  beforeAll(async () => {
    vite = await createServer({
      configFile: path.join(webviews, "vite.config.gallery-dev.ts"),
      server: { port: 0, host: "127.0.0.1", strictPort: false },
      logLevel: "error",
    });
    await vite.listen();
    browser = await chromium.launch({ headless: true });
    await warmGalleryFrame(vite, ENTRY, { browser, params: { variant: VARIANTS[0]! } });
  });
  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });
  for (const variant of VARIANTS) {
    test(`probe ${variant}`, async () => {
      const page = await browser.newPage({ viewport: { width: 860, height: 760 }, deviceScaleFactor: 2 });
      const port = (vite!.httpServer!.address() as { port: number }).port;
      await page.goto(
        `http://127.0.0.1:${port}${galleryFrame(ENTRY, { variant, width: 760, theme: "Catppuccin Mocha", reducedMotion: "true" })}`,
      );
      await page.waitForFunction(() => document.documentElement.dataset.galleryReady === "1", undefined, {
        timeout: 120_000,
      });
      await page.evaluate(() => document.fonts.ready);
      await page.mouse.move(0, 0);
      const log = await page.evaluate(() => {
        const out: string[] = [];
        for (const row of document.querySelectorAll<HTMLElement>(".acpmux-row")) {
          const box = row.getBoundingClientRect();
          out.push(
            `ROW ${box.top.toFixed(2)}+${box.height.toFixed(2)} id=${row.dataset.rowId} cls=${row.className} | ${(row.innerText || "").replace(/\s+/g, " ").slice(0, 90)}`,
          );
          const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node.textContent?.trim();
            if (!text || !node.parentElement) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            const rect = [...range.getClientRects()].find((each) => each.width > 0 && each.height > 0);
            if (!rect) continue;
            const style = getComputedStyle(node.parentElement);
            out.push(
              `   T c=${((rect.top + rect.bottom) / 2).toFixed(2)} h=${rect.height.toFixed(1)} fs=${style.fontSize} el=${node.parentElement.tagName}.${node.parentElement.className} "${text.slice(0, 40)}"`,
            );
          }
          for (const el of row.querySelectorAll<HTMLElement>("svg, .cv-agent-tag, button")) {
            const b = el.getBoundingClientRect();
            if (b.height === 0) continue;
            out.push(`   E ${el.tagName}.${String(el.className.baseVal ?? el.className)} top=${b.top.toFixed(2)} ${b.width.toFixed(1)}x${b.height.toFixed(1)}`);
          }
        }
        return out.join("\n");
      });
      console.log(`DENSITY ${variant}\n${log}`);
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        await page.screenshot({ path: path.join(OUT, `${variant}.png`), fullPage: true });
      }
      await page.close();
      expect(log.length).toBeGreaterThan(0);
    });
  }
});
