// The composer's draft, kept outside React so a keystroke never waits for a render (Leo,
// 2026-11-17: "we're not waiting for ui to render. we're just gonna have the text be drawn fast").
//
// ProseMirror already paints the character into its own DOM on the key. Everything else in the
// composer only *reads* the draft: whether there is anything to send, which picker a `/`, `@` or
// `:` opens, what the host is told. Those used to be React state (`text`, `caret`), so each key
// re-rendered the composer, its box and its queue before the frame; now the key writes this store
// and each reader subscribes with a selector, so a render happens only when the value that reader
// takes really changes. Typing letters into a draft changes none of them, so it costs no render.
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

/// The prompt as the editor holds it, and the caret's offset in its first paragraph.
export type ComposerDraft = {
  readonly text: string;
  readonly caret: number;
};

export type ComposerDraftStore = {
  /// The draft now. Stable by reference until the next write, so a selector can cache on it.
  get(): ComposerDraft;
  /// Records what the editor holds. The editor is written first; this only tells the readers.
  write(text: string, caret: number): void;
  /// The caret moved with no edit (an arrow key, a click).
  writeCaret(caret: number): void;
  subscribe(listener: () => void): () => void;
};

export function createComposerDraftStore(text: string): ComposerDraftStore {
  let draft: ComposerDraft = { text, caret: text.length };
  const listeners = new Set<() => void>();
  const tell = () => {
    // A listener that unsubscribes while this runs must not drop the one after it.
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => draft,
    write: (next, caret) => {
      if (draft.text === next && draft.caret === caret) return;
      draft = { text: next, caret };
      tell();
    },
    writeCaret: (caret) => {
      if (draft.caret === caret) return;
      draft = { text: draft.text, caret };
      tell();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/// One store per mounted composer, made on its first render from `initial`.
export function useComposerDraftStore(initial: () => string): ComposerDraftStore {
  const store = useRef<ComposerDraftStore | undefined>(undefined);
  store.current ??= createComposerDraftStore(initial());
  return store.current;
}

/// Shallow equality for a picker's trigger, a flat object or undefined: a selector that recomputes
/// the same trigger from a longer draft must read as unchanged, or every key would render.
export function sameTrigger<T extends object>(a: T | undefined, b: T | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a) as (keyof T)[];
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.is(a[key], b[key]));
}

/// What `select` reads from the draft, re-read on every write and handed to React only when it
/// changed (`isEqual`, else `Object.is`). A key that does not change the value a reader takes
/// renders nothing.
export function useDraftValue<T>(
  store: ComposerDraftStore,
  select: (draft: ComposerDraft) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  // A selector closes over the composer's other state, so it is a new function on every render and
  // must be re-run on every read: never cached against the draft alone. What is kept across reads,
  // and across renders, is the *identity* of the last value handed out, so an equal value comes
  // back as the same object: that is what makes a write render nothing, and what keeps a trigger a
  // `useMemo` downstream can rely on. (The rule use-sync-external-store's `with-selector` applies;
  // React 19 does not ship it and the package is not a dependency.)
  const latest = useRef({ select, isEqual });
  latest.current = { select, isEqual };
  const held = useRef<{ value: T } | undefined>(undefined);
  const read = useCallback(() => {
    const next = latest.current.select(store.get());
    const previous = held.current;
    const same =
      previous && (latest.current.isEqual ? latest.current.isEqual(previous.value, next) : Object.is(previous.value, next));
    const value = same ? previous.value : next;
    held.current = { value };
    return value;
  }, [store]);
  return useSyncExternalStore(store.subscribe, read, read);
}

/// Runs `run` with the draft on every change of its *text*, and once whenever one of `deps`
/// changes: exactly what an effect with `[...deps, text]` did, without the render each key used to
/// take. The caret moving is no change here, as it was none to a `text` dependency.
///
/// It runs in a microtask, not inside the write, for the same reason an effect ran after the commit
/// and not inside the handler: the caller writes the draft first and records what the write means
/// afterwards (`noteDraftEdited`, `noteDraftSent`, `editedBeforeHydration`), and this body reads
/// that. Running inside the write would read the state of the key before. Several writes in one
/// task coalesce to one run with the last text, as the old effect's batched renders did.
export function useDraftWrites(store: ComposerDraftStore, run: (draft: ComposerDraft) => void, deps: unknown[]): void {
  const latest = useRef(run);
  latest.current = run;
  // `run` is read through the ref, so only `deps` (what the old effect listed besides the draft)
  // re-arm it.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller's deps stand for `run`'s.
  useEffect(() => {
    let last = store.get().text;
    let queued = false;
    let live = true;
    const flush = () => {
      queued = false;
      if (!live) return;
      const draft = store.get();
      if (draft.text === last) return;
      last = draft.text;
      latest.current(draft);
    };
    latest.current(store.get());
    const off = store.subscribe(() => {
      if (queued || store.get().text === last) return;
      queued = true;
      queueMicrotask(flush);
    });
    return () => {
      off();
      // A write this composer made and is leaving on (a send's clear, then a switch) is still saved.
      if (queued) flush();
      live = false;
    };
  }, [store, ...deps]);
}
