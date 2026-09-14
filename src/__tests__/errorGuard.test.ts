import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { CognigyApiClient } from "../api/client.js";
import { ToolHandlers } from "../tools/handlers.js";
import { ERROR_TRACE_MARKER } from "../utils/errorTrace.js";

const ID = {
  project: "60d5ec49f1a2c8b1a4e0f000",
  flow: "60d5ec49f1a2c8b1a4e0f002",
  codeNode: "60d5ec49f1a2c8b1a4e0f101",
  guardNode: "60d5ec49f1a2c8b1a4e0f102",
  thenNode: "60d5ec49f1a2c8b1a4e0f103",
  elseNode: "60d5ec49f1a2c8b1a4e0f104",
  handlerNode: "60d5ec49f1a2c8b1a4e0f105",
  toolNode: "60d5ec49f1a2c8b1a4e0f200",
  handlerFlow: "60d5ec49f1a2c8b1a4e0f300",
};
const HANDLER_FLOW_REF = "55cc0db7-ff5e-4721-b112-d20ba77a9fde";

/**
 * Chart shape the guard relies on. Note `parentId` is deliberately absent from
 * the node entries: the live API returns null there for then/else children and
 * only expresses the link through `relations[].children`.
 */
const chartWithGuardChildren = () => ({
  relations: [
    { node: ID.codeNode, children: [], next: ID.guardNode },
    { node: ID.guardNode, children: [ID.thenNode, ID.elseNode], next: null },
  ],
  nodes: [
    { _id: ID.codeNode, type: "code", label: "Compute" },
    { _id: ID.guardNode, type: "if", label: "Error Guard: Compute" },
    { _id: ID.thenNode, type: "then", label: "Then" },
    { _id: ID.elseNode, type: "else", label: "Else" },
  ],
});

