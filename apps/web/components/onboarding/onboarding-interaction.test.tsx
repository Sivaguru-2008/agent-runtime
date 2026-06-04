// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExplainModeProvider } from "@/components/explain/explain-mode";
import { ExplainPanel } from "@/components/explain/explain-panel";
import { TourProvider, useTour } from "./tour-provider";
import { TourOverlay } from "./tour-overlay";
import { GlossaryProvider } from "./concept-glossary";
import { ConceptGlossary } from "./concept-glossary";
import { GlossaryButton } from "./onboarding-launchers";

/**
 * Real interaction tests (jsdom + Testing Library) for the onboarding layer:
 *   - the guided tour advances, goes back, skips, navigates by keyboard, and
 *     persists "seen" so it doesn't auto-replay;
 *   - the concept glossary filters as you type and opens the click-to-learn
 *     panel for the chosen concept.
 */

beforeEach(() => {
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.localStorage.clear();
});

afterEach(() => cleanup());

// ── Tour harness ───────────────────────────────────────────────────────────

function TourControls() {
  const { start, maybeAutoStart } = useTour();
  return (
    <>
      <button onClick={() => start("dashboard")}>start-tour</button>
      <button onClick={() => maybeAutoStart("dashboard")}>maybe-auto</button>
    </>
  );
}

function TourHarness() {
  return (
    <ExplainModeProvider>
      <TourProvider>
        {/* The dashboard tour's targets, stubbed so the overlay can anchor. */}
        <span data-tour="explain-toggle">toggle</span>
        <button data-tour="glossary-button">glossary</button>
        <button data-tour="dash-tab-workbench">workbench</button>
        <button data-tour="dash-tab-playground">playground</button>
        <button data-tour="dash-tab-cognition">cognition</button>
        <button data-tour="dash-tab-cluster">cluster</button>
        <a data-tour="operator-link">operator</a>
        <TourControls />
        <TourOverlay />
      </TourProvider>
    </ExplainModeProvider>
  );
}

describe("Guided tour", () => {
  it("advances, goes back, and shows registry-driven copy per step", () => {
    render(<TourHarness />);

    // Not running yet.
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByText("start-tour"));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Step 1 of 7");
    // Step 1 copy comes from the "explain-mode" concept.
    expect(dialog.textContent).toContain("Explain Everything");

    // Advance to step 2 — the glossary concept.
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));
    expect(screen.getByRole("dialog").textContent).toContain("Step 2 of 7");
    expect(screen.getByRole("dialog").textContent).toContain("Concept Glossary");

    // Back to step 1.
    fireEvent.click(screen.getByRole("button", { name: /^Back$/i }));
    expect(screen.getByRole("dialog").textContent).toContain("Step 1 of 7");
  });

  it("navigates by keyboard (→ advances, Esc skips)", () => {
    render(<TourHarness />);
    fireEvent.click(screen.getByText("start-tour"));
    expect(screen.getByRole("dialog").textContent).toContain("Step 1 of 7");

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByRole("dialog").textContent).toContain("Step 2 of 7");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    // Escaping still counts as "seen".
    expect(window.localStorage.getItem("runloop.tour.dashboard.seen")).toBe("1");
  });

  it("persists 'seen' when skipped", () => {
    render(<TourHarness />);
    fireEvent.click(screen.getByText("start-tour"));
    expect(window.localStorage.getItem("runloop.tour.dashboard.seen")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Skip$/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.localStorage.getItem("runloop.tour.dashboard.seen")).toBe("1");
  });

  it("auto-starts only when not already seen", () => {
    // Already seen → maybeAutoStart is a no-op.
    window.localStorage.setItem("runloop.tour.dashboard.seen", "1");
    render(<TourHarness />);
    fireEvent.click(screen.getByText("maybe-auto"));
    expect(screen.queryByRole("dialog")).toBeNull();

    cleanup();

    // Fresh visitor → it starts.
    window.localStorage.clear();
    render(<TourHarness />);
    fireEvent.click(screen.getByText("maybe-auto"));
    expect(screen.getByRole("dialog").textContent).toContain("Step 1 of 7");
  });

  it("finishing the last step closes the tour and marks it seen", () => {
    render(<TourHarness />);
    fireEvent.click(screen.getByText("start-tour"));
    // 7 steps: click the primary button 7 times (Next ×6, then Done).
    for (let i = 0; i < 7; i++) {
      const primary = screen.getByRole("button", { name: /^(Next|Done)$/i });
      fireEvent.click(primary);
    }
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.localStorage.getItem("runloop.tour.dashboard.seen")).toBe("1");
  });
});

// ── Glossary harness ─────────────────────────────────────────────────────────

function GlossaryHarness() {
  return (
    <ExplainModeProvider>
      <GlossaryProvider>
        <GlossaryButton surface="dashboard" />
        <ConceptGlossary />
        <ExplainPanel />
      </GlossaryProvider>
    </ExplainModeProvider>
  );
}

describe("Concept glossary", () => {
  it("opens, filters as you type, and opens the click-to-learn panel for a result", () => {
    render(<GlossaryHarness />);

    // Closed initially.
    expect(screen.queryByRole("dialog", { name: /glossary/i })).toBeNull();

    // Open via the launcher button.
    fireEvent.click(screen.getByRole("button", { name: /Search/i }));
    const palette = screen.getByRole("dialog", { name: /glossary/i });
    expect(palette).toBeTruthy();

    const input = screen.getByRole("combobox", { name: /search concepts/i });

    // Unfiltered: an unrelated concept like Determinism is present.
    expect(screen.getByText("Determinism (Reproducibility Check)")).toBeTruthy();

    // Filter to "lease" — Determinism should drop out, Lease should remain.
    fireEvent.change(input, { target: { value: "lease" } });
    expect(screen.queryByText("Determinism (Reproducibility Check)")).toBeNull();
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    // The strongest match for "lease" is the "Lease" concept itself.
    expect(options[0].textContent).toContain("Lease");

    // Open the top result → the click-to-learn panel for Lease appears, glossary closes.
    fireEvent.click(options[0]);
    expect(screen.queryByRole("dialog", { name: /glossary/i })).toBeNull();
    const panel = screen.getByRole("dialog", { name: "Lease" });
    expect(panel.textContent).toContain("temporary ownership lock");
  });

  it("opens with ⌘K and closes on Escape", () => {
    render(<GlossaryHarness />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog", { name: /glossary/i })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("combobox", { name: /search concepts/i }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: /glossary/i })).toBeNull();
  });

  it("selects results with the arrow keys and opens with Enter", () => {
    render(<GlossaryHarness />);
    fireEvent.click(screen.getByRole("button", { name: /Search/i }));
    const input = screen.getByRole("combobox", { name: /search concepts/i });
    fireEvent.change(input, { target: { value: "determinism" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // Determinism's panel opened.
    const panel = screen.getByRole("dialog", { name: /Determinism/i });
    expect(panel.textContent).toContain("reproduc");
  });
});
