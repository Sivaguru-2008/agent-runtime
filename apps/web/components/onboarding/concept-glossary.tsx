"use client";

/**
 * Concept Glossary — a command-style search over every registry concept.
 *
 * Open with ⌘K / Ctrl-K (toggle) or "?" (when not typing), or the launcher
 * button in the top bar. Type any term to filter; results are grouped by area.
 * Arrow keys move the selection, Enter opens the concept's full click-to-learn
 * panel (via the Explain context), Escape closes.
 *
 * The provider owns open/closed state and the global hotkeys so any surface can
 * trigger it; `ConceptGlossary` renders the palette and is mounted once at the
 * app root, beside the ExplainPanel it opens.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Search, CornerDownLeft } from "lucide-react";
import { searchConcepts } from "@/lib/explain/areas";
import { cn } from "@/lib/utils";
import { useExplainMode } from "@/components/explain/explain-mode";

interface GlossaryContextValue {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

const defaultValue: GlossaryContextValue = {
  isOpen: false,
  open: () => {},
  close: () => {},
  toggle: () => {},
};

const GlossaryContext = createContext<GlossaryContextValue>(defaultValue);

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function GlossaryProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((v) => !v), []);

  // Global hotkeys: ⌘K / Ctrl-K toggles; "?" opens (unless the user is typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === "k") {
        e.preventDefault();
        setIsOpen((v) => !v);
        return;
      }
      if (e.key === "?" && !isTypingTarget(e.target)) {
        e.preventDefault();
        setIsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const value = useMemo(() => ({ isOpen, open, close, toggle }), [isOpen, open, close, toggle]);
  return <GlossaryContext.Provider value={value}>{children}</GlossaryContext.Provider>;
}

export function useGlossary(): GlossaryContextValue {
  return useContext(GlossaryContext);
}

export function ConceptGlossary() {
  const { isOpen, close } = useGlossary();
  const { openConcept } = useExplainMode();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => searchConcepts(query), [query]);
  const flatIds = useMemo(() => groups.flatMap((g) => g.entries.map((e) => e.concept.id)), [groups]);

  // Reset the palette each time it opens; focus the input.
  useEffect(() => {
    if (!isOpen) return;
    setQuery("");
    setActiveIndex(0);
    // Focus after the element is mounted.
    const id = typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => inputRef.current?.focus()) : null;
    inputRef.current?.focus();
    return () => {
      if (id !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
    };
  }, [isOpen]);

  // Keep the active index in range as results change.
  useEffect(() => {
    setActiveIndex((i) => (flatIds.length === 0 ? 0 : Math.min(i, flatIds.length - 1)));
  }, [flatIds.length]);

  const openActive = useCallback(
    (id?: string) => {
      const targetId = id ?? flatIds[activeIndex];
      if (!targetId) return;
      openConcept(targetId);
      close();
    },
    [flatIds, activeIndex, openConcept, close]
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (flatIds.length === 0 ? 0 : (i + 1) % flatIds.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (flatIds.length === 0 ? 0 : (i - 1 + flatIds.length) % flatIds.length));
      } else if (e.key === "Enter") {
        e.preventDefault();
        openActive();
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    },
    [flatIds.length, openActive, close]
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[250] flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Concept glossary search">
      <button type="button" aria-label="Close glossary" onClick={close} className="absolute inset-0 bg-black/60 backdrop-blur-[1px]" />
      <div className="relative w-full max-w-xl overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950 shadow-2xl">
        {/* Search box */}
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4">
          <Search className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded
            aria-controls="glossary-listbox"
            aria-autocomplete="list"
            aria-label="Search concepts"
            placeholder="Search concepts — try “lease”, “determinism”, “memory drift”…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDown}
            className="w-full bg-transparent py-3.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
          />
          <kbd className="hidden shrink-0 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 sm:inline">
            Esc
          </kbd>
        </div>

        {/* Results */}
        <div id="glossary-listbox" role="listbox" aria-label="Concepts" ref={listRef} className="max-h-[55vh] overflow-y-auto py-2">
          {flatIds.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-zinc-500">
              No concepts match “{query}”. Try a shorter term.
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.area} className="mb-1">
                <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{group.area}</div>
                {group.entries.map((entry) => {
                  const idx = flatIds.indexOf(entry.concept.id);
                  const active = idx === activeIndex;
                  return (
                    <button
                      key={entry.concept.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onMouseMove={() => setActiveIndex(idx)}
                      onClick={() => openActive(entry.concept.id)}
                      className={cn(
                        "flex w-full items-start gap-3 px-4 py-2 text-left transition-colors",
                        active ? "bg-sky-500/15" : "hover:bg-zinc-900"
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className={cn("text-sm font-medium", active ? "text-sky-200" : "text-zinc-200")}>{entry.concept.label}</div>
                        <div className="truncate text-xs text-zinc-500">{entry.concept.short}</div>
                      </div>
                      {active ? (
                        <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-[10px] text-sky-300">
                          <CornerDownLeft className="h-3 w-3" /> open
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-2 text-[11px] text-zinc-600">
          <span>
            {flatIds.length} concept{flatIds.length === 1 ? "" : "s"}
          </span>
          <span className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[10px]">↑</kbd>
              <kbd className="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[10px]">↓</kbd>
              navigate
            </span>
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[10px]">↵</kbd>
              open
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
