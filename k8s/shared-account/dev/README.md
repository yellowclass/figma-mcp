# Dev Figma policy proxy

Dev runs its own `figma-mcp-multitenant` deployment and ECR image. `CORE_INTERNAL_URL` resolves to dev Core inside aws-zivon-dev, so org tokens, destination bindings, file ownership and creation intents are validated against dev storage. Clients use `https://figma-mcp-dev.zivon.ai/orgs/<slug>/sse`.

The account identity remains centrally operated. Dev does not receive OAuth client secrets or refresh tokens, and must not run a second relay refreshing the same grant. Its upstream is `https://figma-account-dev.zivon.ai/sse`, protected by both a production gateway SecurityPolicy allowing only dev NAT `35.154.19.252/32` and the account relay's transport bearer token. No prod org tokens or Core service credentials are copied to dev.

## Apply order

1. Promote the tested image to dev ECR, pinned by digest in resources.yaml.
2. Store dev's own FIGMA_RELAY_SERVICE_SECRET in dev Core and `zivon/dev/figma-mcp-core-auth`. Store only the shared account transport token in `zivon/dev/figma-mcp-upstream-auth`.
3. **Requires explicit production-boundary approval:** apply production-account-route.yaml to aws-zivon-prod. For initial installation, strip the Authorization header at the route until its SecurityPolicy is accepted, then remove that temporary filter. This prevents successful account calls before the allowlist is attached. Verify off-network access and forged X-Forwarded-For are denied, and dev bearerless requests are rejected by the account relay.
4. Apply resources.yaml to aws-zivon-dev. Wait for both ExternalSecrets to sync and the deployment to become ready. Verify the account relay is reachable from this pod with its bearer token, without printing that token.
5. Set FIGMA_SHARED_RELAY_BASE_URL=https://figma-mcp-dev.zivon.ai and FIGMA_SHARED_ACCOUNT_EMAIL to the actual account in the dev Core source secret and live secret; restart dev Core. Release-pinned Core ExternalSecrets may have refreshInterval=0, so changing the AWS source alone is insufficient until the next release.
6. Reconnect configured dev organisations so stored integration URLs use the dev host. Confirm a dev-issued org token succeeds only against the dev proxy; test creation, metadata and canvas editing through it.

Only resources.yaml belongs in dev. production-account-route.yaml is narrowly scoped production-side infrastructure; it does not replace either production Figma service or public tenant route. Production routing changes must not be applied until approved.

## Current validation

The same application revision passed all 23 MCP tests. The dev manifest passes Kubernetes server-side dry-run after namespace creation. Complete live smoke tests after the account relay connection is approved and installed; a ready HTTP health check alone does not establish working org access.
