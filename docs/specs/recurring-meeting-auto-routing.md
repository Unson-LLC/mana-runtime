# Recurring meeting auto-routing spec

Story: `story-recurring-meeting-auto-routing`

## Configuration

```yaml
meetingMinutesPipeline:
  autoRoutes:
    - ruleId: tech-knight-board-weekly
      destinationId: tech-knight-minutes
      messageTextIncludesAll: ["Tech Knight", "ボード定例"]
      fileNameIncludesAll: ["board-weekly"]
```

`destinationId`は同じpipelineの正規化済み`destinations`または互換`shareDestinations`に存在する値を使う。
各ruleには少なくとも1つの空でないmatcherが必要である。

## Required behavior

1. Slackの`.txt` file-shareを受けたとき、投稿文とファイル名を正規化して全matcherを照合する。
2. 有効なruleが1件だけ一致すれば、そのdestinationをconfigから解決して既存pipelineを継続する。
3. 0件または複数件なら、LLMの候補提示とoperatorの宛先ボタン確認を行う。
4. rule不正またはdestination不明は一致として扱わない。
5. 投稿直前の既存destination snapshot検証、remote delivery gateway、更新・再試行契約を変更しない。
6. stateにはrule IDとconfig由来の承認主体を記録するが、投稿文とtranscript本文は追加保存しない。

## Test mapping

- AC-01/04/06: 正規化された一意一致が分類なしでlocal destinationへ配信される。
- AC-02: 未一致が`awaiting_destination`となる既存testを維持する。
- AC-03: 複数一致と未知destinationが自動投稿しない。
- AC-05: 明示ruleのcross-workspace配送が既存`shareMinutes`だけを呼ぶ。
- AC-07: meeting-minutes pipeline suiteとtypecheckを通す。
