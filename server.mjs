#!/usr/bin/env node
// ---------------------------------------------------------------------------
// figma-mcp-server
//
// MCP server that bridges to mcp.figma.com with pre-injected bearer auth.
// Supports two modes:
//   - stdio:  For embedding inside the designer specialist pod (Claude CLI -p)
//   - HTTP/SSE: For standalone K8s deployment (clients connect via mcp-remote)
//
// Mode is selected by PORT env var:
//   PORT set     → HTTP/SSE on that port (requires MCP_AUTH_TOKEN)
//   PORT not set → stdio
//
// Env vars:
//   FIGMA_ACCESS_TOKEN           - Bearer token (set directly or via token exchange)
//   FIGMA_OAUTH_CLIENT_ID        - For auto token exchange (optional if ACCESS_TOKEN set)
//   FIGMA_OAUTH_CLIENT_SECRET    - For auto token exchange (optional if ACCESS_TOKEN set)
//   FIGMA_OAUTH_REFRESH_TOKEN    - For auto token exchange (optional if ACCESS_TOKEN set)
//   PORT                         - If set, run HTTP/SSE mode on this port
//   MCP_AUTH_TOKEN               - Bearer token clients must send (HTTP mode only)
// ---------------------------------------------------------------------------

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { trace, metrics, SpanStatusCode } from "@opentelemetry/api";

// ---------------------------------------------------------------------------
// OpenTelemetry manual instrumentation (tracer + metrics)
// Auto-instrumentation handles fetch/http/express automatically via
// instrumentation.mjs. These add app-level spans and counters.
// ---------------------------------------------------------------------------

const tracer = trace.getTracer("figma-mcp-server", "1.0.0");
const meter = metrics.getMeter("figma-mcp-server", "1.0.0");

const figmaApiCallCounter = meter.createCounter("figma.api.calls", {
  description: "Total HTTP requests to mcp.figma.com",
});

const figmaApiErrorCounter = meter.createCounter("figma.api.errors", {
  description: "Figma API error responses (non-2xx)",
});

const toolCallCounter = meter.createCounter("figma.tool.calls", {
  description: "MCP tool calls by tool name",
});

const toolErrorCounter = meter.createCounter("figma.tool.errors", {
  description: "MCP tool call errors by tool name",
});

const tokenRefreshCounter = meter.createCounter("figma.token.refreshes", {
  description: "OAuth token refresh attempts",
});

const figmaApiDuration = meter.createHistogram("figma.api.duration_ms", {
  description: "Figma API call duration in milliseconds",
  unit: "ms",
});

const FIGMA_MCP_URL = "https://mcp.figma.com/mcp";
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : null;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

const log = (msg) => {
  const ts = new Date().toISOString();
  if (PORT) {
    console.log(`[${ts}] ${msg}`);
  } else {
    process.stderr.write(`[figma-mcp] ${msg}\n`);
  }
};

// ---------------------------------------------------------------------------
// Token management — exchange refresh token for access token
// Auto-refreshes when token expires (~50 min for Figma)
// ---------------------------------------------------------------------------

let figmaAccessToken = process.env.FIGMA_ACCESS_TOKEN;

