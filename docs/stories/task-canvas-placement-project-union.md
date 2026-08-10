# Task Canvas placement project union

## Story

Slackの各チャンネルCanvasで、そのplacementに設定された複数projectのCanonical Taskを、
担当者ごとに確認できるようにする。

## Acceptance criteria

- Canvasの対象は `task.project_codes ∩ placement.projects ≠ ∅` のTaskである。
- 複数projectの結果は和集合とし、同じTask IDは1件にまとめる。
- Canvasは担当者別（未割当を含む）に表示し、各Taskにprojectタグを表示する。
- CanvasはBrainbase PostgreSQLの読み取り専用projectionであり、直接編集を正本へ戻さない。
- meeting task proposalから登録するTaskには、そのSlack channelのplacement projectsを保存する。
- Slack placementの `connector` はinstance IDではなくtransport種別 `slack` とし、
  Canvas対象は `connector + workspaceId + channelId` の完全一致で決める。
- placement運用時にconnector側の `workspaceId` が未設定なら、別workspaceへ誤配信せず
  Canvas生成をfail closedする。
- `placement.taskCanvas.enabled: false` はCanvasだけを対象外にし、通常のmessage routing、
  delivery、meeting task proposalは維持する。

## Release boundary

このStoryはコードと契約テストまでを対象とする。Brainbase schema apply、Mana deploy、
既存Taskのproject backfill、Slack上の実Canvas確認は別の承認済みリリース作業とする。
