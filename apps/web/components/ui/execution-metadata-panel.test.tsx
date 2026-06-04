import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutionMetadataPanel } from "./execution-metadata-panel";

/**
 * Proves the ExecutionMetadataPanel surfaces every identifier it is given and
 * the failure reason. Rendered via react-dom/server so no jsdom is required.
 */
describe("ExecutionMetadataPanel", () => {
  it("renders all five identifiers + a copy button per id + the failure reason", () => {
    const ids = {
      runId: "run-abc",
      executionId: "exec-def",
      traceId: "trace-ghi",
      cognitionId: "cog-jkl",
      runtimeId: "runtime-mno"
    };
    const html = renderToStaticMarkup(
      <ExecutionMetadataPanel
        {...ids}
        status="FAILED"
        failure={{ message: "planner confidence collapsed", code: "CognitionHalted", recoverable: true }}
      />
    );

    // Every identifier value is present in the output.
    for (const value of Object.values(ids)) {
      expect(html).toContain(value);
    }
    // Every labelled row is present.
    for (const label of ["Run ID", "Execution ID", "Trace ID", "Cognition ID", "Runtime ID"]) {
      expect(html).toContain(label);
    }
    // One copy button per identifier (title="Copy <value>").
    for (const value of Object.values(ids)) {
      expect(html).toContain(`Copy ${value}`);
    }
    // Failure reason surfaced instead of a bare FAILED badge.
    expect(html).toContain("Failure reason");
    expect(html).toContain("planner confidence collapsed");
    expect(html).toContain("CognitionHalted");
    expect(html).toContain("FAILED");
  });

  it("omits unknown identifiers but still renders the ones provided", () => {
    const html = renderToStaticMarkup(
      <ExecutionMetadataPanel executionId="exec-only" traceId="trace-only" />
    );
    expect(html).toContain("exec-only");
    expect(html).toContain("trace-only");
    expect(html).toContain("Execution ID");
    expect(html).toContain("Trace ID");
    // No Run/Cognition/Runtime rows when those ids are absent.
    expect(html).not.toContain("Run ID");
    expect(html).not.toContain("Cognition ID");
    expect(html).not.toContain("Runtime ID");
  });

  it("renders nothing when given no identifiers and no failure", () => {
    const html = renderToStaticMarkup(<ExecutionMetadataPanel />);
    expect(html).toBe("");
  });

  it("renders the MODEL-BACKED mode badge with violet tint when supplied", () => {
    const html = renderToStaticMarkup(
      <ExecutionMetadataPanel executionId="exec-1" mode="MODEL-BACKED" status="COMPLETED" />
    );
    expect(html).toContain("MODEL-BACKED");
    // Violet tint = model-backed; the deterministic case uses zinc.
    expect(html).toContain("violet");
    // The badge tooltip explains what the mode means so operators don't guess.
    expect(html).toContain("Cognition ran through a real model provider");
  });

  it("renders the DETERMINISTIC mode badge with zinc tint (no violet)", () => {
    const html = renderToStaticMarkup(
      <ExecutionMetadataPanel executionId="exec-1" mode="DETERMINISTIC" status="COMPLETED" />
    );
    expect(html).toContain("DETERMINISTIC");
    // Deterministic must NOT pick up the violet model-backed treatment.
    expect(html).not.toMatch(/violet/);
    expect(html).toContain("deterministic heuristics");
  });
});
