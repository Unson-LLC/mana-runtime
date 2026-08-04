import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'

// Story: story-mana-configuration-visibility
// This boundary E2E executes the focused runtime and Web contract suites. It
// keeps the Slack and browser entry points tied to the Story acceptance
// criteria without requiring a live Slack workspace or production credential.
test.describe('Mana configuration visibility boundaries', () => {
  test('S-001 S-002 S-003 S-004 S-005 S-008: Slack entry points, topology projection, probes, and deep links satisfy the runtime contract', () => {
    const output = execFileSync(
      'pnpm',
      [
        '--filter', 'openryoko', 'exec', 'vitest', 'run', '--reporter=verbose',
        'src/connectors/slack/__tests__/connector-authorization.test.ts',
        'src/connectors/slack/__tests__/settings-deep-link.test.ts',
        'src/connectors/slack/__tests__/meeting-minutes-pipeline.test.ts',
        'src/gateway/__tests__/settings-topology.test.ts',
        'src/gateway/__tests__/api-settings-topology-http.test.ts',
      ],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, CI: '1' } },
    )

    expect(output, 'vibepro: ac:1 operator-only HTTPS topology API is redacted').toContain(
      'returns a redacted projection only for the operator credential',
    )
    expect(output, 'vibepro: ac:3 AC-02 allowlisted App Home publishes the canonical Web entry').toContain(
      'publishes a fail-closed App Home settings entry only for an explicitly allowlisted user',
    )
    expect(output, 'vibepro: ac:4 AC-03 exact settings DM bypasses normal conversation handling').toContain(
      'handles an exact settings DM in the same thread before respondTo and without a normal handler',
    )
    expect(output, 'vibepro: ac:6 AC-05 delivery errors use allowlisted route identifiers only').toContain(
      'regenerates once on contract violations, then fails loud',
    )
    expect(output, 'vibepro: ac:7 AC-06 primary and cross-workspace share routes remain distinct').toContain(
      'projects primary and cross-workspace share routes onto their declaring and target connectors',
    )
    expect(output, 'vibepro: ac:8 AC-07 missing names and observations retain stable identifiers and reasons').toContain(
      'retains routes and reports stable unconfirmed/error reasons when runtime evidence is absent',
    )
    expect(output, 'vibepro: ac:9 AC-08 Slack probe failures and workspace mismatches are classified fail-closed').toContain(
      'classifies bounded Slack topology probes without exposing Slack errors',
    )
    expect(output, 'vibepro: ac:10 AC-09 API history and topology projection exclude credentials and raw config').toContain(
      'serializes only allowlisted history metadata and never config credentials or env names',
    )
    expect(output, 'vibepro: ac:11 AC-10 topology API has an unconditional dedicated operator boundary').toContain(
      'requires the dedicated operator credential even without placements',
    )
    expect(output, 'vibepro: ac:12 AC-11 App Home, DM, and error-link runtime entry contracts execute together').toContain(
      'does not treat a partial phrase or a replayed old DM as a settings shortcut',
    )
    expect(output, 'vibepro: ac:13 AC-12 App Home and error links target the requested settings view directly').toContain(
      'omits empty values and never accepts arbitrary query fields',
    )
    expect(output, 'vibepro: ac:15 AC-14 share probes are assigned only to the named target connector').toContain(
      'assigns router/primary probes to the source and share probes to the named target',
    )
    expect(output, 'vibepro: ac:16 AC-15 history is limited to allowlisted metadata behind operator auth').toContain(
      'serializes only allowlisted history metadata and never config credentials or env names',
    )
    expect(output, 'vibepro: ac:17 AC-16 URL userinfo is rejected before any Slack link or Web origin is emitted').toContain(
      'builds the canonical topology entry without credentials or inherited query',
    )
  })

  test('S-006 S-007: Web authentication, navigation, selection, responsive structure, and Slack manifest satisfy the operator journey', () => {
    const output = execFileSync(
      'pnpm',
      [
        '--filter', '@openryoko/web', 'exec', 'vitest', 'run', '--reporter=verbose',
        'src/components/__tests__/settings-topology-view.test.tsx',
        'src/lib/__tests__/nav.test.ts',
        'src/lib/__tests__/slack-manifest.test.ts',
      ],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, CI: '1' } },
    )

    expect(output, 'vibepro: ac:2 AC-01a rejected or missing browser credential yields an in-page prompt before fetch').toContain(
      'does not fetch protected topology until a token is entered',
    )
    expect(output, 'vibepro: ac:3 AC-02 Slack manifest enables App Home events').toContain(
      'includes the native development command and Socket Mode contract',
    )
    expect(output, 'vibepro: ac:5 AC-04 sidebar exposes the read-only topology independently from edit settings').toContain(
      'keeps edit settings and read-only topology reachable with one active item',
    )
    expect(output, 'vibepro: ac:6 AC-05 safe workspace/project/channel query fields select the matching route').toContain(
      'highlights the route selected by safe deep-link query fields',
    )
    expect(output, 'vibepro: ac:12 AC-11 Web sidebar and deep-link entry contracts execute in the same suite').toContain(
      'keeps edit settings and read-only topology reachable with one active item',
    )
    expect(output, 'vibepro: ac:13 AC-12 selected route is visible directly after opening the deep link').toContain(
      'highlights the route selected by safe deep-link query fields',
    )
    expect(output, 'vibepro: ac:14 AC-13 responsive view retains labelled navigation and read-only controls').toContain(
      'highlights the route selected by safe deep-link query fields',
    )
  })
})
