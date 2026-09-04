---
story_id: story-company-authority-live-transport
title: "Manaの会社権限取得をBrainbase実APIへ接続する"
status: active
spec_docs:
  - docs/specs/company-authority-live-transport.md
---

# Manaの会社権限取得をBrainbase実APIへ接続する

## 成果と範囲

Program A0の未完了境界である固定 `not_collected` clientを実API接続へ置き換える。認証済みSlack操作は、既存private service binding経由でBrainbaseの会社権限producerへ到達し、既存adapterの署名・tenant/person・scope検証を通った場合だけQueueへ進む。

前提はBrainbase PR #1394のproducer契約と既存private bridge。public fetch、新しいservice JWT保管、旧authorityへのfallbackは追加しない。T0の本番schema/OAuth、P0/G0、7境界の本番readbackをこの実装のローカル成功で完了扱いしない。

## 受入条件

- AC-001: 専用clientが既存private service bindingへPOST `/api/v1/runtime/company-authority:resolve`を送り、観測requestを保持する。呼出元Authorizationは渡さない。
- AC-002: 応答は未信頼のまま既存adapterへ渡し、署名検証を省略しない。通信・HTTP・JSON失敗、redirect、不正contextは作用前に拒否する。
- AC-003: 有効設定の実Worker入口が専用clientを呼ぶ。client欠落は設定不備。disabledの既存経路を維持し、opt-in後の失敗では旧authorityとQueueへ進まない。
- AC-004: ローカルの影響テストと独立レビューを経てPR/CI/mergeを行い、配備後の同一run本番証跡は別に取得する。production evidenceは取得までnot_collected。

## 変更対象

`http-clients.ts`、`company-authority-runtime-config.ts`、Workerの`/slack/events`接続と対応テスト。resource_refの正本解決互換性は接続の成功に必要な別の確認点として残し、HTTP成功だけで解決済みにしない。
