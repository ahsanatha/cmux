// SUBJECT-BUCKETS (scripts/postcss/subjectBuckets.mjs): every webviews build lists a selector whose subject
// is an `:is()`/`:where()` of several once per alternative, so Chromium and WebKit file it under each
// alternative's class, tag or attribute instead of matching it against every element styled. Leo,
// 2026-11-16: "how about speeding up the scrolling up of chats?", "as in i scroll up and it loads the
// stuff". Each older page mounts thousands of row elements; before this, each was matched against about
// 700 such rules (transcript-scroll-up.bench.ts TRACE=3).
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import config from "../postcss.config.mjs";
import { splitSubjectList, splitSubjectLists } from "../scripts/postcss/subjectBuckets.mjs";

const src = path.resolve(import.meta.dir, "../src");

function cssFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : cssFiles(full);
    return entry.name.endsWith(".css") ? [full] : [];
  });
}

test("a subject list is split per alternative, at the same specificity", () => {
  expect(splitSubjectList(":is(.a, .b, .c)")).toEqual([".a", ".b", ".c"]);
  expect(splitSubjectList(".row :is(.a, .b)")).toEqual([".row .a", ".row .b"]);
  expect(splitSubjectList(":root[data-x] > :is(.a, .b):hover::before")).toEqual([
    ":root[data-x] > .a:hover::before",
    ":root[data-x] > .b:hover::before",
  ]);
  // A tag goes first in the compound it lands in.
  expect(splitSubjectList(":hover:is(button, summary)")).toEqual(["button:hover", "summary:hover"]);
  // `:where()` scores nothing, so each copy keeps one.
  // A `:where()` alternative may be a chain of simple compounds.
  expect(splitSubjectList(":where(.selectable, .selectable *)")).toEqual([
    ":where(.selectable)",
    ":where(.selectable *)",
  ]);
  expect(splitSubjectList(':where(.a, [role="tab"])')).toEqual([":where(.a)", ':where([role="tab"])']);
  // An ancestor that is a list and nothing else is split for the ancestor filter.
  expect(splitSubjectList(':where(button, a[href], [role="button"]) *')).toEqual([
    ":where(button) *",
    ":where(a[href]) *",
    ':where([role="button"]) *',
  ]);
});

test("a list it cannot split exactly stays", () => {
  // Alternatives that score differently: the list takes the highest, a copy would not.
  expect(splitSubjectList(":is(.a, #b)")).toEqual([":is(.a, #b)"]);
  expect(splitSubjectList(":is(button, .b)")).toEqual([":is(button, .b)"]);
  // Not simple: a combinator, a function, nesting.
  expect(splitSubjectList(":is(.a .b, .c)")).toEqual([":is(.a .b, .c)"]);
  expect(splitSubjectList(":is(.a:not(.x), .c)")).toEqual([":is(.a:not(.x), .c)"]);
  expect(splitSubjectList("& :is(.a, .b)")).toEqual(["& :is(.a, .b)"]);
  // A subject already filed under its own class.
  expect(splitSubjectList(".row:is(.a, .b)")).toEqual([".row:is(.a, .b)"]);
  // Two lists in the subject.
  expect(splitSubjectList(":is(.a, .b):is(:hover, .c)")).toEqual([":is(.a, .b):is(:hover, .c)"]);
  expect(splitSubjectLists(".a, .b")).toBe(".a, .b");
});

/// Selectors whose subject is still a splittable list, after the build's own PostCSS plugins.
async function unfiled(): Promise<string[]> {
  const processor = postcss(config.plugins);
  const left: string[] = [];
  for (const file of cssFiles(src)) {
    const out = await processor.process(fs.readFileSync(file, "utf8"), { from: file });
    out.root.walkRules((rule) => {
      for (const selector of rule.selectors) {
        if (splitSubjectList(selector).length > 1) left.push(`${path.relative(src, file)} ${selector}`);
      }
    });
  }
  return left;
}

test("every webviews sheet, as the build emits it, has no subject list left to split", async () => {
  const left = await unfiled();
  console.log(`subject-buckets: ${left.length} subject lists left in the built sheets`);
  expect(left).toEqual([]);
});
