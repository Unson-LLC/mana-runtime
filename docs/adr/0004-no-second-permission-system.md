# ランタイムに第二の権限体系を作らない（スコープ語彙はbrainbaseから借りる）

**日付**: 2026-07-30

## Context

スキル・記憶をチャンネル（placement）ごとに出し分ける必要が出た際、ランタイム側に独自の権限分類（役職・プロジェクト・グループ等）を設計する選択肢があった。一方、brainbaseは既にRACI・project・scopeという権限構造を持っている。

## Decision

- ランタイムは独自の権限分類を発明しない。権限判定が必要な知識・記憶は**brainbaseに置き、RACI/projectに判定させる**
- ランタイムローカルに残す権限判定は「**自placementか否か**」の1個だけ（記憶3層モデル: 脳=RACI / placementローカル=自placementのみ / 共通=全公開かつ機微禁止）
- スキルの可視性は独立管理せず、**placementのcapabilities + frontmatterのscopeから導出**する。scopeの語彙はplacementの`projects`＝brainbaseのprojectと同一にする
- 詳細は [11_persona_skills_memory.md §3](../architecture/11_persona_skills_memory.md)

## Why

- 権限の正本が2箇所に育つと、必ず食い違いが起き、どちらを信じるかの判断が毎回発生する（shared/・submodule方式が敗れたのと同じ構造）
- 語彙を揃えておけば、将来の「オントロジー→placement写像」（10章§3）でスキル可視性・記憶スコープもGraphから一括導出でき、移行に断絶がない
- 「中間の細かい権限が欲しい」と感じた時点で、それは業務の記憶である（＝置き場所の選択がそのまま権限の選択になる）というシンプルな運用判定が成立する

## Alternatives

- ランタイム独自のロール/グループ体系: 上記の二重管理リスクで不採用
- スキルごとの明示allowlistをplacementに追記: 「ツール追加のたびに3箇所登録」問題の4箇所目になるため不採用（導出+明示overrideは許容）

## Consequences

- placement単位より細かい出し分け（同一チャンネル内でユーザーごとに見せる記憶を変える等）はランタイムでは表現できない。その要件が出たら、brainbase側へ寄せるか、このADRを見直す
- brainbase側のproject/RACI定義が変わると、スキルscope・記憶スコープの意味も変わる。接続契約の追従ルール（10章末尾）に従う
