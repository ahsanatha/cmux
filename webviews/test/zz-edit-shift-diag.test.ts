import { afterAll, beforeAll, setDefaultTimeout, test } from "bun:test";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { devHighlightWorker } from "./support/devHighlightWorker";
import { galleryFrame, warmGalleryFrame } from "./support/galleryFrame";

setDefaultTimeout(300_000);
const { createServer } = await import("vite");
let server: Awaited<ReturnType<typeof createServer>>;
let browser: Browser;
let base: string;
beforeAll(async () => {
  const root = path.resolve(import.meta.dir, "..");
  server = await createServer({
    root,
    configFile: path.join(root, "vite.config.ts"),
    server: { port: 0, host: "127.0.0.1" },
    plugins: [devHighlightWorker()],
    logLevel: "error",
  });
  await server.listen();
  base = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true });
  await warmGalleryFrame(server, "agent-pane.transcript", { browser, params: { variant: "edit-long-line-code" } });
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});
for (const variant of ["edit-long-line-prose", "edit-long-line-code"])
  for (const run of [1, 2, 3])
    test(`${variant} ${run}`, async () => {
      const page = await browser.newPage({ viewport: { width: 760, height: 720 } });
      await page.addInitScript(() => {
        const out: unknown[] = [];
        (window as unknown as { __shifts: unknown[] }).__shifts = out;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as unknown as {
            value: number;
            startTime: number;
            sources: { node?: Element; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[];
          }[])
            out.push({
              t: Math.round(entry.startTime),
              value: Number(entry.value.toFixed(4)),
              sources: entry.sources.map((s) => ({
                node: s.node instanceof Element ? `${s.node.tagName}.${s.node.className}[${(s.node as HTMLElement).dataset?.rowId ?? ""}]` : String(s.node),
                prev: [s.previousRect.y, s.previousRect.height],
                cur: [s.currentRect.y, s.currentRect.height],
              })),
            });
        }).observe({ type: "layout-shift", buffered: true });
      });
      await page.goto(
        `${base}${galleryFrame("agent-pane.transcript", { variant, theme: "Apple System Colors", colorScheme: "dark", width: 760, height: 720 })}`,
      );
      await page.waitForFunction(() => document.documentElement.dataset.galleryReady !== undefined, null, {
        timeout: 60_000,
      });
      await page.waitForTimeout(1500);
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".acpmux-row")].map((row) => {
          const r = row.getBoundingClientRect();
          return `${row.dataset.rowId}@${r.top.toFixed(1)}+${r.height.toFixed(1)}`;
        }),
      );
      const shifts = await page.evaluate(() => (window as unknown as { __shifts: unknown[] }).__shifts);
      console.log("SHIFTDIAG", variant, run, JSON.stringify({ rows, shifts }));
      await page.close();
    });
