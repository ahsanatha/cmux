// Probe: what scripts does a bench page fetch, and which React markers do they carry?
import { chromium } from "playwright";
import { gotoBenchPage, serveBenchPage } from "./bench/support/benchPage";

const served = await serveBenchPage("/", { config: "vite.config.acpmux-pane.mjs", query: "?mock" });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
await gotoBenchPage(page, served);
await page.waitForFunction(() => "__debug" in window).catch(() => {});
const found = await page.evaluate(async () => {
  const here = location.origin;
  const urls = performance
    .getEntriesByType("resource")
    .map((e) => e.name)
    .filter((n) => n.startsWith(here));
  const rows: string[] = [];
  for (const url of urls) {
    let info = "unread";
    try {
      const r = await fetch(url);
      const t = r.ok ? await r.text() : "";
      info = `${r.status} len=${t.length} dev=${t.includes("addObjectDiffToProperties")} prod=${t.includes("Minified React error")} prof=${t.includes("isProfiling")} reactdom=${t.includes("__reactContainer$")}`;
    } catch (e) {
      info = `threw ${String(e)}`;
    }
    rows.push(`${url.slice(here.length)} :: ${info}`);
  }
  return rows;
});
console.log(found.join("\n"));
await browser.close();
await served.close();
