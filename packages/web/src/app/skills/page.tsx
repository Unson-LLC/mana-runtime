"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { renderMarkdown } from "@/lib/sanitize";
import { PageLayout } from "@/components/page-layout";
import { useBreadcrumbs } from "@/context/breadcrumb-context";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Zap } from "lucide-react";
import { useSettings } from "@/app/settings-provider";

interface Skill {
  name: string;
  description?: string;
  content?: string;
  requiredMcp?: string[];
  requiredTools?: string[];
  scope?: string;
  [key: string]: unknown;
}

export default function SkillsPage() {
  useBreadcrumbs([{ label: 'スキル' }])
  const { settings } = useSettings();
  const portalName = settings.portalName ?? "Ryoko";
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [skillContent, setSkillContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    api
      .getSkills()
      .then((data) => setSkills(data as Skill[]))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  function openSkill(skill: Skill) {
    setSelectedSkill(skill);
    setDialogOpen(true);
    setContentLoading(true);
    api
      .getSkill(skill.name)
      .then((data) => {
        const d = data as Record<string, unknown>;
        setSkillContent(
          (d.content as string) ||
            (d.skillMd as string) ||
            JSON.stringify(d, null, 2),
        );
      })
      .catch(() => setSkillContent("スキル内容の読み込みに失敗しました"))
      .finally(() => setContentLoading(false));
  }

  function closeDialog() {
    setDialogOpen(false);
    setSelectedSkill(null);
    setSkillContent(null);
  }

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto p-[var(--space-6)]">
        {/* Header */}
        <div className="flex items-center justify-between mb-[var(--space-6)]">
          <div>
            <h2 className="text-[length:var(--text-title2)] font-[var(--weight-bold)] text-[var(--text-primary)] mb-[var(--space-1)]">
              スキル
            </h2>
            <p className="text-[length:var(--text-body)] text-[var(--text-tertiary)]">
              能力と習得した行動パターン
            </p>
          </div>
          <button
            onClick={() =>
              alert(
                `新しいスキルを作成するには、${portalName}とチャットして何か新しいことを学ぶように頼んでください。`,
              )
            }
            className="py-[var(--space-2)] px-[var(--space-4)] rounded-[var(--radius-md,12px)] text-[var(--accent)] border-none cursor-pointer text-[length:var(--text-body)] font-[var(--weight-medium)]"
            style={{
              background:
                "color-mix(in srgb, var(--accent) 12%, transparent)",
            }}
          >
            + スキル作成
          </button>
        </div>

        {error && (
          <div
            className="mb-[var(--space-4)] rounded-[var(--radius-md,12px)] py-[var(--space-3)] px-[var(--space-4)] text-[length:var(--text-body)] text-[var(--system-red)]"
            style={{
              background:
                "color-mix(in srgb, var(--system-red) 10%, transparent)",
              border:
                "1px solid color-mix(in srgb, var(--system-red) 30%, transparent)",
            }}
          >
            スキルの読み込みに失敗しました: {error}
          </div>
        )}

        {loading ? (
          <div className="text-center p-[var(--space-8)] text-[var(--text-tertiary)] text-[length:var(--text-body)]">
            Loading...
          </div>
        ) : skills.length === 0 && !error ? (
          <Card>
            <CardContent>
              <div className="text-center p-[var(--space-6)]">
                <p className="text-[length:var(--text-body)] text-[var(--text-tertiary)]">
                  スキルがまだありません
                </p>
                <p className="text-[length:var(--text-caption1)] text-[var(--text-quaternary)] mt-[var(--space-1)]">
                  {portalName}とチャットして新しいスキルを教えましょう
                </p>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="rounded-[var(--radius-md,12px)] border border-[var(--separator)] overflow-x-auto">
            <table className="w-full text-[length:var(--text-footnote)]">
              <thead>
                <tr className="border-b border-[var(--separator)] text-left text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                  <th className="px-[var(--space-3)] py-[var(--space-2)] font-[var(--weight-medium)]">スキル</th>
                  <th className="px-[var(--space-3)] py-[var(--space-2)] font-[var(--weight-medium)]">説明</th>
                  <th className="px-[var(--space-3)] py-[var(--space-2)] font-[var(--weight-medium)]">scope</th>
                  <th className="px-[var(--space-3)] py-[var(--space-2)] font-[var(--weight-medium)]">requiredMcp</th>
                </tr>
              </thead>
              <tbody>
                {skills.map((skill) => (
                  <tr
                    key={skill.name}
                    className="border-b border-[var(--separator)] last:border-b-0 cursor-pointer transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_6%,transparent)]"
                    onClick={() => openSkill(skill)}
                  >
                    <td className="px-[var(--space-3)] py-[var(--space-2)] align-top">
                      <span className="inline-flex items-center gap-[var(--space-2)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
                        <Zap size={14} className="text-[var(--system-yellow)] shrink-0" />
                        {skill.name}
                      </span>
                    </td>
                    <td className="px-[var(--space-3)] py-[var(--space-2)] align-top text-[var(--text-secondary)]">
                      {skill.description || "説明なし"}
                    </td>
                    <td className="px-[var(--space-3)] py-[var(--space-2)] align-top text-[var(--text-secondary)] whitespace-nowrap">
                      {skill.scope || "global"}
                    </td>
                    <td className="px-[var(--space-3)] py-[var(--space-2)] align-top text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                      {skill.requiredMcp && skill.requiredMcp.length > 0
                        ? skill.requiredMcp.join(", ")
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Skill detail dialog */}
        <Dialog open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
          <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>{selectedSkill?.name ?? "Skill"}</DialogTitle>
              <DialogDescription>
                {selectedSkill?.description || "Skill details"}
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto py-[var(--space-2)]">
              {contentLoading ? (
                <p className="text-[length:var(--text-body)] text-[var(--text-tertiary)]">
                  読み込み中...
                </p>
              ) : skillContent ? (
                <div
                  className="text-[length:var(--text-body)] leading-[1.7] text-[var(--text-secondary)]"
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(skillContent),
                  }}
                />
              ) : null}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </PageLayout>
  );
}
