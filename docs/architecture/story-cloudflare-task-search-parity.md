---
architecture_id: arch-cloudflare-task-search-parity
story_id: story-cloudflare-task-search-parity
title: Cloudflare版境界付きタスク検索アーキテクチャ
status: accepted
date: 2026-08-13
---

# Cloudflare版境界付きタスク検索アーキテクチャ

## 決定

Cloudflare Sandboxへ検索専用stdio MCPを同梱し、Claudeの一般返信だけを `--mcp-config` と `--strict-mcp-config` で接続する。MCPはBrainbaseへ直接接続せず、固定合成host `task-search.internal` を呼ぶ。Workerのoutbound handlerだけがBrainbaseの正規検索APIへ認証付きで中継する。

## データフロー

```text
Slack app_mention
  -> Workerがtenant/workspace/channel/project bindingを解決
  -> Sandbox Claude --print + 検索専用stdio MCP
  -> HTTPS GET task-search.internal/api/companion/tasks/search
  -> Worker outbound handlerが要求を検証・再構築
  -> Brainbase GET /api/companion/tasks/search
  -> MCP result
  -> Claudeが元Slack threadへ回答
```

## 認可境界

- `enableInternet=false` を維持する。
- `allowedHosts` はAnthropicと合成hostだけにする。実Brainbase hostをSandboxへ許可しない。
- MCP inputに `project_code`、token、上流URLを公開しない。
- WorkerはSandbox由来のAuthorization、Cookie、Host等を破棄する。
- WorkerはGET、固定path、既知query key、query 1〜200文字、limit 1〜20だけを許可する。
- projectは `RUNTIME_PROJECT_CODES` を正規化し、繰り返し `project_code` として一回の検索へ付与する。空ならfail closedする。
- Worker secretのTask tokenは上流fetchのAuthorizationにだけ使う。

## 検索契約

`search_tasks` はqueryを必須とし、status、priority、assignee_person_id、cursor、limitを任意で受ける。既定limitは20、最大20とする。複数projectを個別取得して結合せず、一つの検索集合へlimitとopaque cursorを適用する。

`items=[]`、`has_more=false`、`next_cursor=null`、`read_status=complete`が揃った場合だけ、許可project・指定条件内の0件として扱う。部分結果と上流障害は0件へ変換しない。

## 段階展開と切戻し

`RUNTIME_TASK_SEARCH_ENABLED` は未設定をOFFとする。まずOFFのまま互換WorkerとMCP入りContainerを配備し、Containerがready/healthyであることを確認する。次に雲孫deploymentだけONへ変更する。

異常時は最初にフラグをOFFへ戻して従来のMCPなし一般返信へ戻す。必要ならknown-good Worker versionへ戻す。以前のContainer imageは切戻し完了まで削除しない。各deployでGit SHA、Worker version、Container image digestを記録する。

## 変更しないもの

Brainbase検索API、Taskデータ、LightsailのJimmy gateway、Slack署名・配送、meeting-taskの作成経路は変更しない。
