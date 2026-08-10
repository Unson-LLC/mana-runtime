"use client"

import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { PageLayout } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { api } from "@/lib/api"
import {
  normalizeProjectCodes,
  resolveChannelPlacementUpdate,
  type PlacementProjectBinding,
} from "./project-binding"

function splitProjectCodes(value: string): string[] {
  return normalizeProjectCodes(value.split(/[\n,]/))
}

function ChannelProjectSettings() {
  useBreadcrumbs([{ label: "Placements", href: "/placements" }, { label: "Project設定" }])
  const params = useSearchParams()
  const connectorId = params.get("connector")?.trim() ?? ""
  const workspaceId = params.get("workspace")?.trim() ?? ""
  const channelId = params.get("channel")?.trim() ?? ""
  const [placements, setPlacements] = useState<PlacementProjectBinding[]>([])
  const [value, setValue] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (!connectorId || !channelId) throw new Error("connectorとchannelの指定が必要です")
      const config = await api.getConfig()
      const nextPlacements = Array.isArray(config.placements)
        ? config.placements as PlacementProjectBinding[]
        : []
      const matches = nextPlacements.filter((placement) =>
        placement.connector === connectorId
        && placement.channelId === channelId
        && (!workspaceId || placement.workspaceId === workspaceId),
      )
      if (matches.length !== 1) {
        resolveChannelPlacementUpdate(nextPlacements, {
          connectorId, workspaceId: workspaceId || undefined, channelId, projectCodes: [],
        })
      }
      setPlacements(nextPlacements)
      setValue((matches[0]?.projects ?? []).join("\n"))
    } catch (err) {
      setError(err instanceof Error ? err.message : "設定を取得できませんでした")
    } finally {
      setLoading(false)
    }
  }, [channelId, connectorId, workspaceId])

  useEffect(() => { void load() }, [load])

  const candidates = useMemo(() => normalizeProjectCodes(
    placements.flatMap((placement) => placement.projects ?? []),
  ), [placements])

  async function save() {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const projectCodes = splitProjectCodes(value)
      if (projectCodes.length === 0) throw new Error("project codeを1つ以上入力してください")
      const updated = resolveChannelPlacementUpdate(placements, {
        connectorId, workspaceId: workspaceId || undefined, channelId, projectCodes,
      })
      const result = await api.updateConfig({ placements: updated })
      if (result.status === "partial") throw new Error("保存しましたがCanvasの再読込に失敗しました")
      setPlacements(updated)
      setValue(projectCodes.join("\n"))
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存できませんでした")
    } finally {
      setSaving(false)
    }
  }

  return (
    <PageLayout>
      <div className="h-full overflow-auto bg-[var(--bg)] px-[var(--space-6)] py-[var(--space-5)]">
        <div className="mx-auto max-w-2xl">
          <Link href="/placements" className="text-[length:var(--text-caption1)] text-[var(--accent)]">← Placements</Link>
          <h1 className="mt-[var(--space-3)] text-[length:var(--text-title2)] font-[var(--weight-bold)] text-[var(--text-primary)]">
            チャンネルのproject設定
          </h1>
          <p className="mt-[var(--space-1)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
            {connectorId || "—"} · {workspaceId || "workspace未指定"} / {channelId || "—"}
          </p>

          <div className="mt-[var(--space-5)] rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--material-thin)] p-[var(--space-4)]">
            {loading ? <p className="text-[var(--text-tertiary)]">Loading…</p> : (
              <>
                <label htmlFor="project-codes" className="block text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
                  project code（複数可）
                </label>
                <p className="mt-[var(--space-1)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                  1行に1件、またはカンマ区切り。チャンネル名からの自動推測はしません。
                </p>
                <textarea
                  id="project-codes"
                  value={value}
                  onChange={(event) => { setValue(event.target.value); setSaved(false) }}
                  rows={7}
                  className="mt-[var(--space-3)] w-full rounded-[var(--radius-sm)] border border-[var(--separator)] bg-[var(--bg)] p-[var(--space-3)] font-mono text-[length:var(--text-footnote)] text-[var(--text-primary)]"
                  placeholder="mana\nbrainbase"
                />
                {candidates.length > 0 && (
                  <div className="mt-[var(--space-2)] flex flex-wrap gap-[var(--space-1)]">
                    {candidates.map((code) => (
                      <button
                        key={code}
                        type="button"
                        onClick={() => setValue(normalizeProjectCodes([...splitProjectCodes(value), code]).join("\n"))}
                        className="rounded-full border border-[var(--separator)] px-[var(--space-2)] py-px text-[length:var(--text-caption2)] text-[var(--text-secondary)]"
                      >
                        {code}
                      </button>
                    ))}
                  </div>
                )}
                <div className="mt-[var(--space-4)] flex items-center gap-[var(--space-3)]">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void save()}
                    className="rounded-[var(--radius-sm)] bg-[var(--accent)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-white disabled:opacity-50"
                  >
                    {saving ? "保存・Canvas更新中…" : "保存してCanvasを更新"}
                  </button>
                  {saved && <span className="text-[length:var(--text-footnote)] text-[var(--system-green)]">保存しました</span>}
                </div>
              </>
            )}
            {error && <p className="mt-[var(--space-3)] text-[length:var(--text-footnote)] text-[var(--system-red)]">{error}</p>}
          </div>
        </div>
      </div>
    </PageLayout>
  )
}

export default function ChannelProjectSettingsPage() {
  return <Suspense fallback={null}><ChannelProjectSettings /></Suspense>
}
