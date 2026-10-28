import { createHash } from "node:crypto";

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const validSlug = (slug) => typeof slug === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug);
const fingerprint = (credentials) => createHash("sha256").update(JSON.stringify([
  credentials.clientId, credentials.clientSecret, credentials.refreshToken,
])).digest("hex");

export class CoreCredentials {
  constructor({ baseUrl, serviceSecret, fetchImpl = globalThis.fetch }) {
    if (!serviceSecret) throw new Error("FIGMA_RELAY_SERVICE_SECRET required in multi-tenant mode");
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid CORE_INTERNAL_URL");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.serviceSecret = serviceSecret;
    this.fetch = fetchImpl;
  }
  async request(slug, token, body) {
    if (!validSlug(slug)) throw new HttpError(400, "Invalid org slug");
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/internal/orgs/${slug}/figma-credentials`, {
        method: body ? "POST" : "GET",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { "X-Internal-Secret": this.serviceSecret, "X-Figma-Relay-Token": token, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new HttpError(503, "Figma credential store unavailable"); }
    if (!response.ok) {
      const status = [400, 403, 404, 409].includes(response.status) ? response.status : 503;
      throw new HttpError(status, status === 409 ? "Figma credentials changed; reconnect" : "Figma connection unavailable or unauthorized");
    }
    return response;
  }
  async get(slug, token) {
    const response = await this.request(slug, token);
    let data;
    try { data = await response.json(); } catch { throw new HttpError(503, "Invalid Figma credential response"); }
    for (const key of ["clientId", "clientSecret", "refreshToken"]) if (typeof data[key] !== "string" || !data[key]) throw new HttpError(503, "Incomplete Figma credentials");
    return { clientId: data.clientId, clientSecret: data.clientSecret, refreshToken: data.refreshToken };
  }
  async rotate(slug, token, previous, refreshToken) {
    // Repeating the same rotation is idempotent in Core, including an unknown
    // outcome after a network timeout. Never log the response body or tokens.
    for (let attempt = 0; ; attempt++) {
      try { await this.request(slug, token, { previous, refreshToken }); return; }
      catch (error) { if (error.status !== 503 || attempt === 2) throw error; }
    }
  }
}

export class TenantRegistry {
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
    if (!validSlug(slug)) throw new HttpError(400, "Invalid org slug");
    // Authenticate against Core every time, including POSTs on an existing
    // session. Revoking/replacing a relay token takes effect immediately.
    const credentials = await this.core.get(slug, token);
    let entry = this.entries.get(slug);
    if (entry && fingerprint(entry.credentials) !== fingerprint(credentials)) entry = null;
    if (!entry) {
      this.sweep();
      if (!this.entries.has(slug) && this.entries.size >= this.maxTenants) throw new HttpError(503, "Figma connection capacity reached");
      entry = { credentials, users: 0, lastUsed: Date.now() };
      entry.bridge = this.createBridge({ credentials, persistRefresh: (previous, refreshToken) => this.core.rotate(slug, token, previous, refreshToken) });
      this.entries.set(slug, entry);
    }
    entry.lastUsed = Date.now();
    return entry;
  }
  retain(entry) { entry.users++; }
  release(entry) { entry.users--; entry.lastUsed = Date.now(); }
  sweep() {
    for (const [slug, entry] of this.entries) if (entry.users === 0 && Date.now() - entry.lastUsed > this.idleMs) this.entries.delete(slug);
  }
  close() { clearInterval(this.timer); this.entries.clear(); }
}
