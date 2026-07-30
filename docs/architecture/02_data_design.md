# データストア設計

**最終更新**: 2026-07-30

mana-runtime自身は「会話の経路・状態」だけを持ち、**業務データの正本は外部（brainbase側）に置く**。ランタイムをステートレスに近づけ、正本を一箇所にする方針。

## 1. ランタイム内ストア

| ストア | 場所 | 内容 |
|---|---|---|
| Session registry | `~/.ryoko/sessions/registry.db`（SQLite / better-sqlite3） | `sessions`（id・sessionKey・engine・**engineSessionId**・employee・model・status・transportMeta・コスト累計）と `messages`。ゲートウェイ再起動をまたぐ会話継続の要 |
| Claude transcripts | `~/.claude/projects/<cwd-slug>/<claudeSessionId>.jsonl` | Claude Code CLI自身の会話履歴。engineSessionIdで`--resume`する。lost-Stop回復・コスト再計算にも使用 |
| Runtime config | `~/.ryoko/config.yaml`（**pilotが正本**・file watcherでhot-reload） | connectors・placements・engines・developmentRunner等。変更前に`config.yaml.bak-<date>-<intent>`でバックアップ |
| Gateway info | `~/.ryoko/gateway.json` | port・hook secret・pid（hook-relay discovery用） |
| 人格・スキル・記憶 | `~/.ryoko/`（CLAUDE.md・skills/・memory/・knowledge/） | 振る舞いを永続的に変える資産。正本・権限・書込ゲートは [11章](./11_persona_skills_memory.md) を正とする（現状は全placement共有・履歴なしで、目標と乖離） |
| その他 | `~/.ryoko/`（org/ cron/ logs/ など） | 組織定義・cron定義等の運用ファイル |

### sessions の要点

- 1セッション = 1 sessionKey（`slack:<channel>:<thread>`）。スレッドが会話の単位
- `engineSessionId` はhook（SessionStart/Stop）到着時に即時永続化（中断ターンでも失わない）
- `transportMeta.placementId` が権限バインドの現在値。placement変更検知（authority rebind判定）に使う

## 2. 外部正本（ランタイムは参照・書込クライアント）

| データ | 正本 | アクセス経路 |
|---|---|---|
| Canonical Task | **bb.unson.jp（Lightsail PostgreSQL 16、single-writer）** | companion task API（service token）。エージェントはcreate/list/update/transitionのみ、deleteなし。Macローカル31013系はfail-closed済み（2026-07-29移設） |
| Graph SSOT（固有名詞・RACI・意思決定） | bb.unson.jp | brainbase MCP（read-only運用） |
| 業務テーブル | NocoDB（noco.unson.jp） | NocoDB MCP |
| タスクの可視ビュー | Slack Canvas | Canonical Taskのミラー（正本ではない） |

## 3. 設計原則

- **registry.dbに業務データを持たない**。会話状態と経路情報のみ
- 外部正本への書込は冪等キーを付ける（例: 議事録タスク登録 `meeting:<ch>:<ts>:<index>`、roadmapタスク `mana-roadmap-<date>-*`）
- ミラー（Canvas等）と正本が食い違ったら正本を優先し、ミラーを作り直す

## 4. TODO

- registry.dbのスキーマ定義（DDL）をこの文書へ転記する（現状は [registry.ts](../../packages/jimmy/src/sessions/registry.ts) が事実上の定義）
- `~/.ryoko/` 配下の運用ファイル群の棚卸し（どれが配布物でどれがインスタンス固有か）
