FROM docker.io/cloudflare/sandbox:0.12.5

RUN npm install -g @anthropic-ai/claude-code@2.1.195 vibepro@0.2.0-beta.8 \
  && mkdir -p /home/ryoko-dev /srv/openryoko-development

COPY --chmod=0555 container/task-search-mcp-server.mjs /opt/mana/task-search-mcp-server.mjs
COPY --chmod=0555 container/task-write-mcp-server.mjs /opt/mana/task-write-mcp-server.mjs
COPY --chmod=0555 container/nocodb-mcp-server.mjs /opt/mana/nocodb-mcp-server.mjs
COPY --chmod=0555 container/gateway-mcp-server.mjs /opt/mana/gateway-mcp-server.mjs
COPY --chmod=0555 container/brainbase-judgment-hook.mjs /opt/mana/brainbase-judgment-hook.mjs
COPY --chmod=0444 container/meeting-minutes-claude-settings.json /opt/mana/meeting-minutes-claude-settings.json
COPY --chmod=0555 container/cloudflare-development-runner.mjs /opt/mana/cloudflare-development-runner.mjs
COPY --chmod=0555 container/openryoko-development-runner.mjs /opt/mana/openryoko-development-runner.mjs
COPY --chmod=0444 container/openryoko-development-runner.json /etc/openryoko-development-runner.json

ENV COMMAND_TIMEOUT_MS=180000

EXPOSE 3000
