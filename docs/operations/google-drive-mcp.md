# Google Drive MCP operations

Mana Runtime exposes the `info@unson.jp` Google Drive account through its
existing custom MCP catalog. This runbook keeps the OAuth credential out of
`config.yaml`, restricts the server surface to Drive plus Sheets value I/O,
and preserves placement deny-by-default behavior.

## Fixed components

- MCP server name: `google-drive`
- Google account: `info@unson.jp`
- Package: `@googleworkspace/cli@0.22.5`
- Credential directory: `/home/ryoko/.config/gws-info-unson`
- Install directory: `/home/ryoko/mcp/google-workspace-cli`
- Runtime binary: `/home/ryoko/bin/gws-drive-cli`

The Google Workspace CLI removed its native MCP transport and multi-account
selection after `0.6.3`. Mana therefore supplies the MCP transport itself and
uses a dedicated CLI config directory containing only `info@unson.jp`.

## Install

Run as the `ryoko` service user:

```bash
npm install --prefix /home/ryoko/mcp/google-workspace-cli @googleworkspace/cli@0.22.5
install -m 0755 \
  /home/ryoko/mcp/google-workspace-cli/node_modules/@googleworkspace/cli/bin/gws \
  /home/ryoko/bin/gws-drive-cli
ln -sfn \
  /home/ryoko/current/packages/jimmy/dist/src/mcp/google-drive-server.js \
  /home/ryoko/mcp/google-drive-server.js
/home/ryoko/bin/gws-drive-cli --version
```

Use a Desktop OAuth client whose Google Cloud project has the Drive API enabled.
Place its client file at
`/home/ryoko/.config/gws-info-unson/client_secret.json`, with directory mode
`0700` and file mode `0600`. Then authenticate only Drive:

```bash
GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/home/ryoko/.config/gws-info-unson \
GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file \
  /home/ryoko/bin/gws-drive-cli auth login \
  --scopes https://www.googleapis.com/auth/drive
```

Never commit the OAuth client or generated credential files to either the
application repository or `/home/ryoko/.ryoko` config history.

The deploy script atomically maintains this symlink and verifies that it
resolves into the activated release. Rollback changes `/home/ryoko/current`, so
the adapter rolls back with the rest of the runtime.

## Runtime configuration

Add the following server to `mcp.custom`:

```yaml
google-drive:
  type: stdio
  command: /home/ryoko/.nvm/versions/node/v22.23.1/bin/node
  args: [/home/ryoko/mcp/google-drive-server.js]
  env:
    GOOGLE_DRIVE_CLI_BIN: /home/ryoko/bin/gws-drive-cli
    GOOGLE_DRIVE_EXPECTED_ACCOUNT: info@unson.jp
    GOOGLE_DRIVE_ALLOWED_UPLOAD_ROOTS: /home/ryoko/workspaces
    GOOGLE_WORKSPACE_CLI_CONFIG_DIR: /home/ryoko/.config/gws-info-unson
    GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: file
  enabled: true
```

Add `google-drive` only to the `capabilities.mcp` arrays of placements that
should use it. A configured global server is not sufficient: the placement
allowlist is the runtime authorization boundary.

For generated artifacts, prefer `create_file` with a `name` and exactly one of
UTF-8 `content` or `contentBase64`. The adapter writes those bytes to a private
temporary file, uploads it, and removes the temporary file on both success and
failure. Inline content is limited to 20 MiB. `upload_file` remains available
for larger pre-existing artifacts, but its `sourcePath` must remain below
`GOOGLE_DRIVE_ALLOWED_UPLOAD_ROOTS`; do not broaden that allowlist to OS temp
directories.

The broad account credential does not itself enforce per-folder access. Before
introducing channel- or user-specific Drive scopes, put a request-validating
proxy in front of this server and enforce folder ancestry there. `dataScopes`
is supplementary context and is not an authorization mechanism.

## Verification

Run all commands with the isolated config directory and account selector:

```bash
export GOOGLE_WORKSPACE_CLI_CONFIG_DIR=/home/ryoko/.config/gws-info-unson
export GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file
GWS=/home/ryoko/bin/gws-drive-cli

$GWS drive about get --params '{"fields":"user(emailAddress,displayName)"}'
$GWS drive files list --params '{"pageSize":1,"fields":"files(id,name,webViewLink)"}'
```

Then verify the MCP protocol (`initialize`, `tools/list`) and perform two
reversible production journeys through Mana: create a text artifact with
`create_file`, and create/populate/read a spreadsheet with
`create_spreadsheet`, `write_sheet_values`, and `get_sheet_values`. In each
journey obtain the Drive-returned `webViewLink` and return it to the originating
Slack thread. Record local tests, MCP protocol evidence, the Drive artifact
ID/link, and the Slack permalink separately; none of them substitutes for
another.
