# Shared-account Figma MCP proxy

Clients invite **harshita@ivypods.com** to their Figma files. Operations accepts the invitation and approves the file URLs for the correct Zivon org in the Figma settings panel. The proxy reuses the existing account authorization. No alias account, per-org OAuth consent, credential export or per-org setup script is needed.

An invitation alone is not an org ownership proof. Platform operations must verify the client/file association before approving it. Customers cannot assign arbitrary file keys to themselves. This version approves **individual files**, not entire workspaces or projects.

## Enforcement

- Core stores an exclusive file-to-org registry. A Mongo transaction reserves every file at its unique `_id` and saves the policy; a conflicting claim rolls back the entire update. A file cannot belong to two orgs.
- Core generates a separate encrypted relay token per org. This is a Zivon access credential, not a Figma OAuth grant.
- Every SSE connection and message POST authenticates against Core. The policy endpoint requires both the dedicated service secret and the org token, checks the authoritative file bindings, and returns only the approved file keys/revision.
- The proxy validates every file key, exposes only explicitly reviewed tools and arguments, and keeps sessions scoped to the org/file. Policy changes invalidate existing client sessions. Missing policies and Core failures block access.
- The shared Figma OAuth credentials and raw upstream relay token never reach a tenant or its agent. The existing upstream relay is the only process refreshing that account's authorization.
- Shared-mode Core credential responses omit old console/file-opener/library/project credentials; changing an org to shared mode removes those legacy configuration paths and its per-org OAuth fields.
- The existing gateway/orchestrator Figma broker still authenticates the human, applies EAP tool permissions and audits calls. File restrictions remain enforced by this proxy even if tool-policy enforcement is in shadow mode.

A shared identity has a larger blast radius than separate Figma accounts: compromising that identity or the server holding its credentials can reach all files shared with it. This proxy isolates tenants' normal Zivon access; it does not change the account's permissions inside Figma.

## Available tools

Read tools: `get_metadata`, `get_screenshot`, `get_design_context` (Code Connect forcibly disabled), `get_variable_defs`, `get_motion_context`, `get_figjam`, `download_assets`. `upload_assets` targets approved files only, with batch commit disabled.

`edit_canvas` creates/edits frames, rectangles, ellipses, text and auto layout, reparents nodes and removes nodes inside an approved file. Its input is a bounded array of typed operations; the proxy generates the only JavaScript sent upstream. Arbitrary JavaScript, dynamic property names, image hashes, component imports and network/account APIs are not accepted. Text creation uses Inter Regular. Operations can partially apply before a later Figma failure; inspect the file before retrying a write.

Account-wide identity/library/Weave/shader/plugin tools, raw `use_figma`, direct session handles, generic resource reads, capture/video job tools, HTML capture and unscoped file creation are unavailable. Unknown upstream tools and arguments are blocked. Tools requiring new, unreviewed arguments are hidden until reviewed. These restrictions are intentional: forwarding the original full tool inventory with a shared identity would not provide org isolation.

## Operations UI

In the org's Figma settings, a platform SUPER_ADMIN sees **Operations: approved Figma files**. Paste verified file URLs/keys (one per line) and save. Saving an empty list disconnects the org and releases its file assignments. Customers see the shared invite address, connection status and their approved file links; they cannot edit the registry.

Core routes:

- `GET /api/orgs/{slug}/figma/shared-policy`: non-secret status for org managers/platform operations.
- `GET/PUT /api/SUPER_ADMIN/orgs/{slug}/figma-policy`: operations configuration; exact SUPER_ADMIN required by the handlers.
- `PUT /internal/orgs/{slug}/figma-policy`: operations service configuration `{ "files": ["https://www.figma.com/design/<key>/..."] }`, guarded by `FIGMA_RELAY_SERVICE_SECRET`.
- `GET /internal/orgs/{slug}/figma-policy`: proxy lookup, additionally requiring `X-Figma-Relay-Token`; returns `{mode:"shared",fileKeys:[...],revision:"..."}` without account credentials.

