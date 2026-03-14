#!/bin/bash
# ---------------------------------------------------------------------------
# setup-figma-oauth.sh
#
# ONE-TIME SETUP: Run this on a machine with a browser to authenticate with
# Figma and extract OAuth credentials for the Figma MCP server.
#
# PREREQUISITES:
#   1. Install Claude Code (https://claude.ai/download)
#   2. Install the Figma plugin / add figma-remote-mcp to Claude
#
# What this script does:
#   1. Adds figma-remote-mcp to Claude CLI (if not already added)
#   2. Prompts you to authenticate via Figma OAuth (opens browser)
#   3. Extracts clientId, clientSecret, refreshToken from Claude's credentials
#   4. Prints credentials to add to k8s/secret.yaml
#
# USAGE:
#   chmod +x scripts/setup-figma-oauth.sh
#   ./scripts/setup-figma-oauth.sh
#
# OUTPUT: FIGMA_OAUTH_CLIENT_ID, FIGMA_OAUTH_CLIENT_SECRET, FIGMA_OAUTH_REFRESH_TOKEN
# Add these to k8s/secret.yaml (replace the placeholders).
# ---------------------------------------------------------------------------

set -euo pipefail

CREDS_FILE="${HOME}/.claude/.credentials.json"

echo "=== Figma OAuth Setup for Designer Specialist ==="
echo ""

# Step 1: Add figma-remote-mcp
echo "[1/4] Adding figma-remote-mcp to Claude CLI..."
claude mcp add --transport http figma-remote-mcp https://mcp.figma.com/mcp 2>&1 || true
echo ""

# Step 2: Prompt for auth
echo "[2/4] You need to authenticate with Figma."
echo ""
echo "  Run this in another terminal:"
echo "    claude"
echo "  Then type: /mcp"
echo "  Select figma-remote-mcp and click 'Authenticate'"
echo "  Complete the Figma login in your browser."
echo ""
read -p "Press ENTER after you've completed the Figma OAuth login... "
echo ""

# Step 3: Extract credentials
echo "[3/4] Extracting OAuth credentials from ${CREDS_FILE}..."

if [ ! -f "$CREDS_FILE" ]; then
  echo "ERROR: ${CREDS_FILE} not found. Did the OAuth succeed?"
  exit 1
fi

# Extract the figma-remote-mcp OAuth entry
OAUTH_DATA=$(python3 -c "
import json, sys

creds = json.load(open('${CREDS_FILE}'))
mcp_oauth = creds.get('mcpOAuth', {})

# Find figma-remote-mcp entry
for key, val in mcp_oauth.items():
    if key.startswith('figma-remote-mcp|'):
        client_id = val.get('clientId', '')
        client_secret = val.get('clientSecret', '')
        refresh_token = val.get('refreshToken', '')
        access_token = val.get('accessToken', '')

        if not client_id or not client_secret:
            print('ERROR: clientId or clientSecret missing', file=sys.stderr)
            sys.exit(1)
        if not refresh_token and not access_token:
            print('ERROR: No refreshToken or accessToken found. Did you complete OAuth?', file=sys.stderr)
            sys.exit(1)

        print(f'{client_id}|{client_secret}|{refresh_token}')
        sys.exit(0)

print('ERROR: No figma-remote-mcp entry found in mcpOAuth', file=sys.stderr)
sys.exit(1)
") || { echo "Failed to extract credentials"; exit 1; }

CLIENT_ID=$(echo "$OAUTH_DATA" | cut -d'|' -f1)
CLIENT_SECRET=$(echo "$OAUTH_DATA" | cut -d'|' -f2)
REFRESH_TOKEN=$(echo "$OAUTH_DATA" | cut -d'|' -f3)

if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
  echo "ERROR: Could not extract OAuth credentials."
  exit 1
fi

if [ -z "$REFRESH_TOKEN" ]; then
  echo "WARNING: No refresh token found. The access token may expire."
  echo "Try re-authenticating."
fi

echo "  Client ID:     ${CLIENT_ID:0:8}..."
echo "  Client Secret: ${CLIENT_SECRET:0:8}..."
echo "  Refresh Token: ${REFRESH_TOKEN:0:8}..."
echo ""

# Step 4: Print credentials for manual secret creation
echo "[4/4] OAuth credentials extracted successfully!"
echo ""
echo "Add these to k8s/secret.yaml (replace the placeholders):"
echo ""
echo "  FIGMA_OAUTH_CLIENT_ID=${CLIENT_ID}"
echo "  FIGMA_OAUTH_CLIENT_SECRET=${CLIENT_SECRET}"
echo "  FIGMA_OAUTH_REFRESH_TOKEN=${REFRESH_TOKEN}"
echo ""
echo "=== Done! ==="
