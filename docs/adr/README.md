# ADR

このディレクトリは、後から理由を知る必要がある設計判断を記録する場所です。

ADRはすべての判断に対して作るものではありません。以下のすべてに当てはまる場合だけ作成します。

- 後から変更するコストが高い
- 背景を知らない人が見たら意外に感じる
- 実際に複数の選択肢があり、トレードオフを選んだ

## 命名

```text
0001-short-title.md
0002-short-title.md
```

## 書き方

[テンプレート](./_template.md) をコピーして使います。

本文は短くて構いません。重要なのは、何を決めたかだけでなく、なぜその判断にしたかを残すことです。

## 一覧

| # | タイトル | 日付 |
|---|---|---|
| [0001](./0001-placement-deny-by-default.md) | placementの能力はdeny-by-default、制限はハード境界で強制する | 2026-07-30 |
| [0002](./0002-placement-rebind-transcript-clearing.md) | placementのtranscriptクリアは「権限バインド変更時のみ」 | 2026-07-30 |
| [0003](./0003-broad-credential-with-tool-layer-enforcement.md) | 広権限クレデンシャル+ツール層強制を許容する条件 | 2026-07-30 |
| [0004](./0004-no-second-permission-system.md) | ランタイムに第二の権限体系を作らない（スコープ語彙はbrainbaseから借りる） | 2026-07-30 |
| [0005](./0005-read-only-configuration-topology.md) | 設定確認は独立したread-only topologyと固定URLで提供する | 2026-08-02 |