async function refreshAccessToken() {
  return tracer.startActiveSpan("figma.token_refresh", async (span) => {
    tokenRefreshCounter.add(1);
    try {
      const clientId = process.env.FIGMA_OAUTH_CLIENT_ID;
      const clientSecret = process.env.FIGMA_OAUTH_CLIENT_SECRET;
      const refreshToken = process.env.FIGMA_OAUTH_REFRESH_TOKEN;

      if (!clientId || !clientSecret || !refreshToken) {
        throw new Error(
          "No FIGMA_OAUTH_* credentials for token refresh"
        );
      }

      log("Refreshing access token via refresh_token grant...");

      const response = await fetch("https://api.figma.com/v1/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Token refresh failed: HTTP ${response.status} — ${text}`);
      }

      const data = await response.json();
      figmaAccessToken = data.access_token;

      if (!figmaAccessToken) {
        throw new Error("Token refresh returned no access_token");
      }

      log("Got new access token from refresh");
      span.setStatus({ code: SpanStatusCode.OK });
      return figmaAccessToken;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}

async function ensureAccessToken() {
  if (figmaAccessToken) return;
  await refreshAccessToken();
}

// ---------------------------------------------------------------------------
// Upstream HTTP client for mcp.figma.com
// ---------------------------------------------------------------------------

let upstreamSessionId = null;
let cachedTools = null;
let callIdCounter = 10;

async function figmaRequest(jsonRpcMessage, isRetry = false) {
  const rpcMethod = jsonRpcMessage.method || "unknown";
  return tracer.startActiveSpan(`figma.api ${rpcMethod}`, async (span) => {
    const start = Date.now();
    span.setAttribute("rpc.method", rpcMethod);
    span.setAttribute("rpc.system", "jsonrpc");
    span.setAttribute("figma.is_retry", isRetry);
    if (jsonRpcMessage.id) span.setAttribute("rpc.request_id", jsonRpcMessage.id);

    try {
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${figmaAccessToken}`,
      };
      if (upstreamSessionId) {
        headers["Mcp-Session-Id"] = upstreamSessionId;
      }

      const response = await fetch(FIGMA_MCP_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(jsonRpcMessage),
      });

      const duration = Date.now() - start;
      const statusCode = response.status;

      span.setAttribute("http.response.status_code", statusCode);
      figmaApiCallCounter.add(1, { "rpc.method": rpcMethod, "http.status_code": statusCode });
      figmaApiDuration.record(duration, { "rpc.method": rpcMethod });

      const sid = response.headers.get("mcp-session-id");
      if (sid) upstreamSessionId = sid;

      if (response.status === 202 || response.status === 204) {
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        return [];
      }

      // --- Auto-refresh on 401 (token expired) ---
      if (response.status === 401 && !isRetry) {
        log("Got 401 — access token expired, refreshing...");
        span.addEvent("token_expired_401");
        figmaApiErrorCounter.add(1, { "rpc.method": rpcMethod, "http.status_code": 401, reason: "token_expired" });
        try {
          await refreshAccessToken();
          upstreamSessionId = null;
          await initializeUpstream();
          log("Re-initialized upstream session with fresh token");
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return figmaRequest(jsonRpcMessage, true);
        } catch (refreshErr) {
          throw new Error(`Token refresh failed: ${refreshErr.message}`);
        }
      }

      if (response.status === 429) {
        span.addEvent("rate_limited_429");
        figmaApiErrorCounter.add(1, { "rpc.method": rpcMethod, "http.status_code": 429, reason: "rate_limited" });
      }

      if (!response.ok) {
        const text = await response.text();
        figmaApiErrorCounter.add(1, { "rpc.method": rpcMethod, "http.status_code": statusCode, reason: "http_error" });
        throw new Error(`Figma MCP HTTP ${response.status}: ${text}`);
      }

      const ct = response.headers.get("content-type") || "";

      let results;
      if (ct.includes("text/event-stream")) {
        const text = await response.text();
        results = [];
        for (const line of text.split("\n")) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data) {
              try {
                results.push(JSON.parse(data));
              } catch {}
            }
          }
        }
      } else {
        const text = await response.text();
        if (!text.trim()) results = [];
        else results = [JSON.parse(text)];
      }

      span.setAttribute("figma.response_count", results.length);
      span.setStatus({ code: SpanStatusCode.OK });
      return results;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}

// ---------------------------------------------------------------------------
// Initialize upstream MCP session
// ---------------------------------------------------------------------------

async function initializeUpstream() {
  const initResults = await figmaRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "figma-mcp-bridge", version: "1.0.0" },
    },
  }, true); // isRetry=true to avoid recursive refresh during init

  let initialized = false;
  for (const msg of initResults) {
    if (msg.result && msg.result.protocolVersion) {
      initialized = true;
      log(`Upstream protocol: ${msg.result.protocolVersion}`);
      break;
    }
  }
  if (!initialized) {
    throw new Error("Failed to initialize upstream MCP session");
  }

  await figmaRequest({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  }, true);

  const toolsResults = await figmaRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  }, true);

  for (const msg of toolsResults) {
    if (msg.result && msg.result.tools) {
      cachedTools = msg.result.tools;
      break;
    }
  }

  if (!cachedTools || cachedTools.length === 0) {
    throw new Error("No tools returned from Figma MCP");
  }
}

// ---------------------------------------------------------------------------
// Forward tool calls upstream
// ---------------------------------------------------------------------------

async function callUpstreamTool(name, args) {
  return tracer.startActiveSpan(`figma.tool ${name}`, async (span) => {
    span.setAttribute("figma.tool.name", name);
    toolCallCounter.add(1, { tool: name });

    try {
      const id = ++callIdCounter;
      span.setAttribute("rpc.request_id", id);

      const results = await figmaRequest({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      });

      for (const msg of results) {
        if (msg.id === id) {
          if (msg.error) {
            throw new Error(msg.error.message || JSON.stringify(msg.error));
          }
          if (msg.result) {
            span.setStatus({ code: SpanStatusCode.OK });
            return msg.result;
          }
        }
      }

      for (const msg of results) {
        if (msg.result) {
          span.setStatus({ code: SpanStatusCode.OK });
          return msg.result;
        }
        if (msg.error) {
          throw new Error(msg.error.message || JSON.stringify(msg.error));
        }
      }

      throw new Error(`No response for tool call: ${name}`);
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      toolErrorCounter.add(1, { tool: name });
      throw err;
    } finally {
      span.end();
    }
  });
}

// ---------------------------------------------------------------------------
// Create an MCP server instance with tool handlers
// ---------------------------------------------------------------------------

function createServer() {
  const server = new Server(
    { name: "figma-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: cachedTools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    log(`Calling tool: ${name}`);
    try {
      const result = await callUpstreamTool(name, args || {});
      return result;
    } catch (err) {
      log(`Tool error: ${err.message}`);
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Mode: stdio (embedded in designer specialist pod)
// ---------------------------------------------------------------------------

async function runStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("Server running on stdio");
}

// ---------------------------------------------------------------------------
// Mode: HTTP/SSE (standalone K8s deployment)
// ---------------------------------------------------------------------------

async function runHttp() {
  if (!MCP_AUTH_TOKEN) {
    console.error("MCP_AUTH_TOKEN required for HTTP mode");
    process.exit(1);
  }

  const express = (await import("express")).default;
  const cors = (await import("cors")).default;

  const app = express();
  app.use(cors());
  // Do NOT use express.json() — SSE transport reads raw body stream

  const sessions = new Map();

  function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing Authorization header" });
    }
    if (authHeader.slice(7) !== MCP_AUTH_TOKEN) {
      return res.status(403).json({ error: "Invalid auth token" });
    }
    next();
  }

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "figma-mcp-server",
      version: "1.0.0",
      activeSessions: sessions.size,
      tools: cachedTools ? cachedTools.length : 0,
      uptime: process.uptime(),
    });
  });

  app.get("/sse", authMiddleware, async (req, res) => {
    log(`New SSE connection from ${req.ip}`);

    const server = createServer();
    const sseTransport = new SSEServerTransport("/messages", res);
    const sessionId = sseTransport.sessionId;
    sessions.set(sessionId, { sseTransport, server });

    log(`Session created: ${sessionId} (active: ${sessions.size})`);

    res.on("close", () => {
      sessions.delete(sessionId);
      log(`Session closed: ${sessionId} (active: ${sessions.size})`);
    });

    await server.connect(sseTransport);
  });

  app.post("/messages", authMiddleware, async (req, res) => {
    const sessionId = req.query.sessionId;
    const session = sessions.get(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    await session.sseTransport.handlePostMessage(req, res);
  });

  app.listen(PORT, "0.0.0.0", () => {
    log(`HTTP/SSE server listening on port ${PORT}`);
    log(`  SSE:     /sse`);
    log(`  Health:  /health`);
    log(`  Tools:   ${cachedTools.length}`);
  });

  function gracefulShutdown(signal) {
    log(`${signal} received, closing ${sessions.size} sessions`);
    for (const [, session] of sessions) {
      try { session.sseTransport.close?.(); } catch {}
    }
    sessions.clear();
    process.exit(0);
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await ensureAccessToken();

  log("Connecting to mcp.figma.com...");
  await initializeUpstream();
  log(`Got ${cachedTools.length} tools: ${cachedTools.map((t) => t.name).join(", ")}`);

  if (PORT) {
    await runHttp();
  } else {
    await runStdio();
  }
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
