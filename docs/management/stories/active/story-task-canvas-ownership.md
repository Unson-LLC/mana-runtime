# Story: Mana管理タスクボードをチャンネル内へ自動作成する

## 利用者価値

Manaを招待したSlackチャンネルの利用者として、管理Canvas IDを手作業で調べて設定しなくても、Manaが自分でタスクボードCanvasを1つ作成し、Brainbaseの正本タスクを継続的に同期してほしい。これにより、既存の別用途Canvasを壊さず、議事録から登録したタスクを同じチャンネルで確認できる。

## 受け入れ条件

- [x] AC-1: 自動作成が許可されたtargetに保存済みbindingがない場合、Manaは`canvases.create`へ信頼済み`channelId`を渡して新しいタスクボードを1つ作り、返却されたCanvas IDを実行時状態へ保存する。
- [x] AC-2: 保存済みbindingがある場合は同じCanvas IDを再利用し、チャンネルに元からあるCanvasや先頭のCanvasを自動採用・更新しない。
- [x] AC-3: 作成応答が不明な場合や同時実行では二重作成せず、bindingが確定するまで安全側で停止する。Slackが作成していないと確定できるエラーだけ再試行可能にする。
- [x] AC-4: consumerはtenant、target、workspace、channel、binding revisionを信頼済み設定と照合し、不一致・無効・token未設定ではCanvasを作成・更新しない。
- [ ] AC-5: PMSとHP制作を対象別に有効化し、本番readbackで各チャンネルにMana管理タスクボードが1つだけ存在し、Brainbaseの正本タスクと同期したことを確認する。

## 成功指標

- 管理Canvas IDの手作業登録は0件である。
- 同一targetでMana管理タスクボードが重複作成される件数は0件である。
- 既存の他用途CanvasをManaが更新する件数は0件である。

## リリース条件

- Canvas作成、binding永続化、再利用、曖昧失敗、scope不一致のテストと型検査を通す。
- PMS、HP制作を1件ずつ有効化し、対象workspaceへのMana bot参加と`canvases:write`、チャンネル参照権限を確認する。
- 配備後、各targetについて作成されたCanvas ID、チャンネルへの結び付き、`task_board_refreshed`、Canvas本文の正本タスクをreadbackする。CI、Queue受付、HTTP 200だけでは完了にしない。

## 現在地

現行実装は所有権事故を避けるため、手作業で`manaCanvasId`を設定するまで全targetを停止している。この安全条件を保ったまま、静的設定は作成許可範囲、Durable ObjectはManaが実際に作成したCanvas IDの正本へ責務を分ける。
