import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { CognigyApiClient } from "../api/client.js";
import { ToolHandlers } from "../tools/handlers.js";
import { conventionalLabel, stripLabelPrefix } from "../utils/nodeLabels.js";

describe("conventionalLabel", () => {
  it.each([
    ["say", "Greeting", "Say: Greeting"],
    ["question", "Ask for zip", "Q: Ask for zip"],
    ["code", "Verify zip", "Code: Verify zip"],
    ["addToContext", "Store caller", "ATC: Store caller"],
    ["aiAgentToolAnswer", "lookup_application", "RTA: lookup_application"],
    ["if", "input.verified", "If: input.verified"],
    ["httpRequest", "Get slots", "HTTP: Get slots"],
    ["switch", "Intent", "Switch: Intent"],
    ["sleep", "Pause", "Wait: Pause"],
    ["llmPromptV2", "Router", "LLM: Router"],
    ["setSessionConfig", "Barge-in", "Config: Barge-in"],
    ["setHTMLAppState", "Seat picker", "xApp: Seat picker"],
  ])("prefixes a %s node", (type, label, expected) => {
    expect(conventionalLabel(type, label)).toBe(expected);
  });

  it("keeps a label that already has the prefix, normalising its case", () => {
    expect(conventionalLabel("say", "Say: Greeting")).toBe("Say: Greeting");
    expect(conventionalLabel("say", "say:Greeting")).toBe("Say: Greeting");
  });

  it("leaves types outside the convention alone", () => {
    expect(conventionalLabel("aiAgentJobTool", " lookup_application ")).toBe(
      "lookup_application",
    );
    expect(conventionalLabel("then", "Then")).toBe("Then");
  });

  it("strips any convention prefix", () => {
    expect(stripLabelPrefix("Code: Verify zip")).toBe("Verify zip");
    expect(stripLabelPrefix("Verify zip")).toBe("Verify zip");
  });
});

const ID = {
  project: "60d5ec49f1a2c8b1a4e0f000",
  flow: "60d5ec49f1a2c8b1a4e0f002",
  node: "60d5ec49f1a2c8b1a4e0f101",
  parent: "60d5ec49f1a2c8b1a4e0f200",
};
const TARGET_REF = "55cc0db7-ff5e-4721-b112-d20ba77a9fde";

describe("manage_flow_nodes naming and comments", () => {
  let api: jest.Mocked<CognigyApiClient>;
  let h: ToolHandlers;

  beforeEach(() => {
    api = {
      get: jest.fn(),
      post: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn(),
      put: jest.fn(),
      uploadFile: jest.fn(),
    } as any;
    h = new ToolHandlers(api, "https://endpoint.example", "", "");
    (h as any).backupDeclinedForProject.add(ID.project);
    (h as any).backupAnsweredAnywhere = true;

    api.get.mockImplementation(async (path: string) => {
      if (path === `/v2.0/flows/${ID.flow}`)
        return { _id: ID.flow, projectReference: ID.project } as any;
      if (path === "/v2.0/flows")
        return {
          items: [{ _id: "x", name: "Error Handler", referenceId: TARGET_REF }],
        } as any;
      if (path === `/v2.0/flows/${ID.flow}/chart/nodes/${ID.node}`)
        return {
          _id: ID.node,
          type: "say",
          label: "Say: Old",
          config: {},
        } as any;
      if (path.includes("/chart/nodes/"))
        return { _id: ID.parent, type: "aiAgentJobTool", config: {} } as any;
      return { items: [] } as any;
    });
    api.post.mockResolvedValue({ _id: ID.node } as any);
    api.patch.mockResolvedValue({} as any);
  });

  const create = (args: Record<string, unknown>) =>
    h.handleToolCall("manage_flow_nodes", {
      operation: "create",
      flowId: ID.flow,
      parentNodeId: ID.parent,
      mode: "appendChild",
      ...args,
    });
  const postedBody = (type: string): any =>
    api.post.mock.calls.find(([, b]: any) => b?.type === type)?.[1];

  it("prefixes the label on create and passes the comment through", async () => {
    await create({
      nodeType: "say",
      label: "Greeting",
      comment: "Plays while the lookup runs.",
      config: { text: "Hi" },
    });

    expect(postedBody("say").label).toBe("Say: Greeting");
    expect(postedBody("say").comment).toBe("Plays while the lookup runs.");
  });

  it("sends no comment field when none is given", async () => {
    await create({
      nodeType: "say",
      label: "Greeting",
      config: { text: "Hi" },
    });
    expect(postedBody("say")).not.toHaveProperty("comment");
  });

  it("names an Execute Flow node after its target flow", async () => {
    await create({
      nodeType: "executeFlow",
      label: "run the handler",
      config: { flowId: TARGET_REF },
    });

    expect(postedBody("executeFlow").label).toBe("Execute: Error Handler");
  });

  it("prefixes a new label on update and patches the comment", async () => {
    await h.handleToolCall("manage_flow_nodes", {
      operation: "update",
      flowId: ID.flow,
      nodeId: ID.node,
      label: "Welcome",
      comment: "",
    });

    expect(api.patch).toHaveBeenCalledWith(
      `/v2.0/flows/${ID.flow}/chart/nodes/${ID.node}`,
      { label: "Say: Welcome", comment: "" },
    );
  });
});
