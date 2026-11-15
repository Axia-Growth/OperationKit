import {
  createContext,
  forwardRef,
  useContext,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import { Check, Minus } from 'lucide-react'
import { cn } from './cn'

/* ─────────────────────────────────────────────────────────
   Form primitives (polish F5, obj 900806): Field, Input, Textarea,
   Checkbox. One control look for every form: the same height as
   ui/Select and ui/Button md (36px desktop, 44px on touch), one
   hairline, one focus ring, one invalid state.

   <Field label="Name" hint="Shown on the card" error={err}>
     <Input value={v} onChange={…} />
   </Field>

   Field owns the label/hint/error ids. The control inside picks them up
   from context (id, aria-describedby, aria-invalid), so the label always
   names the control and the hint/error are read with it. Pass `id` on
   Field (or the control) to pin it; otherwise one is generated.

   Labels, not placeholders: a placeholder is an example value, never the
   only name a control has.
   ───────────────────────────────────────────────────────── */

/** The one text-control look. Exported for the rare control that cannot be an
 *  <Input> (a search box with a leading icon, a contenteditable…). */
export const INPUT_CLS =
  'block w-full min-w-0 rounded-md border border-line bg-surface-1 px-3 text-sm text-fg-0 ' +
  'placeholder:text-fg-3 outline-none transition-colors duration-fast ease-out ' +
  'hover:border-line-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 ' +
  'aria-[invalid=true]:border-danger aria-[invalid=true]:focus-visible:ring-danger/30 ' +
  'disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-fg-3 read-only:bg-surface-0'

/** Single-line control heights, on the F1 control scale shared with ui/Select
 *  and ui/Button: xs 24px (dense rails), sm 32px (toolbars), md 36px (forms;
 *  44px on touch). md is the default. This one module owns Input / Textarea /
 *  Checkbox for the whole app: the board (F4, #781) and Settings (F5) call
 *  sites use the same components. */
type InputSize = 'xs' | 'sm' | 'md'
const INPUT_SIZE: Record<InputSize, string> = {
  xs: 'h-6 px-2 text-xs',
  sm: 'h-8 px-2.5 text-sm',
  md: 'h-11 sm:h-9',
}

interface FieldCtx {
  id: string
  describedBy?: string
  invalid: boolean
  required: boolean
}

const FieldContext = createContext<FieldCtx | null>(null)

/** For controls outside this file (ui/Select) to join a Field. */
export function useFieldControl(props: {
  id?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling'
  required?: boolean
}) {
  const ctx = useContext(FieldContext)
  const describedBy = [ctx?.describedBy, props['aria-describedby']].filter(Boolean).join(' ') || undefined
  const invalidProp = props['aria-invalid'] === true || props['aria-invalid'] === 'true'
  return {
    id: props.id ?? ctx?.id,
    'aria-describedby': describedBy,
    'aria-invalid': invalidProp || ctx?.invalid ? true : undefined,
    required: props.required ?? (ctx?.required || undefined),
  }
}

export function Field({
  label,
  hint,
  error,
  id,
  required,
  optional,
  action,
  className,
  labelClassName,
  children,
}: {
  label: ReactNode
  /** Help text under the control (read with it via aria-describedby). */
  hint?: ReactNode
  /** Error under the control; also marks the control aria-invalid. */
  error?: ReactNode
  /** Pins the control id (default: generated). */
  id?: string
  required?: boolean
  /** Shows a quiet "Optional" after the label. */
  optional?: boolean
  /** Right-aligned element on the label row (a "Generate" link, a counter…). */
  action?: ReactNode
  className?: string
  labelClassName?: string
  children: ReactNode
}) {
  const auto = useId()
  const controlId = id ?? `f${auto.replace(/:/g, '')}`
  const hintId = hint ? `${controlId}-hint` : undefined
  const errorId = error ? `${controlId}-error` : undefined
  const ctx: FieldCtx = {
    id: controlId,
    describedBy: [errorId, hintId].filter(Boolean).join(' ') || undefined,
    invalid: !!error,
    required: !!required,
  }
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <div className="flex min-h-5 items-center justify-between gap-3">
        <label htmlFor={controlId} className={cn('text-sm font-medium text-fg-1', labelClassName)}>
          {label}
          {optional && <span className="ml-1.5 font-normal text-fg-3">Optional</span>}
        </label>
        {action && <div className="-my-1 flex shrink-0 items-center">{action}</div>}
      </div>
      <FieldContext.Provider value={ctx}>{children}</FieldContext.Provider>
      {error && (
        <p id={errorId} className="text-xs text-danger">
          {error}
        </p>
      )}
      {hint && (
        <p id={hintId} className="text-xs leading-relaxed text-fg-2">
          {hint}
        </p>
      )}
    </div>
  )
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Control height: xs 24px, sm 32px, md 36px (44px on touch). Default md. */
  size?: InputSize
  /** Marks the control invalid without a Field error (e.g. a live mismatch). */
  invalid?: boolean
  /** Text/icon inside the left edge (a search glyph, "https://"). */
  leading?: ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, leading, size = 'md', type = 'text', ...rest },
  ref,
) {
  const f = useFieldControl({ ...rest, 'aria-invalid': invalid || rest['aria-invalid'] })
  const input = (
    <input
      ref={ref}
      type={type}
      {...rest}
      id={f.id}
      required={f.required}
      aria-describedby={f['aria-describedby']}
      aria-invalid={f['aria-invalid']}
      className={cn(INPUT_CLS, INPUT_SIZE[size], leading ? 'pl-8' : undefined, className)}
    />
  )
  if (!leading) return input
  return (
    <div className="relative min-w-0">
      <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-fg-3" aria-hidden="true">
        {leading}
      </span>
      {input}
    </div>
  )
})

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, rows = 3, ...rest },
  ref,
) {
  const f = useFieldControl({ ...rest, 'aria-invalid': invalid || rest['aria-invalid'] })
  return (
    <textarea
      ref={ref}
      rows={rows}
      {...rest}
      id={f.id}
      required={f.required}
      aria-describedby={f['aria-describedby']}
      aria-invalid={f['aria-invalid']}
      className={cn(INPUT_CLS, 'py-2 leading-relaxed', className)}
    />
  )
})

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  /** Visible label, clickable. Omit only when an outer <label> or aria-label names it. */
  label?: ReactNode
  /** Secondary line under the label. */
  description?: ReactNode
  /** Mixed state (some of a group checked). */
  indeterminate?: boolean
}

