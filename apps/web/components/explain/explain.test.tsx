import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CONCEPTS, getConcept } from "@/lib/explain/registry";
import { translateStatus, hasTranslation } from "@/lib/explain/status";
import { narrateRun, narrationProgress } from "@/lib/explain/narration";
import { MicroExplanation } from "./explain-label";
import { StatusPill } from "./status-pill";
import { ExplainedEmptyState } from "./empty-state";
import { RunNarration } from "./run-narration";

/**
 * The explainability system is registry-driven. These tests prove (a) the
 * knowledge base is internally consistent, (b) the pure layers (status
 * translation, narration) behave, and (c) the registry content actually
 * reaches the DOM through the components — rendered with react-dom/server so no
 * jsdom is required and the SSR-safe defaults are exercised (no provider).
 */

describe("explain registry", () => {
  it("keys its concepts by their own id", () => {
    for (const [key, concept] of Object.entries(CONCEPTS)) {
      expect(concept.id).toBe(key);
    }
  });

  it("gives every concept the Layer-1 essentials", () => {
    for (const concept of Object.values(CONCEPTS)) {
      expect(concept.label.length).toBeGreaterThan(0);
      expect(concept.short.length).toBeGreaterThan(0);
      expect(concept.what.length).toBeGreaterThan(0);
      expect(concept.why.length).toBeGreaterThan(0);
      expect(concept.whyCare.length).toBeGreaterThan(0);
    }
  });

  it("covers the headline concepts the platform exposes", () => {
    for (const id of [
      "memory-drift",
      "coordination-pressure",
      "determinism",
      "dlq",
      "lease",
      "worker-health",
      "failure-clusters",
      "uncertainty-heatmap",
    ]) {
      expect(getConcept(id)).toBeDefined();
    }
  });

  it("interprets a metric value into a health band with a recommendation", () => {
    const drift = getConcept("memory-drift");
    const low = drift?.interpret?.(10);
    const high = drift?.interpret?.(80);
    expect(low?.level).toBe("healthy");
    expect(high?.level).toBe("critical");
    expect(high?.recommendation).toBeTruthy();
  });
});

describe("status translation (Layer 2)", () => {
  it("translates internal codes into human language", () => {
    expect(translateStatus("LOST").label).toBe("Connection Lost");
    expect(translateStatus("BUSY").label).toBe("Processing Tasks");
    expect(translateStatus("MEMORY_COMMIT").label).toBe("Saving Learned Information");
    expect(translateStatus("CRITIC").label).toBe("Quality Reviewer");
    expect(translateStatus("EXECUTOR").label).toBe("Task Performer");
  });

  it("is case-insensitive and carries a tone + meaning", () => {
    const t = translateStatus("ready");
    expect(t.label).toBe("Ready for Work");
    expect(t.tone).toBe("success");
    expect(t.meaning.length).toBeGreaterThan(0);
  });

  it("falls back gracefully for unknown codes without throwing", () => {
    const t = translateStatus("SOME_NEW_STATE");
    expect(t.label).toBe("Some New State");
    expect(t.tone).toBe("neutral");
    expect(hasTranslation("SOME_NEW_STATE")).toBe(false);
    expect(hasTranslation("LOST")).toBe(true);
  });
});

describe("narration (Layer 4)", () => {
  it("tells the run story from signals and marks the outcome", () => {
    const steps = narrateRun({
      signals: ["PLANNER", "EXECUTOR", "VERIFIER", "CRITIC", "MEMORY_COMMIT"],
      outcome: "completed",
    });
    const titles = steps.map((s) => s.title);
    expect(titles).toContain("Task Planned");
    expect(titles).toContain("Task Executed");
    expect(titles).toContain("Results Verified");
    expect(titles).toContain("Quality Reviewed");
    expect(titles).toContain("Memory Updated");
    expect(titles).toContain("Execution Completed");
  });

  it("marks the final beat as failed when the run failed", () => {
    const steps = narrateRun({ signals: ["PLANNER"], outcome: "failed" });
    const last = steps[steps.length - 1];
    expect(last.title).toBe("Execution Failed");
    expect(last.status).toBe("failed");
  });

  it("counts progress excluding the terminal beat", () => {
    const steps = narrateRun({ signals: ["PLANNER", "EXECUTOR"], outcome: "running" });
    const { done, total } = narrationProgress(steps);
    expect(done).toBeGreaterThan(0);
    expect(total).toBe(7); // the seven canonical beats
  });
});

describe("explain components reach the DOM (SSR, no provider)", () => {
  it("MicroExplanation surfaces the concept's words", () => {
    const html = renderToStaticMarkup(<MicroExplanation conceptId="memory-drift" />);
    expect(html).toContain("Memory Drift");
    expect(html).toContain("Why it matters");
    expect(html).toContain("Healthy");
  });

  it("StatusPill renders the translated label, not the raw code, by default", () => {
    const html = renderToStaticMarkup(<StatusPill status="LOST" />);
    expect(html).toContain("Connection Lost");
    expect(html).not.toContain(">LOST<");
  });

  it("ExplainedEmptyState replaces bare empty strings with explanatory copy", () => {
    const html = renderToStaticMarkup(<ExplainedEmptyState concept="memory-influence" />);
    expect(html).toContain("No memory was used during this execution");
    expect(html).toContain("without referencing");
  });

  it("RunNarration renders the numbered, plain-language steps", () => {
    const html = renderToStaticMarkup(
      <RunNarration signals={["PLANNER", "EXECUTOR"]} outcome="completed" />
    );
    expect(html).toContain("Task Received");
    expect(html).toContain("Task Planned");
    expect(html).toContain("Execution Completed");
    expect(html).toContain("Step 1");
  });
});
