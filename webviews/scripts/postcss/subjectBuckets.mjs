// SUBJECT-BUCKETS: a selector whose subject is a list (`:is(.a, .b)`, `:where(.a, .b)`) is listed once
// per alternative at build time, so the engine can file it under each alternative's class, id, tag or
// attribute. Chromium and WebKit file a rule by its subject's own class, id, tag or attribute; a
// subject that is an `:is()` or `:where()` of several has none of its own, so the rule went in the
// list every element styled is matched against. A page of older history mounts thousands of row
// elements in a frame, and each of them was matched against all such rules: about 700 in the agent
// pane (transcript-scroll-up.bench.ts TRACE=3, `EVERY-ELEMENT`). An ancestor list
// (`:where(button, [role="button"]) *`) is split the same way, so each copy can be skipped by the
// engine's ancestor filter instead of testing every alternative on every ancestor.
//
// The split keeps what each element matches and with what specificity:
// - `X:is(A, B) Y` matches what `X A Y` and `X B Y` together match. `:is()` takes its most specific
//   alternative's specificity, so it is split only when every alternative scores the same; then each
//   copy scores what the original did. Each copy writes the alternative in place of the `:is()`.
// - `:where()` scores nothing, so each copy keeps a one-alternative `:where(A)`.
// - The copies stay in the same rule, so the cascade order is the same.
// Only lists of simple alternatives are split (a tag, `.class`, `#id`, `[attr...]`, and plain
// pseudo-classes such as `:hover`): `:is()` forgives an alternative the engine cannot read, a
// selector list does not, so an alternative with anything else keeps the list as it is.

/// Splits `text` at `separator` characters outside parentheses, brackets and quotes.
function splitTop(text, isSeparator) {
  const parts = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "\\") i += 1;
    else if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (depth === 0 && isSeparator(c, i)) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/// A complex selector as compounds and the combinators between them (`>`, `+`, `~`, or " ").
function compounds(selector) {
  const text = selector.trim();
  const tokens = [];
  let combinator = "";
  // splitTop drops each separator, one character each: the text after a piece is its separator.
  let at = 0;
  for (const piece of splitTop(text, (c) => /\s|>|\+|~/.test(c))) {
    at += piece.length;
    const separator = text[at] ?? "";
    at += 1;
    if (piece) {
      if (tokens.length) tokens.push({ combinator: combinator || " " });
      tokens.push({ compound: piece });
      combinator = "";
    }
    if (separator === ">" || separator === "+" || separator === "~") combinator = separator;
  }
  return tokens;
}

function join(tokens) {
  return tokens
    .map((token) => ("compound" in token ? token.compound : token.combinator === " " ? " " : ` ${token.combinator} `))
    .join("");
}

