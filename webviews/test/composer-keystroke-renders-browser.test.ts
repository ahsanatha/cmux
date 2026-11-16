// l10n-allow-file: typed test keys, not shipped UI.
// A keystroke in the agent chat's prompt is the editor's edit and nothing else, however long the chat
// (CMUX-571; Leo: "improve performance (chat, everything related)"; Leo, 2026-11-12: long chats must
// have "no perceivable difference"; Leo, 2026-11-16: "typing under load is not good enough"). The
// composer draws only when what it shows from the text changes (the first key: Send for a draft),
// never once a key (Composer.tsx `textView`, MarkdownField `reportLater`). Not the pane root,
// the transcript or a row; and not the model picker under the box, which does not read the text
// (it read the composer's prompt-focus function, a new one on each composer render, from context),
// and not the + menu (ComposerFrame, which the React Compiler leaves as written, built its rows and
// handlers anew on each render).
//
// The real pane (`?mock`) built by vite.config.acpmux-pane.mjs as it ships (production React, React
// Compiler on; the dev server's development build never drew the picker on a key, fix or not); a chat of
// 1,500 rows (`cmuxAcpmuxDebug.loadSeed`), then real keys in Chromium, counted by `acpmuxPerf.render`.
// Locally: CMUX_BROWSER_TESTS=1 bun test test/composer-keystroke-renders-browser.test.ts
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { probeEngineOrSkip, requireBrowserLane } from "./support/requireBrowserLane";
import fs from "node:fs";
import os from "node:os";

await requireBrowserLane("composer-keystroke-renders-browser.test.ts", async () => {
  if (!(await probeEngineOrSkip("composer-keystroke-renders-browser", "chromium", chromium))) return;
  setDefaultTimeout(240_000);
  const webviews = path.resolve(import.meta.dir, "..");
  const PROMPT = ".acpmux-composer-prompt[contenteditable='true'], .acpmux-composer-prompt [contenteditable='true']";
  const KEYS = 12;
  const out = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "composer-keystroke-renders-"));
  let statics: ReturnType<typeof Bun.serve> | undefined;
  let browser: Browser;

  beforeAll(async () => {
    const { build } = await import("vite");
    await build({
      configFile: path.join(webviews, "vite.config.acpmux-pane.mjs"),
      build: { outDir: out, emptyOutDir: true },
      logLevel: "error",
    });
    statics = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        const file = Bun.file(path.join(out, pathname === "/" ? "index.html" : pathname));
        return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
      },
    });
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
    await statics?.stop(true);
    fs.rmSync(out, { recursive: true, force: true });
  });

  test("a key in a long chat draws neither the transcript, a row, the model picker nor the + menu", async () => {
    const port = statics!.port!;
    const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
    await page.goto(`http://127.0.0.1:${port}/?mock`);
    await page.waitForFunction(() => "cmuxAcpmuxDebug" in window, null, { timeout: 60_000 });
    const seeded = (await page.evaluate(() => (window as any).cmuxAcpmuxDebug.loadSeed(500, { light: true }))) as {
      rows?: number;
      error?: string;
    };
    expect(seeded.error).toBeUndefined();
    expect(seeded.rows ?? 0).toBeGreaterThan(1000);
    const prompt = page.locator(PROMPT).first();
    await prompt.waitFor({ timeout: 30_000 });
    await prompt.click();
    // The first keys load the composer's lazy parts (emoji data, the mention index).
    const shows = (text: string) =>
      page.waitForFunction(
        ([selector, want]) => {
          const text = (document.querySelector(selector!)?.textContent ?? "").trim();
          // An empty prompt may still draw its placeholder.
          return want === "" ? !text.includes("warm") : text === want;
        },
        [PROMPT, text] as const,
      );
    // Two frames after the last change: every render the key started has committed.
    const settled = () =>
      page.evaluate(
        () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
      );
    for (const key of "warm") await page.keyboard.press(key);
    await shows("warm");
    for (let i = 0; i < 4; i += 1) await page.keyboard.press("Backspace");
    await shows("");
    await settled();
    await page.evaluate(() => (window as any).cmuxAcpmuxDebug.renders());
    const typed = "abcdefghijkl".slice(0, KEYS);
    for (let i = 0; i < typed.length; i += 1) {
      await page.keyboard.press(typed[i]!);
      await shows(typed.slice(0, i + 1));
    }
    await settled();
    const renders = (await page.evaluate(() => (window as any).cmuxAcpmuxDebug.renders())) as Record<string, number>;
    await page.close();
    const counted = (prefix: string) =>
      Object.entries(renders)
        .filter(([name]) => name.startsWith(prefix))
        .reduce((total, [, value]) => total + value, 0);
    // The composer draws for the first key (the draft is no longer empty), not once a key: the text
    // is the editor's, and the composer keeps only what it shows from it.
    expect({
      composer: (renders.composer ?? 0) <= 2,
      queue: (renders["composer:queue"] ?? 0) <= 2,
      box: (renders["composer:box"] ?? 0) <= 2,
    }).toEqual({ composer: true, queue: true, box: true });
    // The pane may draw once over the run (a clock tick), never once a key.
    expect(renders.pane ?? 0).toBeLessThanOrEqual(1);
    expect({
      transcript: renders.transcript ?? 0,
      rows: counted("row:") + counted("content:") + counted("frame:"),
      model: renders["composer:model"] ?? 0,
      plus: renders["composer:plus"] ?? 0,
    }).toEqual({ transcript: 0, rows: 0, model: 0, plus: 0 });
  });

  /// The pane with a 300-row chat, its prompt focused and its lazy parts loaded.
  const openPrompt = async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
    await page.goto(`http://127.0.0.1:${statics!.port!}/?mock`);
    await page.waitForFunction(() => "cmuxAcpmuxDebug" in window, null, { timeout: 60_000 });
    const seeded = (await page.evaluate(() => (window as any).cmuxAcpmuxDebug.loadSeed(100, { light: true }))) as {
      error?: string;
    };
    expect(seeded.error).toBeUndefined();
    const prompt = page.locator(PROMPT).first();
    await prompt.waitFor({ timeout: 30_000 });
    await prompt.click();
    await page.keyboard.type("w");
    await page.waitForTimeout(300);
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);
    return page;
  };

  // The composer hears a key after the key's task, so Return and a page going away must read every
  // key typed before them, however fast: a send or a draft never misses text.
  test("text typed and sent in the same moment goes whole", async () => {
    const page = await openPrompt();
    const words = "sent-whole-7q4";
    // Keys and Return back to back: no frame, no idle time between them.
    await page.keyboard.type(words);
    await page.keyboard.press("Enter");
    // Sent whole: the chat shows every key and the prompt is empty (a send that missed a key would
    // show part of it and never match).
    await page.waitForFunction(
      ([selector, want]) =>
        (document.querySelector(".acpmux-scroll")?.textContent ?? "").includes(want!) &&
        !(document.querySelector(selector!)?.textContent ?? "").includes(want!),
      [PROMPT, words] as const,
      { timeout: 20_000 },
    );
    await page.close();
  });

  test("text typed as the page goes away is in the saved draft", async () => {
    const page = await openPrompt();
    const words = "kept-draft-9z2";
    await page.keyboard.type(words);
    // In the same task as the page hides: nothing ran between the last key and here.
    const saved = await page.evaluate((want) => {
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
      return Object.keys(localStorage)
        .map((key) => localStorage.getItem(key) ?? "")
        .filter((value) => value.includes(want.slice(0, 4)));
    }, words);
    await page.close();
    expect(saved).toEqual([words]);
  });
});
