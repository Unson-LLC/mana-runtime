---
story_id: story-placement-memory-promotion
title: Slackチャンネルの業務文脈を安全に記憶し再利用する
status: active
---

# Slackチャンネルの業務文脈を安全に記憶し再利用する

## User story

バックオフィス担当者として、同じSlackチャンネルで依頼した契約管理の文脈を、スレッドや実行の中断をまたいでmanaが参照できるようにしたい。これにより、Driveの成果物管理や契約台帳更新の前提を毎回説明せずに済む。

## Evidence

本番の`mana-accounting` placementには対象チャンネルの会話セッションが24件保存されている。同チャンネルのlearning candidate outboxは0件で、直近の重要な依頼は中断セッションに含まれる。現行の候補捕捉は正常なassistant応答完了時だけ実行され、中断・異常終了したユーザー発話を復旧しない。

## Acceptance Criteria

- 起動時に永続SQLite会話台帳を走査し、workspaceとchannelを確定できる各sessionの最終ユーザー発話をreview-required candidateへ冪等に復旧する。
- 正常応答がある発話はuser/assistantの証跡対として復旧する。
- assistant応答が保存されていない発話も、未完了であることを明示した証跡として復旧する。
- placementからGraphや`memory/`への直接書込権限は追加しない。
- candidate-storeの既存HITL承認・Graph昇格境界を維持する。
- workspace/channel/placement/projectのscopeを候補へ保持し、別チャンネルの会話を混ぜない。
- 再起動を繰り返しても候補が重複しない。
- 自動テスト、typecheck、VibePro verifyが通る。
- 初回復旧は明示allowlistされたplacementだけに限定し、未設定時は外部候補を作らない。
- scope欠落・placement除外と候補化試行数を本文なしで観測できる。

最終発話に限定する理由は、sessionのtransport metadataが保持する発話者IDが最新のinbound speakerのみであり、複数人スレッドの過去発話を誤った人物へ帰属させないためである。

## Non-goals

生のSlack会話をplacement memoryファイルへ直接書くこと、mana-runtime独自の業務事実SSOTを作ること、BrainbaseのRACI・候補承認ポリシーを迂回することは対象外とする。
