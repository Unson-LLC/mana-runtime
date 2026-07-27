# `no_progress`を安全に1回だけ自動再開する

## Story

Slackから開始した隔離VibePro実行が、再開可能な`no_progress`で停止した場合に、
利用者が内部コマンドを手で扱わなくても`pr_ready`まで進められるようにする。

## Acceptance criteria

- `blocked`かつstop codeが厳密に`no_progress`の場合だけ自動再開候補にする。
- recovery文字列をshell実行せず、現在のStory、run ID、実在するmanaged worktreeを検証して固定argvを再構築する。
- managed worktreeは現在の隔離Story配下にrealpathで閉じ、symlink escapeや別Storyを拒否する。
- 自動再開は最大1回で、初回VibePro実行からの総wall-clock budgetを共有する。
- 不正なrecovery、別stop code、再開後の再停止、timeout、実行失敗はfail closedで終了する。
- PR作成、merge、deployの人間境界は変更しない。

## Explicit scenarios

- S-001: 正規の`no_progress`から1回再開して`pr_ready`になれば、Slackへ`pr_ready`を返す。
- S-002: 再開後も`no_progress`なら、2回目は実行せず`needs_input`で停止する。
- S-003: Story、run ID、path、引数が不正なら、再開せず`needs_input`で停止する。
- S-004: managed worktreeがsymlinkで許可root外へ出るなら、再開しない。
- S-005: 総時間を使い切った場合は、新しい子プロセスを開始しない。

## Explicitly out of scope

- `no_progress`以外の停止理由の自動解決。
- 2回以上の自動再開。
- PR作成、merge、deploy、secret変更。
