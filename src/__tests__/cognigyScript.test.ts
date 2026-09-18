import { describe, it, expect } from "@jest/globals";
import {
  cognigyScriptHints,
  reviewCognigyScriptPayload,
  reviewHttpBody,
} from "../tools/cognigyScript.js";

const paths = (f: { path: string }[]) => f.map((x) => x.path);

describe("reviewCognigyScriptPayload", () => {
  it("accepts a well-formed $cs wrapper", () => {
    const r = reviewCognigyScriptPayload({
      customerName: { $cs: { script: "context.user.name", type: "string" } },
      orderId: { $cs: { script: "context.currentOrder.id", type: "number" } },
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("accepts $cs without a type, which is optional", () => {
    const r = reviewCognigyScriptPayload({
      orders: { $cs: { script: "context.orders" } },
    });
    expect(r.errors).toEqual([]);
  });

  it("warns that a bare {{ }} value is sent as a string", () => {
    // The whole point: this is legal, and silently wrong for a number field.
    const r = reviewCognigyScriptPayload({ orderId: "{{context.order.id}}" });
    expect(r.errors).toEqual([]);
    expect(paths(r.warnings)).toEqual(["orderId"]);
    expect(r.warnings[0].message).toContain("STRING");
    // The suggestion rewrites it into the $cs form with the braces stripped.
    expect(r.warnings[0].message).toContain('"script": "context.order.id"');
  });

  it("leaves {{ }} embedded in a larger string alone", () => {
    // Interpolation into a sentence is genuinely a string; nothing to fix.
    const r = reviewCognigyScriptPayload({
      greeting: "Hello {{context.user.name}}, welcome back",
    });
    expect(r.warnings).toEqual([]);
  });

  it("rejects a $cs whose script is wrapped in braces", () => {
    const r = reviewCognigyScriptPayload({
      id: { $cs: { script: "{{context.id}}" } },
    });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toContain("must NOT be wrapped in {{ }}");
  });

  it("rejects a $cs with a missing or empty script", () => {
    expect(
      reviewCognigyScriptPayload({ a: { $cs: { type: "number" } } }).errors,
    ).toHaveLength(1);
    expect(
      reviewCognigyScriptPayload({ a: { $cs: { script: "  " } } }).errors,
    ).toHaveLength(1);
  });

  it("rejects a $cs that is not an object", () => {
    const r = reviewCognigyScriptPayload({ a: { $cs: "context.x" } });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toContain('{ "script"');
  });

  it("rejects unknown keys inside and beside the wrapper", () => {
    const inside = reviewCognigyScriptPayload({
      a: { $cs: { script: "context.x", cast: "number" } },
    });
    expect(inside.errors[0].message).toContain('remove "cast"');

    const beside = reviewCognigyScriptPayload({
      a: { $cs: { script: "context.x" }, fallback: 1 },
    });
    expect(beside.errors[0].message).toContain("only key");
  });

  it("warns about an undocumented type but does not reject it", () => {
    const r = reviewCognigyScriptPayload({
      a: { $cs: { script: "context.x", type: "integer" } },
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings[0].message).toContain('"integer"');
  });

  it("reports the path through nested objects and arrays", () => {
    const r = reviewCognigyScriptPayload({
      order: { items: [{ qty: "{{context.qty}}" }] },
    });
    expect(paths(r.warnings)).toEqual(["order.items[0].qty"]);
  });

  it("walks into arrays of $cs wrappers", () => {
    const r = reviewCognigyScriptPayload([
      { $cs: { script: "context.a", type: "number" } },
      { $cs: { type: "number" } },
    ]);
    expect(paths(r.errors)).toEqual(["[1]"]);
  });

  it("is quiet for a payload with no CognigyScript at all", () => {
    const r = reviewCognigyScriptPayload({ a: 1, b: "plain", c: [true, null] });
    expect(r).toEqual({ errors: [], warnings: [] });
  });
});

describe("reviewHttpBody", () => {
  it("reviews a JSON string body", () => {
    const r = reviewHttpBody('{"orderId":"{{context.id}}"}');
    expect(paths(r.warnings)).toEqual(["orderId"]);
  });

  it("ignores a body that is not JSON", () => {
    // A text payload containing {{ }} is normal and not a typing mistake.
    expect(reviewHttpBody("name={{context.name}}")).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it("ignores an absent or empty body", () => {
    expect(reviewHttpBody(undefined)).toEqual({ errors: [], warnings: [] });
    expect(reviewHttpBody("   ")).toEqual({ errors: [], warnings: [] });
  });
});

describe("cognigyScriptHints", () => {
  it("returns null when there is nothing to say", () => {
    expect(cognigyScriptHints({ errors: [], warnings: [] })).toBeNull();
  });

  it("leads with misuse when there are errors", () => {
    const hints = cognigyScriptHints(
      reviewCognigyScriptPayload({ a: { $cs: {} } }),
    )!;
    expect(hints.warning).toContain("misuses CognigyScript");
    expect(hints.action).toContain("$cs");
  });

  it("leads with the string-typing problem when there are only warnings", () => {
    const hints = cognigyScriptHints(
      reviewCognigyScriptPayload({ a: "{{context.a}}" }),
    )!;
    expect(hints.warning).toContain("as a string");
    expect(hints.action).toContain("docs.cognigy.com");
  });
});
