# ディレクトリ構成

**最終更新**: 2026-07-30

## 1. リポジトリ構成

```text
mana-runtime/
├── packages/
│   ├── jimmy/               # gateway本体（パッケージ名: openryoko）
│   │   └── src/
│   │       ├── gateway/     # server起動・HTTP API・hook受信・operator認証・watcher・budgets
│   │       ├── connectors/  # slack / discord / telegram / whatsapp / cron
│   │       ├── sessions/    # SessionManager・registry(SQLite)・placement文脈・development-runner・委譲認可
│   │       ├── engines/     # claude-interactive(PTY)・claude(headless)・codex・gemini・mock
│   │       ├── mcp/         # gateway MCPサーバ（gatewayTools公開）・policy
│   │       ├── shared/      # config・types・placement-profile（権限境界の choke point）・paths
│   │       ├── cron/ cli/ stt/
│   │       └── index.ts
│   └── web/                 # 管理UI（Next.js、静的出力を jimmy/dist/web へ同梱）
├── scripts/
│   ├── development-runner/  # /ryoko-develop のroot所有ラッパー実体
│   └── systemd/             # run receipt・health timer
├── docs/                    # 設計正本（docs/README.md 参照）
└── e2e/                     # Playwright
```

## 2. 責務分離の要点

- **権限境界のchoke point**は `shared/placement-profile.ts`（engine実行）と `mcp/gateway-policy.ts`（ツール公開）。権限に触る変更はまずここを読む
- connectors は受発信のみ。判断（placement解決・認可）は SessionManager 側
- engines は「1ターン実行して結果を返す」以外を知らない。リトライ・フォールバック等の政策は manager
- 業務データの正本はリポジトリ外（[02_data_design.md](./02_data_design.md)）

## 3. 実行環境の配置（pilot）

```text
/home/ryoko/
├── src/OpenRyoko/           # 本番checkout（main追従）
├── .ryoko/                  # runtime home（config.yaml正本・sessions/registry.db・logs・人格ファイル）
├── .claude/projects/        # Claude transcripts
└── bin/ryoko                # systemd ExecStart
/usr/local/libexec/openryoko-development-runner   # root所有・ryoko-dev実行ラッパー
```

## 4. 命名の歴史的経緯

| 名前 | 実体 |
|---|---|
| `jimmy` / `jinn` | upstream由来のパッケージディレクトリ名・内部識別子 |
| `openryoko` / `ryoko` | 旧プロダクト名（npmパッケージ名・Unixユーザー・runtime home に残存） |
| `mana` / mana-runtime | 現行名。リポジトリ旧名 `brainbase-mana` はリダイレクトされる |

改名の追従は「動作に触らない範囲で段階的に」。識別子の一括置換はしない（ADR候補）。
