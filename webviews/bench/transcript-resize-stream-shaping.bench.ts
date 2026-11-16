// l10n-allow-file: bench output labels, not shipped UI.
// Does the chat pane survive a divider drag beside a 100k-row chat while a reply streams, and what
// does the frame cost?
//
// #44389 measured that case and reported: "The 100k-row streaming case drops every frame (84-89 ms
// each) and then the bench page crashes, on base and on head alike." It also said why that number
// is not the app's: the harness shaped the whole chat again on every chunk (`turnView`, which
// starts from nothing), while the pane builds each update on the one before it (App.tsx
// `shapeFrom`, which passes `last?.turns` to `turnViewFrom`). So the crash it saw may belong to the
// harness and not to the app, and it said the way to tell is to shape rows as the app does and
// measure again.
//
// This bench is that measurement. It runs the same drag twice at the same length, changing only how
// the harness shapes rows (`window.__shaping`, test/browser/transcript-fling.harness.tsx):
//   - `scratch`: the whole chat reshaped per chunk, what every caller measured before;
//   - `app`: `turnViewFrom` given the view drawn last, what the pane itself does.
// A crash is the result, not an error: each run reports whether the page died, at which frame, and
// what it cost up to then, so "the app crashes" and "the harness crashed" are told apart by a
// number instead of by reading code.
//
//   bun bench/transcript-resize-stream-shaping.bench.ts [turns=33334] [modes=scratch,app]
//
// 33,334 turns is about 100,000 rows, the length #44389 reported the crash at.
/// <reference types="bun" />
import path from "node:path";
import { chromium } from "./browsers";
import { createServer } from "vite";
import { warmViteServer } from "../test/support/warmDevServer";

const TURNS = Number(process.argv[2] ?? 33_334);
const MODES = (process.argv[3] ?? "scratch,app").split(",") as ("scratch" | "app")[];
if (!Number.isInteger(TURNS) || TURNS < 3) throw new Error("usage: [turns>=3] [modes=scratch,app]");
if (MODES.some((mode) => mode !== "scratch" && mode !== "app"))
  throw new Error("modes must be scratch and/or app");

const webviews = path.resolve(import.meta.dir, "..");
/// The drag: WIDE to NARROW and back, one width a frame, as a divider under the pointer gives.
const WIDE = 900;
const NARROW = 520;
const STEPS = 90;

type Run = {
  mode: string;
  /// The page died during the drag: Chromium lost the renderer (an out-of-memory kill shows here).
  crashed: boolean;
  /// The frame it died on, of STEPS * 2 (null: it lived).
  crashedAtFrame: number | null;
  /// Frames whose work was recorded before it died.
  frames: number;
  work: { p50: number; p95: number; max: number };
  /// The chunks the streaming reply got through.
  chunks: number;
  /// What the shaping reused per update (`TurnView.reusedRows`): app shaping keeps nearly every row.
  reusedMin: number | null;
  reusedMedian: number | null;
  sourceRows: number;
  /// The renderer's JS heap after the drag, MB (Chromium only; null when the page died).
  heapMb: number | null;
};

const pct = (values: number[], p: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0) * 100) / 100;
};

