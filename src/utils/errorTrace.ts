/**
 * Code Node error tracing.
 *
 * An uncaught throw inside a Cognigy Code Node stops flow execution outright —
 * the turn ends and the caller gets an empty response with no diagnostic. That
 * failure mode is silent: `config.hasError` only reports *transpile* failures,
 * and `input.codeNodeError` only covers timeouts and event-limit breaches, so a
 * plain runtime TypeError leaves nothing behind to debug.
 *
 * Every code node written through this plugin is therefore wrapped in a
 * try/catch that records a structured trace and sets `input.hasError`, which a
 * generated guard node checks immediately afterwards.
 *
 * The trace shape is deliberately stable across projects and clients:
 *
 *   {
 *     traceId, timestamp,
 *     flowId, flowName,
 *     nodeId, nodeLabel,
 *     errorName, errorMessage, stack,
 *     sessionId, userId,
 *     toolId, toolArgs
 *   }
 *
 * written to `context.errors` (array), `context.lastError` (latest),
 * `input.errorTrace`, and the project logs via `api.log("error", ...)`.
 *
 * The catch block is the ONLY place an error is logged. An earlier design also
 * logged from a shared Error Handler flow reached via Execute Flow, which
 * emitted the same payload twice for no added signal.
 *
 * `flowId`, `nodeId` and `nodeLabel` have no runtime accessor inside a Code
 * Node, so they are baked in as literals at authoring time. A node's id only
 * exists after it has been created, which is why creation is a two-pass
 * operation: POST the node, then PATCH the wrapped code with the real id.
 */

/** Marker identifying wrapped code, and the wrapper revision. */
export const ERROR_TRACE_MARKER = "/* cognigy-plugin:error-trace:v1 */";

const BODY_OPEN = "/* >>> user code >>> */";
const BODY_CLOSE = "/* <<< user code <<< */";

/** Placeholder written at create time, replaced once the node id is known. */
export const PENDING_NODE_ID = "__PENDING_NODE_ID__";

export interface ErrorTraceWrapOptions {
  /** The author's code, unwrapped. */
  code: string;
  /** Flow the node lives in. */
  flowId: string;
  /** Node id; pass PENDING_NODE_ID when it is not known yet. */
  nodeId: string;
  /** Node label, used to make traces readable without a lookup. */
  nodeLabel: string;
}

/** True when `code` has already been through {@link wrapCodeWithErrorTrace}. */
export function isWrapped(code: string): boolean {
  return (
    typeof code === "string" &&
    code.includes(ERROR_TRACE_MARKER) &&
    code.includes(BODY_OPEN) &&
    code.includes(BODY_CLOSE)
  );
}

/**
 * Recover the author's original code from a wrapped node.
 *
 * Updates go through this first so that re-wrapping never nests: the caller may
 * hand back either raw code or the wrapped code they just read out of the node.
 */
export function unwrapCode(code: string): string {
  if (!isWrapped(code)) return code;
  const start = code.indexOf(BODY_OPEN);
  const end = code.lastIndexOf(BODY_CLOSE);
  if (start === -1 || end === -1 || end < start) return code;
  return code.slice(start + BODY_OPEN.length, end).replace(/^\n|\n$/g, "");
}

/**
 * Read the node id baked into wrapped code, if any.
 *
 * Used on update to preserve the id already embedded in a node rather than
 * re-deriving it.
 */
export function embeddedNodeId(code: string): string | null {
  const match = code.match(/nodeId:\s*"([^"]+)"/);
  if (!match) return null;
  return match[1] === PENDING_NODE_ID ? null : match[1];
}

/**
 * Wrap `code` in the standard try/catch error-trace envelope.
 *
 * Indentation of the original code is preserved so the author's line structure
 * stays recognisable in the Cognigy editor.
 */
