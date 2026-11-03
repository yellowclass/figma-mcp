import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CoreCredentials, HttpError, validSlug } from "./tenants.mjs";
import { canvasCode, canvasTool } from "./canvas.mjs";
import { validDestination, creationTool, CreationError } from "./creation.mjs";

// Explicitly reviewed tools and arguments. A newly discovered upstream tool or
// argument is never automatically admitted. Account/library/code/job tools are
// intentionally absent. Resources/prompts are not advertised or forwarded.
const fields = {
  get_screenshot: [
    "fileKey",
    "nodeId",
    "contentsOnly",
    "enableBase64Response",
    "maxDimension",
  ],
  get_design_context: [
    "fileKey",
    "nodeId",
    "clientLanguages",
    "clientFrameworks",
    "forceCode",
    "disableCodeConnect",
    "excludeScreenshot",
  ],
  get_metadata: ["fileKey", "nodeId"],
  get_variable_defs: ["fileKey", "nodeId"],
  get_motion_context: [
    "fileKey",
    "nodeId",
    "recursive",
    "clientLanguages",
    "clientFrameworks",
  ],
  get_figjam: ["fileKey", "nodeId", "includeImagesOfNodes"],
  download_assets: ["fileKey", "nodeId", "defaultFormat", "defaultScale"],
  upload_assets: [
    "fileKey",
    "currentPageId",
    "count",
    "nodeId",
    "nodeIds",
    "scaleMode",
  ],
};
const fileKeyPattern = /^[A-Za-z0-9]{22,128}$/;
const nodePattern =
  /^(?:\d+[:-]\d+|I\d+[:-]\d+(?:;\d+[:-]\d+)*|T\d+[:-]\d+(?:;\d+[:-]\d+){2})$/;
const booleans = new Set([
  "contentsOnly",
  "enableBase64Response",
  "forceCode",
  "disableCodeConnect",
  "excludeScreenshot",
  "recursive",
  "includeImagesOfNodes",
]);

export class CorePolicies extends CoreCredentials {
  async get(slug, token) {
    if (!validSlug(slug)) throw new HttpError(400, "Invalid org slug");
    let response;
    try {
      response = await this.fetch(
        `${this.baseUrl}/internal/orgs/${slug}/figma-policy`,
        {
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
          headers: {
            "X-Internal-Secret": this.serviceSecret,
            "X-Figma-Relay-Token": token,
          },
        },
      );
    } catch {
      throw new HttpError(503, "Figma policy service unavailable");
    }
    if (!response.ok)
      throw new HttpError(
        [403, 404].includes(response.status) ? response.status : 503,
        "Figma shared policy unavailable or unauthorized",
      );
    let data;
    try {
      data = await response.json();
    } catch {
      throw new HttpError(503, "Invalid Figma policy");
    }
    if (
      data.mode !== "shared" ||
      !Array.isArray(data.fileKeys) ||
      (data.fileKeys.length < 1 && !validDestination(data.destination)) ||
      (data.destination != null && !validDestination(data.destination)) ||
      data.fileKeys.length > 200 ||
      !data.fileKeys.every(
        (key) => typeof key === "string" && fileKeyPattern.test(key),
      ) ||
      typeof data.revision !== "string" ||
      !data.revision
    )
      throw new HttpError(503, "Invalid Figma policy");
    return {
      fileKeys: [...new Set(data.fileKeys)].sort(),
      revision: data.revision,
      ...(data.destination ? { destination: data.destination } : {}),
    };
  }
  async creation(slug, token, body) {
    if (!validSlug(slug)) throw new HttpError(400, "Invalid org slug");
    let r;
    try {
      r = await this.fetch(
        `${this.baseUrl}/internal/orgs/${slug}/figma-creation`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Secret": this.serviceSecret,
            "X-Figma-Relay-Token": token,
          },
          body: JSON.stringify(body),
        },
      );
    } catch {
      throw new CreationError(
        "Creation service unavailable; preserve the request ID and inspect the destination before retrying",
      );
    }
    if (!r.ok)
      throw new CreationError(
        `Creation registration HTTP ${r.status}; preserve the request ID and inspect the destination before retrying`,
      );
    return r.json();
  }
}

