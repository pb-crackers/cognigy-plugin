/**
 * CognigyScript inside JSON payloads.
 *
 * There are two ways to put CognigyScript into a JSON body, and they are not
 * interchangeable:
 *
 *   Inline      "customerName": "{{context.user.name}}"
 *   Typed       "orderId": { "$cs": { "script": "context.order.id", "type": "number" } }
 *
 * Inline interpolation always produces a **string**. That is fine for a string
 * field and silently wrong for everything else: an API expecting a number gets
 * `"42"`, one expecting an object gets `"[object Object]"`. The `$cs` form runs
 * the script and converts the result to `type`, so it is the only correct
 * choice for a number, boolean, array or object field.
 *
 * Getting this wrong produces a request the API rejects — or worse, accepts
 * with the wrong types — and nothing in the flow reports it, so the checks here
 * are advisory hints attached to the tool result rather than hard failures.
 *
 * Reference: https://docs.cognigy.com/ai/platform-features/cognigyscript
 */

/** A JSON value that is entirely one `{{ ... }}` expression. */
const WHOLE_INLINE_EXPRESSION = /^\s*\{\{[\s\S]+\}\}\s*$/;

/** Any `{{ ... }}` expression appearing inside a larger string. */
const CONTAINS_INLINE_EXPRESSION = /\{\{[\s\S]+?\}\}/;

/**
 * Return types documented for `$cs`. The docs show `object` explicitly and
 * describe converting to a number and to a string; the rest are accepted by
 * the platform but undocumented, so an unrecognised value is reported as a
 * hint rather than an error.
 */
const DOCUMENTED_TYPES = ["string", "number", "boolean", "object", "array"];

export interface CognigyScriptFinding {
  /** Dotted path to the offending value, e.g. `order.items[0].qty`. */
  path: string;
  message: string;
  /**
   * `inline` — a whole value written as `{{ ... }}`. Common, often fine, and
   * summarised in bulk. Anything else is reported on its own line.
   */
  kind?: "inline";
}

export interface CognigyScriptReview {
  /** Malformed `$cs` wrappers — these will not run as intended. */
  errors: CognigyScriptFinding[];
  /** Things that are legal but probably not what the author meant. */
  warnings: CognigyScriptFinding[];
}

const joinPath = (base: string, key: string | number): string =>
  typeof key === "number"
    ? `${base}[${key}]`
    : base
      ? `${base}.${key}`
      : String(key);

/**
 * Walk a parsed JSON payload and report `$cs` misuse.
 *
 * Reports two classes of problem:
 *
 *  - **errors** — a `$cs` wrapper that is structurally wrong (missing or
 *    non-string `script`, a non-object wrapper, unknown sibling keys). These
 *    do not do what the author intended.
 *  - **warnings** — a value that is entirely one `{{ ... }}` expression. Legal,
 *    and correct when the field really is a string, but this is the exact
 *    shape that silently sends `"42"` where `42` was meant.
 */
