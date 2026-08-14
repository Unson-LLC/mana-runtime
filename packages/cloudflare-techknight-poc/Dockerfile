FROM docker.io/cloudflare/sandbox:0.12.5

RUN npm install -g @anthropic-ai/claude-code@2.1.195

COPY --chmod=0555 container/task-search-mcp-server.mjs /opt/mana/task-search-mcp-server.mjs
COPY --chmod=0555 container/task-write-mcp-server.mjs /opt/mana/task-write-mcp-server.mjs
COPY --chmod=0555 container/nocodb-mcp-server.mjs /opt/mana/nocodb-mcp-server.mjs

ENV COMMAND_TIMEOUT_MS=180000

EXPOSE 3000
