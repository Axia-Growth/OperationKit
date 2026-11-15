import type { ModelRow } from '@operationkit/shared'
import { Select } from './ui/Select'
import { modelOptionGroups, modelOptionLabel } from '../lib/model-options'

/* The one model dropdown (obj 900863). Settings → Models, the card modal and
   the bot page all render this, over registry rows, so the list and its format
   match everywhere. `leading` adds entries above the models (e.g. "Default"),
   `trailing` below them (e.g. "Other model id…"). A current value that is not
   in the registry still shows, marked, so a saved choice is never hidden. */

export interface ModelPickerExtra {
  value: string
  label: string
}

export function ModelPicker({
  models,
  value,
  onChange,
  id,
  disabled,
  className = 'w-full',
  leading = [],
  trailing = [],
  suffix,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
}: {
  models: ModelRow[]
  value: string
  onChange: (value: string) => void
  id?: string
  disabled?: boolean
  className?: string
  leading?: ModelPickerExtra[]
  trailing?: ModelPickerExtra[]
  /** Extra text after a model's label, e.g. " — off, will be enabled". */
  suffix?: (m: ModelRow) => string
  'aria-label'?: string
  'aria-describedby'?: string
}) {
  const groups = modelOptionGroups(models)
  const known = !value || models.some(m => m.id === value) || [...leading, ...trailing].some(o => o.value === value)
  return (
    <Select
      id={id}
      value={value}
      onChange={onChange}
      disabled={disabled}
      className={className}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
    >
      {leading.map(o => <option key={`l:${o.value}`} value={o.value}>{o.label}</option>)}
      {!known && <option value={value}>{value} (not in Settings → Models)</option>}
      {groups.map(g => (
        <optgroup key={g.engine} label={g.label}>
          {g.rows.map(m => (
            <option key={m.id} value={m.id}>{modelOptionLabel(m)}{suffix ? suffix(m) : ''}</option>
          ))}
        </optgroup>
      ))}
      {trailing.map(o => <option key={`t:${o.value}`} value={o.value}>{o.label}</option>)}
    </Select>
  )
}