export function wrapCodeWithErrorTrace(options: ErrorTraceWrapOptions): string {
  const { flowId, nodeId, nodeLabel } = options;
  const body = unwrapCode(options.code ?? "");

  // JSON.stringify escapes quotes, backslashes and newlines for safe embedding.
  const litFlowId = JSON.stringify(flowId ?? "");
  const litNodeId = JSON.stringify(nodeId ?? PENDING_NODE_ID);
  const litNodeLabel = JSON.stringify(nodeLabel ?? "");

  return `${ERROR_TRACE_MARKER}
// Auto-generated error handling. Edit only the code between the user-code markers.
// An uncaught throw here would otherwise end the turn with an empty response.
input.hasError = false;
try {
${BODY_OPEN}
${body}
${BODY_CLOSE}
} catch (caughtError) {
  const err = caughtError instanceof Error ? caughtError : new Error(String(caughtError));
  const aiAgent = input.aiAgent || {};
  const errorTrace = {
    traceId: "ERR-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    timestamp: new Date().toISOString(),
    flowId: ${litFlowId},
    flowName: input.flowName || null,
    nodeId: ${litNodeId},
    nodeLabel: ${litNodeLabel},
    errorName: err.name || "Error",
    errorMessage: err.message || String(caughtError),
    stack: (err.stack || "").split("\\n").slice(0, 12).join("\\n"),
    sessionId: input.sessionId || null,
    userId: input.userId || null,
    toolId: aiAgent.toolId || null,
    toolArgs: aiAgent.toolArgs || null
  };
  input.hasError = true;
  input.errorTrace = errorTrace;
  // Each api.* call is guarded: a failure inside the catch must never mask the
  // original error or re-throw and stop the flow.
  try { api.addToContext("errors", errorTrace, "array"); } catch (ignored) {}
  try { api.addToContext("lastError", errorTrace, "simple"); } catch (ignored) {}
  try { api.log("error", "[code-node-error] " + JSON.stringify(errorTrace)); } catch (ignored) {}
}`;
}

/** Condition the generated guard node evaluates. */
export const ERROR_GUARD_CONDITION = "{{input.hasError}}";

/** Label prefix for generated guard nodes, used to identify them in a flow. */
export const ERROR_GUARD_LABEL_PREFIX = "Error Guard:";

/**
 * Guard condition for nodes that follow an HTTP Request.
 *
 * Covers both failure modes: a code node that threw (`input.hasError`) and an
 * HTTP call that came back non-2xx, which the HTTP Request node reports as a
 * status code rather than by throwing.
 */
export const HTTP_ERROR_GUARD_CONDITION =
  "{{input.hasError || (input.httprequest && input.httprequest.statusCode >= 400)}}";

/**
 * Handler placed in an http tool's guard branch.
 *
 * Without it the tool goes silent on failure: the post-process node never sets
 * `input.result`, the Resolve Tool Action hands the LLM nothing, and the LLM
 * emits no text — the same empty turn an uncaught throw used to produce, by a
 * different route. Writing a readable error into the tool result instead lets
 * the agent say it could not complete the lookup.
 *
 * Both `input.result` and `input.httprequest` are set because either may be
 * what the tool's Resolve node returns: `toolResponseValue` defaults to
 * `input.httprequest` for http tools, but callers commonly point it at
 * `input.result` after post-processing.
 */
export function buildHttpFailureHandlerCode(): string {
  return `// Auto-generated: surface the failure to the LLM so the tool cannot go silent.
const trace = input.errorTrace || {};
const status = (input.httprequest || {}).statusCode || null;
const failure = {
  error: true,
  userMessage: "This lookup could not be completed right now. Tell the user the information is temporarily unavailable, do not invent a value, and offer an alternative if you have one.",
  detail: trace.errorMessage || (status ? "HTTP " + status : "Unknown failure"),
  statusCode: status,
  traceId: trace.traceId || null
};
input.result = failure;
input.httprequest = { result: failure, statusCode: status || 500, length: 0 };`;
}
