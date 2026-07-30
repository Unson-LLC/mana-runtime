# placementの能力はdeny-by-default、制限はハード境界で強制する

**日付**: 2026-07-30（channel-placement-profiles設計時の判断を追認・明文化）

## Context

同一ランタイムを複数チャンネルで使うと、あるチャンネルに与えたMCP・ツール・データが別チャンネルへ暗黙に広がる。またLLMへの「〜しかアクセスするな」というプロンプト指示は、プロンプトインジェクションや判断ミスで破られる。

## Decision

- placementの `capabilities`（mcp / gatewayTools / allowedDelivery）は**明示したものだけ許可**。未設定は全拒否
- 権限昇格が起きうる制限は必ず**コード層（ハード境界）**で強制する。`projects` / `dataScopes` はプロンプト注入の**ソフト境界**であり、行動指針の宣言にのみ使う

## Why

- fail-closedにしておけば、設定漏れの結果は「使えない」であって「漏れる」ではない。前者は気づけるが後者は気づけない
- モデルの遵守に依存する制御は敵対的入力に対して防御にならない

## Alternatives

- デフォルト許可+ブラックリスト: 設定漏れが即漏えいになるため不採用
- プロンプトのみでの制限: 上記の理由で不採用

## Consequences

- **新規placementは `capabilities` を書くまで「何も参照できない一般論bot」になる**。これは仕様（2026-07-30の事業運営チャンネルで、capabilities未設定のまま運用開始し「わけのわからない回答」障害として顕在化した。設定を書けば即解消する）
- placement新設手順に「capabilities/projects/agentまで書く」を含めること（雛形: `mana-backoffice`）
