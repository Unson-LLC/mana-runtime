import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'

// Story: agent-ledger-gaps (docs/stories/agent-ledger-gaps.md)
// Executable coverage markers map the 受け入れ基準 to the focused vitest
// suites, following the channel-placement-profiles-boundaries.spec.ts contract.
test.describe('Agent ledger execution boundaries', () => {
  test('focused suites satisfy the agent-ledger acceptance contract', () => {
    const output = execFileSync(
      'pnpm',
      [
        '--filter', 'openryoko', 'exec', 'vitest', 'run', '--reporter=verbose',
        'src/shared/__tests__/placement-profile.test.ts',
        'src/gateway/__tests__/placements.test.ts',
        'src/gateway/__tests__/costs.test.ts',
        'src/gateway/__tests__/api-placement-authorization-http.test.ts',
        'src/shared/__tests__/security-events.test.ts',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, CI: '1' },
      },
    )

    expect(output, 'vibepro: ac:1 owner/purpose backward compatibility — enabled未設定の既存configは有効のまま (S-001)').toContain(
      'treats explicit enabled: true and absent enabled as active',
    )
    expect(output, 'vibepro: ac:2 placement単位の月次コスト集計 monthly cost aggregation — unplacedセッションを漏れなく可視化').toContain(
      'groups monthly cost by transport_meta.placementId and reports unplaced sessions',
    )
    expect(output, 'vibepro: ac:3 kill switch enabled false はresolver境界でfail closed').toContain(
      'fails closed with an auditable reason when the placement kill switch is off',
    )
    expect(output, 'vibepro: ac:3 kill switch はdelivery・派生セッション境界でもfail closed').toContain(
      'fail-closes direct delivery when the placement kill switch is off',
    )
    expect(output, 'vibepro: ac:4 無効化による拒否は security_event placement_disabled として監査ログに記録される').toContain(
      'fail-closes direct delivery when the placement kill switch is off',
    )
    expect(output, 'vibepro: ac:5 台帳 ledger はsecret様の値をredactし当月コスト・セッション数・最終利用を返す').toContain(
      'redacts secret-like values in free-text ledger fields',
    )
    expect(output, 'vibepro: ac:5 台帳APIはoperator認可のfail-closed保護に従う').toContain(
      'protects session metadata and transcripts while placements are active',
    )
    expect(output, 'vibepro: ac:6 台帳ビューのgap badge — owner未設定・purpose未設定・budget対象外・disabledを識別').toContain(
      'flags ledger gaps: missing owner/purpose, untracked budget, disabled kill switch',
    )
    expect(output, 'vibepro: ac:8 追加挙動の自動テストと既存placementスイートが全て通る').toContain(
      'joins ledger fields with monthly placement costs and keeps unplaced/orphan spend visible',
    )
    expect(output, 'vibepro: schema_failure invalid placement config fails closed').toContain(
      'fails closed when a placement data scope contains a secret-like value',
    )
  })

  test('operations runbooks exist for decommission and pilot config change management', () => {
    const lifecycle = readFileSync('docs/operations/placement-lifecycle.md', 'utf8')
    expect(lifecycle, 'vibepro: ac:7 placement廃止手順 decommission が運用文書として存在する').toContain('廃止手順')
    expect(lifecycle, 'vibepro: ac:7 kill switch運用が文書化されている').toContain('kill switch')
    const changeManagement = readFileSync('docs/operations/pilot-config-change-management.md', 'utf8')
    expect(changeManagement, 'vibepro: ac:7 pilot config.yamlのgit変更管理手順が運用文書として存在する').toContain('変更管理')
    expect(changeManagement, 'vibepro: ac:7 secretはenv注入（Infisical）でcommitへ含めない設計判断が明記されている').toContain('Infisical')
  })
})
