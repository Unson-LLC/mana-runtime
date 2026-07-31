import { execFileSync } from 'node:child_process'
import { test, expect } from '@playwright/test'

// Story: placement-read-filters (docs/stories/placement-read-filters.md)
// Executable coverage markers map the 受け入れ基準 to the focused vitest
// suites, following the agent-ledger-gaps-boundaries.spec.ts contract.
test.describe('Placement read filter boundaries', () => {
  test('focused suites satisfy the placement read-filter acceptance contract', () => {
    const output = execFileSync(
      'pnpm',
      [
        '--filter', 'openryoko', 'exec', 'vitest', 'run', '--reporter=verbose',
        'src/cli/__tests__/skills-frontmatter.test.ts',
        'src/shared/__tests__/placement-profile.test.ts',
        'src/sessions/__tests__/context-read-filters.test.ts',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, CI: '1' },
      },
    )

    expect(output, 'vibepro: ac:1 skill capability declaration — requiredMcp/requiredTools/scopeがパースされる').toContain(
      'parses requiredMcp/requiredTools/scope capability declarations',
    )
    expect(output, 'vibepro: ac:1 宣言のない既存スキルはglobal・要求能力なしの後方互換').toContain(
      'treats undeclared skills as global with no capability requirements (backward compat)',
    )
    expect(output, 'vibepro: ac:2 skill manifest filtering — capabilitiesとscopeが合致するスキルだけ注入される').toContain(
      'injects only skills executable under the placement capabilities with a matching scope',
    )
    expect(output, 'vibepro: ac:2 能力・scope外のスキルは本文の存在ごと隠される').toContain(
      'hides capability-requiring and out-of-scope skills from an unprivileged placement',
    )
    expect(output, 'vibepro: ac:3 placement外セッションのマニフェストは従来どおり全件').toContain(
      'keeps the full skill listing for non-placement sessions',
    )
    expect(output, 'vibepro: ac:4 placement-local memory view — 自placement分だけが注入される').toContain(
      "injects the placement's own memory view and warns other placements' memory is blocked",
    )
    expect(output, 'vibepro: ac:5 memory read deny — 他placementのRead/Glob/Grepがdenyルールで遮断される').toContain(
      "denies Read/Glob/Grep on every other configured placement's memory directory",
    )
    expect(output, 'vibepro: ac:5 configに無いディスク上のディレクトリもfail closedに遮断される').toContain(
      'also denies placement directories that exist on disk but are absent from config',
    )
    expect(output, 'vibepro: ac:5 denyルールはengine boundaryのdisallowedToolsへ実際に載る').toContain(
      'includes memory read deny rules for every other configured placement',
    )
    expect(output, 'vibepro: ac:6 memory/直下の共通記憶は読取denyの対象にならない').toContain(
      "never denies the placement's own memory directory or the shared memory root",
    )
    expect(output, 'vibepro: ac:2 deny by default — capabilities.mcpがfalse/未設定ならMCP要求スキルは不可視').toContain(
      'hides every MCP-requiring skill when capabilities.mcp is false or absent (deny by default)',
    )
    expect(output, 'vibepro: ac:8 追加・変更した挙動の自動テストが焦点スイート（cli/shared/sessions）として全て通る').toContain(
      'returns no rules when nothing else is configured and no directory exists',
    )
  })

  test('skills ledger view exposes scope and requiredMcp columns (SKILLVIS-STORY-S-001)', () => {
    const output = execFileSync(
      'pnpm',
      [
        '--filter', '@openryoko/web', 'exec', 'vitest', 'run', '--reporter=verbose',
        'src/app/skills/__tests__/skills-ledger.test.tsx',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, CI: '1' },
      },
    )

    expect(output, 'vibepro: ac:7 ledger view columns — scope/requiredMcp列がスキル台帳に表示される (SKILLVIS-STORY-S-001, spec S-004)').toContain(
      'renders scope and requiredMcp as ledger columns for every skill',
    )
  })
})
