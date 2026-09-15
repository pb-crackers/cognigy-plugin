import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { CognigyApiClient } from "../api/client.js";
import { ToolHandlers } from "../tools/handlers.js";
import { ERROR_TRACE_MARKER } from "../utils/errorTrace.js";

// The backup gate holds the first change to an existing agent until the user
// answers; suites that are not testing the gate answer it up front. The answer
// is recorded per project — a call whose project cannot be determined falls
// back to "answered anywhere this session".
const PROJECT_FOR_GATE = "60d5ec49f1a2c8b1a4e0f000";

const ID = {
  project: "507f1f77bcf86cd799439011",
  agent: "60d5ec49f1a2c8b1a4e0f001",
  flow: "60d5ec49f1a2c8b1a4e0f002",
  endpoint: "60d5ec49f1a2c8b1a4e0f003",
  entry: "60d5ec49f1a2c8b1a4e0f004",
  node: "60d5ec49f1a2c8b1a4e0f005",
  llm: "60d5ec49f1a2c8b1a4e0f006",
  ks: "60d5ec49f1a2c8b1a4e0f007",
  tool: "60d5ec49f1a2c8b1a4e0f008",
  func: "60d5ec49f1a2c8b1a4e0f009",
  ext: "60d5ec49f1a2c8b1a4e0f00a",
};

const MOCK_IDS = {
  toolNode: "aaaaaaaaaaaaaaaaaaaaa001",
  resolveNode: "aaaaaaaaaaaaaaaaaaaaa002",
  preNode: "aaaaaaaaaaaaaaaaaaaaa003",
  httpNode: "aaaaaaaaaaaaaaaaaaaaa004",
  postNode: "aaaaaaaaaaaaaaaaaaaaa005",
  preGuard: "aaaaaaaaaaaaaaaaaaaaa006",
  responseGuard: "aaaaaaaaaaaaaaaaaaaaa007",
  handler: "aaaaaaaaaaaaaaaaaaaaa008",
  thenNode: "aaaaaaaaaaaaaaaaaaaaa009",
};