export function reviewCognigyScriptPayload(
  value: unknown,
): CognigyScriptReview {
  const errors: CognigyScriptFinding[] = [];
  const warnings: CognigyScriptFinding[] = [];

  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, joinPath(path, i)));
      return;
    }

    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;

      if ("$cs" in obj) {
        const keys = Object.keys(obj);
        if (keys.length > 1) {
          errors.push({
            path: path || "(root)",
            message: `a $cs wrapper must be the only key on its object; found ${keys
              .filter((k) => k !== "$cs")
              .map((k) => `"${k}"`)
              .join(", ")} alongside it`,
          });
        }

        const spec = obj.$cs;
        if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
          errors.push({
            path: path || "(root)",
            message:
              '$cs must be an object of the form { "script": "...", "type": "..." }',
          });
          return;
        }

        const { script, type, ...rest } = spec as Record<string, unknown>;
        if (typeof script !== "string" || script.trim() === "") {
          errors.push({
            path: path || "(root)",
            message: '$cs requires a non-empty "script" string',
          });
        } else if (CONTAINS_INLINE_EXPRESSION.test(script)) {
          // Inside $cs the script is already evaluated as CognigyScript, so
          // the braces would be treated as part of the expression.
          errors.push({
            path: path || "(root)",
            message:
              'the "script" inside $cs must NOT be wrapped in {{ }} — write it as a bare expression, e.g. "context.user.name"',
          });
        }
        if (type !== undefined && typeof type !== "string") {
          errors.push({
            path: path || "(root)",
            message: '$cs "type" must be a string when present',
          });
        } else if (
          typeof type === "string" &&
          !DOCUMENTED_TYPES.includes(type)
        ) {
          warnings.push({
            path: path || "(root)",
            message: `$cs "type" is "${type}"; the documented values are ${DOCUMENTED_TYPES.join(", ")}`,
          });
        }
        const extra = Object.keys(rest);
        if (extra.length > 0) {
          errors.push({
            path: path || "(root)",
            message: `$cs accepts only "script" and "type"; remove ${extra
              .map((k) => `"${k}"`)
              .join(", ")}`,
          });
        }
        return;
      }

      for (const [k, v] of Object.entries(obj)) walk(v, joinPath(path, k));
      return;
    }

    if (typeof node === "string" && WHOLE_INLINE_EXPRESSION.test(node)) {
      warnings.push({
        kind: "inline",
        path: path || "(root)",
        message: `"${node.trim()}" interpolates to a STRING. If this field needs a number, boolean, array or object, use { "$cs": { "script": "${node
          .trim()
          .replace(/^\{\{|\}\}$/g, "")
          .trim()}", "type": "number" } } instead`,
      });
    }
  };

  walk(value, "");
  return { errors, warnings };
}

/**
 * Review an HTTP body that arrives as a raw string.
 *
 * A non-JSON body is not a problem — a plain text payload with `{{ }}` in it is
 * perfectly normal — so anything unparseable is skipped rather than reported.
 */
export function reviewHttpBody(body: unknown): CognigyScriptReview {
  if (typeof body !== "string" || body.trim() === "") {
    return { errors: [], warnings: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { errors: [], warnings: [] };
  }
  return reviewCognigyScriptPayload(parsed);
}

/** How many inline-expression paths to name before summarising the rest. */
const MAX_LISTED_WARNINGS = 3;

/**
 * Render a review as the `_hints` warning/action pair, or null when clean.
 *
 * Errors are listed individually — each one is a wrapper that will not work.
 * Inline-expression warnings are summarised instead: a body of genuinely
 * string fields is perfectly correct, and emitting one line per field on every
 * write would be noise that teaches the reader to skip the hint entirely.
 */
export function cognigyScriptHints(
  review: CognigyScriptReview,
): { warning: string; action: string } | null {
  const { errors, warnings } = review;
  if (errors.length === 0 && warnings.length === 0) return null;

  const parts: string[] = [];

  if (errors.length > 0) {
    parts.push(
      `The request body misuses CognigyScript. ` +
        errors.map((e) => `${e.path}: ${e.message}`).join(" | "),
    );
  }

  // Anything that is not a bulk inline warning is specific enough to name.
  const other = warnings.filter((w) => w.kind !== "inline");
  if (other.length > 0) {
    parts.push(other.map((w) => `${w.path}: ${w.message}`).join(" | "));
  }

  const inline = warnings.filter((w) => w.kind === "inline");
  if (inline.length > 0) {
    const listed = inline.slice(0, MAX_LISTED_WARNINGS);
    const rest = inline.length - listed.length;
    const names = listed.map((w) => w.path).join(", ");
    parts.push(
      `${inline.length} value${inline.length === 1 ? "" : "s"} (${names}${
        rest > 0 ? `, +${rest} more` : ""
      }) use inline {{ }} and will be sent as STRINGS. That is correct for a string field — switch any that need a number, boolean, array or object to the $cs form.`,
    );
  }

  return {
    warning: parts.join(" "),
    action:
      'Typed form: { "$cs": { "script": "<bare expression, no braces>", "type": "number" } }. See https://docs.cognigy.com/ai/platform-features/cognigyscript',
  };
}