function policyHash(policy) {
  return createHash("sha256")
    .update(
      JSON.stringify([policy.revision, policy.fileKeys, policy.destination]),
    )
    .digest("hex");
}
export class SharedRegistry {
  constructor({ core, createBridge, idleMs = 10 * 60_000, maxTenants = 1000 }) {
    this.core = core;
    this.createBridge = createBridge;
    this.idleMs = idleMs;
    this.maxTenants = maxTenants;
    this.entries = new Map();
    this.timer = setInterval(() => this.sweep(), 30_000);
    this.timer.unref();
  }
  async resolve(slug, token) {
    const policy = await this.core.get(slug, token);
    let entry = this.entries.get(slug);
    const credentialHash = createHash("sha256").update(token).digest("hex");
    if (entry && entry.credentialHash !== credentialHash) {
      void entry.bridge.close();
      this.entries.delete(slug);
      entry = null;
    }
    if (entry && policyHash(entry.policy) !== policyHash(policy)) {
      if (
        JSON.stringify(entry.policy.destination) ===
          JSON.stringify(policy.destination) &&
        policy.fileKeys.length > entry.policy.fileKeys.length &&
        entry.policy.fileKeys.every((k) => policy.fileKeys.includes(k)) &&
        entry.bridge.updatePolicy
      ) {
        entry.bridge.updatePolicy(policy);
        entry.policy = policy;
      } else {
        void entry.bridge.close();
        entry = null;
      }
    }
    if (!entry) {
      this.sweep();
      if (!this.entries.has(slug) && this.entries.size >= this.maxTenants)
        throw new HttpError(503, "Figma connection capacity reached");
      entry = {
        policy,
        credentialHash,
        bridge: this.createBridge(policy, { slug, token }),
        users: 0,
        lastUsed: Date.now(),
      };
      this.entries.set(slug, entry);
    }
    entry.lastUsed = Date.now();
    return entry;
  }
  retain(entry) {
    entry.users++;
  }
  release(entry) {
    entry.users--;
    entry.lastUsed = Date.now();
  }
  sweep() {
    for (const [slug, entry] of this.entries)
      if (entry.users === 0 && Date.now() - entry.lastUsed > this.idleMs) {
        this.entries.delete(slug);
        void entry.bridge.close();
      }
  }
  async close() {
    clearInterval(this.timer);
    await Promise.all(
      [...this.entries.values()].map((entry) => entry.bridge.close()),
    );
    this.entries.clear();
  }
}

class SharedPolicyError extends Error {}

