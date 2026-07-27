import { describe, expect, it } from "vitest"
import { buildSlackManifest } from "../slack-manifest"

describe("buildSlackManifest", () => {
  it("includes the native development command and Socket Mode contract", () => {
    const manifest = JSON.parse(buildSlackManifest("Pilot Ryoko"))

    expect(manifest.features.slash_commands).toContainEqual(
      expect.objectContaining({ command: "/ryoko-develop" }),
    )
    expect(manifest.oauth_config.scopes.bot).toContain("commands")
    expect(manifest.settings.socket_mode_enabled).toBe(true)
    expect(JSON.stringify(manifest)).not.toContain("request_url")
  })
})
