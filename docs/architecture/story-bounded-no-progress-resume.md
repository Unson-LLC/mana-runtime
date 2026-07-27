---
story_id: story-bounded-no-progress-resume
title: Bounded no-progress resume architecture
---

# Bounded no-progress resume architecture

## Decision

Slack self-development runnerの既存プロセス境界内で、初回VibePro実行の結果だけを入力に
最大1回のresumeを行う。recoveryの`next_command`は実行せず、厳密な構文検証から
Story ID、run ID、managed worktree候補だけを抽出し、runner自身が固定argvを再構築する。

managed worktreeは設定済みrepository rootの`.worktrees/vibepro/<story-id>-*`配下に限定し、
候補と許可rootの双方を`realpath`で比較する。存在しないpath、別Story、symlink escape、
追加引数を拒否する。初回とresumeは同じdeadlineを共有し、残時間がなければspawnしない。

## State and failure boundaries

```text
initial guarded run
  -> pr_ready: return pr_ready
  -> blocked/no_progress + valid recovery + remaining budget: resume once
       -> pr_ready: return pr_ready
       -> every other state: return needs_input or failed
  -> every other stop, invalid recovery, or exhausted budget: fail closed
```

resume後の結果を再びresume候補へ戻す遷移は存在しない。PR作成、merge、deploy、secret変更、
runtime checkout更新は引き続き人間操作であり、runnerのauthorityには追加しない。

## Deployment version evidence

この変更はrunner artifactの配備差異で再発し得るため、検証時はソース上の期待値だけでなく、
running sessionが読み込んだartifact版を証明する。operatorは起動中runnerが返す
`RUNNER_VERSION`、実行対象`run.mjs`のSHA-256 digest、期待するGit HEADを同一証跡に記録し、
期待値と一致しないsessionを機能検証へ使用しない。rollbackはreview済み旧artifactへ戻し、
同じversion/digest probeで切替を確認する。

## Consequences

- shell解釈、任意argv、別Story worktreeへの権限拡張を導入しない。
- 1回という上限と共有deadlineにより、停止ループと時間budgetの再初期化を防ぐ。
- deployment確認にはrunning-session version stampが必須となり、unit testだけでは完了しない。
