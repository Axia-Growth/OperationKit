import { useId, type ReactNode } from 'react'
import { cn } from './cn'

/* ─────────────────────────────────────────────────────────
   SettingsSection (polish F5, obj 900806) — the ONE section header for
   Settings, Secrets and every form page under them: a title, an optional
   one-line description, and right-aligned actions. Replaces the 14
   hand-rolled h2/h3 styles and the redundant eyebrows ("SETTINGS ·
   BRANDING", "MANAGE / Workspaces") above them.

   level 2 = a section of a Settings tab (16px semibold).
   level 3 = a sub-section inside one (14px semibold).

   `danger` draws the GitHub-style Danger zone: a red hairline box for
   destructive, hard-to-undo actions, kept away from Save.
   ───────────────────────────────────────────────────────── */
export function SettingsSection({
  title,
  description,
  actions,
  level = 2,
  danger,
  id,
  className,
  bodyClassName,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  level?: 2 | 3
  /** Danger zone styling for destructive actions. */
  danger?: boolean
  id?: string
  className?: string
  bodyClassName?: string
  children?: ReactNode
}) {
  const auto = useId()
  const headingId = `${id ?? `s${auto.replace(/:/g, '')}`}-title`
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn(
        'min-w-0',
        danger && 'rounded-lg border border-danger/40 p-4',
        className,
      )}
    >
      <SectionHeader
        headingId={headingId}
        title={title}
        description={description}
        actions={actions}
        level={level}
        danger={danger}
      />
      {children != null && <div className={cn('min-w-0', bodyClassName)}>{children}</div>}
    </section>
  )
}

/** The header row on its own, for a section whose body is laid out elsewhere. */
export function SectionHeader({
  title,
  description,
  actions,
  level = 2,
  danger,
  headingId,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  level?: 2 | 3
  danger?: boolean
  headingId?: string
  className?: string
}) {
  const Heading = level === 2 ? 'h2' : 'h3'
  return (
    <div className={cn('mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4', className)}>
      <div className="min-w-0">
        <Heading
          id={headingId}
          className={cn(
            'font-semibold leading-snug',
            level === 2 ? 'text-base' : 'text-sm',
            danger ? 'text-danger' : 'text-fg-0',
          )}
        >
          {title}
        </Heading>
        {description && <p className="mt-1 max-w-prose text-sm leading-relaxed text-fg-2">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
