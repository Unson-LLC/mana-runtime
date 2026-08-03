import { describe, expect, it } from "vitest"
import { buildSlackManifest } from "../slack-manifest"

describe("buildSlackManifest", () => {
  it("includes the native development command and Socket Mode contract", () => {
    const manifest = JSON.parse(buildSlackManifest("Pilot Ryoko"))

    expect(manifest.features.slash_commands).toContainEqual(
      expect.objectContaining({ command: "/vibepro" }),
    )
    expect(manifest.oauth_config.scopes.bot).toContain("commands")
    expect(manifest.settings.socket_mode_enabled).toBe(true)
    expect(manifest.features.app_home).toMatchObject({
      home_tab_enabled: true,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    })
    expect(manifest.settings.event_subscriptions.bot_events).toContain("app_home_opened")
    expect(JSON.stringify(manifest)).not.toContain("/ryoko-develop")
    expect(JSON.stringify(manifest)).not.toContain("request_url")
  })
})
