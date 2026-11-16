// l10n-allow-file: test fixture prompts, thoughts and commands, not shipped UI.
// Every line in an opened "Worked for" group sits on the one 22px pitch (--cv-tool-row-height,
// design/chat-transcript.md "One-line row pitch"), whatever the line is: a thought first, a tool
// run, a background task's notice and the run the agent did after it. Leo, 2026-11-16, on two
// opened groups: "why is the spacing different on the first thinking tool call?" and "why is the
// background task space after so big".
//
// The page is the pane's dev entry with its browser host, talking JSON-RPC to a stand-in acpmux.
// Real Chromium from Playwright; CI fails the file when it cannot launch (requireBrowserLane).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { installPaintedFrames } from "./support/paintedFrames";
import { requireBrowserLane } from "./support/requireBrowserLane";
import { warmViteServer } from "./support/warmDevServer";

await requireBrowserLane("agent-pane-worked-group-pitch-browser.test.ts", async () => {
  setDefaultTimeout(120_000);
  try {
    await (await chromium.launch({ headless: true })).close();
  } catch {
    console.warn("agent-pane-worked-group-pitch: skipping (run `bunx playwright install chromium`)");
    describe.skip("worked group pitch", () => test("chromium", () => {}));
    return;
  }
  const { createServer } = await import("vite");
  const webviews = path.resolve(import.meta.dir, "..");

  const CHAT = "0190a000-0000-7000-8000-0000000000f9";
  const START = Date.UTC(2026, 10, 16, 18, 0, 0);
  type Step = [dir: string, kind: string, msg: Record<string, unknown>];
  const update = (update: Record<string, unknown>) => ({
    method: "session/update",
    params: { sessionId: "agent-1", update },
  });
  const say = (text: string): Step => [
    "in",
    "agent_message_chunk",
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }),
  ];
  const think = (text: string): Step => [
    "in",
    "agent_thought_chunk",
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } }),
  ];
  const ran = (id: string, command: string, kind = "execute"): Step => [
    "in",
    "tool_call",
    update({ sessionUpdate: "tool_call", toolCallId: id, title: command, kind, status: "completed" }),
  ];
  const THINKING_REPLY = "Linux hosts can share their screen once the portal is in.";
  const NOTICE_REPLY = "The quiet text change is pushed.";
  const steps: Step[] = [
    // Shot 1: a thought leads the turn's work.
    ["mux", "user_message", { text: "Does screen sharing work on Linux?", turnId: "t1" }],
    ["mux", "turn_started", { turnId: "t1" }],
    think("The question is about Linux, most likely host support for screen sharing and remote access."),
    ran("fetch", "git-fetch-once"),
    ran("grep", "rg portal src"),
    ran("cat", "cat README.md"),
    say(THINKING_REPLY),
    ["mux", "turn_result", { turnId: "t1", status: "completed" }],
    // Shot 2: a background task's notice, then the run the agent did after it.
    ["mux", "background_turn", { state: "started", id: "bg-1", trigger: "task_notification" }],
    [
      "mux",
      "user_message",
      {
        text: "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command finished: cd ~/lane && git push (exit 0)</summary>\n</task-notification>",
        turnId: "t2",
      },
    ],
    ["mux", "turn_started", { turnId: "t2" }],
    ran("push", "git log -1"),
    ran("read", "README.md", "read"),
    say(NOTICE_REPLY),
    ["mux", "turn_result", { turnId: "t2", status: "completed" }],
    ["mux", "background_turn", { state: "ended", id: "bg-1", trigger: "task_notification", quiet: false, reason: "result" }],
  ];
  const events = steps.map(([dir, kind, msg], index) => ({
    sessionId: CHAT,
    seq: index + 1,
    at: START + index * 7000,
    dir,
    kind,
    msg,
  }));
  const session = {
    sessionId: CHAT,
    cwd: "/home/dev/cmux",
    title: "Worked group pitch",
    harness: "claude",
    family: "claude",
    status: "idle",
    turnCount: 2,
    updatedAt: START,
  };
  function answer(method: string): unknown {
    switch (method) {
      case "initialize":
        return { protocolVersion: 1, _meta: { acpmux: { origin: "local", extensions: [], operations: [] } } };
      case "_acpmux/watch":
        return { sessions: [session] };
      case "_acpmux/attach":
        return { session, lastSeq: events.length, events };
      case "_acpmux/events":
        return { events: [], hasMore: false, lastSeq: events.length };
      default:
        return null;
    }
  }

  let daemon: ReturnType<typeof Bun.serve> | undefined;
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  let browser: Browser | undefined;
  const url = () => {
    const { port } = vite!.httpServer!.address() as { port: number };
    const endpoint = `ws://127.0.0.1:${daemon!.port}/`;
    return `http://127.0.0.1:${port}/#endpoint=${encodeURIComponent(endpoint)}&token=t&session=${CHAT}`;
  };
  const atRest = (page: Page) =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          window.cmuxAfterPaint(() => {
            const moving = document
              .getAnimations()
              .some(
                (animation) =>
                  animation.playState === "running" && animation.effect?.getComputedTiming().endTime !== Infinity,
              );
            if (moving) return true;
            resolve();
            return false;
          }),
        ),
    );
  const open = async (): Promise<Page> => {
    const page = await browser!.newPage({ viewport: { width: 900, height: 1400 } });
    await installPaintedFrames(page);
    await page.goto(url());
    await page.getByText(NOTICE_REPLY).waitFor();
    await page.mouse.move(0, 0);
    await atRest(page);
    // Open every turn's "Worked for" group.
    for (let pass = 0; pass < 4; pass += 1) {
      const shut = page.locator("button.cv-worked.is-toggle[aria-expanded='false']");
      if ((await shut.count()) === 0) break;
      await shut.first().click();
      await page.mouse.move(0, 0);
      await atRest(page);
    }
    return page;
  };
  beforeAll(async () => {
    daemon = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request, server) {
        return server.upgrade(request, { data: undefined }) ? undefined : new Response("acpmux", { status: 426 });
      },
      websocket: {
        message(ws, raw) {
          const message = JSON.parse(String(raw)) as { id?: number; method: string };
          if (message.id !== undefined)
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: answer(message.method) }));
        },
      },
    });
    vite = await createServer({
      configFile: path.join(webviews, "vite.config.acpmux-pane.mjs"),
      server: { port: 0, host: "127.0.0.1", strictPort: false },
      logLevel: "error",
    });
    await vite.listen();
    await warmViteServer(vite, "/");
    browser = await chromium.launch({ headless: true });
    for (let attempt = 1; ; attempt++) {
      const warm = await browser.newPage();
      try {
        await warm.goto(url());
        await warm.getByText(NOTICE_REPLY).waitFor({ timeout: 25_000 });
        await warm.close();
        break;
      } catch (error) {
        await warm.close();
        if (attempt === 3) throw error;
      }
    }
  });
  afterAll(async () => {
    await browser?.close();
    await vite?.close();
    await daemon?.stop(true);
  });

  /// Each opened group's one-line rows, top to bottom: the line's top, height and words, and the
  /// pitch (top to top) to the next line. A line is any element on the rows' icon column that draws
  /// one line: a tool row, a thought, a notice.
  const lines = (page: Page) =>
    page.evaluate(() => {
      const rows = [...document.querySelectorAll<HTMLElement>(".acpmux-row")].sort(
        (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
      );
      const out: { group: number; top: number; height: number; text: string; row: string }[] = [];
      let group = -1;
      for (const row of rows) {
        if (row.querySelector(".cv-worked")) {
          group += 1;
          continue;
        }
        if (group < 0) continue;
        // Prose ends the group's lines.
        if (row.querySelector(".cv-md") && !row.querySelector(".cv-tool")) continue;
        const LINE = ".cv-tool, .cv-disclosure__line";
        const found = [...row.querySelectorAll<HTMLElement>(LINE)].filter(
          (node) => node.getBoundingClientRect().height > 0 && !node.parentElement?.closest(LINE),
        );
        if (found.length === 0 && row.getBoundingClientRect().height > 0) found.push(row);
        for (const node of found) {
          const rect = node.getBoundingClientRect();
          out.push({
            group,
            top: Math.round(rect.top * 10) / 10,
            height: Math.round(rect.height * 10) / 10,
            text: (node.textContent ?? "").trim().slice(0, 48),
            row: `${row.dataset.rowId ?? ""} ${row.className}`.slice(0, 120),
          });
        }
      }
      return out;
    });

  test("every line of an opened Worked group sits one 22px pitch from the next", async () => {
    const page = await open();
    const measured = await lines(page);
    const pitches = measured.slice(1).map((line, index) => ({
      from: measured[index]!.text,
      to: line.text,
      pitch: measured[index]!.group === line.group ? Math.round((line.top - measured[index]!.top) * 10) / 10 : null,
    }));
    console.log("worked-group-pitch lines", JSON.stringify(measured, null, 1));
    console.log("worked-group-pitch pitches", JSON.stringify(pitches, null, 1));
    const inGroup = pitches.filter((pitch) => pitch.pitch !== null);
    expect(inGroup.length).toBeGreaterThanOrEqual(4);
    for (const pitch of inGroup) expect({ ...pitch, pitch: Math.round(pitch.pitch!) }).toEqual({ ...pitch, pitch: 22 });
    await page.close();
  });
});
