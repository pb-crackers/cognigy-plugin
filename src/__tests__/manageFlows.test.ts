import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { CognigyApiClient } from "../api/client.js";
import { ToolHandlers } from "../tools/handlers.js";
import { manageFlowsSchema } from "../schemas/tools.js";

const ID = {
  project: "60d5ec49f1a2c8b1a4e0f000",
  flow: "60d5ec49f1a2c8b1a4e0f002",
  newFlow: "60d5ec49f1a2c8b1a4e0f003",
  start: "60d5ec49f1a2c8b1a4e0f010",
  end: "60d5ec49f1a2c8b1a4e0f011",
  say: "60d5ec49f1a2c8b1a4e0f012",
  code: "60d5ec49f1a2c8b1a4e0f013",
  agentJob: "60d5ec49f1a2c8b1a4e0f014",
  created: "60d5ec49f1a2c8b1a4e0f099",
};

describe("manageFlowsSchema", () => {
  it("requires projectId and name to create", () => {
    expect(() =>
      manageFlowsSchema.parse({ operation: "create", name: "Shared" }),
    ).toThrow();
    expect(
      manageFlowsSchema.parse({
        operation: "create",
        projectId: ID.project,
        name: "Shared",
      }),
    ).toMatchObject({ name: "Shared" });
  });

  it("rejects a non-hex id", () => {
    expect(() =>
      manageFlowsSchema.parse({ operation: "clone", flowId: "not-an-id" }),
    ).toThrow();
  });

  it("allows update with only a description", () => {
    expect(
      manageFlowsSchema.parse({
        operation: "update",
        flowId: ID.flow,
        description: "why it exists",
      }),
    ).toMatchObject({ flowId: ID.flow });
  });
});

describe("manage_flows", () => {
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
  });

  it("creates a flow and points the caller at the next step", async () => {
    api.post.mockResolvedValue({
      _id: ID.newFlow,
      referenceId: "uuid-ref",
      name: "Shared Subroutine",
    } as any);

    const result: any = await h.handleToolCall("manage_flows", {
      operation: "create",
      projectId: ID.project,
      name: "Shared Subroutine",
      description: "Called by several agents",
    });

    expect(api.post).toHaveBeenCalledWith("/v2.0/flows", {
      projectId: ID.project,
      name: "Shared Subroutine",
      description: "Called by several agents",
    });
    expect(result).toMatchObject({
      flowId: ID.newFlow,
      referenceId: "uuid-ref",
    });
    // referenceId, not flowId, is what executeFlow/goTo point at — easy to
    // get wrong, so the hint has to say it.
    expect(result._hints.action).toContain("referenceId");
  });

  it("omits description when none was given", async () => {
    api.post.mockResolvedValue({ _id: ID.newFlow } as any);
    await h.handleToolCall("manage_flows", {
      operation: "create",
      projectId: ID.project,
      name: "Bare",
    });
    expect(api.post).toHaveBeenCalledWith("/v2.0/flows", {
      projectId: ID.project,
      name: "Bare",
    });
  });

  it("renames a flow", async () => {
    api.patch.mockResolvedValue({} as any);
    const result: any = await h.handleToolCall("manage_flows", {
      operation: "update",
      flowId: ID.flow,
      name: "Renamed",
    });
    expect(api.patch).toHaveBeenCalledWith(`/v2.0/flows/${ID.flow}`, {
      name: "Renamed",
    });
    expect(result.updated).toBe(true);
  });

  it("refuses an update that would change nothing", async () => {
    const result: any = await h.handleToolCall("manage_flows", {
      operation: "update",
      flowId: ID.flow,
    });
    expect(result.error).toContain("name and/or description");
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("clones a flow", async () => {
    api.post.mockResolvedValue({
      _id: ID.newFlow,
      referenceId: "clone-ref",
      name: "Copy of X",
    } as any);
    const result: any = await h.handleToolCall("manage_flows", {
      operation: "clone",
      flowId: ID.flow,
    });
    expect(api.post).toHaveBeenCalledWith(`/v2.0/flows/${ID.flow}/clone`, {});
    expect(result).toMatchObject({
      flowId: ID.newFlow,
      clonedFrom: ID.flow,
    });
  });
});

describe("manage_flow_nodes without parentNodeId", () => {
  let api: jest.Mocked<CognigyApiClient>;
  let h: ToolHandlers;

  const chart = (nodes: any[], relations: any[]) => ({ nodes, relations });

  const createNode = (extra: Record<string, unknown> = {}) =>
    h.handleToolCall("manage_flow_nodes", {
      operation: "create",
      flowId: ID.flow,
      nodeType: "say",
      label: "Greet",
      config: { text: "hi" },
      ...extra,
    });

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
    api.post.mockResolvedValue({ _id: ID.created } as any);
  });

  it("anchors to Start in a brand-new agent-less flow", async () => {
    api.get.mockResolvedValue(
      chart(
        [
          { _id: ID.start, type: "start" },
          { _id: ID.end, type: "end" },
        ],
        [
          { node: ID.start, next: ID.end, children: [] },
          { node: ID.end, next: null, children: [] },
        ],
      ) as any,
    );

    const result: any = await createNode();

    expect(result.targetNodeId).toBe(ID.start);
    expect(result.mode).toBe("append");
    expect(result.anchoredAutomatically).toBe(true);
  });

  it("anchors to the last node so nodes build up in writing order", async () => {
    // Appending after Start every time would stack them in reverse.
    api.get.mockResolvedValue(
      chart(
        [
          { _id: ID.start, type: "start" },
          { _id: ID.say, type: "say" },
          { _id: ID.code, type: "code" },
          { _id: ID.end, type: "end" },
        ],
        [
          { node: ID.start, next: ID.say, children: [] },
          { node: ID.say, next: ID.code, children: [] },
          { node: ID.code, next: ID.end, children: [] },
          { node: ID.end, next: null, children: [] },
        ],
      ) as any,
    );

    const result: any = await createNode();
    expect(result.targetNodeId).toBe(ID.code);
  });

  it("still demands a tool branch when the flow has an AI Agent", async () => {
    api.get.mockResolvedValue(
      chart(
        [
          { _id: ID.start, type: "start" },
          { _id: ID.agentJob, type: "aiAgentJob" },
          { _id: ID.end, type: "end" },
        ],
        [
          { node: ID.start, next: ID.agentJob, children: [] },
          { node: ID.agentJob, next: ID.end, children: [] },
        ],
      ) as any,
    );

    const result: any = await createNode();

    expect(result.error).toContain("parentNodeId is required");
    expect(result._hints.action).toContain("tool branch");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("does not auto-anchor when a parentNodeId was given", async () => {
    api.get.mockResolvedValue({ _id: ID.say, type: "say" } as any);
    const result: any = await createNode({ parentNodeId: ID.say });
    expect(result.targetNodeId).toBe(ID.say);
    expect(result.anchoredAutomatically).toBeUndefined();
  });

  it("asks for an explicit parent when the chart cannot be read", async () => {
    api.get.mockRejectedValue(new Error("boom"));
    const result: any = await createNode();
    expect(result.error).toContain("parentNodeId is required");
    expect(result._hints.action).toContain("list");
  });

  it("tolerates a cyclic chart instead of hanging", async () => {
    api.get.mockResolvedValue(
      chart(
        [
          { _id: ID.start, type: "start" },
          { _id: ID.say, type: "say" },
        ],
        [
          { node: ID.start, next: ID.say, children: [] },
          { node: ID.say, next: ID.start, children: [] },
        ],
      ) as any,
    );

    const result: any = await createNode();
    expect(result.targetNodeId).toBeDefined();
  });
});