`FIGMA_SHARED_ACCOUNT_EMAIL` defaults to `harshita@ivypods.com`. Core's `FIGMA_SHARED_RELAY_BASE_URL` defaults to `https://figma-mcp.zivon.ai`. `TOKEN_ENCRYPTION_KEY` must be configured. Core exposes the usual org-scoped Figma catalogue entry and `FIGMA_MCP_URL`/`FIGMA_MCP_AUTH_TOKEN` to the existing orchestrator flow.

## Runtime configuration

The policy proxy requires:

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP listener, usually 3100 |
| `CORE_INTERNAL_URL` | Private Core origin |
| `FIGMA_RELAY_SERVICE_SECRET` | Same dedicated secret as Core's policy endpoints |
| `FIGMA_SHARED_RELAY_URL` | Fixed internal URL of the existing account relay, e.g. `http://figma-mcp.figma-mcp.svc.cluster.local/sse` |
| `FIGMA_SHARED_RELAY_TOKEN` | Server-only credential for that upstream relay |

Never configure the shared URL without Core or omit the shared relay token: startup fails rather than falling back to an unrestricted identity. `/health` reports `mode:"shared-account"`. Clients use `/orgs/<slug>/sse`; the public proxy has no unscoped `/sse` endpoint. `/orgs/<slug>/messages` is owned by the authenticated org/session.

Run one policy-proxy replica with **Recreate**; SSE connections live in memory. The existing upstream account relay also remains a single process. Multiple replicas require deliberate session routing and cleanup; this change does not add that.

## Production cutover (once for the platform)

1. Merge/deploy the companion Core changes before switching the proxy. Preserve `FIGMA_RELAY_SERVICE_SECRET` in the existing AWS/External Secrets setup.
2. In operations UI, approve the verified files for **every existing org**, including those currently pointing at the unrestricted relay. Core creates their new org tokens, updates their URLs and drops legacy bypass fields. Do not infer file ownership from an agent-provided URL or a workspace display name.
3. Rotate the upstream `MCP_AUTH_TOKEN` in AWS Secrets Manager at `zivon/prod/figma-mcp-upstream-auth` (JSON property `MCP_AUTH_TOKEN`). Apply `k8s/shared-account/upstream-auth.yaml` and wait for its ExternalSecret to be Ready. Its Merge policy replaces only the transport token in `figma-mcp-secrets`, preserving all existing OAuth fields. Verify the Kubernetes token changed before restarting. Any previously exposed global relay token must become invalid. Rotate credentials for any other legacy direct Figma service before treating it as private.
4. Patch the existing account relay with `kubectl --context aws-zivon-prod -n figma-mcp patch deployment figma-mcp --type=merge --patch-file=k8s/shared-account/legacy-strategy-patch.yaml`, then restart it and wait for rollout completion. The one-replica Recreate strategy prevents overlapping OAuth refreshers. Restart/deploy this policy proxy with the same new token reference. Existing connections will need to reconnect through their org-specific broker URL.
5. Apply `k8s/shared-account/resources.yaml` after setting its reviewed image tag. It configures the shared proxy, existing service-secret reference and HTTPS route, and repoints the old SpeakX public hostname to the guarded proxy. Unrestricted `/sse` calls then fail closed. The raw upstream account relay must remain server-only; do not publish its credential or allow tenants to bypass the policy proxy.
6. Verify health, missing/invalid token rejection, allowed file access, denied cross-org file/tool/session attempts, and rejection of the old global token against the private account relay before inviting additional clients to the shared account.

Production uses `aws-zivon-prod`, the `figma-mcp` namespace and `v2-zivon-core-service.zivon.svc.cluster.local`. The operations acceptance of email invitations is still manual; no Harshita mailbox integration was provisioned by this change. Customers should invite the base address, not `harshita+<org>@ivypods.com`.

## Compatibility and validation

The old dedicated-account credential API and exporter scripts remain solely for rollback/compatibility; the shared UI and proxy do not use them. An org in shared mode cannot read a dedicated OAuth bundle. Legacy single-account stdio/HTTP behavior remains the private upstream; it must not be exposed as the multi-tenant boundary.

`npm ci && npm test` runs the old relay tests and the new shared-account security tests: real MCP SSE clients, cross-org/file/session attempts, revocation, unknown tools/arguments, ownership-policy failures, and generated-code injection tests. Companion Core tests exercise authorization, non-disclosure, file claiming and transaction commit/abort paths. No production client file is modified by these tests.
