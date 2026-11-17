// temporary diagnostic, not committed
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { settleReact } from "../../../../test/support/domTeardown";
import { AcpmuxDirectClient, type EventRecord } from "../direct";
import type { AcpmuxRow } from "../model";
import { turnReplies, undrawnReplies } from "./repliesDrawn";
import { turnView } from "./turns";

const load = (name: string): EventRecord[] =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
const FIX = [
  ["01a18a35-b1e8-7951-ba2f-703bf916b9a6", "sr2-turns-3999123.ndjson"],
  ["01a1e3f0-e8a7-7488-a4c1-0eb969d4bbc0", "sr2-coord-197051.ndjson"],
] as const;
const dom = new JSDOM("<!doctype html>", { url: "http://localhost/" });
const scope = globalThis as Record<string, unknown>;
beforeAll(() => {
  scope.window = dom.window;
  scope.document = dom.window.document;
});
afterAll(async () => {
  await settleReact();
});
function replay(session: string, events: readonly EventRecord[]): AcpmuxRow[] {
  let rows: readonly AcpmuxRow[] = [];
  const client = AcpmuxDirectClient.replay(session, [...events], (s) => {
    rows = s.rows;
  });
  try {
    client.seekReplay(events.at(-1)!.seq);
  } finally {
    client.close();
  }
  return [...rows];
}
const line = (r: AcpmuxRow) =>
  `${r.kind}:${r.id}${r.inBackground ? " inBg=" + r.inBackground : ""}${r.kind === "assistant" ? " len=" + (r.text?.length ?? 0) + (r.foldedReply ? " folded" : "") : ""}`;
for (const [sid, name] of FIX)
  test("diag " + name, () => {
    const logged = load(name);
    const replies = turnReplies(logged);
    console.log("REPLIES", name, replies.map((r) => `${r.startSeq} ${r.segment} ${r.text.length}`).join("\n"));
    const rows = replay(sid, logged);
    console.log("RAW", name, rows.map(line).join("\n"));
    for (const family of ["claude", "codex"]) {
      const drawn = turnView(rows, new Set(), { agentFamily: family });
      console.log("DRAWN", name, family, drawn.map(line).join("\n"));
      console.log("MISSING", name, family, undrawnReplies(replies, drawn).map((r) => `${r.startSeq}`).join(", "));
    }
    expect(true).toBe(true);
  });
const settle = async (done: () => boolean) => {
  for (let turns = 0; !done(); turns += 1) {
    if (turns > 20_000) throw new Error("never settled");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};
for (const [, name] of FIX)
  test("live " + name, async () => {
    const logged = load(name);
    const { MockAcpmuxSocket, mockHost } = await import("../mock");
    const { turnViewFrom } = await import("./turns");
    let live: any;
    let shown: any;
    let snapshots = 0;
    let socket!: any;
    const client = await AcpmuxDirectClient.connect(
      mockHost,
      (snapshot) => {
        shown = snapshot;
        snapshots += 1;
        live = turnViewFrom(
          snapshot.rows,
          new Set() as never,
          {
            working: snapshot.isWorking,
            clockOffset: snapshot.clockOffsetMs,
            turnStartedAtMs: snapshot.turnStartedAtMs,
            agentFamily: "claude",
            waitingSteers: snapshot.waitingSteers,
          } as never,
          live,
        );
      },
      undefined,
      () => (socket = new MockAcpmuxSocket(() => Promise.resolve())) as unknown as WebSocket,
    );
    const id = mockHost.sessionId!;
    await settle(() => shown?.summary !== undefined);
    const replies = turnReplies(logged);
    for (const event of logged) {
      if (event.dir === "mux") {
        if (event.kind === "turn_started") socket.touch(id, { status: "running", turn: { turnId: event.msg?.turnId } });
        socket.emit(id, { mux: event.kind, msg: event.msg });
        if (event.kind === "turn_result") socket.touch(id, { status: "idle", turn: undefined });
      } else
        socket.emit(id, {
          update: event.msg.params.update,
          ...(event.msg.params._meta && { meta: event.msg.params._meta }),
        });
      const before = snapshots;
      await settle(() => snapshots > before);
    }
    console.log("LIVE DRAWN", name, live.rows.map(line).join("\n"));
    console.log("LIVE MISSING", name, undrawnReplies(replies, live.rows).map((r) => `${r.startSeq}`).join(", "));
    client.close?.();
  }, 120_000);
