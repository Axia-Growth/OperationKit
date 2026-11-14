import { Children, isValidElement, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import {
  Select as SdkSelect,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@ui-sdk/react/select'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from './cn'

/* Select on the UI SDK select behavior (obj 900819): a button trigger with a
   listbox popup drawn in our tokens (so the list matches the theme in light
   and dark, which a native <select> list does not), arrows / Home / End /
   typeahead, Escape and outside press to close, focus back to the trigger,
   a bottom sheet on small touch screens, and a hidden native input when it
   has a `name` so forms still submit.

   Options come from `options`, or from <option> children so a native
   <select> moves over with the same markup. */

export interface SelectOption {
  value: string
  label: ReactNode
  disabled?: boolean
}

// The SDK treats null as "nothing chosen"; an option whose value is "" (e.g.
// "Any") still has to be choosable, so it travels under a sentinel.
const EMPTY = '__cc_empty__'
const toSdk = (v: string) => (v === '' ? EMPTY : v)
const fromSdk = (v: string) => (v === EMPTY ? '' : v)

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children)
  return ''
}

/** Reads <option> (and <optgroup> contents) children into options. */
function optionsFromChildren(children: ReactNode): SelectOption[] {
  const out: SelectOption[] = []
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return
    const el = child as ReactElement<{ value?: string | number; children?: ReactNode; disabled?: boolean }>
    if (el.type === 'optgroup') {
      out.push(...optionsFromChildren(el.props.children))
    } else if (el.type === 'option') {
      const label = el.props.children
      out.push({ value: String(el.props.value ?? textOf(label)), label, disabled: el.props.disabled })
    }
  })
  return out
}

export const SELECT_TRIGGER =
  'inline-flex h-11 min-w-0 sm:h-9 items-center justify-between gap-2 rounded-md border border-line bg-surface-2 px-2.5 text-left text-sm text-fg-0 outline-none transition-colors duration-fast ease-out hover:border-line-strong aria-[invalid=true]:border-danger focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 data-[open]:border-line-strong data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50'

export function Select({
  value,
  onChange,
  options,
  children,
  id,
  name,
  disabled,
  required,
  placeholder,
  className,
  contentClassName,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
}: {
  value: string
  onChange: (value: string) => void
  options?: SelectOption[]
  /** <option> / <optgroup> children, as on a native select. */
  children?: ReactNode
  /** Goes on the trigger, so a <label htmlFor> names it. */
  id?: string
  name?: string
  disabled?: boolean
  required?: boolean
  placeholder?: string
  /** Trigger classes (width etc.). */
  className?: string
  contentClassName?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
}) {
  const items = options ?? optionsFromChildren(children)
  // The open list carries the same name as the field, so a screen reader says
  // "Scope, listbox" rather than a bare "listbox". A <label htmlFor> names the
  // trigger natively; read its text for the list.
  const [labelText, setLabelText] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (ariaLabel || ariaLabelledBy || !id || typeof document === 'undefined') return
    const el = document.querySelector(`label[for="${CSS.escape(id)}"]`)
    setLabelText(el?.textContent?.trim() || undefined)
  }, [id, ariaLabel, ariaLabelledBy])
  const known = items.some((o) => o.value === value)
  return (
    <SdkSelect
      value={known ? toSdk(value) : null}
      onValueChange={(next) => {
        if (next != null) onChange(fromSdk(next))
      }}
      itemToLabel={(v) => textOf(items.find((o) => toSdk(o.value) === v)?.label) || v}
      name={name}
      disabled={disabled}
      required={required}
      placeholder={placeholder}
      presentation="auto"
      loop
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid || undefined}
        className={cn(SELECT_TRIGGER, className)}
      >
        <SelectValue className="min-w-0 truncate data-[placeholder]:text-fg-3" />
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden="true" />
      </SelectTrigger>
      <SelectContent
        aria-label={ariaLabelledBy ? undefined : ariaLabel ?? labelText}
        aria-labelledby={ariaLabelledBy}
        sideOffset={4}
        collisionPadding={8}
        className={cn(
          'z-[60] m-0 max-h-[min(60vh,var(--available-height,60vh))] min-w-[var(--anchor-width)] overflow-y-auto rounded-lg border border-line bg-surface-1 p-1 text-fg-1 shadow-pop outline-none cc-pop-in',
          contentClassName,
        )}
      >
        {items.map((o) => (
          <SelectItem
            key={o.value}
            value={toSdk(o.value)}
            label={textOf(o.label)}
            disabled={o.disabled}
            className="flex min-h-[40px] cursor-default select-none items-center gap-2 rounded-md px-2.5 text-sm outline-none transition-colors duration-fast sm:min-h-[32px] data-[highlighted]:bg-surface-3 data-[highlighted]:text-fg-0 data-[selected]:text-fg-0 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45"
          >
            <SelectItemText className="min-w-0 flex-1 truncate">{o.label}</SelectItemText>
            <SelectItemIndicator className="shrink-0 text-accent">
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
            </SelectItemIndicator>
          </SelectItem>
        ))}
      </SelectContent>
    </SdkSelect>
  )
}
