#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validSlug } from "../tenants.mjs";

export async function exportOAuth({ slug, source, destination, entryKey }) {
  if (!validSlug(slug) || !source || !destination) throw new Error("Org slug, source and destination are required");
  const data = JSON.parse(await readFile(source,"utf8"));
  const entries = Object.entries(data.mcpOAuth || {}).filter(([key]) => key.startsWith("figma-remote-mcp|") && (!entryKey || key === entryKey));
  if (entries.length !== 1) throw new Error("Use an isolated Claude profile with exactly one Figma authorization, or select FIGMA_OAUTH_ENTRY_KEY explicitly");
  const credentials = entries[0][1];
  for (const key of ["clientId","clientSecret","refreshToken"]) if (typeof credentials[key] !== "string" || !credentials[key]) throw new Error("Complete Figma OAuth authorization with a refresh token is required");
  const bundle = { accountEmail:`developer+${slug}@iypods.com`, clientId:credentials.clientId, clientSecret:credentials.clientSecret, refreshToken:credentials.refreshToken };
  // Never overwrite a prior account export; never print credential material.
  await writeFile(destination,JSON.stringify(bundle,null,2)+"\n",{ mode:0o600, flag:"wx" });
  return { accountEmail:bundle.accountEmail, status:"exported" };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  exportOAuth({ slug:process.argv[2], destination:process.argv[3], source:join(process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME,".claude"),".credentials.json"), entryKey:process.env.FIGMA_OAUTH_ENTRY_KEY })
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => { console.error("OAuth export failed. Verify the dedicated Claude profile, complete credentials, entry selection and a new output path. No credentials were printed."); process.exitCode=1; });
}
