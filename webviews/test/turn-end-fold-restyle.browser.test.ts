// cmux-web-test-timeout: 300
// l10n-allow-file: the mock daemon's fixture turns, not shipped UI.
// A turn's end fold touches the rows that fold, not the whole thread (hq docs/design/chat-render-
// pipeline.md, stage 5, R1/R2/R9; Leo, 2026-11-16: "The rendering wants to recalculating stuff when
// the agent chat stream is going/ends, but text comes in pretty quickly, and stuff shifts at the
// bottom pretty frequently, and then there's a big wave of stuff that gets redrawn").
//
// The real pane (`?mock`) with a 700-turn chat (`cmuxAcpmuxDebug.loadSeed`), then one turn streamed
// with tool calls (`loadRun`) so its end folds. Chromium's own trace over the second after the fold
// starts: how many elements each style pass restyles (UpdateLayoutTree elementCount) against every
// element in the thread, and how many style or layout passes script forced (a read after a write).
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { requireBrowserLane } from "./support/requireBrowserLane";
import { warmViteServer } from "./support/warmDevServer";

type TraceEvent = { name: string; ph: string; ts: number; dur?: number; tid: number; args?: any };

await requireBrowserLane("turn-end-fold-restyle.browser.test.ts", async () => {
  setDefaultTimeout(280_000);
  const { createServer } = await import("vite");
  const webviews = path.resolve(import.meta.dir, "..");
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: Browser | undefined;
  beforeAll(async () => {
    vite = await createServer({
      configFile: path.join(webviews, "vite.config.acpmux-pane.mjs"),
      server: { port: 0, host: "127.0.0.1", strictPort: false },
      logLevel: "error",
    });
    await vite.listen();
    await warmViteServer(vite, "/?mock");
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
    await vite?.close();
  });

  test("a turn's end fold restyles and forces layout only for the rows that fold", async () => {
    const page = await browser!.newPage({ viewport: { width: 900, height: 760 } });
    const { port } = vite!.httpServer!.address() as { port: number };
    await page.goto(`http://127.0.0.1:${port}/?mock`);
    await page.waitForFunction(() => "cmuxAcpmuxDebug" in window, null, { timeout: 60_000 });
    const seeded = (await page.evaluate(() => (window as any).cmuxAcpmuxDebug.loadSeed(700))) as Record<string, any>;
    expect(seeded.error).toBeUndefined();
    // The fold's start, stamped into the trace, with the thread's size then.
    await page.evaluate(() => {
      const w = window as any;
      w.__fold = { started: 0, threadElements: 0, rows: 0 };
      new MutationObserver(() => {
        const thread = document.querySelector(".acpmux-thread");
        if (!thread?.hasAttribute("data-turn-end-folding") || w.__fold.started) return;
        console.timeStamp("turn-end-fold-start");
        w.__fold.started = performance.now();
        w.__fold.threadElements = thread.querySelectorAll("*").length;
        w.__fold.rows = thread.querySelectorAll(":scope > .acpmux-row[data-row-id]").length;
      }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-turn-end-folding"] });
    });
    await browser!.startTracing(page, {
      categories: ["devtools.timeline", "disabled-by-default-devtools.timeline"],
    });
    const run = (await page.evaluate(() =>
      (window as any).cmuxAcpmuxDebug.loadRun({
        seconds: 2,
        chunk_chars: 24,
        chunk_ms: 12,
        tool_every: 12,
        scroll_speed: 0,
      }),
    )) as Record<string, any>;
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1200)));
    const fold = (await page.evaluate(() => (window as any).__fold)) as {
      started: number;
      threadElements: number;
      rows: number;
    };
    const passes = (await page.evaluate(() => (window as any).cmuxTurnEndFoldPerf?.() ?? null)) as Record<
      string,
      number
    > | null;
    const raw = JSON.parse((await browser!.stopTracing()).toString()) as { traceEvents: TraceEvent[] };
    await page.close();
    expect(run.error).toBeUndefined();
    expect(fold.started, "the turn's end folded").toBeGreaterThan(0);
    const stamp = raw.traceEvents.find(
      (event) => event.name === "TimeStamp" && event.args?.data?.message === "turn-end-fold-start",
    );
    expect(stamp, "the fold's start is in the trace").toBeDefined();
    const from = stamp!.ts - 50_000;
    const to = stamp!.ts + 1_000_000;
    const inFold = raw.traceEvents.filter((event) => event.ts >= from && event.ts <= to && event.ph === "X");
    const recalcs = inFold.filter((event) => event.name === "UpdateLayoutTree");
    const elements = recalcs.map((event) => Number(event.args?.elementCount ?? event.args?.data?.elementCount ?? 0));
    const forced = (name: string) =>
      inFold.filter((event) => event.name === name && (event.args?.beginData?.stackTrace?.length ?? 0) > 0).length;
    const report = {
      threadElements: fold.threadElements,
      mountedRows: fold.rows,
      recalcs: recalcs.length,
      maxElements: Math.max(0, ...elements),
      totalElements: elements.reduce((a, b) => a + b, 0),
      overHalf: elements.filter((count) => count > fold.threadElements / 2).length,
      forcedStyle: forced("UpdateLayoutTree"),
      forcedLayout: forced("Layout"),
      passes,
    };
    console.log(`TURN-END-FOLD-RESTYLE ${JSON.stringify(report)}`);
    expect(report.overHalf, "style passes over half the thread in the fold's second").toBe(0);
    // Each pass reads every place first and writes after: script forces no more style passes than
    // the fold has passes (one read at each pass's start), never one per row it animates.
    expect(report.forcedStyle, "script-forced style passes in the fold's second").toBeLessThanOrEqual(
      Math.max(4, passes?.passes ?? 4),
    );
  });
});
