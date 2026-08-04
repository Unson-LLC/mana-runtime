"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangle, CheckCircle2, CircleHelp, RefreshCw } from "lucide-react"
import { ApiError, api, type SettingsTopology } from "@/lib/api"
import { operatorToken, storeOperatorToken } from "@/lib/operator-auth"
import { PageLayout } from "@/components/page-layout"
import { cn } from "@/lib/utils"

export type SettingsTopologyView = "topology" | "slack" | "minutes" | "permissions" | "history"

const tabs: Array<{ href: string; label: string }> = [
  { href: "/settings/topology", label: "全体" },
  { href: "/settings/connectors/slack", label: "Slack接続" },
  { href: "/settings/meeting-minutes", label: "議事録" },
  { href: "/settings/permissions", label: "権限" },
  { href: "/settings/history", label: "履歴" },
]

const viewHref: Record<SettingsTopologyView, string> = {
  topology: "/settings/topology",
  slack: "/settings/connectors/slack",
  minutes: "/settings/meeting-minutes",
  permissions: "/settings/permissions",
  history: "/settings/history",
}

// The API contract deliberately excludes credentials. Keep a second boundary
// in the browser so an accidentally broadened projection cannot render common
// token forms or credential-bearing URLs into the operator UI.
function containsSensitiveDisplayValue(value: unknown): boolean {
  if (typeof value === "string") {
    return /(?:xox[baprs]|xapp)-[A-Za-z0-9-]{6,}/i.test(value) ||
      /https?:\/\/[^/\s:@]+:[^@\s/]+@/i.test(value)
  }
  if (Array.isArray(value)) return value.some(containsSensitiveDisplayValue)
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsSensitiveDisplayValue)
  }
  return false
}

function statusLabel(status: string, code?: string): string {
  if (status === "verified" && code === "channel_ready_by_static_checks") return "静的確認済み（実投稿未確認）"
  if (status === "verified") return "Slack確認済み"
  if (status === "healthy") return "実行中"
  if (status === "error") return "Slack確認エラー"
  if (status === "degraded") return "実行異常"
  if (status === "stopped") return "停止"
  return "未確認"
}

const responseModeLabels: Record<string, string> = {
  always: "常に応答",
  mention: "メンション時のみ応答",
  never: "応答しない",
}

const reasonGuidance: Record<string, { cause: string; action: string }> = {
  bot_not_member: { cause: "Botが対象チャンネルに参加していません。", action: "SlackでBotを対象チャンネルに招待してください。" },
  channel_archived: { cause: "対象チャンネルはアーカイブされています。", action: "有効なチャンネルへ設定を変更してください。" },
  permission_denied: { cause: "Botにチャンネル確認の権限がありません。", action: "Slackアプリの権限と再インストール状況を確認してください。" },
  channel_not_found: { cause: "対象チャンネルをSlack上で確認できません。", action: "チャンネルIDとBotが接続するworkspaceを確認してください。" },
  workspace_identity_unavailable: { cause: "接続先workspaceの認証済みIDを確認できません。", action: "共有先connectorの認証と起動状態を確認してください。" },
  workspace_mismatch: { cause: "設定したworkspaceとBotの接続先が一致しません。", action: "共有先workspace IDまたはconnector設定を修正してください。" },
  slack_probe_failed: { cause: "Slackへの確認処理が失敗しました。", action: "Slack接続と権限を確認してから再取得してください。" },
  runtime_snapshot_unavailable: { cause: "実行中のconnectorから最新状態を取得できません。", action: "connectorの起動状態を確認してから再取得してください。" },
  target_connector_missing: { cause: "共有先connectorの宣言または起動を確認できません。", action: "共有先connectorの設定と起動状態を確認してください。" },
  slack_runtime_unavailable: { cause: "Slack connectorが正常に稼働していません。", action: "connectorのログとSlack接続を確認して再起動してください。" },
}

