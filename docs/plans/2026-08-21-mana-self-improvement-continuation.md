# Mana自己改善の同一Story継続設計

## Status

- guided request / progress / structured result UX: implementation in progress
- same-Story decision resume: blocked by durable development state
- same-Story Gate continuation: blocked by durable development state
- merge / deploy / secret mutation: out of scope

## Problem

Cloudflare-native Manaは、開発operationごとにfresh Container identityを払い出し、終端callback後にContainerを破棄する。この境界はcross-tenant process、filesystem、credential、transcriptの再利用を構造的に防ぐために必要である。

一方、VibeProの`needs_decision`と`needs_input`から同じStoryを再開するには、前runの次の状態が必要になる。

- Story document
- `.vibepro` stateとevidence
- branch / worktree HEAD
- 未push commitとworking tree
- questions / human answers
- unresolved Gate
- runner identityとprovenance

旧Jimmyは同一ホストの永続worktreeを再利用できたが、fresh Containerへ移行したCloud runtimeにはその正本がない。したがって、Slackボタンから新しいContainerへ`storyId`だけを渡しても、同じStoryは再開できない。

## Safety decision

永続状態がないまま次のボタンを表示してはならない。

- Manaの推奨で続ける
- 続行してGateを解消させる

クリック後に新しいStoryを作る、空のworktreeで再開を装う、別tenantのContainerへfallbackする、runtime checkoutを使う、といった代替はすべて禁止する。

現段階では、`needs_decision`と`needs_input`を構造化された安全停止として表示する。利用者には質問、Manaの推奨、ここまでの成果、残っている確認を示すが、同一Story継続を成功したとは扱わない。

## Required architecture

以下のいずれかを正本として選び、tenant・operation・Storyへ署名付きで束縛する必要がある。

### Option A: private durable worktree artifact

- run終了時にgit bundleまたは検証済みsnapshotをprivate object storageへ保存
- artifact digest、base SHA、branch、Story ID、tenant、operationをReceiptへ記録
- continuation時にfresh Containerへrestore
- restore後にdigest、base、tenant、Storyを再検証
- terminal completionまたはTTL後に削除し、deletion receiptを残す

### Option B: paused Container ownership

- `needs_decision` / `needs_input`をterminalではなくpaused stateとして扱う
- Container IDとfilesystemをtenant-scoped owner stateへ保持
- 新しいsigned tenant contextで同じContainer ownershipを再認証
- timeout、回答期限、強制破棄、quota accountingを定義
- 別Container、別tenant、別Storyへのfallbackを禁止

Option Aを推奨する。人間の回答待ちは長時間になり得るため、Containerを保持し続けるより、暗号学的に検証可能なprivate artifactをfresh Containerへrestoreする方が分離・費用・復旧の境界を明確にできる。

## Acceptance Criteria

- [ ] Story stateはtenant ID、connection revision、operation ID、Story ID、base SHAへ束縛される
- [ ] artifact本文や未push codeをSlack、通常ログ、Receiptへ出さない
- [ ] 別tenant、別person、別Story、stale revision、改ざんartifactをrestore前に拒否する
- [ ] needs_decisionの回答後に同一Story・同一branch lineageをreadbackできる
- [ ] needs_inputの続行後に前runのcommitとGate evidenceが保持される
- [ ] duplicate click / Queue retryでcontinuation run、Slack投稿、外部副作用が重複しない
- [ ] completion、cancel、timeoutでartifactまたはpaused Containerを削除し、証跡を残す
- [ ] restore不能時に新規Storyへfallbackせず、安全停止する

## Current UX boundary

この設計が実装されるまで、今回のP0/P1 PRが提供するのは次までとする。

- 非エンジニア向け改善依頼フォーム
- 型付き`mana_improvement_request_v1`
- 実在するSlack受付メッセージをthread rootに使用
- 整理中 / 変更中 / 確認中の進捗表示
- questions / gates / commits / Storyを失わない構造化callback
- 利用者向けの判断・Gate・成果・失敗カード
- merge / deploy / secret変更を行わない安全境界

同一Story継続は、この文書のAcceptance Criteriaが満たされるまで未完了として扱う。
