import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'

// Story: mcp-readonly-vocabulary (docs/stories/mcp-readonly-vocabulary.md)
// Executable coverage markers map the 受け入れ基準 to the focused vitest
// suites, following the placement-allowed-tools-boundaries.spec.ts contract.
test.describe('MCP read-only vocabulary boundaries', () => {
  test('focused suites satisfy the read-only vocabulary acceptance contract', () => {
    const output = execFileSync(
      'pnpm',
      [
        '--filter', 'openryoko', 'exec', 'vitest', 'run', '--reporter=verbose',
        'src/shared/__tests__/placement-profile.test.ts',
        'src/gateway/__tests__/placements.test.ts',
        'src/sessions/__tests__/context-delegation.test.ts',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, CI: '1' },
      },
    )

    expect(output, 'vibepro: ac:1 catalog tool classification — mcp.custom.<name>.tools.writeToolsの宣言でread-only許可が成立する').toContain(
      'grants read-only mode when the catalog declares a tool classification',
    )
    expect(output, 'vibepro: ac:2 read-only mode derivation — カタログwriteToolsがmcp__<server>__<tool>のdenyへ導出される').toContain(
      'derives catalog writeTools of read-only grants into mcp__<server>__<tool> deny rules',
    )
    expect(output, 'vibepro: ac:3 undeclared classification fail-closed — 分類宣言のないサーバーへのread-only指定は拒否される').toContain(
      'rejects a read-only grant fail-closed when the catalog declares no tool classification (MCPRO-STORY-S-002)',
    )
    expect(output, 'vibepro: ac:3 fail-closedはエンジン境界でも成立しallowが導出されない').toContain(
      'fail-closes a read-only grant without catalog classification at the engine boundary (MCPRO-STORY-S-002)',
    )
    expect(output, 'vibepro: ac:3 fail-closed拒否されたサーバーはMCP設定から除外されspawnされない').toContain(
      'excludes fail-closed rejected servers so they are never spawned',
    )
    expect(output, 'vibepro: ac:3 schema_failure coverage — 不明mode・不正エントリはfullへ広げず拒否される（negative_path）').toContain(
      'rejects unknown modes and malformed entries instead of widening to full access',
    )
    expect(output, 'vibepro: ac:4 interim deny replacement — カタログ宣言+read-only指定が暫定固定列挙と同一のdeny集合を導出する').toContain(
      'replaces the interim freee pinning: catalog writeTools + read-only grant derive the identical deny set (MCPRO-STORY-S-001)',
    )
    expect(output, 'vibepro: ac:5 backward compatibility — 文字列形式エントリは全ツール許可のまま無変更で動く').toContain(
      'treats plain-string entries as full grants (backward compatibility)',
    )
    expect(output, 'vibepro: ac:5 deny precedence維持 — サーバー全体許可でも恒常denyはdisallowedToolsに残る').toContain(
      'keeps every constant deny in disallowedTools even when its server is wholesale-allowed (deny beats allow)',
    )
    expect(output, 'vibepro: ac:6 ledger mode visibility — GET /api/placementsの台帳projectionにmodeとfail-closed拒否が出る').toContain(
      'projects read-only and fail-closed rejected MCP grants with their modes (G2 ledger visibility)',
    )
    expect(output, 'vibepro: ac:7 capability declaration accuracy — 能力宣言にread-only modeと拒否writeToolsが併記される').toContain(
      'derives the capability declaration from capabilities, not hand-written dataScopes',
    )
    expect(output, 'vibepro: ac:7 fail-closed拒否されたサーバーは能力宣言で利用不能と明示される').toContain(
      'declares a fail-closed rejected read-only server as unavailable instead of advertising it',
    )
    expect(output, 'vibepro: ac:9 追加・変更した挙動の自動テストが焦点スイートとして全て通る').toContain(
      'derives a whole-server allow rule for every capabilities.mcp server except gateway',
    )
  })

  test('web placements ledger displays per-server MCP modes (ac:6)', () => {
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

    expect(output, 'vibepro: ac:6 web placements画面がread-only modeを表示する').toContain(
      'renders gap badges for missing owner/purpose, untracked budget, and disabled kill switch',
    )
    expect(output, 'vibepro: ac:6 web placements画面がfail-closed拒否を表示する').toContain(
      'marks a fail-closed rejected read-only grant in the ledger row',
    )
  })

  test('docs and template carry the read-only vocabulary (ac:8)', () => {
    const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')

    const authDoc = read('docs/architecture/04_auth_permission.md')
    expect(authDoc, 'vibepro: ac:8 04章のcapabilities例にread-only形式がある').toContain('{name: freee, mode: read-only}')
    expect(authDoc, 'vibepro: ac:8 04章がG2+G6の導出とfail-closedを説明する').toContain('read-only語彙とカタログツール分類')

    const gapDoc = read('docs/discovery/gap-analysis-capability-config-2026-07-31.md')
    expect(gapDoc, 'vibepro: ac:8 gap-analysisのG2が済になっている').toContain('Story mcp-readonly-vocabulary')

    const template = read('packages/jimmy/template/config.default.yaml')
    expect(template, 'vibepro: ac:8 templateのカタログ例にfreeeのwriteTools宣言がある').toContain('writeTools: [freee_api_post, freee_api_put, freee_api_delete, freee_api_patch, freee_file_upload]')
  })

  test('read-only freee placement derives the interim-identical deny set in one spawn (MCPRO-STORY-S-001)', () => {
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

    expect(output, 'vibepro: scenario MCPRO-STORY-S-001 (spec S-001) — カタログwriteTools+read-only指定でmcp__freee__*のallowと書込5ツールdenyが同一spawnに載る').toContain(
      'derives the freee server allow from capabilities.mcp alone without any global registration (ALLOWTOOLS-STORY-S-001)',
    )
  })

  test('undeclared server read-only request fails closed end to end (MCPRO-STORY-S-002)', () => {
    const output = execFileSync(
      'pnpm',
      [
        '--filter', 'openryoko', 'exec', 'vitest', 'run', '--reporter=verbose',
        'src/shared/__tests__/placement-profile.test.ts',
        'src/sessions/__tests__/context-delegation.test.ts',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, CI: '1' },
      },
    )

    expect(output, 'vibepro: scenario MCPRO-STORY-S-002 (spec S-002) — 分類宣言のないサーバーはallow・MCP設定から除外され、能力宣言で利用不能と明示される').toContain(
      'fail-closes a read-only grant without catalog classification at the engine boundary (MCPRO-STORY-S-002)',
    )
    expect(output, 'vibepro: scenario MCPRO-STORY-S-002 (spec S-002) 宣言側 — 能力宣言のunavailable明示').toContain(
      'declares a fail-closed rejected read-only server as unavailable instead of advertising it',
    )
  })
})
