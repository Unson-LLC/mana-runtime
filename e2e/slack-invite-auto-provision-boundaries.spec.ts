import { execFileSync } from 'node:child_process'
import { test, expect } from '@playwright/test'

// Story: slack-invite-auto-provision (docs/stories/slack-invite-auto-provision.md)
// Executable coverage markers map the 受け入れ基準 to the focused vitest
// suites, following the placement-read-filters-boundaries.spec.ts contract.
test.describe('Slack invite auto-provisioning boundaries', () => {
  test('focused suites satisfy the invite auto-provisioning acceptance contract', () => {
    const output = execFileSync(
      'pnpm',
      [
        '--filter', 'openryoko', 'exec', 'vitest', 'run', '--reporter=verbose',
        'src/shared/__tests__/placement-autoprovision.test.ts',
        'src/shared/__tests__/placement-profile.test.ts',
        'src/connectors/slack/__tests__/auto-provision-events.test.ts',
        'src/gateway/__tests__/route-options-channel-members.test.ts',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, CI: '1' },
      },
    )

    expect(output, 'vibepro: ac:1 auto-provision on invite — 標準プロファイルのplacementが生成・永続化される').toContain(
      'creates a channel-members placement with the standard profile on bot invite',
    )
    expect(output, 'vibepro: ac:1 書込は必ずconfig-historyスナップショット（source: auto-provision）を通る').toContain(
      'records a config-history snapshot with source auto-provision before writing',
    )
    expect(output, 'vibepro: ac:2 idempotent no-op — 既存placement（disabled含む）は上書きされない').toContain(
      'does nothing when a placement for the channel already exists (including disabled)',
    )
    expect(output, 'vibepro: ac:3 placement-mode gate — placements未構成では発動しない').toContain(
      'does not auto-provision when the placements key is not configured (placement-mode gate)',
    )
    expect(output, 'vibepro: ac:4 standard profile — placementDefaultsで上書きできる').toContain(
      'applies placementDefaults overrides from config.yaml',
    )
    expect(output, 'vibepro: ac:4 標準プロファイルの確定内容（owner=招待者・sonnet・budget10）').toContain(
      'builds the standard profile with the inviter as owner',
    )
    expect(output, 'vibepro: ac:5 channel-members audience — memberで解決される').toContain(
      'matches a channel-members placement when the speaker membership is member',
    )
    expect(output, 'vibepro: ac:5 conversations.members照会はTTLキャッシュ付き').toContain(
      'caches conversations.members lookups with a TTL and returns member/non-member',
    )
    expect(output, 'vibepro: ac:5 API失敗・判定不能・非対応connectorはfail-closed').toContain(
      'denies channel-members placements when membership is non-member, unknown, or unstated (fail-closed)',
    )
    expect(output, 'vibepro: ac:5 members API失敗はunknown（拒否）に倒れる').toContain(
      'returns unknown when the members API fails (fail-closed)',
    )
    expect(output, 'vibepro: ac:5 routing gateがmembership判定をresolvePlacementへ受け渡す').toContain(
      'passes channel membership through to placement resolution',
    )
    expect(output, 'vibepro: ac:6 personal KG deny — 全placementセッションのdisallowedToolsに恒常追加').toContain(
      "adds the personal KG tool deny to every placement session's disallowedTools",
    )
    expect(output, 'vibepro: ac:7 greeting once — owner・できること3行・昇格経路を含む挨拶が1回だけ').toContain(
      'builds a greeting that names the owner and the escalation path',
    )
    expect(output, 'vibepro: ac:7 生成イベント時のみ投稿（bot自身のjoinのみ発火）').toContain(
      'invokes onBotJoinedChannel only when the bot itself joins',
    )
    expect(output, 'vibepro: ac:8 disable on leave — enabled: falseへ更新し監査痕跡を残す').toContain(
      'disables the placement on bot leave while keeping the entry (audit trail)',
    )
    expect(output, 'vibepro: ac:8 channel_left / group_left の両方で無効化が発火する').toContain(
      'invokes onBotLeftChannel on channel_left and group_left',
    )
    expect(output, 'vibepro: ac:9 fail-closed on error — 書込失敗時にconfig.yamlへ中途半端なplacementを書かない').toContain(
      'leaves config.yaml untouched when the write fails (fail-closed)',
    )
  })

  test('jimmy typecheck passes alongside the focused suites (done evidence)', () => {
    const output = execFileSync(
      'pnpm',
      ['--filter', 'openryoko', 'exec', 'tsc', '--noEmit'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, CI: '1' },
      },
    )

    expect(output, 'vibepro: ac:11 done evidence — packages/jimmyのtsc --noEmitがエラーなしで通る（vitest全件は上のfocused suites実行で担保）').not.toContain('error TS')
  })

  test('placements ledger shows the auto-provisioned row with owner and purpose (AUTOPROV-STORY-S-001)', () => {
    const output = execFileSync(
      'pnpm',
      [
        '--filter', '@openryoko/web', 'exec', 'vitest', 'run', '--reporter=verbose',
        'src/app/placements/__tests__/placements-ledger.test.tsx',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, CI: '1' },
      },
    )

    expect(output, 'vibepro: ac:10 ledger visibility — 台帳で自動生成placementがowner・purpose付きで見える (AUTOPROV-STORY-S-001, spec S-001)').toContain(
      'renders an auto-provisioned placement row with owner and purpose (AUTOPROV-STORY-S-001)',
    )
  })
})
