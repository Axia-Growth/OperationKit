// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { Checkbox, Field, Input, Textarea } from './Field'
import { Select } from './Select'
import { cleanup, click, render } from '../../test/render'

/* Form primitives (polish F5, obj 900806): the label names the control,
   hint and error are read with it, invalid shows, one control look. */

afterEach(cleanup)

const labelFor = (c: Element) => {
  const id = c.getAttribute('id')
  return id ? document.querySelector(`label[for="${id}"]`)?.textContent : null
}
const describedText = (c: Element) =>
  (c.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent)
    .join(' | ')

describe('ui/Field + Input', () => {
  it('the visible label names the input (htmlFor ↔ id), no placeholder needed', async () => {
    const { container } = await render(
      <Field label="Workspace name">
        <Input value="" onChange={() => {}} />
      </Field>,
    )
    const input = container.querySelector('input')!
    expect(labelFor(input)).toBe('Workspace name')
    expect(input.getAttribute('placeholder')).toBeNull()
  })

  it('pins the id passed on Field (so existing ids and tests survive)', async () => {
    const { container } = await render(
      <Field label="Username" id="username">
        <Input value="" onChange={() => {}} />
      </Field>,
    )
    expect(container.querySelector('input')!.id).toBe('username')
    expect(container.querySelector('label')!.getAttribute('for')).toBe('username')
  })

  it('hint and error are read with the control; error marks it invalid', async () => {
    const { container, rerender } = await render(
      <Field label="Slug" hint="Lowercase letters and dashes">
        <Input value="" onChange={() => {}} />
      </Field>,
    )
    const input = () => container.querySelector('input')!
    expect(describedText(input())).toBe('Lowercase letters and dashes')
    expect(input().getAttribute('aria-invalid')).toBeNull()

    await rerender(
      <Field label="Slug" hint="Lowercase letters and dashes" error="That slug is taken">
        <Input value="" onChange={() => {}} />
      </Field>,
    )
    expect(input().getAttribute('aria-invalid')).toBe('true')
    expect(describedText(input())).toBe('That slug is taken | Lowercase letters and dashes')
  })

  it('required on Field reaches the control; Optional shows on the label', async () => {
    const { container } = await render(
      <>
        <Field label="Name" required>
          <Input value="" onChange={() => {}} />
        </Field>
        <Field label="Notes" optional>
          <Textarea value="" onChange={() => {}} />
        </Field>
      </>,
    )
    expect((container.querySelector('input') as HTMLInputElement).required).toBe(true)
    expect(container.textContent).toContain('NotesOptional')
  })

  it('Input keeps native props, one control height, and a focus ring', async () => {
    const onChange = vi.fn()
    const { container } = await render(
      <Input aria-label="Search" type="search" value="abc" onChange={onChange} data-testid="q" leading={<span>⌕</span>} />,
    )
    const input = container.querySelector('[data-testid="q"]') as HTMLInputElement
    expect(input.type).toBe('search')
    expect(input.getAttribute('aria-label')).toBe('Search')
    expect(input.className).toContain('sm:h-9')
    expect(input.className).toContain('h-11')
    expect(input.className).toContain('focus-visible:ring-2')
    expect(input.className).toContain('pl-8') // room for the leading icon
  })

  it('invalid on Input marks it without a Field', async () => {
    const { container } = await render(<Input aria-label="x" invalid value="" onChange={() => {}} />)
    expect(container.querySelector('input')!.getAttribute('aria-invalid')).toBe('true')
  })
})

describe('ui/Textarea', () => {
  it('joins a Field like Input does', async () => {
    const { container } = await render(
      <Field label="Description" hint="Shown to reviewers">
        <Textarea value="" onChange={() => {}} />
      </Field>,
    )
    const ta = container.querySelector('textarea')!
    expect(labelFor(ta)).toBe('Description')
    expect(describedText(ta)).toBe('Shown to reviewers')
    expect(ta.rows).toBe(3)
  })
})

describe('ui/Select inside a Field', () => {
  it('the Field label names the Select trigger and the hint describes it', async () => {
    const { container } = await render(
      <Field label="Scope" hint="Who can use the secret">
        <Select value="global" onChange={() => {}} options={[{ value: 'global', label: 'Everywhere' }]} />
      </Field>,
    )
    const trigger = container.querySelector('[role="combobox"]')!
    expect(labelFor(trigger)).toBe('Scope')
    expect(describedText(trigger)).toBe('Who can use the secret')
  })

  it('an error marks the Select invalid', async () => {
    const { container } = await render(
      <Field label="Workspace" error="Pick a workspace">
        <Select value="" onChange={() => {}} options={[{ value: 'a', label: 'Acme' }]} />
      </Field>,
    )
    expect(container.querySelector('[role="combobox"]')!.getAttribute('aria-invalid')).toBe('true')
  })
})

describe('ui/Checkbox', () => {
  function Harness({ onChange }: { onChange: (v: boolean) => void }) {
    const [on, setOn] = useState(false)
    return (
      <Checkbox
        label="Send me a copy"
        description="One email per run"
        checked={on}
        onChange={(e) => {
          setOn(e.target.checked)
          onChange(e.target.checked)
        }}
      />
    )
  }

  it('is a real, labelled checkbox drawn in tokens (not the browser default)', async () => {
    const { container } = await render(<Harness onChange={() => {}} />)
    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(labelFor(box)).toContain('Send me a copy')
    expect(describedText(box)).toBe('One email per run')
    expect(box.className).toContain('appearance-none')
    expect(box.className).toContain('checked:bg-accent')
    expect(box.className).toContain('focus-visible:ring-2')
  })

  it('clicking the label toggles it', async () => {
    const onChange = vi.fn()
    const { container } = await render(<Harness onChange={onChange} />)
    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    await click(container.querySelector('label'))
    expect(onChange).toHaveBeenLastCalledWith(true)
    expect(box.checked).toBe(true)
    await click(box)
    expect(onChange).toHaveBeenLastCalledWith(false)
    expect(box.checked).toBe(false)
  })

  it('supports the mixed state', async () => {
    const { container } = await render(<Checkbox aria-label="All rows" indeterminate checked={false} onChange={() => {}} />)
    expect((container.querySelector('input') as HTMLInputElement).indeterminate).toBe(true)
  })

  it('disabled reaches the native checkbox and dims the label', async () => {
    const { container } = await render(<Checkbox label="Locked" disabled checked={false} onChange={() => {}} />)
    expect((container.querySelector('input') as HTMLInputElement).disabled).toBe(true)
    expect(container.querySelector('label')!.className).toContain('cursor-not-allowed')
  })
})
