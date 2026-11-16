import { test } from "bun:test";
import type { AcpmuxRow } from "../model";
import { keptPrefix, noteKeptPrefix, prefixWalks } from "../conversation/prefixFlatMap";
import { type StartedCache, withStartedSessions } from "./startedSessions";
test("count", () => {
  const rows: AcpmuxRow[] = [];
  for (let i = 0; i < 20_000; i++)
    rows.push({ id: `r${i}`, version: 1, at: i, kind: i % 50 === 0 ? "user" : i % 50 === 49 && i < 19_999 ? "turnSummary" : "assistant" });
  const children = [{ sessionId: "a", title: "A", state: "idle" as const, createdAt: 155 }, { sessionId: "b", title: "B", state: "idle" as const, createdAt: 9955 }];
  const cache: StartedCache = new Map();
  let reads = 0;
  const wrap = (r: AcpmuxRow[]) => new Proxy(r, { get(t, k, rc) { if (typeof k === "string" && /^\d+$/.test(k)) reads++; return Reflect.get(t, k, rc); } });
  const first = wrap(rows);
  const before = withStartedSessions(first, children, cache);
  const raw = [...rows.slice(0, -1), { ...rows.at(-1)!, version: 2 }];
  const next = wrap(raw);
  noteKeptPrefix(next, first, rows.length - 1);
  reads = 0;
  const t0 = performance.now();
  const after = withStartedSessions(next, children, cache);
  const ms = performance.now() - t0;
  const pass = reads;
  const w = prefixWalks.rows;
  keptPrefix(before, after);
  console.log(`COUNT rows-read-by-pass=${pass} rows-walked-by-next-pass=${prefixWalks.rows - w} pass-ms=${ms.toFixed(3)}`);
});
