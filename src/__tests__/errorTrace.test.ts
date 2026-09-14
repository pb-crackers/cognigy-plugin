import { describe, it, expect } from "@jest/globals";
import {
  ERROR_TRACE_MARKER,
  PENDING_NODE_ID,
  embeddedNodeId,
  isWrapped,
  unwrapCode,
  wrapCodeWithErrorTrace,
} from "../utils/errorTrace.js";

const FLOW = "60d5ec49f1a2c8b1a4e0f002";
const NODE = "60d5ec49f1a2c8b1a4e0f012";

const wrap = (
  code: string,
  overrides: Partial<Parameters<typeof wrapCodeWithErrorTrace>[0]> = {},
) =>
  wrapCodeWithErrorTrace({
    code,
    flowId: FLOW,
    nodeId: NODE,
    nodeLabel: "Compute Payment",
    ...overrides,
  });

describe("wrapCodeWithErrorTrace", () => {
  it("wraps the body in a try/catch and preserves it verbatim", () => {
    const body = "const a = 1;\ninput.result = { a };";
    const wrapped = wrap(body);

    expect(wrapped).toContain(ERROR_TRACE_MARKER);
    expect(wrapped).toContain("try {");
    expect(wrapped).toContain("} catch (caughtError) {");
    expect(unwrapCode(wrapped)).toBe(body);
  });

  it("clears the error flag up front so a stale flag cannot fire the guard", () => {
    // input persists across nodes within a turn, so a hasError left by an
    // earlier node would otherwise route this node's success into the guard.
    const wrapped = wrap("input.result = 1;");
    const flagReset = wrapped.indexOf("input.hasError = false;");
    const tryStart = wrapped.indexOf("try {");

    expect(flagReset).toBeGreaterThan(-1);
    expect(flagReset).toBeLessThan(tryStart);
  });

  it("bakes flow id, node id and label in as literals", () => {
    const wrapped = wrap("noop();");

    expect(wrapped).toContain(`flowId: "${FLOW}"`);
    expect(wrapped).toContain(`nodeId: "${NODE}"`);
    expect(wrapped).toContain('nodeLabel: "Compute Payment"');
  });

  it("escapes a label containing quotes rather than breaking the literal", () => {
    const wrapped = wrap("noop();", { nodeLabel: 'Say "hi"\\done' });

    expect(wrapped).toContain('nodeLabel: "Say \\"hi\\"\\\\done"');
  });

  it("captures every field of the trace contract", () => {
    const wrapped = wrap("noop();");

    for (const field of [
      "traceId",
      "timestamp",
      "flowId",
      "flowName",
      "nodeId",
      "nodeLabel",
      "errorName",
      "errorMessage",
      "stack",
      "sessionId",
      "userId",
      "toolId",
      "toolArgs",
    ]) {
      expect(wrapped).toContain(`${field}:`);
    }
  });

  it("writes the trace to context, input and the logs", () => {
    const wrapped = wrap("noop();");

    expect(wrapped).toContain(
      'api.addToContext("errors", errorTrace, "array")',
    );
    expect(wrapped).toContain(
      'api.addToContext("lastError", errorTrace, "simple")',
    );
    expect(wrapped).toContain('api.log("error"');
    expect(wrapped).toContain("input.errorTrace = errorTrace;");
    expect(wrapped).toContain("input.hasError = true;");
  });

  it("guards each api call so a failure in the catch cannot stop the flow", () => {
    const wrapped = wrap("noop();");
    const catchBlock = wrapped.slice(
      wrapped.indexOf("} catch (caughtError) {"),
    );

    // Every api.* call inside the catch sits in its own try/catch.
    const apiCalls = catchBlock.match(/api\.\w+\(/g) ?? [];
    const guarded = catchBlock.match(/try \{ api\.\w+\(/g) ?? [];
    expect(apiCalls.length).toBeGreaterThan(0);
    expect(guarded.length).toBe(apiCalls.length);
  });

  it("is idempotent — re-wrapping does not nest another envelope", () => {
    const body = "input.result = 42;";
    const once = wrap(body);
    const twice = wrap(once);

    expect(twice.split(ERROR_TRACE_MARKER).length - 1).toBe(1);
    expect(twice.match(/} catch \(caughtError\) \{/g)).toHaveLength(1);
    expect(unwrapCode(twice)).toBe(body);
  });

  it("handles an empty body without producing invalid syntax", () => {
    const wrapped = wrap("");

    expect(wrapped).toContain("try {");
    expect(unwrapCode(wrapped)).toBe("");
  });

  it("does not corrupt a body that itself contains the body markers as strings", () => {
    // lastIndexOf on the closing marker keeps the outermost pair.
    const body = 'const s = "/* <<< user code <<< */";';
    const wrapped = wrap(body);

    expect(unwrapCode(wrapped)).toBe(body);
  });
});

describe("isWrapped / unwrapCode", () => {
  it("reports raw code as unwrapped and returns it untouched", () => {
    expect(isWrapped("input.x = 1;")).toBe(false);
    expect(unwrapCode("input.x = 1;")).toBe("input.x = 1;");
  });

  it("reports wrapped code as wrapped", () => {
    expect(isWrapped(wrap("input.x = 1;"))).toBe(true);
  });

  it("tolerates a non-string input", () => {
    expect(isWrapped(undefined as unknown as string)).toBe(false);
  });
});

describe("embeddedNodeId", () => {
  it("reads back the node id baked into wrapped code", () => {
    expect(embeddedNodeId(wrap("noop();"))).toBe(NODE);
  });

  it("treats the create-time placeholder as absent", () => {
    const pending = wrap("noop();", { nodeId: PENDING_NODE_ID });
    expect(embeddedNodeId(pending)).toBeNull();
  });

  it("returns null for code that was never wrapped", () => {
    expect(embeddedNodeId("input.x = 1;")).toBeNull();
  });
});
