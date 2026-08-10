---
story_id: story-recurring-meeting-auto-routing
title: 承認済み定例議事録を安全に自動配信する
status: active
---

# 承認済み定例議事録を安全に自動配信する

## Story

Manaの運用者として、Tech Knightボード定例のように配送先が毎回同じ会議は、
送信元設定に明示した定例ルールが一意に一致するときだけ確認操作なしで議事録チャンネルへ配信したい。
一方、新規・単発・曖昧な会議は従来どおり宛先ボタンで確認し、別workspaceへの誤配送を防ぎたい。

## Policy

- 自動配信の権限はLLMの推定や過去の選択ではなく、operatorが管理する明示configだけが持つ。
- 判定対象はSlack投稿文とファイル名の固定文字列であり、transcript本文、正規表現、AI分類は使わない。
- 有効なルールがちょうど1件一致した場合だけ自動配信する。
- 0件、複数件、不正なルール、存在しない宛先はすべて既存の手動選択へフォールバックする。
- 宛先は`destinationId`から実行時configを再解決し、connector・workspace・channelを固定する。

## Acceptance Criteria

- AC-01: 明示ルールが一意に一致すると、LLM分類と宛先確認を呼ばず指定destinationへ配信する。
- AC-02: 不一致時は既存のLLM候補とoperator確認を維持し、自動投稿しない。
- AC-03: 複数一致、不正ルール、未知destinationはfail-openせず手動選択へ戻す。
- AC-04: 比較はUnicode NFKC、英字小文字化、連続空白の正規化を行い、全指定語の包含一致とする。
- AC-05: local/cross-workspaceのどちらも既存の宛先再検証と配送gatewayを通る。
- AC-06: run stateに自動ルールIDとconfig由来の承認主体を残し、transcript本文は永続化しない。
- AC-07: 既存の手動routing、更新、再配信、重複排除を回帰テストで維持する。

## Non-goals

- 過去のoperator選択を自動学習してルール化すること
- transcript本文を読んだAIによる自動配信判断
- Slack UIからのルール作成・編集
- このPRで本番configへ個別の定例ルールを追加すること

## Release boundary

PR内ではunit/typecheckとVibePro gateまでを証明する。本番での自動配信は、別途operatorが対象workspaceの
configへルールを明示し、deploy後に許可されたテスト議事録で確認するまで未確認とする。
