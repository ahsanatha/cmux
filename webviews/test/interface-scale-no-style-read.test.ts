// The transcript reads the Interface Size in every layout pass (transcriptGrid.ts `gridScale`, from model.ts
// `transcriptColumn` during render). Read through getComputedStyle on <html>, each pass forced a style
// recalculation in the middle of React's render: 5.6 ms of a released chat's 68 ms switch at 10 turns and
// 10.3 ms at 100 (first-load-after-restart.bench.ts MODE=reopen-spare PROFILE=1, Linux fleet run 43884994030).
// The App writes the scale inline on <html> (DesignSettings.interfaceScaleScript), and the stylesheet's own
// value is 1 (desktop.css `:root`), so the page's scale is read from the inline style, with no style read.
// Leo, 2026-11-16: "the dream is infinite chats of infinite length with flat or no growth in cpu/memory/even disk".
import { afterEach, beforeEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { gridScale } from "../src/agent-session/acpmux/transcriptGrid";
import { interfaceScale } from "../src/ui/interfaceScale";

const scope = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};
let dom: JSDOM;
let styleReads = 0;
/// The page's window as the DOM Window type the code reads (jsdom's own type lacks the globals).
const view = () => dom.window as unknown as Window;

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  styleReads = 0;
  const computed = dom.window.getComputedStyle.bind(dom.window);
  dom.window.getComputedStyle = ((element: Element) => {
    styleReads += 1;
    return computed(element);
  }) as typeof dom.window.getComputedStyle;
  for (const key of ["window", "document", "getComputedStyle"]) saved[key] = scope[key];
  scope.window = dom.window;
  scope.document = dom.window.document;
  scope.getComputedStyle = dom.window.getComputedStyle;
});

afterEach(() => {
  for (const key of ["window", "document", "getComputedStyle"]) scope[key] = saved[key];
});

test("the transcript's grid scale is the page's inline Interface Size, read with no style read", () => {
  dom.window.document.documentElement.style.setProperty("--cmux-interface-scale", "1.25");
  expect(gridScale()).toBe(1.25);
  expect(interfaceScale(view())).toBe(1.25);
  expect(styleReads).toBe(0);
});

test("a page whose App wrote no scale is at 1, the stylesheet's value, with no style read", () => {
  expect(gridScale()).toBe(1);
  expect(interfaceScale(view())).toBe(1);
  expect(styleReads).toBe(0);
});

test("an unreadable scale is 1", () => {
  dom.window.document.documentElement.style.setProperty("--cmux-interface-scale", "nope");
  expect(gridScale()).toBe(1);
  expect(interfaceScale(view())).toBe(1);
});

test("an element other than <html> still reads its computed scale", () => {
  const host = dom.window.document.createElement("div");
  host.style.setProperty("--cmux-interface-scale", "1.5");
  dom.window.document.body.append(host);
  expect(interfaceScale(view(), host)).toBe(1.5);
});
