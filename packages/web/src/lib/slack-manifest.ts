export function buildSlackManifest(botName?: string | null): string {
  const name = (botName ?? "").trim() || "Ryoko"
  return JSON.stringify(
    {
      display_information: { name },
      features: {
        app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
        bot_user: { display_name: name, always_online: true },
        assistant_view: {
          assistant_description: `${name} — your AI assistant`,
          suggested_prompts: [{ title: "What can you do?", message: "What can you help me with?" }],
        },
        slash_commands: [{
          command: "/vibepro",
          description: "Start an isolated VibePro development task",
          should_escape: true,
        }],
      },
      oauth_config: {
        scopes: {
          bot: [
            "app_mentions:read", "assistant:write", "canvases:read", "canvases:write",
            "channels:history", "channels:read", "chat:write", "chat:write.customize",
            "commands", "files:read", "files:write", "groups:history", "groups:read",
            "im:history", "im:read", "im:write", "mpim:history", "mpim:read",
            "mpim:write", "reactions:read", "reactions:write", "users:read", "users:read.email",
          ],
          user: [
            "channels:history", "channels:read", "files:read", "groups:history", "groups:read",
            "im:history", "im:read", "mpim:history", "mpim:read", "search:read", "users:read",
            "bookmarks:read",
          ],
        },
      },
      settings: {
        event_subscriptions: {
          bot_events: [
            "app_mention", "assistant_thread_context_changed", "assistant_thread_started",
            "message.channels", "message.groups", "message.im", "message.mpim", "reaction_added",
          ],
        },
        socket_mode_enabled: true,
      },
    },
    null,
    2,
  )
}