function allowedArguments(name, args, tool) {
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new SharedPolicyError("Invalid tool arguments");
  if (Object.keys(args).some((key) => !fields[name].includes(key)))
    throw new SharedPolicyError("Unsupported tool argument");
  for (const key of tool.inputSchema.required || [])
    if (key !== "sessionId" && !Object.hasOwn(args, key))
      throw new SharedPolicyError(`Missing required argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    if (key === "fileKey") continue;
    let valid = false;
    if (booleans.has(key)) valid = typeof value === "boolean";
    else if (["nodeId", "currentPageId"].includes(key))
      valid = typeof value === "string" && nodePattern.test(value);
    else if (key === "nodeIds")
      valid =
        Array.isArray(value) &&
        value.length <= 60 &&
        value.every((id) => typeof id === "string" && nodePattern.test(id));
    else if (["clientLanguages", "clientFrameworks"].includes(key))
      valid = typeof value === "string" && value.length <= 200;
    else if (key === "maxDimension")
      valid = Number.isInteger(value) && value > 0 && value <= 4096;
    else if (key === "defaultScale")
      valid = Number.isFinite(value) && value >= 0.01 && value <= 4;
    else if (key === "defaultFormat")
      valid = ["png", "jpg", "svg", "pdf"].includes(value);
    else if (key === "count")
      valid = Number.isInteger(value) && value >= 1 && value <= 60;
    else if (key === "scaleMode")
      valid = ["FILL", "FIT", "TILE"].includes(value);
    if (!valid) throw new SharedPolicyError(`Invalid argument: ${key}`);
  }
  return {
    ...args,
    ...(name === "get_design_context" ? { disableCodeConnect: true } : {}),
    ...(name === "upload_assets" ? { batchCommit: false } : {}),
  };
}

export function createSharedBridge({
  policy,
  upstreamUrl,
  upstreamToken,
  connect,
  createFile,
}) {
  const allowedFiles = new Set(policy.fileKeys);
  let client,
    connecting,
    tools = [],
    closed = false;
  const sessions = new Map();
  async function ready() {
    if (closed) throw new Error("Figma connection closed; reconnect");
    if (client) return;
    if (!connecting)
      connecting = (async () => {
        const candidate = connect
          ? await connect()
          : new Client({ name: "zivon-shared-figma", version: "1" });
        try {
          if (!connect)
            await candidate.connect(
              new SSEClientTransport(new URL(upstreamUrl), {
                requestInit: {
                  headers: { Authorization: `Bearer ${upstreamToken}` },
                },
                fetch: (url, init) =>
                  fetch(url, { ...init, redirect: "error" }),
              }),
            );
          const listing = await candidate.listTools();
          tools = listing.tools;
          if (closed) {
            await candidate.close();
            throw new Error("Figma connection closed");
          }
          candidate.onclose = () => {
            if (client === candidate) {
              client = null;
              sessions.clear();
            }
          };
          client = candidate;
        } catch (error) {
          await candidate.close().catch(() => {});
          throw error;
        }
      })().finally(() => {
        connecting = null;
      });
    await connecting;
  }
  function available() {
    return tools.filter(
      (tool) =>
        Object.hasOwn(fields, tool.name) &&
        tool.inputSchema?.properties?.fileKey &&
        (tool.inputSchema.required || []).includes("fileKey") &&
        (tool.inputSchema.required || []).every(
          (key) => key === "sessionId" || fields[tool.name].includes(key),
        ),
    );
  }
  // Tool definitions must stay stable as files are created. Agents and EAP
  // cache/hash schemas; ownership is enforced by call(), never by this hint.
  function scopedFileSchema(upstream = {}) {
    const { enum: _enum, const: _const, ...schema } = upstream;
    return {
      ...schema,
      type: "string",
      pattern: "^[A-Za-z0-9]{22,128}$",
      description: "Figma file key returned by create_new_file for this organisation. Use the returned key to edit or inspect the new file; the server checks organisation ownership on every call.",
    };
  }
  function listing() {
    const bounded = available().map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      annotations: tool.annotations,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(
          Object.entries(tool.inputSchema.properties)
            .filter(([key]) => fields[tool.name].includes(key))
            .map(([key, value]) => [
              key,
              key === "fileKey" ? scopedFileSchema(value) : value,
            ]),
        ),
        required: (tool.inputSchema.required || []).filter(
          (key) => key !== "sessionId",
        ),
      },
    }));
    if (tools.some((tool) => tool.name === "use_figma"))
      bounded.push({
        ...canvasTool,
        inputSchema: {
          ...canvasTool.inputSchema,
          properties: {
            ...canvasTool.inputSchema.properties,
            fileKey: scopedFileSchema(),
          },
        },
      });
    if (
      validDestination(policy.destination) &&
      createFile &&
      tools.some((t) => t.name === "create_new_file")
    )
      bounded.push(creationTool);
    return bounded;
  }
  async function fileSession(key) {
    if (!tools.some((tool) => tool.name === "create_session")) return undefined;
    if (!sessions.has(key))
      sessions.set(
        key,
        (async () => {
          const result = await client.callTool({
            name: "create_session",
            arguments: {
              fileKey: key,
              description: "Zivon approved-file task",
            },
          });
          if (result.isError)
            throw new Error("Could not create a scoped Figma session");
          let data = result.structuredContent;
          if (!data)
            for (const item of result.content || [])
              if (item.type === "text") {
                try {
                  data = JSON.parse(item.text);
                  break;
                } catch {}
              }
          const id = data?.sessionId ?? data?.session_id;
          if (typeof id !== "string" || !/^[0-9a-fA-F-]{36}$/.test(id))
            throw new Error("Invalid scoped Figma session response");
          return id;
        })().catch((error) => {
          sessions.delete(key);
          throw error;
        }),
      );
    return sessions.get(key);
  }
  async function call(name, args) {
    await ready();
    if (name === "create_new_file") {
      if (
        !validDestination(policy.destination) ||
        !createFile ||
        !tools.some((t) => t.name === "create_new_file")
      )
        throw new SharedPolicyError(
          "File creation is unavailable: no approved destination for this organisation",
        );
      const result = await createFile(args, (request) =>
        client.callTool(request),
      );
      if (result.structuredContent?.fileKey)
        allowedFiles.add(result.structuredContent.fileKey);
      return result;
    }
    if (
      !args ||
      typeof args.fileKey !== "string" ||
      !allowedFiles.has(args.fileKey)
    )
      throw new SharedPolicyError("File is not approved for this organisation");
    let upstreamName = name,
      forward;
    if (name === "edit_canvas") {
      if (
        Object.keys(args).some(
          (key) => !["fileKey", "operations"].includes(key),
        )
      )
        throw new SharedPolicyError("Unsupported canvas argument");
      if (!tools.some((tool) => tool.name === "use_figma"))
        throw new SharedPolicyError("Canvas editing unavailable");
      upstreamName = "use_figma";
      let code;
      try {
        code = canvasCode(args.operations);
      } catch (error) {
        throw new SharedPolicyError(error.message);
      }
      forward = {
        fileKey: args.fileKey,
        code,
        description: "Apply validated Zivon canvas operations",
      };
    } else {
      const tool = available().find((tool) => tool.name === name);
      if (!tool)
        throw new SharedPolicyError(
          "Tool is unavailable in shared-account mode",
        );
      forward = allowedArguments(name, args, tool);
    }
    const sessionId = await fileSession(args.fileKey);
    if (sessionId) forward.sessionId = sessionId;
    let result;
    try {
      result = await client.callTool({
        name: upstreamName,
        arguments: forward,
      });
    } catch {
      throw new Error("Figma request failed");
    }
    if (result.isError)
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Figma could not complete this operation. Check the approved file's access and inspect its current state before retrying.",
          },
        ],
      };
    return result;
  }
  function createServer() {
    const server = new Server(
      { name: "figma-mcp", version: "2.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      await ready();
      return { tools: listing() };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        return await call(request.params.name, request.params.arguments || {});
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error instanceof SharedPolicyError ||
                error instanceof CreationError
                  ? error.message
                  : "Figma operation failed; reconnect and inspect the file before retrying.",
            },
          ],
        };
      }
    });
    return server;
  }
  return {
    ready,
    createServer,
    call,
    listing,
    updatePolicy(next) {
      for (const key of next.fileKeys) allowedFiles.add(key);
    },
    async close() {
      closed = true;
      if (connecting) await connecting.catch(() => {});
      if (client) await client.close().catch(() => {});
      client = null;
      sessions.clear();
    },
  };
}
