# Slackネイティブコマンドで自己開発を開始する

## Story

OpenRyokoの自己開発をSlack上で誰でも観察可能な定型操作にするため、
allowlist済みの担当者がパイロットチャンネルで `/ryoko-develop` を実行すると、
既存の隔離VibeProランナーへ安全に要求が渡るようにする。

## Acceptance criteria

- Slack App Manifestに `/ryoko-develop` と `commands` scopeが含まれる。
- Socket Mode上のcommand handlerは処理前にackする。
- `allowFrom` 外の利用者は検索・dispatch前にエフェメラル応答で拒否され、未設定・空配列もこのコマンドではfail closedになる。
- `developmentRunner.allowedSlackChannels` 外のチャンネルは検索・dispatch前にエフェメラル応答で拒否され、未設定・空配列もfail closedになる。
- 許可された入力は内部の `/develop` 境界へ正規化され、既存の隔離ランナー、単一実行、出力検証を再利用する。
- 旧メンション経由で内部 `/develop` を呼んでも同じチャンネル制限を迂回できない。
- public HTTP endpointは追加せず、稼働中checkout、secret、merge、deployの境界を変えない。

## Explicit scenarios

- S-001: Given an allowlisted user in an allowed channel, when `/ryoko-develop change docs` is invoked, then Slack is acknowledged and `/develop change docs` is dispatched once.
- S-002: Given a user outside `allowFrom`, when the command is invoked, then an ephemeral denial is returned before Slack lookups or dispatch.
- S-003: Given an allowed user outside `allowedSlackChannels`, when the command is invoked, then an ephemeral denial is returned before Slack lookups or dispatch.
- S-004: Given an internal `/develop` message outside `allowedSlackChannels`, when SessionManager handles it, then no runner process is started.
- S-005: Given the generated Slack manifest, when it is installed or updated, then the command and `commands` scope are declared.

## Links

- Architecture: `docs/architecture/story-slack-native-development-command.md`
- Specification: `docs/specs/slack-self-development-runner.md`
- Parent Story: `docs/management/stories/active/story-slack-self-development-runner.md`
