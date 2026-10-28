#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import cors from "cors";
import { timingSafeEqual, createHash } from "node:crypto";
import { createBridge } from "./upstream.mjs";
import { CoreCredentials, HttpError, TenantRegistry } from "./tenants.mjs";
import { CorePolicies, SharedRegistry, createSharedBridge } from "./shared.mjs";

const digest = (value) => createHash("sha256").update(value).digest();
const equal = (a, b) => !!a && !!b && timingSafeEqual(digest(a), digest(b));
const credentialsFromEnv = () => ({
  clientId: process.env.FIGMA_OAUTH_CLIENT_ID,
  clientSecret: process.env.FIGMA_OAUTH_CLIENT_SECRET,
  refreshToken: process.env.FIGMA_OAUTH_REFRESH_TOKEN,
});

export function createHttpApp({
  registry,
  legacyBridge,
  legacyToken,
  onError = (error) => console.error(error.message),
}) {
  const app = express();
  app.use(cors());
  const sessions = new Map();
  const legacyTenant = { bridge: legacyBridge };
  const handle = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch((error) => {
      onError(error);
      if (!res.headersSent)
        res
          .status(error.status || 502)
          .json({
            error: error.status ? error.message : "Figma connection failed",
          });
      else res.end();
    });
  const auth = handle(async (req, res, next) => {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) throw new HttpError(401, "Missing bearer token");
    if (registry) {
      const slug = req.params.slug;
      req.tenant = await registry.resolve(slug, token);
      req.orgSlug = slug;
    } else {
      if (!equal(token, legacyToken))
        throw new HttpError(403, "Invalid bearer token");
      req.tenant = legacyTenant;
      req.orgSlug = "legacy";
    }
    next();
  });
  app.get("/health", (_req, res) =>
    res.json({
      status: "ok",
      service: "figma-mcp-server",
      mode: registry?.mode || (registry ? "multi-tenant" : "legacy"),
      activeSessions: sessions.size,
    }),
  );
  const prefix = registry ? "/orgs/:slug" : "";
  app.get(
    `${prefix}/sse`,
    auth,
    handle(async (req, res) => {
      await req.tenant.bridge.ready();
      const server = req.tenant.bridge.createServer();
      const transport = new SSEServerTransport(
        `${registry ? `/orgs/${req.orgSlug}` : ""}/messages`,
        res,
      );
      const entry = {
        transport,
        server,
        tenant: req.tenant,
        orgSlug: req.orgSlug,
      };
      sessions.set(transport.sessionId, entry);
      registry?.retain(req.tenant);
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        sessions.delete(transport.sessionId);
        registry?.release(req.tenant);
        void server.close().catch(() => {});
      };
      res.on("close", cleanup);
      try {
        await server.connect(transport);
      } catch (error) {
        cleanup();
        throw error;
      }
    }),
  );
  app.post(
    `${prefix}/messages`,
    auth,
    handle(async (req, res) => {
      const entry = sessions.get(req.query.sessionId);
      if (!entry || entry.orgSlug !== req.orgSlug)
        throw new HttpError(404, "Session not found");
      if (entry.tenant !== req.tenant)
        throw new HttpError(409, "Figma credentials changed; reconnect");
      await entry.transport.handlePostMessage(req, res);
    }),
  );
  return {
    app,
    close: async () => {
      for (const entry of sessions.values())
        await entry.server.close().catch(() => {});
      sessions.clear();
      await registry?.close();
    },
  };
}

async function main() {
  const coreURL = process.env.CORE_INTERNAL_URL;
  const port = process.env.PORT;
  if (coreURL && !port) throw new Error("Multi-tenant mode requires PORT");
  let registry, legacyBridge;
  const sharedUrl = process.env.FIGMA_SHARED_RELAY_URL;
  if (sharedUrl && !coreURL)
    throw new Error("Shared-account mode requires CORE_INTERNAL_URL");
  if (sharedUrl && !process.env.FIGMA_SHARED_RELAY_TOKEN)
    throw new Error("FIGMA_SHARED_RELAY_TOKEN required");
  if (coreURL && sharedUrl) {
    const core = new CorePolicies({
      baseUrl: coreURL,
      serviceSecret: process.env.FIGMA_RELAY_SERVICE_SECRET,
    });
    registry = new SharedRegistry({
      core,
      createBridge: (policy) =>
        createSharedBridge({
          policy,
          upstreamUrl: sharedUrl,
          upstreamToken: process.env.FIGMA_SHARED_RELAY_TOKEN,
        }),
    });
    registry.mode = "shared-account";
  } else if (coreURL) {
    const core = new CoreCredentials({
      baseUrl: coreURL,
      serviceSecret: process.env.FIGMA_RELAY_SERVICE_SECRET,
    });
    registry = new TenantRegistry({ core, createBridge });
  } else {
    legacyBridge = createBridge({
      credentials: credentialsFromEnv(),
      accessToken: process.env.FIGMA_ACCESS_TOKEN,
    });
    await legacyBridge.ready();
  }
  if (!port) {
    await legacyBridge.createServer().connect(new StdioServerTransport());
    return;
  }
  if (!registry && !process.env.MCP_AUTH_TOKEN)
    throw new Error("MCP_AUTH_TOKEN required in legacy HTTP mode");
  const { app, close } = createHttpApp({
    registry,
    legacyBridge,
    legacyToken: process.env.MCP_AUTH_TOKEN,
  });
  const listener = app.listen(Number(port), "0.0.0.0", () =>
    console.log(
      `Figma MCP listening on ${port} (${registry?.mode || (registry ? "multi-tenant" : "legacy")})`,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      listener.close();
      await close();
      process.exit(0);
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(`Fatal: ${error.message}`);
    process.exitCode = 1;
  });
