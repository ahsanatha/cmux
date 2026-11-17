// temporary diagnostic, not committed
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { settleReact } from "../../../../test/support/domTeardown";
import { AcpmuxDirectClient, type EventRecord } from "../direct";
import type { AcpmuxRow } from "../model";
import { turnReplies, undrawnReplies } from "./repliesDrawn";
import { turnView } from "./turns";

const SESSION = "01a18a35-b1e8-7951-ba2f-703bf916b9a6";
const logged: EventRecord[] = readFileSync(new URL("./fixtures/sr2-turns-3999123.ndjson", import.meta.url), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line));
const dom = new JSDOM("<!doctype html>", { url: "http://localhost/" });
const scope = globalThis as Record<string, unknown>;
beforeAll(() => { scope.window = dom.window; scope.document = dom.window.document; });
afterAll(async () => { await settleReact(); });
function replay(events: readonly EventRecord[]): AcpmuxRow[] {
  let rows: readonly AcpmuxRow[] = [];
  const client = AcpmuxDirectClient.replay(SESSION, [...events], (s) => { rows = s.rows; });
  try { client.seekReplay(events.at(-1)!.seq); } finally { client.close(); }
  return [...rows];
}
test("diag", () => {
  const replies = turnReplies(logged);
  console.log("REPLIES", replies.map((r) => `${r.startSeq} ${r.segment} ${r.text.length}`).join("\n"));
  const rows = replay(logged);
  console.log("RAW", rows.map((r) => `${r.kind}:${r.id}${r.inBackground ? " inBg=" + r.inBackground : ""}${r.background ? " bg=" + JSON.stringify(r.background) : ""}${r.kind === "assistant" ? " len=" + (r.text?.length ?? 0) : ""}`).join("\n"));
  for (const family of ["claude", "codex"]) {
    const drawn = turnView(rows, new Set(), { agentFamily: family });
    console.log("DRAWN", family, drawn.map((r) => `${r.kind}:${r.id}${r.kind === "assistant" ? " len=" + (r.text?.length ?? 0) + (r.foldedReply ? " folded" : "") : ""}`).join("\n"));
    console.log("MISSING", family, undrawnReplies(replies, drawn).map((r) => `${r.startSeq} ${r.segment}`).join(", "));
  }
  expect(true).toBe(true);
});