/// A simple alternative: an optional tag, then classes, ids, attribute tests and plain pseudo-classes.
const SIMPLE =
  /^(?:[a-zA-Z][\w-]*|\*)?(?:\.[\w-]+|#[\w-]+|\[[\w-]+(?:[~|^$*]?=(?:"[^"]*"|'[^']*'|[\w-]+)(?:\s+[is])?)?\]|:[\w-]+(?!\())*$/;
/// What the engines file a rule under: a tag, a class, an id or an attribute.
const BUCKETED = /^[a-zA-Z]|[.#[]/;

/// [ids, classes and the like, tags] of a simple alternative.
function specificity(simple) {
  const withoutAttrs = simple.replace(/\[[^\]]*\]/g, () => " ");
  const attrs = (simple.match(/\[[^\]]*\]/g) ?? []).length;
  const ids = (withoutAttrs.match(/#[\w-]+/g) ?? []).length;
  const classes = (withoutAttrs.match(/\.[\w-]+/g) ?? []).length + (withoutAttrs.match(/:[\w-]+/g) ?? []).length;
  const tags = /^[a-zA-Z]/.test(simple) ? 1 : 0;
  return `${ids},${classes + attrs},${tags}`;
}

/// The compound's one top-level `:is(...)` or `:where(...)` list: its name, where it starts and ends,
/// and its alternatives; undefined when there is none, or more than one.
function listIn(compound) {
  let found;
  let depth = 0;
  let quote = "";
  for (let i = 0; i < compound.length; i += 1) {
    const c = compound[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[") depth += 1;
    else if (c === "]") depth -= 1;
    else if (c === "(") {
      if (depth === 0) {
        const name = /:([\w-]+)$/.exec(compound.slice(0, i))?.[1];
        if (name === "is" || name === "where") {
          if (found) return undefined;
          found = { name, start: i - name.length - 1, open: i };
        }
      }
      depth += 1;
    } else if (c === ")") {
      depth -= 1;
      if (depth === 0 && found && found.close === undefined) found.close = i;
    }
  }
  if (!found || found.close === undefined) return undefined;
  const alternatives = splitTop(compound.slice(found.open + 1, found.close), (c) => c === ",").map((each) =>
    each.trim(),
  );
  return { ...found, alternatives };
}

/// The compound with its list replaced by `alternative` (`:is`) or `:where(alternative)`.
function withAlternative(compound, list, alternative) {
  const rest = compound.slice(0, list.start) + compound.slice(list.close + 1);
  if (list.name === "where")
    return compound.slice(0, list.start) + `:where(${alternative})` + compound.slice(list.close + 1);
  // A tag goes first in a compound; the rest (classes, pseudo-classes, a pseudo-element last) after it.
  return alternative + rest;
}

/// Whether a list in this compound can be split: two or more simple alternatives, each filed under
/// something of its own; an `:is()` only when they all score the same.
function splittable(compound, list) {
  if (!list || list.alternatives.length < 2) return false;
  // `:where()` scores nothing whatever it holds, so an alternative may also be a chain of simple
  // compounds (`.selectable *`): its copy keeps the chain inside a `:where()` of its own.
  const fits = (each) =>
    list.name === "where"
      ? compounds(each).every(
          (token) => !("compound" in token) || token.compound === "*" || SIMPLE.test(token.compound),
        )
      : SIMPLE.test(each);
  if (!list.alternatives.every((each) => fits(each) && BUCKETED.test(each))) return false;
  // A tag outside the list would sit after the alternative's own tag.
  if (list.name === "is" && /^[a-zA-Z*]/.test(compound)) return false;
  if (list.name === "is" && new Set(list.alternatives.map(specificity)).size !== 1) return false;
  return true;
}

/// One complex selector as the selectors it is split into (itself when it is not split). The subject's
/// list is split first; with none there, the first ancestor compound that is a list and nothing else.
export function splitSubjectList(selector) {
  if (selector.includes("&") || selector.includes("\\")) return [selector];
  const tokens = compounds(selector);
  const indices = tokens.flatMap((token, index) => ("compound" in token ? [index] : []));
  if (!indices.length) return [selector];
  const subject = indices.at(-1);
  const subjectCompound = tokens[subject].compound;
  // A subject filed under its own class, id, tag or attribute is not in every element's list.
  const outside = subjectCompound.replace(/:(is|where|not|has)\(.*\)/g, "");
  const subjectList = BUCKETED.test(outside) ? undefined : listIn(subjectCompound);
  let at;
  let list;
  if (
    subjectList &&
    !/::/.test(subjectCompound.slice(0, subjectList.start)) &&
    splittable(subjectCompound, subjectList)
  ) {
    at = subject;
    list = subjectList;
  } else {
    for (const index of indices.slice(0, -1)) {
      const compound = tokens[index].compound;
      const candidate = listIn(compound);
      if (
        candidate &&
        candidate.start === 0 &&
        candidate.close === compound.length - 1 &&
        splittable(compound, candidate)
      ) {
        at = index;
        list = candidate;
        break;
      }
    }
  }
  if (at === undefined || !list) return [selector];
  // Each copy holds one list fewer; one with another list left is split again.
  return list.alternatives.flatMap((alternative) => {
    const copy = tokens.map((token) => ({ ...token }));
    copy[at] = { compound: withAlternative(tokens[at].compound, list, alternative) };
    return splitSubjectList(join(copy));
  });
}

/// A rule's selector list with each selector split (splitSubjectList).
export function splitSubjectLists(selectorList) {
  const selectors = splitTop(selectorList, (c) => c === ",").map((each) => each.trim());
  const out = selectors.flatMap(splitSubjectList);
  return out.length === selectors.length && out.every((each, index) => each === selectors[index])
    ? selectorList
    : out.join(",\n");
}

export default function subjectBuckets() {
  return {
    postcssPlugin: "cmux-subject-buckets",
    Rule(rule) {
      // Keyframe stops (`from`, `50%`) are rules too; they hold no selector to split.
      if (rule.parent?.type === "atrule" && /keyframes$/i.test(rule.parent.name)) return;
      const split = splitSubjectLists(rule.selector);
      if (split !== rule.selector) rule.selector = split;
    },
  };
}
subjectBuckets.postcss = true;
