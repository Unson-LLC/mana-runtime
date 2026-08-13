#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
server="$repo_root/packages/jimmy/dist/src/mcp/google-drive-server.js"

# Keep this deploy-contract test self-contained in clean CI checkouts.
pnpm --dir "$repo_root" --filter openryoko... build
[[ -f "$server" ]]

output_file="$(mktemp)"
fixture_dir="$(mktemp -d)"
stable_server="$fixture_dir/google-drive-server.js"
ln -s "$server" "$stable_server"
trap 'rm -f "$output_file"; unlink "$stable_server"; rmdir "$fixture_dir"' EXIT

printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"protocol-test","version":"1.0.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | GOOGLE_DRIVE_CLI_BIN=/usr/bin/true \
    GOOGLE_DRIVE_EXPECTED_ACCOUNT=info@unson.jp \
    node "$stable_server" > "$output_file"

grep -Fq '"serverInfo":{"name":"mana-google-drive","version":"1.2.0"}' "$output_file"
grep -Fq '"name":"create_file"' "$output_file"
echo "Google Drive MCP initialize and tools/list protocol fixture passed through the deployed symlink contract"

bash "$repo_root/scripts/deploy/test-deploy-scripts.sh"