describe("create_tool – HTTP tool path", () => {
  let api: jest.Mocked<CognigyApiClient>;
  let h: ToolHandlers;

  beforeEach(() => {
    api = {
      get: jest.fn(),
      post: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn(),
      put: jest.fn(),
    } as any;
    h = new ToolHandlers(api, "https://endpoint-trial.cognigy.ai");
    (h as any).backupDeclinedForProject.add(PROJECT_FOR_GATE);
  });

  function mockFlowWithJobNode() {
    api.get.mockResolvedValueOnce({ flowId: ID.flow }).mockResolvedValueOnce({
      items: [
        { _id: ID.entry, isEntryPoint: true },
        { _id: ID.node, type: "aiAgentJob" },
      ],
    });
  }

  function baseArgs(configOverrides: Record<string, any> = {}) {
    return {
      aiAgentId: ID.agent,
      toolType: "http",
      name: "My HTTP Tool",
      config: { url: "https://api.example.com/data", ...configOverrides },
    };
  }

  // Resolve each created node by what it IS, not by call order — the http
  // chain gains and loses nodes (guards, handlers) as the builder evolves, and
  // positional mocks silently mis-assign ids the moment it does.
  function mockPostSequence(..._ids: string[]) {
    let guardCount = 0;
    api.post.mockImplementation(async (_path: string, body: any) => {
      const type = body?.type;
      const label = String(body?.label ?? "");
      if (type === "aiAgentJobTool") return { _id: MOCK_IDS.toolNode } as any;
      if (type === "aiAgentToolAnswer")
        return { _id: MOCK_IDS.resolveNode } as any;
      if (type === "httpRequest") return { _id: MOCK_IDS.httpNode } as any;
      if (type === "if") {
        guardCount += 1;
        return {
          _id: guardCount === 1 ? MOCK_IDS.preGuard : MOCK_IDS.responseGuard,
        } as any;
      }
      if (type === "code" && label.endsWith("Pre-Process"))
        return { _id: MOCK_IDS.preNode } as any;
      if (type === "code" && label.endsWith("Post-Process"))
        return { _id: MOCK_IDS.postNode } as any;
      if (type === "code" && label.endsWith("Report Failure"))
        return { _id: MOCK_IDS.handler } as any;
      return { _id: "aaaaaaaaaaaaaaaaaaaaa0ff" } as any;
    });
  }

  // The guard locates its then-branch through the chart relations.
  function mockChartForGuards() {
    const base = api.get.getMockImplementation();
    api.get.mockImplementation(async (path: string, opts?: any) => {
      if (typeof path === "string" && path.endsWith("/chart")) {
        return {
          relations: [
            { node: MOCK_IDS.preGuard, children: [MOCK_IDS.thenNode] },
            { node: MOCK_IDS.responseGuard, children: [MOCK_IDS.thenNode] },
          ],
          nodes: [{ _id: MOCK_IDS.thenNode, type: "then", label: "Then" }],
        } as any;
      }
      return base ? base(path, opts) : ({ items: [] } as any);
    });
  }

  it("writes pre/post-process code that uses unavailable runtime APIs and hints about it", async () => {
    mockFlowWithJobNode();
    mockPostSequence(
      MOCK_IDS.toolNode,
      MOCK_IDS.resolveNode,
      MOCK_IDS.httpNode,
      MOCK_IDS.postNode,
    );
    const result = await h.handleToolCall(
      "create_tool",
      baseArgs({ postProcessCode: "const r = await fetch('https://x');" }),
    );
    expect(result.childNodes.postProcessNodeId).toBe(MOCK_IDS.postNode);
    expect(result._hints?.warning).toContain("fetch()/XMLHttpRequest");
  });

  it("creates HTTP tool with basic GET request (url only)", async () => {
    mockFlowWithJobNode();
    mockPostSequence(
      MOCK_IDS.toolNode,
      MOCK_IDS.resolveNode,
      MOCK_IDS.httpNode,
    );

    const result = await h.handleToolCall("create_tool", baseArgs());

    expect(result.toolId).toBe(MOCK_IDS.toolNode);
    expect(result.toolType).toBe("http");
    expect(result.childNodes.httpNodeId).toBe(MOCK_IDS.httpNode);
    expect(result.childNodes.resolveNodeId).toBe(MOCK_IDS.resolveNode);
    expect(result.childNodes.preProcessNodeId).toBeUndefined();
    expect(result.childNodes.postProcessNodeId).toBeUndefined();

    const httpCallBody = api.post.mock.calls[2][1];
    expect(httpCallBody.config.url).toBe("https://api.example.com/data");
    expect(httpCallBody.config.type).toBe("GET");
  });

  it("creates HTTP tool with POST method, headers, and JSON body", async () => {
    mockFlowWithJobNode();
    mockPostSequence(
      MOCK_IDS.toolNode,
      MOCK_IDS.resolveNode,
      MOCK_IDS.httpNode,
    );

    const result = await h.handleToolCall(
      "create_tool",
      baseArgs({
        method: "POST",
        headers: {
          Authorization: "Bearer tok",
          "Content-Type": "application/json",
        },
        body: '{"key":"value"}',
      }),
    );

    expect(result.toolType).toBe("http");
    const httpCallBody = api.post.mock.calls[2][1];
    expect(httpCallBody.config.type).toBe("POST");
    expect(httpCallBody.config.url).toBe("https://api.example.com/data");
    expect(JSON.parse(httpCallBody.config.headers)).toEqual({
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
    });
    expect(httpCallBody.config.payloadType).toBe("json");
    expect(httpCallBody.config.payloadJSON).toEqual({ key: "value" });
  });

  it("creates HTTP tool with non-JSON body (text fallback)", async () => {
    mockFlowWithJobNode();
    mockPostSequence(
      MOCK_IDS.toolNode,
      MOCK_IDS.resolveNode,
      MOCK_IDS.httpNode,
    );

    const result = await h.handleToolCall(
      "create_tool",
      baseArgs({
        method: "POST",
        body: "plain text body that is not JSON",
      }),
    );

    expect(result.toolType).toBe("http");
    const httpCallBody = api.post.mock.calls[2][1];
    expect(httpCallBody.config.payloadType).toBe("text");
    expect(httpCallBody.config.payloadText).toBe(
      "plain text body that is not JSON",
    );
    expect(httpCallBody.config.payloadJSON).toBeUndefined();
  });

  it("creates HTTP tool with pre-process code node", async () => {
    mockFlowWithJobNode();
    mockPostSequence(
      MOCK_IDS.toolNode,
      MOCK_IDS.resolveNode,
      MOCK_IDS.preNode,
      MOCK_IDS.httpNode,
    );

    const result = await h.handleToolCall(
      "create_tool",
      baseArgs({
        preProcessCode: "input.data = { transformed: true };",
      }),
    );

    expect(result.childNodes.preProcessNodeId).toBe(MOCK_IDS.preNode);
    expect(result.childNodes.httpNodeId).toBe(MOCK_IDS.httpNode);
    expect(result.childNodes.postProcessNodeId).toBeUndefined();

    const preCallBody = api.post.mock.calls[2][1];
    expect(preCallBody.type).toBe("code");
    expect(preCallBody.config.code).toContain(
      "input.data = { transformed: true };",
    );
    // Code nodes are wrapped in the error-trace envelope before they are written.
    expect(preCallBody.config.code).toContain(ERROR_TRACE_MARKER);
    expect(preCallBody.label).toBe("My HTTP Tool - Pre-Process");
  });

  it("creates HTTP tool with post-process code node", async () => {
    mockFlowWithJobNode();
    mockPostSequence(
      MOCK_IDS.toolNode,
      MOCK_IDS.resolveNode,
      MOCK_IDS.httpNode,
      MOCK_IDS.postNode,
    );

    const result = await h.handleToolCall(
      "create_tool",
      baseArgs({
        postProcessCode: "input.result = input.httprequest.data;",
      }),
    );

    expect(result.childNodes.preProcessNodeId).toBeUndefined();
    expect(result.childNodes.httpNodeId).toBe(MOCK_IDS.httpNode);
    expect(result.childNodes.postProcessNodeId).toBe(MOCK_IDS.postNode);

    const postCallBody = api.post.mock.calls[3][1];
    expect(postCallBody.type).toBe("code");
    expect(postCallBody.config.code).toContain(
      "input.result = input.httprequest.data;",
    );
    expect(postCallBody.config.code).toContain(ERROR_TRACE_MARKER);
    expect(postCallBody.label).toBe("My HTTP Tool - Post-Process");
  });

  it("creates HTTP tool with both pre and post-process code nodes", async () => {
    mockFlowWithJobNode();
    mockPostSequence(
      MOCK_IDS.toolNode,
      MOCK_IDS.resolveNode,
      MOCK_IDS.preNode,
      MOCK_IDS.httpNode,
      MOCK_IDS.postNode,
    );

    const result = await h.handleToolCall(
      "create_tool",
      baseArgs({
        preProcessCode: "input.pre = true;",
        postProcessCode: "input.post = true;",
      }),
    );

    expect(result.childNodes.preProcessNodeId).toBe(MOCK_IDS.preNode);
    expect(result.childNodes.httpNodeId).toBe(MOCK_IDS.httpNode);
    expect(result.childNodes.postProcessNodeId).toBe(MOCK_IDS.postNode);
    expect(result.childNodes.resolveNodeId).toBe(MOCK_IDS.resolveNode);
  });

  it("returns error when URL is missing for http tool type", async () => {
    mockFlowWithJobNode();

    const result = await h.handleToolCall("create_tool", {
      aiAgentId: ID.agent,
      toolType: "http",
      name: "Bad HTTP Tool",
      config: {},
    });

    expect(result.error).toBe("url is required in config for http tool type.");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("rolls back all created nodes on failure", async () => {
    mockFlowWithJobNode();
    api.post
      .mockResolvedValueOnce({ _id: MOCK_IDS.toolNode })
      .mockResolvedValueOnce({ _id: MOCK_IDS.resolveNode })
      .mockRejectedValueOnce(new Error("HTTP node creation failed"));
    api.delete.mockResolvedValue({});

    const result = await h.handleToolCall("create_tool", baseArgs());

    expect(result.error).toBe("HTTP node creation failed");
    expect(api.delete).toHaveBeenCalledTimes(2);
    expect(api.delete).toHaveBeenCalledWith(
      `/v2.0/flows/${ID.flow}/chart/nodes/${MOCK_IDS.resolveNode}`,
    );
    expect(api.delete).toHaveBeenCalledWith(
      `/v2.0/flows/${ID.flow}/chart/nodes/${MOCK_IDS.toolNode}`,
    );
  });

  it("reports partial rollback failure when some deletes fail", async () => {
    mockFlowWithJobNode();
    api.post
      .mockResolvedValueOnce({ _id: MOCK_IDS.toolNode })
      .mockResolvedValueOnce({ _id: MOCK_IDS.resolveNode })
      .mockRejectedValueOnce(new Error("HTTP node creation failed"));
    api.delete
      .mockRejectedValueOnce(new Error("delete failed"))
      .mockResolvedValueOnce({});

    const result = await h.handleToolCall("create_tool", baseArgs());

    expect(result.error).toBe("HTTP node creation failed");
    expect(result._hints.action).toContain("Rollback partially failed");
    expect(result._hints.action).toContain(MOCK_IDS.resolveNode);
  });

  it("HTTP node target is pre-process node when pre-process code exists", async () => {
    mockFlowWithJobNode();
    mockPostSequence(
      MOCK_IDS.toolNode,
      MOCK_IDS.resolveNode,
      MOCK_IDS.preNode,
      MOCK_IDS.httpNode,
    );

    await h.handleToolCall(
      "create_tool",
      baseArgs({
        preProcessCode: "input.x = 1;",
      }),
    );

    // The HTTP node targets the pre-process GUARD, not the pre-process node.
    // Appending both to the same target would leave their order ambiguous.
    const httpCallBody = api.post.mock.calls.find(
      ([, b]: any) => b?.type === "httpRequest",
    )![1] as any;
    expect(httpCallBody.target).toBe(MOCK_IDS.preGuard);
  });

  it("guards both code legs so a failed http tool cannot go silent", async () => {
    // Without these the tool answers with nothing: post-process never sets
    // input.result, Resolve hands the LLM an empty value and it emits no text.
    mockFlowWithJobNode();
    mockPostSequence();
    mockChartForGuards();

    const result: any = await h.handleToolCall(
      "create_tool",
      baseArgs({
        preProcessCode: "input.x = 1;",
        postProcessCode: "input.y = 2;",
      }),
    );

    expect(result.childNodes.preProcessGuardNodeId).toBe(MOCK_IDS.preGuard);
    expect(result.childNodes.responseGuardNodeId).toBe(MOCK_IDS.responseGuard);

    const guards = api.post.mock.calls.filter(([, b]: any) => b?.type === "if");
    expect(guards).toHaveLength(2);

    // The response guard also catches a non-2xx, which the HTTP Request node
    // reports as a status code rather than by throwing.
    const responseGuard = guards[1][1] as any;
    expect(responseGuard.config.condition.condition).toContain(
      "input.hasError",
    );
    expect(responseGuard.config.condition.condition).toContain("statusCode");

    const handlers = api.post.mock.calls.filter(([, b]: any) =>
      String(b?.label).endsWith("Report Failure"),
    );
    expect(handlers).toHaveLength(2);
    // The handler writes a readable failure the LLM can actually verbalise.
    expect(handlers[0][1].config.code).toContain("input.result = failure");
    expect(handlers[0][1].config.code).toContain("userMessage");
  });

  it("guards the response even when there is no post-process node", async () => {
    mockFlowWithJobNode();
    mockPostSequence();
    mockChartForGuards();

    await h.handleToolCall("create_tool", baseArgs({}));

    const guards = api.post.mock.calls.filter(([, b]: any) => b?.type === "if");
    expect(guards).toHaveLength(1);
    // Anchored to the HTTP node, since there is no post-process to follow.
    expect((guards[0][1] as any).target).toBe(MOCK_IDS.httpNode);
  });

  it("skips the generated guards when errorGuard is false", async () => {
    mockFlowWithJobNode();
    mockPostSequence();
    mockChartForGuards();

    const result: any = await h.handleToolCall(
      "create_tool",
      baseArgs({ postProcessCode: "input.y = 2;", errorGuard: false }),
    );

    expect(api.post.mock.calls.some(([, b]: any) => b?.type === "if")).toBe(
      false,
    );
    expect(result.childNodes.responseGuardNodeId).toBeUndefined();
  });

  it("resolve node has the correct answer config", async () => {
    mockFlowWithJobNode();
    mockPostSequence(
      MOCK_IDS.toolNode,
      MOCK_IDS.resolveNode,
      MOCK_IDS.httpNode,
    );

    await h.handleToolCall("create_tool", baseArgs());

    const resolveCallBody = api.post.mock.calls[1][1];
    expect(resolveCallBody.type).toBe("aiAgentToolAnswer");
    expect(resolveCallBody.config.answer).toBe(
      "{{JSON.stringify(input.httprequest)}}",
    );
  });

  it("uses toolId as node label for HTTP tool and child nodes", async () => {
    mockFlowWithJobNode();
    mockPostSequence(
      MOCK_IDS.toolNode,
      MOCK_IDS.resolveNode,
      MOCK_IDS.preNode,
      MOCK_IDS.httpNode,
      MOCK_IDS.postNode,
    );

    await h.handleToolCall("create_tool", {
      aiAgentId: ID.agent,
      toolType: "http",
      name: "Fetch User Posts",
      config: {
        toolId: "fetch_user_posts",
        url: "https://api.example.com/posts",
        preProcessCode: "input.x = 1;",
        postProcessCode: "input.y = 2;",
      },
    });

    const bodyOf = (pred: (b: any) => boolean) =>
      api.post.mock.calls.find(([, b]: any) => pred(b))![1] as any;

    const toolCallBody = bodyOf((b) => b?.type === "aiAgentJobTool");
    expect(toolCallBody.label).toBe("fetch_user_posts");

    const resolveCallBody = bodyOf((b) => b?.type === "aiAgentToolAnswer");
    expect(resolveCallBody.label).toBe("fetch_user_posts - Resolve");

    const preCallBody = bodyOf(
      (b) => b?.type === "code" && String(b?.label).endsWith("Pre-Process"),
    );
    expect(preCallBody.label).toBe("fetch_user_posts - Pre-Process");

    const httpCallBody = bodyOf((b) => b?.type === "httpRequest");
    expect(httpCallBody.label).toBe("fetch_user_posts - HTTP Request");

    const postCallBody = bodyOf(
      (b) => b?.type === "code" && String(b?.label).endsWith("Post-Process"),
    );
    expect(postCallBody.label).toBe("fetch_user_posts - Post-Process");
  });

  it("uses custom toolResponseValue for HTTP resolve node", async () => {
    mockFlowWithJobNode();
    mockPostSequence(
      MOCK_IDS.toolNode,
      MOCK_IDS.resolveNode,
      MOCK_IDS.httpNode,
    );

    await h.handleToolCall("create_tool", {
      aiAgentId: ID.agent,
      toolType: "http",
      name: "Custom HTTP",
      config: {
        url: "https://api.example.com/data",
        toolResponseValue: "{{JSON.stringify(input.customResult)}}",
      },
    });

    const resolveCallBody = api.post.mock.calls[1][1];
    expect(resolveCallBody.config.answer).toBe(
      "{{JSON.stringify(input.customResult)}}",
    );
  });
});

describe("update_tool – HTTP child-node resolution", () => {
  let api: jest.Mocked<CognigyApiClient>;
  let h: ToolHandlers;

  beforeEach(() => {
    api = {
      get: jest.fn(),
      post: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn(),
      put: jest.fn(),
    } as any;
    h = new ToolHandlers(api, "https://endpoint-trial.cognigy.ai");
    (h as any).backupDeclinedForProject.add(PROJECT_FOR_GATE);
  });

  // Real /chart/nodes responses do NOT include parentId on nodes — the tree
  // relationship lives in the chart's separate `relations` array. These
  // fixtures mirror that shape: tool node + child nodes share no parent link.
  function mockFlowAndChildren() {
    api.get.mockResolvedValueOnce({ flowId: ID.flow }).mockResolvedValueOnce({
      items: [
        { _id: ID.node, type: "aiAgentJob", label: "AI Agent Job" },
        {
          _id: MOCK_IDS.toolNode,
          type: "aiAgentJobTool",
          label: "search_recipes",
        },
        {
          _id: MOCK_IDS.resolveNode,
          type: "aiAgentToolAnswer",
          label: "Resolve Tool Action",
        },
        {
          _id: MOCK_IDS.httpNode,
          type: "httpRequest",
          label: "search_recipes - HTTP Request",
        },
        {
          _id: MOCK_IDS.postNode,
          type: "code",
          label: "search_recipes - Post-Process",
        },
      ],
    });
  }

  it("hints about unavailable runtime APIs in written post-process code", async () => {
    mockFlowAndChildren();
    api.patch.mockResolvedValueOnce({ _id: MOCK_IDS.postNode });
    const result = await h.handleToolCall("update_tool", {
      aiAgentId: ID.agent,
      toolNodeId: MOCK_IDS.toolNode,
      toolType: "http",
      config: { postProcessCode: "import axios from 'axios';" },
    });
    expect(result.updatedFields).toContain("postProcessCode");
    expect(result._hints?.warning).toContain("require()/import");
  });

  it("resolves post-process Code node by label prefix", async () => {
    mockFlowAndChildren();
    api.patch.mockResolvedValue({});

    const result = await h.handleToolCall("update_tool", {
      aiAgentId: ID.agent,
      toolNodeId: MOCK_IDS.toolNode,
      toolType: "http",
      config: { postProcessCode: "input.x = 1;" },
    });

    expect(result.updatedFields).toContain("postProcessCode");
    expect(api.patch).toHaveBeenCalledWith(
      `/v2.0/flows/${ID.flow}/chart/nodes/${MOCK_IDS.postNode}`,
      {
        config: { code: expect.stringContaining("input.x = 1;") },
      },
    );
  });

  it("resolves HTTP node by label prefix and patches url/method", async () => {
    mockFlowAndChildren();
    api.patch.mockResolvedValue({});

    const result = await h.handleToolCall("update_tool", {
      aiAgentId: ID.agent,
      toolNodeId: MOCK_IDS.toolNode,
      toolType: "http",
      config: { url: "https://api.example.com/v2", method: "POST" },
    });

    expect(result.updatedFields).toContain("http");
    expect(api.patch).toHaveBeenCalledWith(
      `/v2.0/flows/${ID.flow}/chart/nodes/${MOCK_IDS.httpNode}`,
      { config: { url: "https://api.example.com/v2", type: "POST" } },
    );
  });

  it("resolves singleton Resolve Tool Action node", async () => {
    mockFlowAndChildren();
    api.patch.mockResolvedValue({});

    const result = await h.handleToolCall("update_tool", {
      aiAgentId: ID.agent,
      toolNodeId: MOCK_IDS.toolNode,
      toolType: "http",
      config: { toolResponseValue: "{{JSON.stringify(input.recipes)}}" },
    });

    expect(result.updatedFields).toContain("toolResponseValue");
    expect(api.patch).toHaveBeenCalledWith(
      `/v2.0/flows/${ID.flow}/chart/nodes/${MOCK_IDS.resolveNode}`,
      { config: { answer: "{{JSON.stringify(input.recipes)}}" } },
    );
  });

  // New tools created on or after this PR carry per-tool Resolve labels —
  // update_tool can disambiguate without an explicit resolveNodeId.
  it("resolves Resolve node by per-tool label even when multiple Resolve nodes exist", async () => {
    const otherResolveId = "bbbbbbbbbbbbbbbbbbbbb001";
    api.get.mockResolvedValueOnce({ flowId: ID.flow }).mockResolvedValueOnce({
      items: [
        {
          _id: MOCK_IDS.toolNode,
          type: "aiAgentJobTool",
          label: "search_recipes",
        },
        {
          _id: MOCK_IDS.resolveNode,
          type: "aiAgentToolAnswer",
          label: "search_recipes - Resolve",
        },
        {
          _id: otherResolveId,
          type: "aiAgentToolAnswer",
          label: "other_tool - Resolve",
        },
      ],
    });
    api.patch.mockResolvedValue({});

    const result = await h.handleToolCall("update_tool", {
      aiAgentId: ID.agent,
      toolNodeId: MOCK_IDS.toolNode,
      toolType: "http",
      config: { toolResponseValue: "{{JSON.stringify(input.recipes)}}" },
    });

    expect(result.updatedFields).toContain("toolResponseValue");
    expect(api.patch).toHaveBeenCalledWith(
      `/v2.0/flows/${ID.flow}/chart/nodes/${MOCK_IDS.resolveNode}`,
      { config: { answer: "{{JSON.stringify(input.recipes)}}" } },
    );
  });

  it("honors explicit resolveNodeId when multiple Resolve nodes exist", async () => {
    const otherResolveId = "bbbbbbbbbbbbbbbbbbbbb001";
    api.get.mockResolvedValueOnce({ flowId: ID.flow }).mockResolvedValueOnce({
      items: [
        {
          _id: MOCK_IDS.toolNode,
          type: "aiAgentJobTool",
          label: "search_recipes",
        },
        {
          _id: MOCK_IDS.resolveNode,
          type: "aiAgentToolAnswer",
          label: "Resolve Tool Action",
        },
        {
          _id: otherResolveId,
          type: "aiAgentToolAnswer",
          label: "Resolve Tool Action",
        },
      ],
    });
    api.patch.mockResolvedValue({});

    const result = await h.handleToolCall("update_tool", {
      aiAgentId: ID.agent,
      toolNodeId: MOCK_IDS.toolNode,
      toolType: "http",
      config: {
        toolResponseValue: "{{JSON.stringify(input.recipes)}}",
        resolveNodeId: MOCK_IDS.resolveNode,
      },
    });

    expect(result.updatedFields).toContain("toolResponseValue");
    expect(api.patch).toHaveBeenCalledWith(
      `/v2.0/flows/${ID.flow}/chart/nodes/${MOCK_IDS.resolveNode}`,
      { config: { answer: "{{JSON.stringify(input.recipes)}}" } },
    );
  });

  it("warns when multiple Resolve nodes exist and no resolveNodeId provided", async () => {
    const otherResolveId = "bbbbbbbbbbbbbbbbbbbbb001";
    api.get.mockResolvedValueOnce({ flowId: ID.flow }).mockResolvedValueOnce({
      items: [
        {
          _id: MOCK_IDS.toolNode,
          type: "aiAgentJobTool",
          label: "search_recipes",
        },
        {
          _id: MOCK_IDS.resolveNode,
          type: "aiAgentToolAnswer",
          label: "Resolve Tool Action",
        },
        {
          _id: otherResolveId,
          type: "aiAgentToolAnswer",
          label: "Resolve Tool Action",
        },
      ],
    });

    const result = await h.handleToolCall("update_tool", {
      aiAgentId: ID.agent,
      toolNodeId: MOCK_IDS.toolNode,
      toolType: "http",
      config: { toolResponseValue: "{{x}}" },
    });

    expect(result.updatedFields).not.toContain("toolResponseValue");
    expect(result._hints?.warning).toContain(
      "Multiple Resolve Tool Action nodes",
    );
  });

  it("honors explicit child node IDs over label-based lookup", async () => {
    mockFlowAndChildren();
    api.patch.mockResolvedValue({});

    await h.handleToolCall("update_tool", {
      aiAgentId: ID.agent,
      toolNodeId: MOCK_IDS.toolNode,
      toolType: "http",
      config: {
        postProcessCode: "input.y = 2;",
        postProcessNodeId: MOCK_IDS.postNode,
      },
    });

    expect(api.patch).toHaveBeenCalledWith(
      `/v2.0/flows/${ID.flow}/chart/nodes/${MOCK_IDS.postNode}`,
      {
        config: { code: expect.stringContaining("input.y = 2;") },
      },
    );
  });

  // Tool was created without postProcessCode → no post Code child exists.
  // Calling update_tool with postProcessCode should provision the missing node.
  it("auto-provisions a post-process Code node when one does not exist", async () => {
    api.get.mockResolvedValueOnce({ flowId: ID.flow }).mockResolvedValueOnce({
      items: [
        {
          _id: MOCK_IDS.toolNode,
          type: "aiAgentJobTool",
          label: "search_recipes",
        },
        {
          _id: MOCK_IDS.resolveNode,
          type: "aiAgentToolAnswer",
          label: "Resolve Tool Action",
        },
        {
          _id: MOCK_IDS.httpNode,
          type: "httpRequest",
          label: "search_recipes - HTTP Request",
        },
      ],
    });
    api.post.mockResolvedValueOnce({ _id: MOCK_IDS.postNode });

    const result = await h.handleToolCall("update_tool", {
      aiAgentId: ID.agent,
      toolNodeId: MOCK_IDS.toolNode,
      toolType: "http",
      config: {
        postProcessCode: "input.recipes = input.httprequest.body.meals;",
      },
    });

    expect(result.updatedFields).toContain("postProcessCode");
    expect(result._hints?.warning).toBeUndefined();
    expect(api.post).toHaveBeenCalledWith(
      `/v2.0/flows/${ID.flow}/chart/nodes`,
      expect.objectContaining({
        type: "code",
        mode: "append",
        target: MOCK_IDS.httpNode,
        label: "search_recipes - Post-Process",
        config: {
          code: expect.stringContaining(
            "input.recipes = input.httprequest.body.meals;",
          ),
        },
      }),
    );
  });

  it("auto-provisions a pre-process Code node when one does not exist", async () => {
    api.get.mockResolvedValueOnce({ flowId: ID.flow }).mockResolvedValueOnce({
      items: [
        {
          _id: MOCK_IDS.toolNode,
          type: "aiAgentJobTool",
          label: "search_recipes",
        },
        {
          _id: MOCK_IDS.resolveNode,
          type: "aiAgentToolAnswer",
          label: "Resolve Tool Action",
        },
        {
          _id: MOCK_IDS.httpNode,
          type: "httpRequest",
          label: "search_recipes - HTTP Request",
        },
      ],
    });
    api.post.mockResolvedValueOnce({ _id: MOCK_IDS.preNode });

    const result = await h.handleToolCall("update_tool", {
      aiAgentId: ID.agent,
      toolNodeId: MOCK_IDS.toolNode,
      toolType: "http",
      config: {
        preProcessCode:
          'input.normalized = String(input.aiAgent.toolArgs.q || "").trim();',
      },
    });

    expect(result.updatedFields).toContain("preProcessCode");
    expect(api.post).toHaveBeenCalledWith(
      `/v2.0/flows/${ID.flow}/chart/nodes`,
      expect.objectContaining({
        type: "code",
        mode: "append",
        target: MOCK_IDS.toolNode,
        label: "search_recipes - Pre-Process",
      }),
    );
  });

  // If the caller explicitly says "use this preProcessNodeId" but the ID does
  // not exist, do NOT silently auto-provision — they identified a specific
  // target, and a stale ID is more likely a bug to surface than to paper over.
  it("does not auto-provision when an explicit preProcessNodeId is provided but missing", async () => {
    api.get.mockResolvedValueOnce({ flowId: ID.flow }).mockResolvedValueOnce({
      items: [
        {
          _id: MOCK_IDS.toolNode,
          type: "aiAgentJobTool",
          label: "search_recipes",
        },
      ],
    });

    const result = await h.handleToolCall("update_tool", {
      aiAgentId: ID.agent,
      toolNodeId: MOCK_IDS.toolNode,
      toolType: "http",
      config: {
        preProcessCode: "input.x = 1;",
        preProcessNodeId: "aaaaaaaaaaaaaaaaaaaaadea",
      },
    });

    expect(result.updatedFields).not.toContain("preProcessCode");
    expect(api.post).not.toHaveBeenCalled();
    expect(result._hints?.warning).toContain(
      "Pre-process Code node with the provided preProcessNodeId was not found",
    );
  });

  it("skips post-process auto-provision and warns when no HTTP Request anchor exists", async () => {
    api.get.mockResolvedValueOnce({ flowId: ID.flow }).mockResolvedValueOnce({
      items: [
        {
          _id: MOCK_IDS.toolNode,
          type: "aiAgentJobTool",
          label: "search_recipes",
        },
      ],
    });

    const result = await h.handleToolCall("update_tool", {
      aiAgentId: ID.agent,
      toolNodeId: MOCK_IDS.toolNode,
      toolType: "http",
      config: { postProcessCode: "input.x = 1;" },
    });

    expect(result.updatedFields).not.toContain("postProcessCode");
    expect(api.post).not.toHaveBeenCalled();
    expect(result._hints?.warning).toContain("HTTP Request node not found");
  });
});
