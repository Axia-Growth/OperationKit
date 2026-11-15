// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsSection } from './SettingsSection'
import { RowActions } from './RowActions'
import { DataTable } from './DataTable'
import { Alert } from './Alert'
import { byRole, cleanup, click, render } from '../../test/render'

afterEach(cleanup)

describe('ui/SettingsSection (polish F5, obj 900806)', () => {
  it('is a section named by its heading, with description and actions', async () => {
    const { container } = await render(
      <SettingsSection title="API key" description="Use it from scripts." actions={<button>Rotate</button>}>
        <p>body</p>
      </SettingsSection>,
    )
    const section = container.querySelector('section')!
    const h2 = container.querySelector('h2')!
    expect(h2.textContent).toBe('API key')
    expect(section.getAttribute('aria-labelledby')).toBe(h2.id)
    expect(container.textContent).toContain('Use it from scripts.')
    expect(container.querySelector('button')?.textContent).toBe('Rotate')
    expect(container.textContent).toContain('body')
  })

  it('level 3 is an h3; danger draws the Danger zone', async () => {
    const { container } = await render(<SettingsSection title="Danger zone" level={3} danger />)
    const h3 = container.querySelector('h3')!
    expect(h3.textContent).toBe('Danger zone')
    expect(h3.className).toContain('text-danger')
    expect(container.querySelector('section')!.className).toContain('border-danger/40')
  })
})

describe('ui/RowActions', () => {
  it('a named "⋯" trigger opens a menu; destructive items come last behind a separator', async () => {
    const onEdit = vi.fn()
    const onDelete = vi.fn()
    await render(
      <RowActions
        label="Actions for OPENAI_API_KEY"
        actions={[
          { label: 'Delete', onSelect: onDelete, danger: true },
          { label: 'Edit', onSelect: onEdit },
          { label: 'History', onSelect: vi.fn() },
        ]}
      />,
    )
    const trigger = document.querySelector('[aria-label="Actions for OPENAI_API_KEY"]') as HTMLElement
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    await click(trigger)
    const items = byRole(document, 'menuitem').map((i) => i.textContent?.trim())
    expect(items).toEqual(['Edit', 'History', 'Delete'])
    expect(byRole(document, 'separator').length).toBe(1)
    await click(byRole(document, 'menuitem').find((i) => i.textContent?.trim() === 'Delete')!)
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onEdit).not.toHaveBeenCalled()
  })
})

describe('ui/DataTable groups', () => {
  type Row = { id: number; scope: string; name: string }
  const rows: Row[] = [
    { id: 1, scope: 'Everywhere', name: 'A' },
    { id: 2, scope: 'Workspace', name: 'B' },
    { id: 3, scope: 'Workspace', name: 'C' },
  ]
  it('renders one header row per group, spanning the table', async () => {
    const { container } = await render(
      <DataTable<Row>
        aria-label="Secrets"
        columns={[{ key: 'name', header: 'Name', cell: (r) => r.name }]}
        rows={rows}
        rowKey={(r) => r.id}
        groupBy={(r) => r.scope}
        rowActions={() => <button>x</button>}
        rowActionsAlways
      />,
    )
    const table = container.querySelector('table')!
    expect(table.getAttribute('aria-label')).toBe('Secrets')
    const groups = Array.from(table.querySelectorAll('th[scope="colgroup"]'))
    expect(groups.map((g) => g.textContent)).toEqual(['Everywhere', 'Workspace'])
    expect(groups[0]!.getAttribute('colspan')).toBe('2')
    // Always-visible actions do not fade in on hover.
    expect(table.querySelector('td:last-child > div')!.className).not.toContain('opacity-0')
  })
})

describe('ui/Alert roles', () => {
  it('alarm is announced at once (role=alert); other tones are polite', async () => {
    const { container } = await render(
      <>
        <Alert tone="alarm" title="Could not save" />
        <Alert tone="info" title="Saved" />
      </>,
    )
    expect(byRole(container, 'alert').map((a) => a.textContent)).toEqual(['Could not save'])
    expect(byRole(container, 'status').map((a) => a.textContent)).toEqual(['Saved'])
  })
})
