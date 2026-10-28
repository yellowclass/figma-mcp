import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { createBridge } from "../upstream.mjs";
import { CoreCredentials, TenantRegistry, HttpError } from "../tenants.mjs";
import { createHttpApp } from "../server.mjs";

function mockFigma({ rotate = false } = {}) {
  const refreshes = [], calls = [];
  let expired = false;
  const fetchImpl = async (url, init) => {
    if (url.includes("oauth/token")) {
      const token = init.body.get("refresh_token"); refreshes.push(token);
      return Response.json({ access_token: `access:${token}:${refreshes.length}`, expires_in: 3600, ...(rotate ? { refresh_token: `${token}:next` } : {}) });
    }
    const message = JSON.parse(init.body), auth = init.headers.Authorization;
    calls.push({ message, headers: init.headers });
    if (message.method === "tools/call" && expired) { expired = false; return new Response(null, { status: 401 }); }
    const result = message.method === "initialize" ? { protocolVersion: "2024-11-05" }
      : message.method === "tools/list" ? { tools: [{ name: "whoami", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: auth }] };
    if (!message.id) return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: message.id, result }, { headers: { "mcp-session-id": `session:${auth}` } });
  };
  return { fetchImpl, calls, refreshes, expire() { expired = true; } };
}
const creds = (org) => ({ clientId: `client:${org}`, clientSecret: `secret:${org}`, refreshToken: `refresh:${org}` });