describe("code node error guard", () => {
  let api: jest.Mocked<CognigyApiClient>;
  let h: ToolHandlers;

  const createCodeNode = (args: Record<string, unknown> = {}) =>
    h.handleToolCall("manage_flow_nodes", {
      operation: "create",
      flowId: ID.flow,
      parentNodeId: ID.toolNode,
      mode: "appendChild",
      nodeType: "code",
      label: "Compute",
      config: { code: "input.result = 1;" },
      ...args,
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

    api.get.mockImplementation(async (path: string, opts?: any) => {
      if (path === `/v2.0/flows/${ID.flow}/chart`) {
        return chartWithGuardChildren() as any;
      }
      if (path === `/v2.0/flows/${ID.flow}/chart/nodes/${ID.toolNode}`) {
        return { _id: ID.toolNode, type: "aiAgentJobTool" } as any;
      }
      if (path === "/v2.0/projects") {
        return { items: [{ _id: ID.project }] } as any;
      }
      if (path === "/v2.0/flows") {
        return {
          items: [
            { _id: ID.flow, name: "Agent Flow", referenceId: "flow-ref" },
            {
              _id: ID.handlerFlow,
              name: "Error Handler",
              referenceId: HANDLER_FLOW_REF,
            },
          ],
        } as any;
      }
      if (path.includes("/chart/nodes/")) return { config: {} } as any;
      return { items: [] } as any;
    });

    let posted = 0;
    api.post.mockImplementation(async (_path: string, body: any) => {
      posted += 1;
      if (body?.type === "code" && posted === 1)
        return { _id: ID.codeNode } as any;
      if (body?.type === "if") return { _id: ID.guardNode } as any;
      return { _id: ID.handlerNode } as any;
    });
    api.patch.mockResolvedValue({} as any);
  });

  it("appends an if guard on input.hasError after the code node", async () => {
    const result: any = await createCodeNode();

    expect(result.errorTrace).toEqual({ wrapped: true, nodeIdEmbedded: true });
    expect(result.errorGuard.guardNodeId).toBe(ID.guardNode);

    const guardPost = api.post.mock.calls.find(
      ([, body]: any) => body?.type === "if",
    );
    expect(guardPost).toBeDefined();
    const [, guardBody]: any = guardPost!;
    expect(guardBody.target).toBe(ID.codeNode);
    expect(guardBody.label).toBe("Error Guard: Compute");
    expect(guardBody.config.condition.condition).toBe("{{input.hasError}}");
  });

  it("leaves the then branch empty by default so the error is logged once", async () => {
    // The code node's own catch block already logs the full trace; a handler
    // flow here would emit the same payload a second time.
    const result: any = await createCodeNode();

    expect(result.errorGuard.handlerKind).toBe("none");
    expect(result.errorGuard.handlerNodeId).toBeNull();
    expect(
      api.post.mock.calls.some(([, b]: any) => b?.type === "executeFlow"),
    ).toBe(false);
    // No handler means no reason to go looking for one.
    expect(api.get).not.toHaveBeenCalledWith(
      "/v2.0/projects",
      expect.anything(),
    );
  });

  it("finds the then branch through chart relations, not node parentId", async () => {
    // Regression: the live API reports parentId: null for then/else children,
    // so a parentId-based lookup silently found nothing and left the opt-in
    // handler unattached.
    const result: any = await createCodeNode({
      errorHandlerFlowId: HANDLER_FLOW_REF,
    });

    expect(result.errorGuard.handlerKind).toBe("executeFlow");
    expect(result.errorGuard.handlerNodeId).toBe(ID.handlerNode);

    const handlerPost = api.post.mock.calls.find(
      ([, body]: any) => body?.type === "executeFlow",
    );
    expect(handlerPost).toBeDefined();
    expect((handlerPost as any)[1].target).toBe(ID.thenNode);
  });

  it("never sends isGoto — the API rejects it on an executeFlow node", async () => {
    // Regression: "Validation failed. Field 'isGoto' is not allowed."
    await createCodeNode({ errorHandlerFlowId: HANDLER_FLOW_REF });

    const [, body]: any = api.post.mock.calls.find(
      ([, b]: any) => b?.type === "executeFlow",
    )!;
    expect(body.config.flowNode).toEqual({
      flow: HANDLER_FLOW_REF,
      node: "",
    });
    expect(JSON.stringify(body)).not.toContain("isGoto");
  });

  it("runs an opt-in handler flow as a side trip via Execute Flow", async () => {
    await createCodeNode({ errorHandlerFlowId: "explicit-flow-ref" });

    const [, body]: any = api.post.mock.calls.find(
      ([, b]: any) => b?.type === "executeFlow",
    )!;
    expect(body.config.flowNode.flow).toBe("explicit-flow-ref");
    expect(body.target).toBe(ID.thenNode);
  });

  it("skips the guard but still wraps when errorGuard is false", async () => {
    const result: any = await createCodeNode({ errorGuard: false });

    expect(result.errorTrace.wrapped).toBe(true);
    expect(result.errorGuard).toBeUndefined();
    expect(api.post.mock.calls.some(([, b]: any) => b?.type === "if")).toBe(
      false,
    );
  });

  it("writes the code untouched when errorTrace is false", async () => {
    const result: any = await createCodeNode({ errorTrace: false });

    const [, body]: any = api.post.mock.calls[0];
    expect(body.config.code).toBe("input.result = 1;");
    expect(body.config.code).not.toContain(ERROR_TRACE_MARKER);
    expect(result.errorTrace).toBeUndefined();
  });

  it("patches the real node id in after create", async () => {
    await createCodeNode();

    const idPatch = api.patch.mock.calls.find(([path]: any) =>
      String(path).endsWith(`/chart/nodes/${ID.codeNode}`),
    );
    expect(idPatch).toBeDefined();
    expect((idPatch as any)[1].config.code).toContain(
      `nodeId: "${ID.codeNode}"`,
    );
  });

  it("still reports the node when guard creation fails", async () => {
    api.post.mockImplementation(async (_p: string, body: any) => {
      if (body?.type === "code") return { _id: ID.codeNode } as any;
      throw new Error("chart is locked");
    });

    const result: any = await createCodeNode();

    expect(result.nodeId).toBe(ID.codeNode);
    expect(result.errorGuard).toEqual({
      created: false,
      error: "chart is locked",
    });
  });
});
