import test from "node:test";
import assert from "node:assert/strict";
import { fileCreator, extractCreatedKey } from "../creation.mjs";
import { CorePolicies, createSharedBridge } from "../shared.mjs";
const A = "aaaaaaaaaaaaaaaaaaaaaa",
  B = "bbbbbbbbbbbbbbbbbbbbbb";
const destination = { planKey: "team::123", projectId: "456" };
test("creation chooses Core destination and registers before returning the file", async () => {
  const calls = [];
  const core = {
    async creation(slug, token, body) {
      calls.push({ slug, token, body });
      return body.fileKey ? { fileKey: body.fileKey } : { destination };
    },
  };
  const create = fileCreator(core, "acme", "org-token");
  const r = await create(
    { fileName: "New design", requestId: "request_123" },
    async (req) => {
      assert.deepEqual(req.arguments, {
        fileName: "New design",
        editorType: "design",
        planKey: "team::123",
        projectId: "456",
      });
      return { structuredContent: { fileKey: A }, content: [] };
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.fileKey, A);
  assert.equal(r.structuredContent.fileKey, A);
});
test("destination overrides and invalid inputs never invoke Core or Figma", async () => {
  const create = fileCreator(
    {
      creation() {
        throw Error("must not reserve");
      },
    },
    "acme",
    "token",
  );
  for (const args of [
    { fileName: "New", requestId: "request_123", planKey: "team::foreign" },
    { fileName: "New", requestId: "request_123", projectId: "foreign" },
    { fileName: "", requestId: "request_123" },
    { fileName: "New", requestId: "short" },
  ])
    await assert.rejects(create(args, () => assert.fail("provider called")));
});
test("completed intent is replayed without creating another file", async () => {
  const create = fileCreator(
    {
      async creation() {
        return { fileKey: A };
      },
    },
    "acme",
    "token",
  );
  const r = await create({ fileName: "New", requestId: "request_123" }, () =>
    assert.fail("provider called"),
  );
  assert.equal(r.structuredContent.fileKey, A);
});
test("registration failure never reports creation success or retries the provider", async () => {
  let count = 0;
  const create = fileCreator(
    {
      async creation(s, t, b) {
        if (b.fileKey) throw Error("registration failed");
        return { destination };
      },
    },
    "acme",
    "token",
  );
  await assert.rejects(
    create({ fileName: "New", requestId: "request_123" }, async () => {
      count++;
      return { structuredContent: { fileKey: A } };
    }),
    /registration failed/,
  );
  assert.equal(count, 1);
});
test("provider file identities must be unique and use Figma URLs", () => {
  assert.equal(
    extractCreatedKey({
      content: [
        { type: "text", text: `Created https://www.figma.com/design/${A}/New` },
      ],
    }),
    A,
  );
  assert.throws(() =>
    extractCreatedKey({ structuredContent: { fileKey: A, file_key: B } }),
  );
  assert.throws(() =>
    extractCreatedKey({
      content: [{ type: "text", text: `https://evil.example/design/${A}` }],
    }),
  );
});
test("zero-file policy permits creation only with a validated destination", async () => {
  const core = new CorePolicies({
    baseUrl: "http://core",
    serviceSecret: "secret",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          mode: "shared",
          fileKeys: [],
          revision: "1",
          destination,
        }),
      ),
  });
  const p = await core.get("acme", "token");
  assert.deepEqual(p.destination, destination);
});
test("bridge exposes creation only for configured orgs, then edits the registered file", async () => {
  const requests = [];
  const upstream = {
    async listTools() {
      return {
        tools: [
          {
            name: "create_new_file",
            inputSchema: { type: "object", properties: {}, required: [] },
          },
          { name: "use_figma", inputSchema: { type: "object", properties: {}, required: [] } },
          {
            name: "get_metadata",
            inputSchema: {
              type: "object",
              properties: { fileKey: { type: "string" } },
              required: ["fileKey"],
            },
          },
        ],
      };
    },
    async callTool(req) {
      requests.push(req);
      return { content: [] };
    },
    async close() {},
  };
  const bridge = createSharedBridge({
    policy: { fileKeys: [], destination },
    connect: async () => upstream,
    createFile: async () => ({
      structuredContent: { fileKey: A },
      content: [],
    }),
  });
  await bridge.ready();
  assert(bridge.listing().some((t) => t.name === "create_new_file"));
  const before = JSON.stringify(bridge.listing());
  await bridge.call("create_new_file", {
    fileName: "New",
    requestId: "request_123",
  });
  assert.equal(JSON.stringify(bridge.listing()), before, "creating a file must not change cached tool definitions or trigger EAP drift");
  await bridge.call("get_metadata", { fileKey: A });
  await bridge.call("edit_canvas", {fileKey: A, operations: [{action: "createFrame", ref: "newFrame", properties: {width: 100, height: 100}}]});
  assert.equal(requests.at(-1).name, "use_figma");
  assert.equal(requests.at(-1).arguments.fileKey, A);
  assert.equal(JSON.stringify(bridge.listing()), before);
  await assert.rejects(
    bridge.call("get_metadata", { fileKey: B }),
    /not approved/,
  );
  await bridge.close();
});
test("file additions preserve the session, while removal and credential rotation replace it", async () => {
  const { SharedRegistry } = await import("../shared.mjs");
  let policy = { fileKeys: [], destination, revision: "1" };
  let made = 0,
    closed = 0;
  const registry = new SharedRegistry({
    core: {
      async get() {
        return policy;
      },
    },
    createBridge() {
      made++;
      return {
        updatePolicy() {},
        async close() {
          closed++;
        },
      };
    },
  });
  const first = await registry.resolve("acme", "token");
  policy = { fileKeys: [A], destination, revision: "2" };
  assert.equal(await registry.resolve("acme", "token"), first);
  assert.equal(made, 1);
  const rotated = await registry.resolve("acme", "new-token");
  assert.notEqual(rotated, first);
  assert.equal(closed, 1);
  policy = { fileKeys: [], destination, revision: "3" };
  assert.notEqual(await registry.resolve("acme", "new-token"), rotated);
  assert.equal(closed, 2);
  await registry.close();
});
