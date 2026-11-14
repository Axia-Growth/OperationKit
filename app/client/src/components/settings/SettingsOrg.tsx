import { useState } from 'react'
import { Tabs } from '../ui'
import type { TabItem } from '../ui'
import { WorkspacesTab } from '../config/WorkspacesTab'
import { UsersTab } from '../config/UsersTab'

const TABS: TabItem[] = [
  { key: 'orgs', label: 'Workspaces' },
  { key: 'users', label: 'Users' },
]

export function SettingsOrg() {
  const [tab, setTab] = useState('orgs')
  return (
    <div>
      <p className="mb-4 max-w-prose text-sm leading-relaxed text-fg-2">
        Workspaces and the people who can see them. A workspace is a boundary — its own board,
        secrets and membership — not a label; most teams only ever need one.
      </p>
      <Tabs items={TABS} value={tab} onChange={setTab} label="Workspaces and people" panelClassName="mt-4">
        {tab === 'orgs' ? <WorkspacesTab /> : <UsersTab />}
      </Tabs>
    </div>
  )
}
