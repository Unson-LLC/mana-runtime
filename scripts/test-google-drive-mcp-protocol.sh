#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
server="$repo_root/packages/jimmy/dist/src/mcp/google-drive-server.js"
[[ -f "$server" ]] || {
  echo "Google Drive MCP build output is missing; run pnpm build first" >&2
  exit 1
}

output_file="$(mktemp)"
trap 'rm -f "$output_file"' EXIT

printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"protocol-test","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | GOOGLE_DRIVE_CLI_BIN=/usr/bin/true \
    GOOGLE_DRIVE_EXPECTED_ACCOUNT=info@unson.jp \
    node "$server" > "$output_file"

grep -Fq '"serverInfo":{"name":"mana-google-drive","version":"1.2.0"}' "$output_file"
grep -Fq '"name":"create_file"' "$output_file"
echo "Google Drive MCP initialize and tools/list protocol fixture passed"