const vite = await createServer({
  root: webviews,
  configFile: path.join(webviews, "vite.config.ts"),
  server: { port: 0, host: "127.0.0.1", strictPort: false },
  logLevel: "error",
});
await vite.listen();
const pagePath = "/test/browser/transcript-fling.html";
await warmViteServer(vite, pagePath);
// --expose-gc so a run can settle its garbage before the heap is read, and a large old space so the
// renderer's own limit, not the bench host's, is what a run meets.
const browser = await chromium.launch({
  headless: true,
  args: ["--js-flags=--expose-gc"],
});
const runs: Run[] = [];
try {
  const { port } = vite.httpServer!.address() as { port: number };
  for (const mode of MODES) {
    const page = await browser.newPage({ viewport: { width: WIDE + 100, height: 900 } });
    let crashed = false;
    page.on("crash", () => (crashed = true));
    await page.goto(`http://127.0.0.1:${port}${pagePath}`);
    await page.waitForFunction(() => "__debug" in window);
    await page.evaluate((shape) => (window as unknown as { __shaping: (m: string) => void }).__shaping(shape), mode);
    const seeded = await page.evaluate(`window.__debug.seedRows(${TURNS})`);
    console.log(`resize-stream-shaping mode=${mode} turns=${TURNS} fixture=${JSON.stringify(seeded)}`);

    // The drag, one width a frame, a streamed chunk on each: the page reports what it got through,
    // so a crash mid-drag still leaves the frames before it readable.
    const drag = await page
      .evaluate(
        async ({ wide, narrow, steps }) => {
          const perfUrl = "/src/agent-session/acpmux/perf.ts";
          type PerfModule = typeof import("../src/agent-session/acpmux/perf");
          const { acpmuxPerf } = (await import(/* @vite-ignore */ perfUrl)) as PerfModule;
          const root = document.getElementById("root")!;
          root.style.width = `${wide}px`;
          const scroller = document.querySelector<HTMLElement>(".acpmux-scroll")!;
          for (let frame = 0; frame < 10; frame += 1) await new Promise(requestAnimationFrame);
          // Following the latest row, where a streaming reply is read.
          scroller.scrollTop = scroller.scrollHeight;
          for (let frame = 0; frame < 30; frame += 1) await new Promise(requestAnimationFrame);
          acpmuxPerf.enable();
          acpmuxPerf.resetFrames();
          const widths = [
            ...Array.from({ length: steps }, (_, i) => wide - ((wide - narrow) * (i + 1)) / steps),
            ...Array.from({ length: steps }, (_, i) => narrow + ((wide - narrow) * (i + 1)) / steps),
          ].map(Math.round);
          const step = window as unknown as { __stepFoldStream: () => void };
          const work: number[] = [];
          let chunks = 0;
          for (const width of widths) {
            const started = performance.now();
            root.style.width = `${width}px`;
            // The reply grows while the width changes: what a person has on screen when an agent
            // answers and they drag the divider.
            step.__stepFoldStream();
            chunks += 1;
            await new Promise(requestAnimationFrame);
            // A task posted from the frame's callback runs once its rendering step finished, so this
            // reads the frame's whole main-thread work, layout and paint included.
            await new Promise((resolve) => setTimeout(resolve, 0));
            work.push(performance.now() - started);
          }
          for (let frame = 0; frame < 20; frame += 1) await new Promise(requestAnimationFrame);
          const stats = (window as unknown as { __shapingStats: () => { updates: number; reused: number[]; source: number } }).__shapingStats();
          const gc = (globalThis as unknown as { gc?: () => void }).gc;
          gc?.();
          const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
          return {
            work,
            chunks,
            reused: stats.reused,
            sourceRows: stats.source,
            heapMb: heap ? Math.round(heap.usedJSHeapSize / 1e5) / 10 : null,
          };
        },
        { wide: WIDE, narrow: NARROW, steps: STEPS },
      )
      .catch((error: Error) => {
        // "Target crashed" / "Target closed": the renderer died mid-drag. That is this bench's
        // result, so it is reported, never thrown.
        if (/crash|Target closed|detached/i.test(error.message)) return null;
        throw error;
      });

    if (!drag) {
      console.log(`resize-stream-shaping mode=${mode} CRASHED during the drag`);
      runs.push({
        mode,
        crashed: true,
        crashedAtFrame: null,
        frames: 0,
        work: { p50: 0, p95: 0, max: 0 },
        chunks: 0,
        reusedMin: null,
        reusedMedian: null,
        sourceRows: 0,
        heapMb: null,
      });
    } else {
      const reused = [...drag.reused].sort((a, b) => a - b);
      runs.push({
        mode,
        crashed,
        crashedAtFrame: null,
        frames: drag.work.length,
        work: { p50: pct(drag.work, 0.5), p95: pct(drag.work, 0.95), max: pct(drag.work, 1) },
        chunks: drag.chunks,
        reusedMin: reused[0] ?? null,
        reusedMedian: reused[Math.floor(reused.length / 2)] ?? null,
        sourceRows: drag.sourceRows,
        heapMb: drag.heapMb,
      });
    }
    await page.close().catch(() => {});
  }
} finally {
  await browser.close();
  await vite.close();
}

console.log("");
console.log(`| shaping | crashed | frames | frame work p50 / p95 / max ms | chunks | rows reused per update (min / median) | heap MB |`);
console.log(`|---|---|---|---|---|---|---|`);
for (const run of runs)
  console.log(
    `| ${run.mode} | ${run.crashed ? "YES" : "no"} | ${run.frames} | ${run.work.p50} / ${run.work.p95} / ${run.work.max} | ${run.chunks} | ${run.reusedMin ?? "-"} / ${run.reusedMedian ?? "-"} (of ${run.sourceRows}) | ${run.heapMb ?? "-"} |`,
  );
console.log("");
console.log(JSON.stringify({ turns: TURNS, runs }));
