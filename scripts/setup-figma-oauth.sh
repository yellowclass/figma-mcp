#!/bin/bash
# Ops-only bootstrap. Use one isolated Claude profile per dedicated Figma user.
# Usage: ./scripts/setup-figma-oauth.sh <zivon-org-slug> <new-private-json-path>
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo 'Usage: setup-figma-oauth.sh <zivon-org-slug> <new-private-json-path>' >&2
  exit 1
fi
if ! [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]; then
  echo 'Invalid org slug' >&2
  exit 1
fi

if ! claude mcp get figma-remote-mcp >/dev/null 2>&1; then
  claude mcp add --transport http figma-remote-mcp https://mcp.figma.com/mcp
fi
printf 'Expected Figma account: developer+%s@iypods.com\n' "$1"
echo 'In this same isolated Claude profile, run claude, open /mcp and authenticate figma-remote-mcp.'
echo 'Check the Figma account in the browser and accept only this client’s invitation.'
echo 'The exporter records your declared account; it cannot verify the identity behind the OAuth token.'
read -r -p 'Press ENTER after verifying the account and completing OAuth: '

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
node "${SCRIPT_DIR}/export-oauth.mjs" "$1" "$2"
echo 'OAuth bundle saved with private permissions. Import it using scripts/configure-org.mjs.'
