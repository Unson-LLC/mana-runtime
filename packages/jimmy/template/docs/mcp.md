# MCP (Model Context Protocol) Integration

{{portalName}} automatically configures MCP servers for AI engine sessions, giving employees access to browser automation, web search, and gateway tools without manual setup.

## How It Works

1. MCP servers are defined in `config.yaml` under the `mcp:` section
2. When a session starts, {{portalName}} resolves which MCP servers the employee needs
3. A temporary MCP config JSON file is written to `~/.jinn/tmp/mcp/`
4. The file is passed to Claude Code via `--mcp-config <path>`
5. The file is cleaned up after the session completes

## Built-in MCP Servers

### Browser (Playwright)
Full browser automation — navigate, click, type, screenshot, extract content.

```yaml
mcp:
  browser:
    enabled: true
    provider: playwright  # or "puppeteer"
```

### Web Search (Brave)
Search the web and get structured results.

```yaml
mcp:
  search:
    enabled: true
    provider: brave
    apiKey: ${BRAVE_API_KEY}  # reads from environment variable
```

### Fetch
Extract readable content from URLs (HTML → markdown/text).

```yaml
mcp:
  fetch:
    enabled: true
```

### Gateway
Built-in MCP server that wraps {{portalName}}'s own API. Gives employees tools to:
- Send messages via connectors (Slack, etc.)
- List and query sessions
- Manage cron jobs
- Query the org structure
- Update department boards

```yaml
mcp:
  gateway:
    enabled: true  # enabled by default
```

## Custom MCP Servers

Add any MCP server via the `custom:` section:

```yaml
mcp:
  custom:
    my-database:
      enabled: true
      command: npx
      args: ["-y", "@my/mcp-server-postgres"]
      env:
        DATABASE_URL: ${DATABASE_URL}
    my-api:
      command: node
      args: ["/path/to/my-mcp-server.js"]
```

### Google Drive (account-pinned)

Google Drive can be exposed through Mana's Drive-only MCP adapter. The adapter
uses the current Google Workspace CLI for API calls, verifies the authenticated
account before every operation, omits delete/share tools, and restricts local
uploads to configured roots. Keep its credential store separate from other
Google accounts.

```bash
npm install --prefix /home/ryoko/mcp/google-workspace-cli @googleworkspace/cli@0.22.5
install -m 0755 \
  /home/ryoko/mcp/google-workspace-cli/node_modules/@googleworkspace/cli/bin/gws \
  /home/ryoko/bin/gws-drive-cli
install -m 0755 \
  /home/ryoko/current/packages/jimmy/dist/src/mcp/google-drive-server.js \
  /home/ryoko/mcp/google-drive-server.js
```

```yaml
mcp:
  custom:
    google-drive:
      enabled: true
      command: node
      args: ["/home/ryoko/mcp/google-drive-server.js"]
      env:
        GOOGLE_DRIVE_CLI_BIN: /home/ryoko/bin/gws-drive-cli
        GOOGLE_DRIVE_EXPECTED_ACCOUNT: info@unson.jp
        GOOGLE_DRIVE_ALLOWED_UPLOAD_ROOTS: /home/ryoko/workspaces
        GOOGLE_WORKSPACE_CLI_CONFIG_DIR: /home/ryoko/.config/gws-info-unson
        GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: file
```

Only placements that explicitly include `google-drive` in
`capabilities.mcp` receive `mcp__google-drive__*` tools. The account credential
may cover the whole Drive, but folder/channel restrictions must not rely on
`dataScopes`; enforce those restrictions in a request-validating MCP proxy
before enabling them.

See [Google Drive MCP operations](../../../../docs/operations/google-drive-mcp.md)
for authentication, deployment, and verification.

## Per-Employee Overrides

Employees can opt out of MCP servers or request only specific ones:

```yaml
# In employee YAML (e.g. org/engineering/backend-dev.yaml)
name: backend-dev
mcp: false  # No MCP servers at all

# Or specific servers only:
mcp:
  - search
  - gateway
```

By default, all globally enabled MCP servers are available to all employees.

## Environment Variables

API keys and secrets should use `${VAR_NAME}` syntax to reference environment variables:

```yaml
mcp:
  search:
    apiKey: ${BRAVE_API_KEY}
  custom:
    stripe:
      env:
        STRIPE_KEY: ${STRIPE_SECRET_KEY}
```

This keeps secrets out of config files.
