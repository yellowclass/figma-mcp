// One bridge owns one Figma authorization and its upstream session.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
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

const log = (msg) => {
  const ts = new Date().toISOString();
  if (PORT) {
    console.log(`[${ts}] ${msg}`);
  } else {
    process.stderr.write(`[figma-mcp] ${msg}\n`);
  }
};

export function createBridge({ credentials, accessToken, persistRefresh = async () => {}, fetchImpl = globalThis.fetch }) {
  const fetch = fetchImpl;
  let figmaAccessToken = accessToken;
  let expiresAt = accessToken ? Date.now() + 50 * 60_000 : 0;
  let refreshPromise;
  let readyPromise;
  let recoveryPromise;
  let initialized = false;
  let pendingRefresh;

  function refreshAccessToken() {
    if (!refreshPromise) refreshPromise = doRefreshAccessToken().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  async function doRefreshAccessToken() {
    return tracer.startActiveSpan("figma.token_refresh", async (span) => {
      tokenRefreshCounter.add(1);
      try {
        const { clientId, clientSecret, refreshToken } = credentials;

        if (!clientId || !clientSecret || !refreshToken) {
          throw new Error(
            "No FIGMA_OAUTH_* credentials for token refresh"
          );
        }

        log("Refreshing access token via refresh_token grant...");

        if (!pendingRefresh) {
          const response = await fetch("https://api.figma.com/v1/oauth/token", {
            signal: AbortSignal.timeout(30_000),
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
            throw new Error(`Token refresh failed: HTTP ${response.status}`);
          }

          const data = await response.json();
          if (typeof data.access_token !== "string" || !data.access_token) throw new Error("Token refresh returned no access_token");
          pendingRefresh = data;
        }
        const data = pendingRefresh;
        if (data.refresh_token && data.refresh_token !== credentials.refreshToken) {
          // Keep pendingRefresh if persistence fails; retry saving it rather than
          // consuming the old refresh token again.
          await persistRefresh({ ...credentials }, data.refresh_token);
          credentials.refreshToken = data.refresh_token;
        }
        figmaAccessToken = data.access_token;
        const lifetime = Number(data.expires_in);
        expiresAt = Date.now() + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime * 1000 : 50 * 60_000);
        pendingRefresh = null;
        upstreamSessionId = null;
        cachedTools = null;
        initialized = false;

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
    if (figmaAccessToken && Date.now() < expiresAt - 30_000) return;
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
        const tokenUsed = figmaAccessToken;
        const headers = {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${tokenUsed}`,
        };
        if (upstreamSessionId) {
          headers["Mcp-Session-Id"] = upstreamSessionId;
        }

        const response = await fetch(FIGMA_MCP_URL, {
          method: "POST",
          signal: AbortSignal.timeout(120_000),
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
          return [];
        }

        // --- Auto-refresh on 401 (token expired) ---
        if (response.status === 401 && !isRetry) {
          log("Got 401 — access token expired, refreshing...");
          span.addEvent("token_expired_401");
          figmaApiErrorCounter.add(1, { "rpc.method": rpcMethod, "http.status_code": 401, reason: "token_expired" });
          try {
            if (!recoveryPromise) {
              recoveryPromise = (async () => {
                if (figmaAccessToken === tokenUsed) await refreshAccessToken();
                await ready();
              })().finally(() => { recoveryPromise = null; });
            }
            await recoveryPromise;
            log("Re-initialized upstream session with fresh token");
            span.setStatus({ code: SpanStatusCode.OK });
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
          figmaApiErrorCounter.add(1, { "rpc.method": rpcMethod, "http.status_code": statusCode, reason: "http_error" });
          throw new Error(`Figma MCP HTTP ${response.status}`);
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
    upstreamSessionId = null;
    cachedTools = null;
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

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      await ready();
      return { tools: cachedTools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      log(`Calling tool: ${name}`);
      try {
        await ready();
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


  function ready() {
    if (!readyPromise) readyPromise = (async () => {
      await ensureAccessToken();
      if (!initialized) {
        await initializeUpstream();
        initialized = true;
      }
    })().finally(() => { readyPromise = null; });
    return readyPromise;
  }
  return { createServer, ready, get toolCount() { return cachedTools?.length || 0; } };
}
