---
architecture_id: arch-hotreload-placement-authority
story_id: HOTRELOAD-PLACEMENT-AUTHORITY
title: placement authorityとClaude transcriptの再開境界
status: accepted
date: 2026-08-12
---

# placement authorityとClaude transcriptの再開境界

## 決定

Claudeのengine sessionは、placement IDだけでなく、そのplacementのauthority revisionにも結び付ける。`SessionManager.route` が毎turn、設定正本から現在のrevisionを計算し、保存済みrevisionと一致する場合だけ既存の `engineSessionId` をresumeする。

## Revisionの範囲

revisionは全placementの集合ではなく、現在解決された1つのplacementを対象にする。これにより他チャンネルの設定変更で無関係な会話をリセットしない。

対象には `capabilities.mcp` と `gatewayTools` に加え、audience、projects、workspace、dataScopesなど同じClaude transcriptの権限・システム文脈に影響するplacement情報を含める。安全側の余分な一度のfresh化は許容する。

## 再開判定

次をすべて満たす場合だけresumeする。

1. placement IDが一致する。
2. engineが一致する。
3. employeeが一致する。
4. placement authority revisionが一致する。
5. cross-engine用の旧metadataに不整合がない。

いずれかが不一致なら、存在するengine sessionを終了し、`engineSessionId` をnullにしてfresh runへ進む。revisionを持たないlegacy sessionも不一致として扱い、fresh run後に現在revisionを保存する。

## 信頼境界

incoming `transportMeta` のrevisionは認可判断に使わない。`SessionManager` がserver側で解決したplacementからrevisionを計算し、保存値をcanonical overwriteする。

## デプロイ境界

今回の変更はLightsail上のJimmy SessionManagerにだけ作用する。Cloudflare Workerは別App・別セッション経路であり、この `engineSessionId` resume処理を使わない。

Lightsail反映後は、失敗した同一Slackスレッドで最初のturnが `resume: none` になり、次のturnが新しいengine sessionをresumeすることをE2Eで確認する。
