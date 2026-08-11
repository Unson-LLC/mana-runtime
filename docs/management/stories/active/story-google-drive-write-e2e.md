---
story_id: story-google-drive-write-e2e
title: Google Drive成果物の書き込みとリンク返信を成功させる
status: active
---

# Google Drive成果物の書き込みとリンク返信を成功させる

## User story

バックオフィス担当者として、Slackでmanaへ成果物の作成を依頼したとき、その成果物を`info@unson.jp`のGoogle Driveへ保存し、実在するDriveリンクを同じSlackスレッドで受け取りたい。これにより、成果物へすぐアクセスでき、Drive上で一元管理できる。

## Confirmed failure

本番E2Eでは、Slack受信、Drive MCPの読み取り、Slack返信、learning candidate送信は成功した。一方、テキストファイル作成時に`create_file`が未公開で失敗し、代替の`upload_file`もローカル一時ファイルが`GOOGLE_DRIVE_ALLOWED_UPLOAD_ROOTS`外だったため失敗した。DriveファイルIDとリンクは生成されなかった。

## Acceptance Criteria

- Google Drive MCPが、ファイル名、本文、任意のMIME type、任意の親フォルダIDを受け取る`create_file`を公開する。
- `create_file`はローカルworkspaceへのWrite権限や`GOOGLE_DRIVE_ALLOWED_UPLOAD_ROOTS`に依存せず、Driveへ本文をアップロードする。
- テキスト本文とbase64本文のどちらか一方だけを受け付け、空入力、同時指定、不正base64、上限超過をDrive API呼び出し前に拒否する。
- 成功時はDrive APIが返したファイルIDと`webViewLink`を返し、manaが同じSlackスレッドへリンクを返信できる。
- Drive作成に失敗した場合、ファイルやリンクを作成済みと回答しない。
- 既存の`upload_file`、Drive読み取り、Sheets操作、placementのMCP allowlist、アカウント固定を壊さない。
- unit、typecheck、build、およびMCP protocol integration testが通る。
- 通常デプロイとrollbackのどちらでも、固定MCPパスが現在のreleaseに含まれるGoogle Drive adapterを参照する。
- 本番E2EでDrive上の実ファイル、リンク、Slack返信をそれぞれ確認する。

## Non-goals

- Driveファイルの削除、共有権限変更、公開リンク化
- placementごとのフォルダ権限モデルの新設
- 大容量動画など、MCP inline payload上限を超える成果物の転送
