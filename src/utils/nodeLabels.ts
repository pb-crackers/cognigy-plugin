/**
 * Node naming convention: every node the plugin writes is labelled
 * `<Prefix>: <what it does>` so a flow reads at a glance in the editor.
 *
 * The prefix is applied by the plugin, never left to the caller: pass the
 * descriptive part ("Greeting") and the node is saved as "Say: Greeting". A
 * label that already carries the right prefix is kept, so re-sending a label
 * read back from `get` never doubles it.
 *
 * Types without an entry (tool nodes, then/else, case, AI Agent) keep the
 * caller's label as-is: a tool node's label is the tool name the LLM sees.
 */

const XAPP = "xApp:";

export const NODE_LABEL_PREFIXES: Readonly<Record<string, string>> = {
  say: "Say:",
  question: "Q:",
  code: "Code:",
  executeFlow: "Execute:",
  addToContext: "ATC:",
  aiAgentToolAnswer: "RTA:",
  if: "If:",
  httpRequest: "HTTP:",
  log: "Log:",
  switch: "Switch:",
  goTo: "GoTo:",
  sleep: "Wait:",
  llmPromptV2: "LLM:",
  setSessionConfig: "Config:",
  initAppSession: XAPP,
  setHTMLAppState: XAPP,
  setAdaptiveCardAppState: XAPP,
  setAppState: XAPP,
  getAppSessionPin: XAPP,
};

/** The descriptive part of a label, with any convention prefix removed. */
export function stripLabelPrefix(label: string): string {
  const trimmed = label.trim();
  for (const prefix of new Set(Object.values(NODE_LABEL_PREFIXES))) {
    if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
      return trimmed.slice(prefix.length).trim();
    }
  }
  return trimmed;
}

/**
 * Apply the convention for a node of Cognigy chart type `type`.
 *
 * "Greeting" → "Say: Greeting"; "say: Greeting" → "Say: Greeting"; a type with
 * no prefix returns the label trimmed and otherwise untouched.
 */
export function conventionalLabel(type: string, label: string): string {
  const prefix = NODE_LABEL_PREFIXES[type];
  const trimmed = label.trim();
  if (!prefix) return trimmed;
  if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
    return `${prefix} ${trimmed.slice(prefix.length).trim()}`;
  }
  return `${prefix} ${trimmed}`;
}