function Status({ status, code }: { status: string; code?: string }) {
  const Icon = status === "verified" || status === "healthy" ? CheckCircle2 : status === "unconfirmed" || status === "unknown" ? CircleHelp : AlertTriangle
  const color = status === "verified" || status === "healthy" ? "var(--system-green)" : status === "unconfirmed" || status === "unknown" ? "var(--system-orange)" : "var(--system-red)"
  const guidance = code ? reasonGuidance[code] : undefined
  return <span className="inline-grid max-w-md gap-1 text-xs">
    <span className="inline-flex items-center gap-1 font-medium" style={{ color }}><Icon size={14} aria-hidden="true" />{statusLabel(status, code)}</span>
    {guidance && <span className="text-foreground/75"><span>原因: {guidance.cause}</span> <span>対応: {guidance.action}</span></span>}
    {code && <code className="text-[11px] text-muted-foreground">診断コード: {code}</code>}
  </span>
}

function OperatorPrompt({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState("")
  return (
    <section className="mx-auto mt-16 w-full max-w-md rounded-xl border border-border bg-[var(--bg-secondary)] p-5 shadow-sm" aria-labelledby="operator-auth-title">
      <h2 id="operator-auth-title" className="text-lg font-semibold">Operator認証が必要です</h2>
      <p className="mt-2 text-sm text-muted-foreground">構成情報は認証後にだけ取得します。TokenはURLには保存されません。</p>
      <label className="mt-4 block text-sm font-medium" htmlFor="topology-operator-token">Operator Token</label>
      <input id="topology-operator-token" type="password" autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} className="mt-1 h-10 w-full rounded-md border border-border bg-background px-3" />
      <button type="button" onClick={() => { storeOperatorToken(value.trim()); onSaved() }} disabled={!value.trim()} className="mt-4 h-10 w-full rounded-md bg-[var(--accent)] px-4 text-sm font-semibold text-white disabled:opacity-50">
        Tokenを保存して再取得
      </button>
    </section>
  )
}

