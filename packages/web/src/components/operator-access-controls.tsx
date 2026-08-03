export function OperatorAccessControls({
  token,
  onTokenChange,
  onRetry,
}: {
  token: string
  onTokenChange: (value: string) => void
  onRetry: () => void
}) {
  return (
    <section className="mb-[var(--space-6)]">
      <div className="px-[var(--space-2)] pb-[var(--space-2)] text-[length:var(--text-caption1)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)]">
        Operator access
      </div>
      <div className="rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--material-regular)] p-[var(--space-4)]">
        <div className="flex items-center justify-between gap-[var(--space-4)] py-[var(--space-2)]">
          <label
            htmlFor="operator-token"
            className="shrink-0 text-[length:var(--text-subheadline)] text-[var(--text-secondary)]"
          >
            Operator Token
          </label>
          <div className="flex w-[240px] shrink-0 gap-2">
            <input
              id="operator-token"
              type="password"
              value={token}
              onChange={(event) => onTokenChange(event.target.value)}
              placeholder="Required when placements are enabled"
              className="apple-input w-full rounded-[var(--radius-sm)] border border-[var(--separator)] bg-[var(--bg-secondary)] px-[10px] py-[6px] text-[length:var(--text-footnote)] text-[var(--text-primary)]"
            />
            <button
              type="button"
              onClick={onRetry}
              aria-label="Save token and retry operator authentication"
              className="rounded-md border border-[var(--border-primary)] px-3 text-sm"
            >
              Save &amp; Retry
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
