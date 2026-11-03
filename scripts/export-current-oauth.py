#!/usr/bin/env python3
"""Export one verified Figma authorization from Claude's file/Keychain store."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request

URL = "https://mcp.figma.com/mcp"


def load_store():
    source = Path(os.environ.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude"))) / ".credentials.json"
    if source.exists():
        return json.loads(source.read_text())
    if sys.platform != "darwin":
        raise RuntimeError("Claude credential file was not found; complete Figma authentication first")
    result = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError("Claude Keychain credentials could not be read")
    return json.loads(result.stdout)


def select_entry(store, name=None):
    entries = [(key, value) for key, value in store.get("mcpOAuth", {}).items()
               if (value.get("serverUrl") == URL or key.split("|")[0] in ("figma-remote-mcp", "plugin:figma:figma"))
               and (name is None or key == name or key.split("|")[0] == name)]
    if len(entries) != 1:
        raise RuntimeError("Expected one Figma authorization; use --entry to select the authenticated connection")
    key, value = entries[0]
    if any(not isinstance(value.get(field), str) or not value[field] for field in ("clientId", "clientSecret", "refreshToken", "accessToken")):
        raise RuntimeError("Figma authorization is incomplete; authenticate in Claude /mcp again")
    return key, value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def verify_account(credentials):
    headers = {"Authorization": "Bearer " + credentials["accessToken"], "Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    opener = urllib.request.build_opener(NoRedirect())

    def rpc(message):
        request = urllib.request.Request(URL, data=json.dumps(message).encode(), headers=headers, method="POST")
        with opener.open(request, timeout=25) as response:
            session = response.headers.get("Mcp-Session-Id")
            if session:
                headers["Mcp-Session-Id"] = session
            text = response.read().decode()
            if not text.strip():
                return {}
            try:
                messages = [json.loads(text)]
            except json.JSONDecodeError:
                messages = [json.loads(line[5:].strip()) for line in text.splitlines() if line.startswith("data:") and line[5:].strip()]
            return next((item for item in messages if item.get("id") == message.get("id")), {})

    init = rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "zivon-account-verification", "version": "1"}}})
    if not init.get("result"):
        raise RuntimeError("Figma initialization failed")
    headers["MCP-Protocol-Version"] = init["result"]["protocolVersion"]
    rpc({"jsonrpc": "2.0", "method": "notifications/initialized"})
    result = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "whoami", "arguments": {}}}).get("result", {})
    if result.get("isError"):
        raise RuntimeError("Figma identity verification failed")
    data = result.get("structuredContent")
    for item in result.get("content", []):
        if data is None and item.get("type") == "text":
            try:
                data = json.loads(item["text"])
            except json.JSONDecodeError:
                pass
    who = (data or {}).get("whoami", data or {})
    if not who.get("email"):
        raise RuntimeError("Figma did not return an account email")
    return who


def export(store, destination, expected_account, entry=None, verifier=verify_account):
    if Path(destination).exists():
        raise RuntimeError("Output file already exists; choose a new private path")
    name, credentials = select_entry(store, entry)
    who = verifier(credentials)
    if who["email"].lower() != expected_account.lower():
        raise RuntimeError("Authenticated Figma account does not match --account; no credentials exported")
    bundle = {"accountEmail": who["email"], **{key: credentials[key] for key in ("clientId", "clientSecret", "refreshToken")}}
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(bundle, output, indent=2)
    return {"accountEmail": who["email"], "server": name.split("|")[0], "credentialFile": str(Path(destination).absolute()), "permissions": "0600"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--entry")
    args = parser.parse_args()
    try:
        print(json.dumps(export(load_store(), args.output, args.account, args.entry)))
    except Exception:
        print("Export failed. Verify the expected Figma account, authentication, entry selection, Keychain access and a new output path. No credentials were printed. Expired access requires reconnecting Figma in Claude; this helper never refreshes a token.", file=sys.stderr)
        sys.exit(1)
