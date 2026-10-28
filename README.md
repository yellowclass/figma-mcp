# Figma MCP relay

A shared relay to Figma's hosted MCP, with one dedicated Figma identity per Zivon org. Clients only invite `developer+<zivon-org-slug>@iypods.com` to their workspace/project with the required file permissions. Zivon operations creates the account, accepts the invitation, authorizes it and configures the connection. Invitation alone does not create OAuth credentials. Each alias must be a separate Figma account; a second token for the same account does not restrict that account's access.

## Operations setup

1. Create/sign into the dedicated Figma account, accept the client's invitation and verify its file access and required Figma seat. Keep this account out of other clients' workspaces.
2. Authorize that account with the supported Figma MCP OAuth client/registration used by your deployment. If using the existing Claude bootstrap, authenticate in a separate ops profile per account. Verify the signed-in Figma account before exporting credentials; the setup endpoint validates the declared email, not Figma's identity behind a token. Never assume client ID and secret are shared between registrations.
3. Prepare a private JSON file (mode `0600`) with the complete authorization:

```json
{
  "accountEmail": "developer+acme@iypods.com",
  "clientId": "<OAuth registration client ID>",
  "clientSecret": "<OAuth registration client secret>",
  "refreshToken": "<refresh token issued for this account>"
}
```

4. Set `CORE_INTERNAL_URL`, `FIGMA_RELAY_SERVICE_SECRET` and `FIGMA_RELAY_BASE_URL` in your ops environment. Core must be reached through its private service or an authenticated tunnel. The relay base URL is the HTTPS origin without a path. Run from this repo:

```sh
node scripts/configure-org.mjs acme /private/path/acme.credentials.json
```

The command saves encrypted OAuth credentials in Core's `organisations.integrations`, generates an org-specific relay token, sets `figma_mcp_url` to `https://<relay>/orgs/acme/sse`, and synchronizes the existing Figma catalogue row/admission. It returns non-secret setup metadata. No credential needs to be passed to the client. Re-run to reauthorize the account or repair catalogue synchronization; managed connections retain their relay token. Migrating an old global connection generates a new token.

The ops bootstrap can export the authorization without printing secrets:

```sh
./scripts/setup-figma-oauth.sh acme /private/path/acme.credentials.json
```

Use a separate `CLAUDE_CONFIG_DIR` per dedicated account. The exporter refuses ambiguous Figma entries, requires a refresh token, writes with mode `0600`, and refuses to overwrite a prior export. `FIGMA_OAUTH_ENTRY_KEY` can explicitly select an entry if needed. The operator must still verify the Figma identity in the browser before export.

The settings panel shows the invite address and leaves existing render relay settings under advanced connection settings. This change configures the hosted MCP; it does not provision any separate render relay, file opener or Figma runner.

## Deploy

Configure `TOKEN_ENCRYPTION_KEY` and the dedicated `FIGMA_RELAY_SERVICE_SECRET` in Core. The new endpoints refuse plaintext storage when encryption is disabled. Do not reuse a secret distributed to agent runtimes. Deploy Core first, then build the relay image (the Dockerfile includes `upstream.mjs` and `tenants.mjs`). Update the image reference to the newly built tag; the existing deployment's image tag does not contain this implementation.

Multi-tenant environment:

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP listener, e.g. `3100` |
| `CORE_INTERNAL_URL` | Private Core service origin |
| `FIGMA_RELAY_SERVICE_SECRET` | Dedicated secret configured in Core; never injected into agent runtimes |

Create a Kubernetes Secret named `figma-mcp-core-auth` in the `figma-mcp` namespace containing `FIGMA_RELAY_SERVICE_SECRET` through your existing secret-management workflow. Review the Core service URL in `k8s/multi-tenant.patch.yaml`, then apply that strategic merge patch to the existing deployment. It preserves telemetry and scheduling settings, removes the global Figma credentials, and uses `Recreate` with one replica.

**Run one relay process/replica.** Refresh coordination and SSE sessions are in process memory. Do not enable rolling overlap, HPA or multiple replicas until refresh locking/access-token sharing and SSE routing are implemented across replicas. A restart closes active sessions; clients reconnect. Recreate avoids old/new relay processes refreshing the same authorization simultaneously.

Runtime baseline: use the literal `@staging` branches of Core, Envoy, gateway and orchestrator. They already mount `GET /api/orgs/{slug}/mcp/figma` and `POST .../mcp/figma/*`. The orchestrator fetches each org's existing relay URL/token, filters tools through its Figma MCPGuard, and rewrites the relay's announced message endpoint. The org-specific `/orgs/<slug>/messages` endpoint fits that existing wildcard route; no runtime credential exposure is needed. Older `master` gateway/orchestrator checkouts lack this broker.

In multi-tenant mode `/sse` is absent. Connections use `/orgs/<slug>/sse` and their org's `FIGMA_MCP_AUTH_TOKEN`, which Core already supplies through Zivon's existing credential flow. The SSE endpoint advertises `/orgs/<slug>/messages?sessionId=...`. Route both paths through your ingress. `/health` reports process health, not whether each account has Figma permission.

Do not configure a fallback identity. Missing Core credentials, invalid org tokens, revoked connections and Core outages fail closed. Clear the org's existing `figma_mcp_auth_token` in Core to revoke relay access. Reauthorize with the ops command to replace OAuth credentials; existing sessions then need to reconnect.

Legacy mode remains available when `CORE_INTERNAL_URL` is absent: the original `FIGMA_OAUTH_*`/`FIGMA_ACCESS_TOKEN` environment variables and `MCP_AUTH_TOKEN` operate one account over `/sse`, or stdio without `PORT`. Keep this mode separate from a multi-tenant deployment.

## Internal Core API

All methods on `/internal/orgs/{slug}/figma-credentials` enforce `X-Internal-Secret`:

- `PUT`: operations setup with the single-account bundle, `accountEmail` and `relayBaseUrl`. Secrets are encrypted and excluded from customer settings/reveal/audit values and general credential registries.
- `GET`: relay credential lookup; additionally requires the org's `X-Figma-Relay-Token`. Returns only that org's OAuth bundle, with `Cache-Control: no-store`.
- `POST`: persist refresh-token rotation, authenticated as above, with `{previous: {clientId, clientSecret, refreshToken}, refreshToken}`. Uses a Mongo ciphertext snapshot to avoid overwriting a newer authorization. Repeating a completed rotation is idempotent.

The relay authenticates against Core on every SSE connection and message POST. Upstream access tokens, sessions, tools and refresh promises are isolated per org. Concurrent refreshes within the process share one operation. Returned refresh tokens are persisted before using the new access token. If persistence fails, the pending rotation remains in memory and is retried before another OAuth refresh. A crash during the provider-to-Core rotation window can still require ops reauthorization; there is no atomic transaction spanning Figma and MongoDB.

The OAuth client registration must support your deployed SaaS integration; this relay does not change Figma's registration, permissions or seat requirements.

## Validation

```sh
npm ci
npm test
```

Tests use real MCP SSE clients against the relay and mocked Figma responses: org/session isolation, revocation, reauthorization, credential outages, refresh serialization, rotation persistence and legacy 401 recovery. Core has complementary tests for service authentication, encrypted setup, disclosure boundaries and stale rotations. No live Figma account is touched by tests.
