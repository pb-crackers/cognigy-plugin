---
name: keep-it-simple
description: "Use on ANY Cognigy build or change — writing Code nodes, creating tools, adding flow nodes, editing agent instructions, fixing a bug — to pick the smallest build that works: native node before Code node, existing resource before new one, one line before fifty. Also use when the user says keep it simple, simplest, minimal, smallest change, YAGNI, over-engineered, too complex, or bloated."
---

# Keep It Simple

Build the smallest thing that works. Every extra node, tool, helper and branch is something
someone has to open in the Cognigy UI, understand and maintain. Less is easier to debug, test and hand over.

Adapted from [Ponytail](https://github.com/DietrichGebert/ponytail) (MIT) for Cognigy.

## The ladder

Understand the request and read what is already there first (`get` the flow, the tool, the
node's current code). Then stop at the first rung that works:

1. **Does it need to exist?** If the need is speculative, skip it and say so in one line.
2. **Is it already in the project?** Reuse or extend an existing tool, flow, node or context key. Don't build a second one next to it.
3. **Can the agent do it?** A line in the AI Agent's instructions or a tool description beats flow logic. A tool parameter (with a clear description) beats parsing `input.text`.
4. **Can a native node do it?** Use Say, Question, If, Lookup, Set Session Context, HTTP Request or LLM Prompt instead of a Code node.
5. **Can a field do it?** CognigyScript `{{ }}` in a node field beats a Code node that computes one value.
6. **Is a global already there?** Use `_` (Lodash) and `moment`. Don't hand-roll what they do.
7. **Only then:** write a Code node, as short as it can be.

Two rungs work → take the higher one.

## Code nodes

- Opening comment: 1-3 lines on *why* the node exists (required by the plugin). No other comments unless a line is genuinely surprising.
- **Let errors throw.** On every create/update the plugin wraps your code in its own try/catch (`src/utils/errorTrace.ts`), which records the stack trace, logs it, and sets `input.hasError` for the Error Guard. A `try/catch` of your own swallows the error before the wrapper sees it, so you lose the trace and the guard never fires. Catch only when you deliberately handle an expected failure (e.g. `JSON.parse` with a fallback value).
- No helper functions, classes, config objects or type declarations for something used once. Inline it.
- No defensive checks on values the flow guarantees. Guard only what can really be missing (optional tool args, API responses, first-turn context).
- Write the result where the next node reads it (`input.x` or `context.x`). Don't return wrapped objects nobody unwraps.

Too much:
```ts
// Formats the order status for the agent.
function formatStatus(order: Order): string { ... }
try {
  const args = input.aiAgent?.toolArgs ?? {};
  if (!args || typeof args !== "object") { api.log("error", "no args"); return; }
  const order = context.orders?.find((o: Order) => o.id === args.orderId);
  input.result = { success: true, data: order ? formatStatus(order) : null };
} catch (e) { api.log("error", e.message); input.result = { success: false }; }
```

Enough:
```ts
// Looks up the caller's order so the agent can read back its status.
const order = _.find(context.orders, { id: input.aiAgent.toolArgs.orderId });
input.result = order ? `${order.id}: ${order.status}` : "No order found with that number.";
```

## Tools and flows

- One tool per job the agent does. Don't split one job into several tools or fold several jobs into one.
- Fewest nodes in a tool branch. Code → Resolve is fine; don't add Say/Log/If nodes "just in case".
- Don't create a new flow for logic that fits in a tool branch. Don't add Execute Flow for something used once.
- Don't add a context key, variable or Lookup branch for a value that never changes.

## Changes and bug fixes

- Change the existing node instead of adding one beside it. Delete before you add.
- Fix the root cause where every path runs through it (the shared tool or Code node), not in each caller.
- Smallest diff wins, but only once you understand the flow. A small change in the wrong node is a second bug.

## Never cut

Input validation on data from outside (callers, APIs), handling that stops a caller from getting an
empty turn, security, PII handling, and anything the user explicitly asked for. If the user wants the
full version, build it without re-arguing.

## Output

Make the change, then report it in at most three short lines: what was built, what was skipped,
and when to add it. Pattern: `Built X. Skipped Y, add it if Z.`
