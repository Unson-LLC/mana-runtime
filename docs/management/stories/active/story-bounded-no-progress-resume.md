---
story_id: story-bounded-no-progress-resume
title: "`no_progress`を安全に1回だけ自動再開する"
status: active
source:
  type: runtime-defect
  id: story-bounded-no-progress-resume
architecture_reason: "ADR不要。既存のSlack self-development runner境界内で、VibeProの型付き停止状態を1回だけ再開する局所的なオーケストレーション変更である。"
architecture_docs:
  - docs/architecture/story-bounded-no-progress-resume.md
spec_docs:
  - docs/specs/story-bounded-no-progress-resume.vibepro.json
related_tasks:
  - docs/plans/story-bounded-no-progress-resume-prepare-artifacts.md
---

# `no_progress`を安全に1回だけ自動再開する

## Background

Slackから開始した隔離VibePro実行が、再開可能な`no_progress`で停止した場合に、
利用者が内部コマンドを手で扱わなくても`pr_ready`まで進められるようにする。

現行runnerはVibeProが`blocked/no_progress`で返した型付きrecoveryをSlack利用者へ
`needs_input`として返すだけで、再開可能な実行でも手作業が必要だった。再開処理は
shell文字列を信用せず、現在のStoryとmanaged worktreeへ閉じた固定argvとして扱う。

## Policy

既存の人間境界を継承し、runnerは`pr_ready`までしか進めない。PR作成、merge、deploy、
secret変更、runtime checkout更新はこのStoryの権限外とする。

## Acceptance Criteria

- `blocked`かつstop codeが厳密に`no_progress`の場合だけ自動再開候補にする。
- recovery文字列をshell実行せず、現在のStory、run ID、実在するmanaged worktreeを検証して固定argvを再構築する。
- managed worktreeは現在の隔離Story配下にrealpathで閉じ、symlink escapeや別Storyを拒否する。
- 自動再開は最大1回で、初回VibePro実行からの総wall-clock budgetを共有する。
- 不正なrecovery、別stop code、再開後の再停止、timeout、実行失敗はfail closedで終了する。
- PR作成、merge、deployの人間境界は変更しない。

## Scenarios

- `BOUNDED-RESUME-STORY-S-001`: Given 正規の`blocked/no_progress` recoveryがあるとき、1回再開して`pr_ready`になれば、Slackへ`pr_ready`を返す。
- `BOUNDED-RESUME-STORY-S-002`: Given 再開後も`blocked/no_progress`のとき、2回目は実行せず`needs_input`で停止する。
- `BOUNDED-RESUME-STORY-S-003`: Given Story、run ID、path、または引数が不正なとき、再開せず`needs_input`で停止する。
- `BOUNDED-RESUME-STORY-S-004`: Given managed worktreeのsymlinkが現在のStory root外へ解決されるとき、再開しない。
- `BOUNDED-RESUME-STORY-S-005`: Given 初回実行からの総wall-clock budgetを使い切ったとき、新しい子プロセスを開始しない。
- `BOUNDED-RESUME-STORY-S-006`: Given running sessionを検証するとき、`RUNNER_VERSION`と実行中artifactのdigestが期待するcurrent HEAD版と一致する証跡を取得できる。

## Out of Scope

- `no_progress`以外の停止理由の自動解決。
- 2回以上の自動再開。
- PR作成、merge、deploy、secret変更。
