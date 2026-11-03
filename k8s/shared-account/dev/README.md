# Independent dev Figma deployment

Dev has its own account relay, multitenant policy proxy, OAuth client/grant, transport token, Core service authentication, and ECR image. Both deployments run in aws-zivon-dev. No production service, production secret, or production gateway route is referenced.

Requests follow: dev Envoy → dev policy proxy → private dev account relay → Figma. The policy proxy validates org tokens, destinations, file ownership and creation intents against dev Core. Its public host is https://figma-mcp-dev.zivon.ai; the account relay is a ClusterIP-only service, with no public route.

## Configure and apply

1. Independently authorize the desired dev Figma account. A separate OAuth client/grant is required; do not copy the production grant. Store FIGMA_OAUTH_CLIENT_ID, FIGMA_OAUTH_CLIENT_SECRET and FIGMA_OAUTH_REFRESH_TOKEN plus a new random MCP_AUTH_TOKEN in `zivon/dev/figma-mcp-secrets`.
2. Keep dev Core's FIGMA_RELAY_SERVICE_SECRET in sync with `zivon/dev/figma-mcp-core-auth`. ExternalSecrets uses the dev ClusterSecretStore's `zivon/dev/` prefix.
3. Promote the tested image to dev ECR and apply resources.yaml to aws-zivon-dev. Wait for ExternalSecrets and both deployments.
4. Set FIGMA_SHARED_RELAY_BASE_URL=https://figma-mcp-dev.zivon.ai and FIGMA_SHARED_ACCOUNT_EMAIL to the dev-authorized account in the dev Core source/live secret, then restart dev Core. Release-pinned Core ExternalSecrets can have refreshInterval=0, so AWS changes alone may wait until the next release.
5. Reconnect any previously configured dev organisations so stored URLs use the dev host. Verify dev-issued org tokens, creation, canvas edits, metadata and foreign-file rejection. HTTP health alone is insufficient.

Dev and production may use separate authorizations of the same Figma user, or different Figma users, according to the accounts explicitly authorized by operations. Figma seat and folder permissions still apply to the selected dev account.

## Live verification

Deployed application revision `1f89ea6` in both dev deployments. The account relay identifies as developer@ivypods.com with a Full seat in SpeakX Product Design, using a separate dev OAuth client and refresh token. Dev Core has FIGMA_SHARED_RELAY_BASE_URL=https://figma-mcp-dev.zivon.ai in both its persistent AWS source and live configuration, and was restarted.

An existing dev destination was reconnected through the standard org settings flow. Authenticated testing through the public dev org MCP endpoint created a file using real dev Core reservation/registration, edited its canvas, confirmed the new frame through metadata, and rejected an unassigned file key. Public health returned 200; bearerless org access returned 401; the unscoped /sse route returned 404. These checks do not change or bypass Envoy tool approval policies.
