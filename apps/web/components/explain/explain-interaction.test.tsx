// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExplainModeProvider } from "./explain-mode";
import { ExplainModeToggle } from "./explain-mode-toggle";
import { ExplainLabel } from "./explain-label";
import { ExplainPanel } from "./explain-panel";

/**
 * Real interaction tests (jsdom + Testing Library) for the Explain Mode shell:
 *  - the global toggle flips state, persists it, and changes the visible
 *    affordance on labels;
 *  - clicking a label opens the click-to-learn side panel;
 *  - Escape (and the close button) dismiss it.
 */

// Radix Popper (used by the tooltip when open) needs ResizeObserver. Tooltips
// stay closed in these tests, but stub it defensively so nothing throws.
beforeEach(() => {
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.localStorage.clear();
});

afterEach(() => cleanup());

function Harness() {
  return (
    <ExplainModeProvider>
      <ExplainModeToggle />
      <ExplainLabel concept="memory-drift">Memory Drift</ExplainLabel>
      <ExplainPanel />
    </ExplainModeProvider>
  );
}

describe("Explain Everything toggle", () => {
  it("defaults ON for a first-time visitor without persisting, then respects explicit toggles", () => {
    render(<Harness />);

    const toggle = screen.getByRole("switch", { name: /Explain Everything/i });
    const label = screen.getByRole("button", { name: "Explain: Memory Drift" });

    // First run (empty localStorage): ON, and the ambient affordance is shown,
    // but nothing is persisted yet — it's a default, not an explicit choice.
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(label.className).toContain("decoration-sky-400/60");
    expect(window.localStorage.getItem("runloop.explainMode")).toBeNull();

    // Turn it off — now it IS an explicit choice, persisted as "0".
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(window.localStorage.getItem("runloop.explainMode")).toBe("0");
    expect(label.className).not.toContain("decoration-sky-400/60");

    // Turn it back on — preference persists as "1".
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(window.localStorage.getItem("runloop.explainMode")).toBe("1");
  });

  it("never overrides an explicit OFF choice on mount", () => {
    window.localStorage.setItem("runloop.explainMode", "0");
    render(<Harness />);
    const toggle = screen.getByRole("switch", { name: /Explain Everything/i });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("restores a persisted ON preference on mount", () => {
    window.localStorage.setItem("runloop.explainMode", "1");
    render(<Harness />);
    const toggle = screen.getByRole("switch", { name: /Explain Everything/i });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
});

describe("Click-to-learn side panel", () => {
  it("opens when a label is clicked and shows the full concept", () => {
    render(<Harness />);

    // No dialog before interaction.
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Explain: Memory Drift" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    // Layer-3 sections are present, driven by the registry.
    expect(dialog.textContent).toContain("Memory Drift");
    expect(dialog.textContent).toContain("What this is");
    expect(dialog.textContent).toContain("How it's calculated");
    expect(dialog.textContent).toContain("Healthy");
  });

  it("closes on Escape", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Explain: Memory Drift" }));
    expect(screen.queryByRole("dialog")).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes via the close button", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Explain: Memory Drift" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
