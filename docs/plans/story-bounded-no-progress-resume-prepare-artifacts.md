# story-bounded-no-progress-resume task plan

## Scope

Story `story-bounded-no-progress-resume` の実装と検証を、対象Story専用のArchitectureとSpecへ
追跡可能にする。別Storyの文書やartifactを証拠として流用しない。

## Tasks

- [x] Story frontmatterへArchitecture、Spec、Taskの正規リンクを追加する。
- [x] fixed argv、realpath containment、single resume、shared deadline、人間境界をArchitectureに固定する。
- [x] ACと明示Scenarioをmachine-readable Spec clauseへ対応付け、threat modelを追加する。
- [ ] `pnpm --filter jinn-cli test -- development-runner.test.ts`でclause固有のunit evidenceを取得する。
- [ ] `pnpm typecheck`と`pnpm build`をcurrent HEADで実行し、VibePro verification evidenceへ記録する。
- [ ] running sessionで`RUNNER_VERSION`、配備済み`run.mjs`のSHA-256、期待Git HEADを採取し、一致を確認する。ソースcheckoutの値だけをrunning-session証跡として扱わない。
- [ ] docs-only pilotで1回のbounded resumeが`pr_ready`に達し、PR作成、merge、deployが行われないことを確認する。

## Allowed paths

- `docs/management/stories/active/story-bounded-no-progress-resume.md`
- `docs/architecture/story-bounded-no-progress-resume.md`
- `docs/specs/story-bounded-no-progress-resume.vibepro.json`
- `docs/plans/story-bounded-no-progress-resume-prepare-artifacts.md`

## Completion evidence

Spec validation、Story source integrity、scenario lineage、clause traceability、必須diagramが対象Story IDで
解決すること。配備バグの完了判断はrunning-session version stamp取得後にのみ行う。