export function SettingsTopologyViewPage({ view }: { view: SettingsTopologyView }) {
  const [data, setData] = useState<SettingsTopology | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Keep the server and first client render identical. The effect below reads
  // browser storage and replaces this conservative state immediately after hydration.
  const [authRequired, setAuthRequired] = useState(true)
  const [query, setQuery] = useState<URLSearchParams>(() => new URLSearchParams())

  useEffect(() => setQuery(new URLSearchParams(window.location.search)), [])

  const refresh = useCallback(() => {
    if (!operatorToken()) {
      setData(null); setLoading(false); setAuthRequired(true); return
    }
    setLoading(true); setError(null); setAuthRequired(false)
    api.getSettingsTopology()
      .then((next) => {
        if (containsSensitiveDisplayValue(next)) throw new Error("unsafe topology projection")
        setData(next)
      })
      .catch((reason) => {
        setData(null)
        if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) setAuthRequired(true)
        else setError("構成情報を取得できませんでした。時間をおいて再試行してください。")
      })
      .finally(() => setLoading(false))
  }, [])

  const requestReauthentication = useCallback(() => {
    storeOperatorToken("")
    setData(null)
    setError(null)
    setLoading(false)
    setAuthRequired(true)
  }, [])

  useEffect(() => refresh(), [refresh])

  const selection = useMemo(() => ({ workspace: query.get("workspace"), project: query.get("project"), channel: query.get("channel") }), [query])
  const hasSelection = Boolean(selection.workspace || selection.project || selection.channel)
  const matchingRoute = hasSelection ? data?.routes.find((route) =>
    (!selection.workspace || route.workspaceId === selection.workspace) &&
    (!selection.project || route.projectId === selection.project) &&
    (!selection.channel || route.channelId === selection.channel)) : undefined

  return (
    <PageLayout suppressOnboarding>
      <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background">
        <header className="border-b border-border px-4 py-4 sm:px-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-bold">Mana 構成</h1>
              <p className="mt-1 text-sm text-foreground/75">宣言設定・実行状態・Slack確認結果を分けて表示します。編集はできません。</p>
            </div>
            <button type="button" onClick={refresh} aria-label="構成情報を再取得" className="inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-border hover:bg-accent"><RefreshCw size={16} /></button>
          </div>
          <nav aria-label="Mana構成" className="mt-4 flex gap-1 overflow-x-auto pb-1">
            {tabs.map((tab) => <Link key={tab.href} href={tab.href} aria-current={viewHref[view] === tab.href ? "page" : undefined} className={cn("whitespace-nowrap rounded-md px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]", viewHref[view] === tab.href ? "bg-[var(--accent-fill)] font-semibold text-[var(--accent)]" : "text-foreground/75 hover:bg-accent")}>{tab.label}</Link>)}
          </nav>
        </header>

        <div className="flex-1 overflow-auto px-4 py-5 sm:px-6">
          {authRequired ? <OperatorPrompt onSaved={refresh} /> : loading ? (
            <div role="status" className="text-sm text-muted-foreground">構成情報を読み込んでいます…</div>
          ) : error ? (
            <div role="alert" className="rounded-lg border border-[var(--system-red)] p-4">
              <p>{error}</p>
              <div className="mt-3 flex flex-wrap gap-4">
                <button type="button" onClick={refresh} className="underline">再試行</button>
                <button type="button" onClick={requestReauthentication} className="underline">Operator Tokenを再入力</button>
              </div>
            </div>
          ) : !data ? null : (
            <div className="mx-auto max-w-7xl">
              {hasSelection && !matchingRoute && <div role="status" className="mb-4 rounded-lg border border-[var(--system-orange)] p-3 text-sm">指定された対象は現在の構成に見つかりません。全体表示に戻しています。</div>}
              {view === "history" ? (
                <section aria-labelledby="history-heading">
                  <h2 id="history-heading" className="text-base font-semibold">構成履歴</h2>
                  <p className="mt-1 text-xs text-muted-foreground">観測: {new Date(data.observedAt).toLocaleString()}</p>
                  {data.history.length === 0 ? <p className="mt-5 text-sm text-muted-foreground">表示できる履歴metadataはありません。</p> : <div className="mt-4 space-y-2">{data.history.map((entry) => <article key={`${entry.ts}:${entry.file}`} className="rounded-lg border border-border p-3"><p className="font-medium">{entry.file}</p><p className="text-sm text-muted-foreground">{entry.ts} · {entry.source} · operator: {entry.operatorAuthenticated === true ? "認証済み" : "未確認"}</p></article>)}</div>}
                </section>
              ) : view === "permissions" ? (
                <section aria-label="Slack権限設定">
                  <p className="mb-4 text-sm text-foreground/75">ここに表示するのはSlack APIの権限ではなく、Mana Botが誰に・どこで応答するかの方針です。</p>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {data.connectors.length === 0 ? <p className="text-sm text-muted-foreground">Slack connectorは設定されていません。</p> : data.connectors.map((connector) => <article key={connector.instanceId} className="rounded-xl border border-border p-4"><h2 className="font-semibold">{connector.instanceId}</h2><dl className="mt-3 grid grid-cols-2 gap-2 text-sm"><dt className="text-muted-foreground">操作許可ユーザー</dt><dd>{connector.allowlistedOperatorCount}人</dd><dt className="text-muted-foreground">ダイレクトメッセージ</dt><dd>{responseModeLabels[connector.respondTo.im] ?? connector.respondTo.im}</dd><dt className="text-muted-foreground">複数人DM</dt><dd>{responseModeLabels[connector.respondTo.mpim] ?? connector.respondTo.mpim}</dd><dt className="text-muted-foreground">チャンネル</dt><dd>{responseModeLabels[connector.respondTo.channel] ?? connector.respondTo.channel}</dd></dl></article>)}
                  </div>
                </section>
              ) : view === "slack" ? (
                <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Slack connector状態">
                  {data.connectors.length === 0 ? <p className="text-sm text-foreground/75">Slack connectorは設定されていません。</p> : data.connectors.map((connector) => <article key={connector.instanceId} className="rounded-xl border border-border p-4"><div className="flex items-start justify-between gap-2"><h2 className="font-semibold">{connector.instanceId}</h2><Status status={connector.health} code={connector.healthCode ?? undefined} /></div><p className="mt-3 text-sm">Workspace: {connector.workspaceName ?? "名称未確認"} <span className="text-foreground/75">({connector.workspaceId ?? "ID未確認"})</span></p><p className="mt-1 text-sm">Slack入口: {connector.settingsEntryEnabled ? "有効" : "無効"}</p><p className="mt-1 text-xs text-foreground/75">最終確認: {connector.checkedAt ?? "未実施"}</p>{connector.healthObservedAt && <p className="mt-1 text-xs text-foreground/75">実行状態観測: {connector.healthObservedAt}</p>}</article>)}
                </section>
              ) : (
                <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
                  <section aria-label="議事録ルーティング" className="space-y-3">
                    {data.routes.length === 0 ? <p className="text-sm text-muted-foreground">議事録routeは設定されていません。</p> : data.routes.map((route) => {
                      const selected = matchingRoute?.id === route.id
                      const routerChannelDetails = route.routerChannelDetails ?? route.routerChannels.map((channelId) => ({ channelId, channelName: null, verification: { status: "unconfirmed" as const, code: "runtime_snapshot_unavailable", checkedAt: null } }))
                      return <article key={route.id} className={cn("rounded-xl border p-4", selected ? "border-[var(--accent)] bg-[var(--accent-fill)]" : "border-border")}><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs font-semibold uppercase tracking-wide text-foreground/75">{route.kind === "share" ? "別workspace共有" : "通常配送"}</p><h2 className="mt-1 font-semibold">{route.projectName} <span className="text-sm font-normal text-foreground/75">({route.projectId})</span></h2></div><Status status={route.verification.status} code={route.verification.code} /></div><p className="mt-2 text-xs text-foreground/75">経路確認: {route.verification.checkedAt ?? "未実施"}</p><dl className="mt-3 grid gap-2 text-sm"><div><dt className="inline text-foreground/75">送信元:</dt> <dd className="inline">{route.sourceConnectorInstanceId} / {route.sourceWorkspaceName ?? "workspace名称未確認"} ({route.sourceWorkspaceId ?? "ID未確認"})</dd></div><div><dt className="inline text-foreground/75">Router:</dt> <dd className="mt-1 grid gap-1">{routerChannelDetails.length === 0 ? "未設定" : routerChannelDetails.map((channel) => <span key={channel.channelId} className="flex flex-wrap items-center gap-2"><span>{channel.channelName ? `#${channel.channelName}` : "名称未確認"} ({channel.channelId})</span><Status status={channel.verification.status} code={channel.verification.code} /><span className="text-xs text-foreground/75">確認: {channel.verification.checkedAt ?? "未実施"}</span></span>)}</dd></div><div><dt className="inline text-foreground/75">送信先:</dt> <dd className="inline">{route.destinationConnectorInstanceId} / {route.workspaceName ?? "workspace名称未確認"} ({route.workspaceId ?? "ID未確認"}) / {route.channelName ? `#${route.channelName}` : "channel名称未確認"} ({route.channelId})</dd></div></dl></article>
                    })}
                  </section>
                  <aside className="rounded-xl border border-border p-4 lg:sticky lg:top-0 lg:self-start" aria-label="構成概要"><h2 className="font-semibold">概要</h2><dl className="mt-3 grid grid-cols-2 gap-2 text-sm"><dt className="text-foreground/75">Connector</dt><dd>{data.summary.connectorCount}</dd><dt className="text-foreground/75">Route</dt><dd>{data.summary.routeCount}</dd><dt className="text-foreground/75">警告</dt><dd>{data.summary.warningCount}</dd></dl>{data.warnings.length > 0 && <div className="mt-4 space-y-3" role="status" aria-label="構成警告">{data.warnings.map((warning, index) => <div key={`${warning.targetId}:${warning.code}:${index}`} className="text-xs text-foreground/75"><p>{warning.message}</p><code className="text-[11px] text-muted-foreground">診断コード: {warning.code}</code></div>)}</div>}</aside>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </PageLayout>
  )
}
