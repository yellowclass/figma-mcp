#!/usr/bin/env node
// Run on an ops machine; credentials are read from disk, never CLI arguments.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { validSlug } from "../tenants.mjs";

export async function configureOrg({ slug, credentialsFile, coreUrl, relayBaseUrl, serviceSecret, fetchImpl = globalThis.fetch }) {
  if (!validSlug(slug)) throw new Error("Use the exact Zivon org slug (lowercase letters, digits and hyphens)");
  if (!coreUrl || !relayBaseUrl || !serviceSecret || !credentialsFile) throw new Error("CORE_INTERNAL_URL, FIGMA_RELAY_BASE_URL, FIGMA_RELAY_SERVICE_SECRET and a credential file are required");
  const data = JSON.parse(await readFile(credentialsFile, "utf8"));
  // An explicit single bundle prevents accidentally importing the previously
  // authenticated org from a shared Claude credentials file.
  for (const key of ["clientId", "clientSecret", "refreshToken"]) if (typeof data[key] !== "string" || !data[key]) throw new Error(`Credential file is missing ${key}`);
  const accountEmail = `developer+${slug}@iypods.com`;
  if (data.accountEmail !== accountEmail) throw new Error(`Credential file must identify the separately authorized account ${accountEmail}`);
  const base = new URL(coreUrl);
  if (!["http:","https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("Invalid CORE_INTERNAL_URL");
  const response = await fetchImpl(`${coreUrl.replace(/\/$/, "")}/internal/orgs/${slug}/figma-credentials`, {
    method: "PUT", redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/json", "X-Internal-Secret": serviceSecret },
    body: JSON.stringify({ clientId: data.clientId, clientSecret: data.clientSecret, refreshToken: data.refreshToken, accountEmail, relayBaseUrl }),
  });
  if (!response.ok) throw new Error(`Core rejected setup (HTTP ${response.status}); check authorization and retry. Credential values are not printed.`);
  return { accountEmail, status: "configured", relayUrl: `${relayBaseUrl.replace(/\/$/, "")}/orgs/${slug}/sse` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  configureOrg({ slug: process.argv[2], credentialsFile: process.argv[3], coreUrl: process.env.CORE_INTERNAL_URL, relayBaseUrl: process.env.FIGMA_RELAY_BASE_URL, serviceSecret: process.env.FIGMA_RELAY_SERVICE_SECRET })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch(() => { console.error("Setup failed. Check the org slug, dedicated-account credential file, Core URL and service secret; then retry. No credentials were printed."); process.exitCode = 1; });
}