/* Checkbox — a real <input type=checkbox> (so forms, tests and assistive tech
   see a native checkbox), drawn in our tokens instead of the browser default:
   a 16px box on a 44px touch row, accent fill when checked. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, indeterminate, className, disabled, id, ...rest },
  ref,
) {
  const auto = useId()
  const f = useFieldControl({ id, ...rest })
  const boxId = f.id ?? `c${auto.replace(/:/g, '')}`
  const descId = description ? `${boxId}-desc` : undefined
  const box = (
    <span className="relative inline-grid h-4 w-4 shrink-0 place-items-center">
      <input
        ref={(el) => {
          if (el) el.indeterminate = !!indeterminate
          if (typeof ref === 'function') ref(el)
          else if (ref) ref.current = el
        }}
        {...rest}
        type="checkbox"
        id={boxId}
        disabled={disabled}
        aria-describedby={[f['aria-describedby'], descId].filter(Boolean).join(' ') || undefined}
        className={cn(
          'peer m-0 h-4 w-4 cursor-pointer appearance-none rounded-[4px] border border-line-strong bg-surface-1',
          'transition-colors duration-fast ease-out hover:border-fg-3',
          'checked:border-accent checked:bg-accent indeterminate:border-accent indeterminate:bg-accent',
          'outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      />
      {indeterminate ? (
        <Minus className="pointer-events-none absolute h-3 w-3 text-accent-fg" strokeWidth={3} aria-hidden="true" />
      ) : (
        <Check
          className="pointer-events-none absolute hidden h-3 w-3 text-accent-fg peer-checked:block"
          strokeWidth={3}
          aria-hidden="true"
        />
      )}
    </span>
  )
  if (label == null) return <span className={cn('inline-flex', className)}>{box}</span>
  return (
    <label
      htmlFor={boxId}
      className={cn(
        'inline-flex min-h-[44px] cursor-pointer items-start gap-2.5 py-1 text-sm text-fg-1 sm:min-h-0',
        disabled && 'cursor-not-allowed opacity-70',
        className,
      )}
    >
      <span className="mt-0.5 inline-flex">{box}</span>
      <span className="min-w-0">
        <span className="block text-fg-0">{label}</span>
        {description && (
          <span id={descId} className="mt-0.5 block text-xs leading-relaxed text-fg-2">
            {description}
          </span>
        )}
      </span>
    </label>
  )
})
