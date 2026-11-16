// l10n-allow-file: benchmark output, not shipped UI.
// Scratch diagnostic (ICON_CENSUS=1 with TRACE=3): the rules the drawn rows' icon svg and path elements
// match, and whether each row icon drawn as one masked element is pixel-identical to its inline svg.
import type { Page } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

export async function reportIconCensus(page: Page) {
  const out = (line: string) => console.log(`ICON-CENSUS ${line}`);
  const rules = await page.evaluate(() => {
    const selectors: string[] = [];
    const walk = (list: CSSRuleList) => {
      for (const rule of Array.from(list)) {
        if (rule instanceof CSSStyleRule) {
          for (const one of rule.selectorText.split(/,(?![^()]*\))/)) selectors.push(one.trim());
          if (rule.cssRules?.length) walk(rule.cssRules);
        } else if ("cssRules" in rule && (rule as CSSGroupingRule).cssRules) walk((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        walk(sheet.cssRules);
      } catch {}
    }
    const usable = selectors
      .map((s) => s.replace(/::[\w-]+(\([^)]*\))?/g, "").replace(/:(hover|focus|focus-visible|focus-within|active)/g, ""))
      .filter((s) => {
        try {
          document.createElement("div").matches(s || "*");
          return !!s;
        } catch {
          return false;
        }
      });
    const hits = new Map<string, number>();
    const icons = new Map<string, number>();
    for (const el of Array.from(document.querySelectorAll(".acpmux-row svg, .acpmux-row svg *"))) {
      if (el.tagName.toLowerCase() === "svg") {
        const key = `${el.getAttribute("data-icon")} in ${el.parentElement?.className}`;
        icons.set(key, (icons.get(key) ?? 0) + 1);
      }
      for (const s of new Set(usable)) if (el.matches(s)) hits.set(`${el.tagName.toLowerCase()} ${s}`, (hits.get(`${el.tagName.toLowerCase()} ${s}`) ?? 0) + 1);
    }
    return { hits: [...hits.entries()].sort((a, b) => b[1] - a[1]), icons: [...icons.entries()] };
  });
  for (const [s, n] of rules.icons) out(`ICON ${n} ${s}`);
  for (const [s, n] of rules.hits) out(`RULE ${n} ${s.slice(0, 200)}`);

  // Pixels: each distinct row icon, its button shown, before and after its svg becomes one masked span.
  await page.addStyleTag({
    content:
      ".cv-turn-actions, .cv-user__actions, .cv-reply-actions, .cv-turn-time { opacity: 1 !important; transition: none !important; }",
  });
  const count = await page.evaluate(() => {
    const seen = new Set<string>();
    let n = 0;
    for (const svg of Array.from(document.querySelectorAll<SVGSVGElement>(".acpmux-row svg[data-icon]"))) {
      const button = svg.closest("button");
      const key = `${svg.getAttribute("data-icon")}|${button?.className}`;
      if (!button || seen.has(key)) continue;
      seen.add(key);
      button.setAttribute("data-icon-probe", String(n));
      n += 1;
    }
    return n;
  });
  let same = 0;
  for (let i = 0; i < count; i += 1) {
    const button = page.locator(`[data-icon-probe="${i}"]`);
    await button.scrollIntoViewIfNeeded();
    const before = PNG.sync.read(await button.screenshot({ animations: "disabled" }));
    const info = await page.evaluate((index) => {
      const button = document.querySelector(`[data-icon-probe="${index}"]`)!;
      const svg = button.querySelector<SVGSVGElement>("svg[data-icon]")!;
      const cs = getComputedStyle(svg);
      const copy = svg.cloneNode(true) as SVGSVGElement;
      copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      copy.removeAttribute("width");
      copy.removeAttribute("height");
      copy.removeAttribute("class");
      copy.removeAttribute("style");
      const accent = copy.outerHTML.includes("var(");
      const markup = copy.outerHTML.replaceAll("currentColor", "black");
      const span = document.createElement("span");
      span.setAttribute("aria-hidden", "true");
      const url = `url("data:image/svg+xml,${encodeURIComponent(markup)}")`;
      span.style.cssText = `display:${cs.display === "inline" ? "inline-block" : cs.display};width:${cs.width};height:${cs.height};flex-shrink:${cs.flexShrink};vertical-align:${cs.verticalAlign};margin:${cs.margin};background-color:currentColor;-webkit-mask:${url} center / 100% 100% no-repeat;mask:${url} center / 100% 100% no-repeat;`;
      svg.replaceWith(span);
      return { icon: svg.getAttribute("data-icon"), accent, w: cs.width, display: cs.display, cls: (button as HTMLElement).className };
    }, i);
    await page.waitForTimeout(150);
    const after = PNG.sync.read(await button.screenshot({ animations: "disabled" }));
    let diff = -1;
    let max = 0;
    if (before.width === after.width && before.height === after.height) {
      diff = pixelmatch(before.data, after.data, undefined, before.width, before.height, { threshold: 0 });
      for (let p = 0; p < before.data.length; p += 1) max = Math.max(max, Math.abs(before.data[p]! - after.data[p]!));
    }
    if (diff === 0) same += 1;
    out(`PIXELS ${JSON.stringify({ ...info, size: `${before.width}x${before.height}`, diffPixels: diff, maxChannelDelta: max })}`);
  }
  out(`PIXELS-SUMMARY ${JSON.stringify({ icons: count, identical: same })}`);
}