async function serve(t, options) {
  const { app, close } = createHttpApp({ ...options, onError: () => {} });
  const listener = app.listen(0, "127.0.0.1"); await once(listener, "listening");
  t.after(async () => { await close(); listener.closeAllConnections(); await new Promise((resolve) => listener.close(resolve)); });
  return `http://127.0.0.1:${listener.address().port}`;
}
async function connect(t, base, path, token) {
  const client = new Client({ name: "isolation-test", version: "1" });
  const transport = new SSEClientTransport(new URL(base + path), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  t.after(() => client.close());
  return { client, transport };
}

test("real SSE clients isolate orgs, reject session theft, revocation and reauthorization", async (t) => {
  const figma = mockFigma(), stored = { acme: creds("acme"), beta: creds("beta") };
  const revoked = new Set();
  const core = { get: async (slug, token) => {
    if (token !== `token:${slug}` || revoked.has(slug)) throw new HttpError(403, "Unauthorized");
    return { ...stored[slug] };
  } };
  const registry = new TenantRegistry({ core, createBridge: (options) => createBridge({ ...options, fetchImpl: figma.fetchImpl }) });
  const base = await serve(t, { registry });
  const a = await connect(t, base, "/orgs/acme/sse", "token:acme");
  const b = await connect(t, base, "/orgs/beta/sse", "token:beta");
  const results = await Promise.all([a.client.callTool({ name: "whoami" }), b.client.callTool({ name: "whoami" })]);
  assert.match(results[0].content[0].text, /refresh:acme/);
  assert.match(results[1].content[0].text, /refresh:beta/);
  const endpoint = a.transport._endpoint;
  const post = (path, token) => fetch(base + path, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal((await post(endpoint.pathname + endpoint.search, "token:beta")).status, 403);
  assert.equal((await post(endpoint.pathname.replace("acme", "beta") + endpoint.search, "token:beta")).status, 404);
  revoked.add("acme");
  assert.equal((await post(endpoint.pathname + endpoint.search, "token:acme")).status, 403);
  revoked.delete("acme"); stored.acme = creds("replacement");
  assert.equal((await post(endpoint.pathname + endpoint.search, "token:acme")).status, 409);
  const replacement = await connect(t, base, "/orgs/acme/sse", "token:acme");
  assert.match((await replacement.client.callTool({ name: "whoami" })).content[0].text, /refresh:replacement/);
  assert.equal((await fetch(base + "/sse", { headers: { Authorization: "Bearer token:acme" } })).status, 404);
  for (const call of figma.calls.filter((c) => c.message.method === "tools/call")) assert.equal(call.headers["Mcp-Session-Id"], `session:${call.headers.Authorization}`);
});

test("concurrent initialization refreshes once and persists rotation before use", async () => {
  const figma = mockFigma({ rotate: true }), credentials = creds("acme");
  let persisted = false;
  const bridge = createBridge({ credentials, fetchImpl: async (...args) => {
    if (!String(args[0]).includes("oauth/token")) assert.equal(persisted, true);
    return figma.fetchImpl(...args);
  }, persistRefresh: async (previous, next) => { assert.equal(previous.refreshToken,"refresh:acme"); assert.equal(next,"refresh:acme:next"); persisted = true; } });
  await Promise.all(Array.from({ length: 20 }, () => bridge.ready()));
  assert.equal(figma.refreshes.length, 1);
  assert.equal(credentials.refreshToken,"refresh:acme:next");
});

test("failed persistence retries pending rotation without consuming refresh token twice", async () => {
  const figma = mockFigma({ rotate: true }); let saves = 0;
  const bridge = createBridge({ credentials: creds("acme"), fetchImpl: figma.fetchImpl, persistRefresh: async () => { if (++saves === 1) throw new Error("store down"); } });
  await assert.rejects(bridge.ready(), /store down/);
  assert.equal(figma.calls.length, 0);
  await bridge.ready();
  assert.equal(figma.refreshes.length, 1); assert.equal(saves, 2);
});

test("401 refreshes and reinitializes only the affected org", async (t) => {
  const figma = mockFigma();
  const bridge = createBridge({ credentials: creds("acme"), fetchImpl: figma.fetchImpl });
  const base = await serve(t, { legacyBridge: bridge, legacyToken: "legacy" });
  const { client } = await connect(t, base, "/sse", "legacy");
  figma.expire();
  const result = await client.callTool({ name: "whoami" });
  assert.equal(result.isError, undefined); assert.equal(figma.refreshes.length, 2);
  assert.match(result.content[0].text, /:2$/);
});

test("credential lookup fails closed and forwards both authentication headers", async () => {
  let request;
  const core = new CoreCredentials({ baseUrl: "http://core", serviceSecret: "service", fetchImpl: async (url, init) => { request = { url, init }; return Response.json(creds("acme")); } });
  assert.deepEqual(await core.get("acme", "org-token"), creds("acme"));
  assert.equal(request.init.headers["X-Internal-Secret"], "service");
  assert.equal(request.init.headers["X-Figma-Relay-Token"], "org-token");
  assert.equal(request.init.redirect,"error");
  await assert.rejects(core.get("../beta", "org-token"), { status: 400 });
  const down = new CoreCredentials({ baseUrl: "http://core", serviceSecret: "service", fetchImpl: async () => { throw new Error("network"); } });
  const registry = new TenantRegistry({ core: down, createBridge: () => { throw new Error("must not fall back"); } });
  await assert.rejects(registry.resolve("acme", "token"), { status: 503 }); registry.close();
});

test("registry bounds idle entries and never refreshes two accounts through one bridge", async () => {
  const registry = new TenantRegistry({ core: { get: async (slug) => creds(slug) }, createBridge: (options) => ({ account: options.credentials.clientId }), maxTenants: 1, idleMs: 1 });
  const a = await registry.resolve("acme", "token"); registry.retain(a);
  await assert.rejects(registry.resolve("beta", "token"), { status: 503 });
  registry.release(a); a.lastUsed = 0;
  const b = await registry.resolve("beta", "token");
  assert.equal(b.bridge.account,"client:beta"); assert.notEqual(a,b); registry.close();
});

test("ops command requires the declared dedicated account and sends one complete bundle", async (t) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { configureOrg } = await import("../scripts/configure-org.mjs");
  const directory = await mkdtemp(join(tmpdir(),"figma-ops-test-"));
  t.after(() => rm(directory,{ recursive:true, force:true }));
  const credentialsFile = join(directory,"account.json");
  await writeFile(credentialsFile,JSON.stringify({ ...creds("acme"), accountEmail:"developer+acme@iypods.com" }),{ mode:0o600 });
  const options = { slug:"acme", credentialsFile, coreUrl:"http://core", relayBaseUrl:"https://relay.example", serviceSecret:"service", fetchImpl:async (url,init) => {
    assert.equal(url,"http://core/internal/orgs/acme/figma-credentials");
    assert.equal(init.headers["X-Internal-Secret"],"service");
    const body = JSON.parse(init.body); assert.equal(body.refreshToken,"refresh:acme"); assert.equal(body.accountEmail,"developer+acme@iypods.com");
    return Response.json({ status:"configured" });
  } };
  const result = await configureOrg(options);
  assert.equal(result.relayUrl,"https://relay.example/orgs/acme/sse");
  assert.equal(JSON.stringify(result).includes("refresh:acme"),false);
  await assert.rejects(configureOrg({ ...options,slug:"beta" }),/separately authorized account/);
});

test("OAuth export refuses ambiguity and overwrite and keeps credentials private", async (t) => {
  const { mkdtemp, writeFile, readFile, stat, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { exportOAuth } = await import("../scripts/export-oauth.mjs");
  const directory = await mkdtemp(join(tmpdir(),"figma-export-test-")); t.after(() => rm(directory,{ recursive:true,force:true }));
  const source = join(directory,"source.json"), destination = join(directory,"private.json");
  await writeFile(source,JSON.stringify({ mcpOAuth:{ "figma-remote-mcp|one":creds("acme"),"figma-remote-mcp|two":creds("beta") } }));
  await assert.rejects(exportOAuth({ slug:"acme",source,destination }),/isolated Claude profile/);
  const result = await exportOAuth({ slug:"acme",source,destination,entryKey:"figma-remote-mcp|one" });
  assert.equal(JSON.stringify(result).includes("refresh:"),false);
  assert.equal((await stat(destination)).mode & 0o777,0o600);
  assert.equal(JSON.parse(await readFile(destination,"utf8")).refreshToken,"refresh:acme");
  await assert.rejects(exportOAuth({ slug:"acme",source,destination,entryKey:"figma-remote-mcp|one" }),{ code:"EEXIST" });
});
