/**
 * Shared Config page form tokens — extracted from ConfigPage.tsx (behavior frozen).
 */
import type { ReactNode } from 'react'
import { cn, INPUT_CLS } from '../ui'

// Legacy alias for the one text-control look (polish F5, obj 900806). New code
// uses <Field>/<Input> from '../ui'. This stays only for the controls that still
// take a class string (AssignmentsTab), so they match the primitive exactly.
export const inputCls = cn(INPUT_CLS, 'h-11 sm:h-9')

export function SectionLabel({ icon, children, className }: { icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-eyebrow text-fg-3', className)}>
      {icon}{children}
    </div>
  )
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`
}

export function formatName(name: string): string {
  return name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

