import { execFileSync } from 'node:child_process'
import { test, expect } from '@playwright/test'

// Story: placement-allowed-tools (docs/stories/placement-allowed-tools.md)
// Executable coverage markers map the 受け入れ基準 to the focused vitest
// suites, following the agent-ledger-gaps-boundaries.spec.ts contract.
test.describe('Placement allowed-tools boundaries', () => {
  test('focused suites satisfy the placement allowed-tools acceptance contract', () => {
    const output = execFileSync(
      'pnpm',
      [
        '--filter', 'openryoko', 'exec', 'vitest', 'run', '--reporter=verbose',
        'src/shared/__tests__/placement-profile.test.ts',
        'src/engines/__tests__/claude-interactive.test.ts',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, CI: '1' },
      },
    )

    expect(output, 'vibepro: ac:1 capability-derived allow — capabilities.mcpからサーバー全体許可が導出される').toContain(
      'derives a whole-server allow rule for every capabilities.mcp server except gateway',
    )
    expect(output, 'vibepro: ac:1 capabilities.gatewayToolsからmcp__gateway__<tool>の個別許可が導出される').toContain(
      'derives per-tool gateway allow rules from capabilities.gatewayTools',
    )
    expect(output, 'vibepro: ac:1 deny by default — capabilities.mcpがfalse/未設定なら何も導出されない').toContain(
      'derives no allow rules when capabilities.mcp is false or absent (deny by default)',
    )
    expect(output, 'vibepro: ac:2 spawn-time binding — placementEngineBoundaryが唯一の導出点としてEngineRunOptsへ渡す').toContain(
      'passes derived allowedTools through the engine boundary on every placement run',
    )
    expect(output, 'vibepro: ac:5 non-placement unchanged — 非placementはグローバルinteractiveAllowedToolsのまま').toContain(
      'leaves allowedTools undefined for non-placement runs (global interactiveAllowedTools stays in charge)',
    )
    expect(output, 'vibepro: ac:3 deny precedence — サーバー全体許可でも恒常denyはdisallowedToolsに残る').toContain(
      'keeps every constant deny in disallowedTools even when its server is wholesale-allowed (deny beats allow)',
    )
    expect(output, 'vibepro: ac:4 freee write deny — 書込系5ツールが全placementでdenyされる').toContain(
      'denies freee write tools in every placement session (read-only until G2)',
    )
    expect(output, 'vibepro: ac:6 global independence — placement導出リストがグローバルリストを置換する').toContain(
      "a placement's derived allow list replaces the global interactiveAllowedTools for that spawn",
    )
    expect(output, 'vibepro: ac:6 空の導出リストはグローバルへフォールバックしない').toContain(
      'a placement with an empty derived list grants nothing extra (no global fallback)',
    )
    expect(output, 'vibepro: ac:5 非placement spawnはグローバルリストを維持する').toContain(
      'non-placement spawns keep the global interactiveAllowedTools unchanged',
    )
    expect(output, 'vibepro: ac:7 cold respawn key — allowedTools変更でwarm PTYがcold-respawnされる').toContain(
      'changes the spawn boundary key when the allowedTools change (forces cold respawn)',
    )
    expect(output, 'vibepro: ac:7 同一入力なら境界鍵は安定でwarm PTYを再利用できる').toContain(
      'keeps the boundary key stable for identical allow/deny inputs',
    )
    expect(output, 'vibepro: ac:8 hot reload effective — boot時状態なしにrun毎へ導出されnext spawnから反映される').toContain(
      're-derives the boundary from the live placement on every run so config changes bind at the next spawn',
    )
    expect(output, 'vibepro: ac:9 追加・変更した挙動の自動テストが焦点スイート（shared/engines）として全て通る').toContain(
      'preserves legacy engine behavior when no placement is bound',
    )
    expect(output, 'vibepro: ac:1 schema_failure — 不正・欠落したcapabilities形状はallow導出を拒否しfail-closedになる').toContain(
      'derives no allow rules when capabilities.mcp is false or absent (deny by default)',
    )
  })

  test('freee capability placement derives its allow and write-deny in one spawn (ALLOWTOOLS-STORY-S-001)', () => {
    const output = execFileSync(
      'pnpm',
      [
        '--filter', 'openryoko', 'exec', 'vitest', 'run', '--reporter=verbose',
        'src/shared/__tests__/placement-profile.test.ts',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, CI: '1' },
      },
    )

    expect(output, 'vibepro: scenario ALLOWTOOLS-STORY-S-001 (spec S-001) — グローバル登録なしでcapabilities.mcpのfreeeからmcp__freee__*が導出され、書込系はdenyに残る').toContain(
      'derives the freee server allow from capabilities.mcp alone without any global registration (ALLOWTOOLS-STORY-S-001)',
    )
  })
})
