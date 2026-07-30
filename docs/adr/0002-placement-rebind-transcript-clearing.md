# placementのtranscriptクリアは「権限バインド変更時のみ」

**日付**: 2026-07-30

## Context

placement下のセッションは、過去の会話（engine transcript）をresumeして文脈を継続する。しかしある権限バインド（placement・engine・employee）の下で得た文脈を、別のバインドへ持ち込むと権限境界を跨ぐ情報流出になる。

2026-07-26のハードニング（`000b1a3` "close placement authority bypasses"）はこれを防ぐため、placement経由の**全メッセージ**で `engineSessionId` を無条件クリアするよう変更した。結果、placementチャンネルは毎ターン `resume: none` の新規セッションになり、**会話が一切継続しない退行**が起きた（2026-07-30、事業運営チャンネルで「同じ指示を繰り返させられる・回答が噛み合わない」として顕在化）。

## Decision

transcriptクリアとengine killは**権限バインドが実際に変わった時だけ**行う。同一とみなす条件（すべて満たす場合のみresume継続）:

- `transportMeta.placementId` が同一
- engine が同一
- employee が同一
- stale metadata（engineOverride / engineSessions）が存在しない

実装: [PR #26](https://github.com/Unson-LLC/mana-runtime/pull/26)（`samePlacementAuthority`、manager.ts）

## Why

- 守るべき不変条件は「文脈は権限バインドを跨がない」であって「文脈を持たない」ではない
- 無条件クリアは安全側に見えるが、会話継続というplacementの前提機能を壊し、結果的に設定不備（ADR-0001参照）と区別のつかない品質障害を生んだ

## Alternatives

- 毎ターンクリア（000b1a3の挙動): 上記退行のため撤回
- model/effortの変更もクリア条件に含める: model切替はエンジン側が `--resume` 付きcold respawnで安全に処理するため、権限変更とはみなさない

## Consequences

- placement設定変更（employee変更等）を行うと、そのチャンネルの進行中会話は1回リセットされる（仕様）
- 同一性判定のフィールドを増減する場合はこのADRを更新すること
