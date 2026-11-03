#!/bin/bash
# Shared-account setup; supports Claude's macOS Keychain and file stores.
# No downgrade, credential printing, account-alias assumption or cluster changes.
# Usage: bash scripts/setup-figma-oauth.sh <expected-email> <new-private-json-path>
set -euo pipefail
if [ "$#" -ne 2 ]; then
  echo 'Usage: setup-figma-oauth.sh <expected-email> <new-private-json-path>' >&2
  echo 'Example: setup-figma-oauth.sh developer@ivypods.com /private/tmp/figma-developer-new.credentials.json' >&2
  echo 'In Claude /mcp, authenticate either the Figma plugin or figma-remote-mcp first.' >&2
  exit 1
fi
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python3 "${SCRIPT_DIR}/export-current-oauth.py" --account "$1" --output "$2"
