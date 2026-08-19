# mana-runtime ドキュメント

このディレクトリは、Cloudflare-nativeなMana Runtimeの設計・運営文書の正本です。

現行Runtimeは `packages/cloud-runtime/` を中心に、Cloudflare Worker、Queue、Durable Objects、Cloudflare Computer / Sandbox、Claude Code、Brainbase連携で構成します。Jimmy / Jinn / OpenRyokoを基盤としたLightsail runtimeは廃止済みであり、現行設計の参照先にはしません。

## 正本の所在

| ディレクトリ | 役割 |
|---|---|
| `architecture/` | システム全体と機能単位の技術設計 |
| `adr/` | 後から理由を知る必要がある設計判断 |
| `discovery/` | 既存実装の棚卸し。確認済み内容だけをarchitectureへ昇華 |
| `management/` | プロダクト層の正本。roadmap、Story、優先順位、進捗 |
| `specs/` | VibePro Specと機械可読仕様 |
| `contracts/` / `responsibility-authority/` | 契約・責任・権限の機械可読アーティファクト |
| `operations/` | Cloudflare deployment、rollout、production verification |
| `plans/` | 現行・将来の実装/移行計画。廃止runtimeの設計資料は置かない |

## 読み方

1. 製品境界: `architecture/mana-operating-loop-product-boundary.md`
2. プロダクト理解: `management/roadmap.md`
3. システム理解: `architecture/01_system_overview.md` から必要な章へ
4. 機能単位: `management/stories/active/` -> `architecture/story-*.md` -> `specs/`
5. 本番運用: `operations/`
6. 設計判断の経緯: `adr/`

## 実装正本

```text
packages/cloud-runtime/       Cloudflare-native Mana runtime
packages/task-runtime-core/   task runtime primitives
packages/slack-thread-context Slack context primitives
packages/write-broker/        bounded write primitives
packages/web/                 Mana web surfaces
```

廃止したJimmy/OpenRyoko/Lightsail実装はGit履歴でのみ参照します。active source tree、現行CI、現行deployment contractへ復活させません。
