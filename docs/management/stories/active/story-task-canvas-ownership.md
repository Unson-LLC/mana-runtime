# Story: Mana管理タスクボードをチャンネル内へ自動作成する

## 利用者価値

Manaを招待したSlackチャンネルの利用者として、管理Canvas IDを手作業で調べて設定しなくても、Manaが自分でタスクボードCanvasを1つ作成し、Brainbaseの正本タスクを継続的に同期してほしい。これにより、既存の別用途Canvasを壊さず、議事録から登録したタスクを同じチャンネルで確認できる。

## 受け入れ条件

- [x] AC-1: 自動作成が許可されたtargetに保存済みbindingがない場合、Manaは`canvases.create`へ信頼済み`channelId`を渡して新しいタスクボードを1つ作り、返却されたCanvas IDを実行時状態へ保存する。
- [x] AC-2: 保存済みbindingがある場合は同じCanvas IDを再利用する。Slack無料プランの1チャンネル1Canvas制約で新規作成できない場合に限り、同じMana botが所有し、編集可能で、名称が「タスクボード」または「Mana タスクボード」の候補が1件だけなら継続利用する。人が所有するCanvas、別用途Canvas、複数候補は自動採用・更新しない。
- [x] AC-3: 作成応答が不明な場合や同時実行では二重作成せず、bindingが確定するまで安全側で停止する。Slackが作成していないと確定できるエラーだけ再試行可能にする。
- [x] AC-4: consumerはtenant、target、workspace、channel、binding revisionを信頼済み設定と照合し、不一致・無効・token未設定ではCanvasを作成・更新しない。
- [ ] AC-5: 登録済みの全task-board targetを自動作成対象として有効化し、本番readbackで各チャンネルにMana管理タスクボードが1つだけ存在し、Brainbaseの正本タスクと同期したことを確認する。招待・scope不足などで作成できないtargetは成功に含めず、対象別に未完了として残す。

## 成功指標

- 管理Canvas IDの手作業登録は0件である。
- 同一targetでMana管理タスクボードが重複作成される件数は0件である。
- 既存の他用途CanvasをManaが更新する件数は0件である。

## リリース条件

- Canvas作成、binding永続化、再利用、曖昧失敗、scope不一致のテストと型検査を通す。
- 登録済みの全targetを自動作成対象として有効化し、workspace別tokenに`canvases:write`とチャンネル参照権限があることを確認する。Mana bot未参加などで失敗したtargetは他targetの成功と分けて扱う。
- 配備後、各targetについて作成されたCanvas ID、チャンネルへの結び付き、`task_board_refreshed`、Canvas本文の正本タスクをreadbackする。CI、Queue受付、HTTP 200だけでは完了にしない。

## 現在地

全23 targetを自動作成対象として本番配備済みで、18 targetはMana管理Canvasの作成・同期をreadback済みである。無料プラン制約で止まったうち、Mana bot所有の既存タスクボード2件は安全な継続利用で復旧する。人所有の別用途Canvas2件と、Manaが参照できない法務チャンネル1件は未完了として残し、上書きや成功扱いをしない。
