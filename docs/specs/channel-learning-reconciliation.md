---
story_id: story-placement-memory-promotion
title: Channel Learning Reconciliation Spec
status: accepted
architecture_docs:
  - docs/architecture/11_persona_skills_memory.md
  - docs/architecture/12_channel_learning_reconciliation.md
---

# Channel Learning Reconciliation Spec

## Input

- `sessions`の永続レコード
- 各sessionの`user`/`assistant` message
- `transportMeta`内のworkspace、channel、placement、actor
- placement設定内のproject
- `OPENRYOKO_LEARNING_RECONCILE_PLACEMENTS`の明示allowlist

## Pairing

時系列メッセージからsessionの最終user発話と直後のassistant発話を一組にする。`transportMeta`は最終入力者の属性なので、それ以前の発話は誤帰属防止のため起動時復旧の対象にしない。次のメッセージがassistantでなければ未回答とし、合成assistant ID `missing:<userMessageId>`と明示的な未完了文言を使う。

## Scope gate

workspaceとchannelの両方が確定し、placementが明示allowlistに含まれるsessionだけを対象とする。allowlist未設定時は復旧しない。projectは配置設定から導出できる場合だけ付与する。actor person IDがなければ既存のSlack person resolverに委ね、解決不能ならoutboxで`identity_unresolved`として再処理可能に保つ。

## Idempotency

既存extractor version、session ID、user message ID、assistant message IDのSHA-256を一意キーとする。起動ごとの全走査を許容し、重複はoutbox repositoryのenqueueで吸収する。

## Observability

起動ログに走査session数、候補化試行turn数、assistantなしturn数、scope欠落除外数、placement除外数を出す。候補化試行数は新規insert数とは表現しない。秘密値や会話本文はログに出さない。
