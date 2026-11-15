/**
 * Users Settings tab — extracted from ConfigPage.tsx (behavior frozen).
 */
import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Plus, ChevronRight } from 'lucide-react'
import {
  Card, CardHeader, Button, Badge, Alert, Skeleton, useConfirm, cn,
  Field, Input, Checkbox, SettingsSection, RowActions,
} from '../ui'
import { useWorkspaces } from '../../hooks/useWorkspaces'
import {
  type User,
  type UserRole,
  type Workspace,
  type WorkspaceMembership,
  type ObjectiveVisibility,
} from '@operationkit/shared'
import { api } from '../../lib/api'
import type { EmailOutcome } from '../../lib/email'
import { generateTempPassword } from '../../lib/tempPassword'
import { Select } from '../ui/Select'
import { humanize } from '../../lib/format'

interface AdminUser extends User {
  workspaces: WorkspaceMembership[]
}

export function UsersTab() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)
  const { slugs: allWorkspaceSlugs } = useWorkspaces()

  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newRole, setNewRole] = useState<UserRole>('member')
  const [newEmail, setNewEmail] = useState('')
  // Sign-in email drafts per user (obj 720332): behind Cloudflare Access this email signs them in.
  const [emailDraft, setEmailDraft] = useState<Record<number, string>>({})
  const [savingEmail, setSavingEmail] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [revealed, setRevealed] = useState<{ username: string; password: string; emailError?: string } | null>(null)
  // obj 900497: invites + temp passwords go by email when this site has its own sender.
  const [emailReady, setEmailReady] = useState<boolean | null>(null)
  const [emailInvite, setEmailInvite] = useState(true)
  const [emailed, setEmailed] = useState<{ username: string; to: string; what: 'invite' | 'password' } | null>(null)
  const { confirm, confirmDialog } = useConfirm()

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.get<AdminUser[]>('/admin/users')
      setUsers(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])
  useEffect(() => {
    api.get<{ configured: boolean }>('/admin/email')
      .then(s => setEmailReady(!!s.configured))
      .catch(() => setEmailReady(false))
  }, [])

  async function createUser(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!newUsername.trim() || newPassword.length < 8) {
      setError('Username and password (8+ chars) required')
      return
    }
    setCreating(true)
    setEmailed(null)
    try {
      const sendEmail = !!(emailReady && emailInvite && newEmail.trim())
      const created = await api.post<{ invite_email?: EmailOutcome }>('/admin/users', {
        username: newUsername.trim(), password: newPassword, role: newRole,
        ...(newEmail.trim() ? { email: newEmail.trim() } : {}),
        ...(sendEmail ? { send_email: true } : {}),
      })
      if (created?.invite_email?.sent) {
        setRevealed(null)
        setEmailed({ username: newUsername.trim(), to: newEmail.trim(), what: 'invite' })
      } else {
        // Fallback (today's flow): show the password to copy and share.
        setRevealed({ username: newUsername.trim(), password: newPassword, emailError: sendEmail ? created?.invite_email?.error : undefined })
      }
      setNewEmail('')
      setNewUsername(''); setNewPassword(''); setNewRole('member')
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create user')
    } finally {
      setCreating(false)
    }
  }

  async function resetPassword(user: AdminUser) {
    const pwd = generateTempPassword()
    setEmailed(null)
    try {
      const sendEmail = !!(emailReady && user.email)
      const r = await api.post<{ temp_password_email?: EmailOutcome }>(`/admin/users/${user.id}/reset-password`, {
        password: pwd, ...(sendEmail ? { send_email: true } : {}),
      })
      if (r?.temp_password_email?.sent && user.email) {
        setRevealed(null)
        setEmailed({ username: user.username, to: user.email, what: 'password' })
      } else {
        setRevealed({ username: user.username, password: pwd, emailError: sendEmail ? r?.temp_password_email?.error : undefined })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed')
    }
  }

  async function setUserRole(user: AdminUser, role: UserRole) {
    try { await api.patch(`/admin/users/${user.id}`, { role }); await reload() }
    catch (e) { setError(e instanceof Error ? e.message : 'Role update failed') }
  }

  async function saveEmail(user: AdminUser) {
    const draft = (emailDraft[user.id] ?? user.email ?? '').trim()
    setSavingEmail(user.id)
    setError(null)
    try {
      await api.patch(`/admin/users/${user.id}`, { email: draft || null })
      setEmailDraft(d => { const { [user.id]: _, ...rest } = d; return rest })
      await reload()
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save the email') }
    finally { setSavingEmail(null) }
  }

  async function grantWorkspace(user: AdminUser, workspace: Workspace) {
    try { await api.post(`/admin/workspaces/${workspace}/users`, { user_id: user.id, role: 'member' }); await reload() }
    catch (e) { setError(e instanceof Error ? e.message : 'Grant failed') }
  }

  async function updateMembership(
    user: AdminUser,
    workspace: string,
    patch: Partial<{ role: UserRole; can_use_assistant: boolean; objective_visibility: ObjectiveVisibility }>,
  ) {
    const existing = user.workspaces.find(w => w.workspace === workspace)
    if (!existing) return
    try {
      await api.post(`/admin/workspaces/${workspace}/users`, {
        user_id: user.id,
        role: patch.role ?? existing.role,
        can_use_assistant: patch.can_use_assistant ?? existing.can_use_assistant,
        objective_visibility: patch.objective_visibility ?? existing.objective_visibility,
      })
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed')
    }
  }

  async function revokeWorkspace(user: AdminUser, workspace: string) {
    if (!(await confirm({
      title: 'Remove from workspace?',
      message: `${user.username} will lose access to ${workspace}.`,
      confirmLabel: 'Remove',
      danger: true,
    }))) return
    try { await api.del(`/admin/workspaces/${workspace}/users/${user.id}`); await reload() }
    catch (e) { setError(e instanceof Error ? e.message : 'Revoke failed') }
  }

  async function deleteUser(user: AdminUser) {
    if (!(await confirm({
      title: 'Delete user?',
      message: `"${user.username}" will be permanently deleted. This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    }))) return
    try { await api.del(`/admin/users/${user.id}`); await reload() }
    catch (e) { setError(e instanceof Error ? e.message : 'Delete failed') }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} inset>
            <div className="flex items-center justify-between p-4">
              <div className="space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-44" />
              </div>
              <Skeleton className="h-6 w-16 rounded-md" />
            </div>
          </Card>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {confirmDialog}
      {/* Create user */}
      <Card inset>
        <CardHeader title="Create user" />
        <form onSubmit={createUser} className="space-y-3 p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Username" id="new-user-username">
              <Input value={newUsername} onChange={e => setNewUsername(e.target.value)} autoComplete="off" />
            </Field>
            <Field
              label="Temporary password"
              id="new-user-password"
              hint="8+ characters"
              action={
                <Button type="button" variant="ghost" size="xs" onClick={() => setNewPassword(generateTempPassword())}>
                  Generate
                </Button>
              }
            >
              <Input value={newPassword} onChange={e => setNewPassword(e.target.value)} className="font-mono" autoComplete="off" />
            </Field>
            <Field label="Sign-in email" id="new-user-email" optional>
              <Input type="email" placeholder="name@company.com" value={newEmail} onChange={e => setNewEmail(e.target.value)} />
            </Field>
            <Field label="Role" id="new-user-role">
              <Select value={newRole} onChange={v => setNewRole(v as UserRole)} className="w-full">
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </Select>
            </Field>
          </div>
          {emailReady === true && newEmail.trim() && (
            <Checkbox
              checked={emailInvite}
              onChange={e => setEmailInvite(e.target.checked)}
              label={<>Email the invite (sign-in link + temporary password) to {newEmail.trim()}</>}
            />
          )}
          {emailReady === false && (
            <p className="text-xs text-fg-3" data-testid="email-not-configured-hint">
              Email isn&apos;t set up, so new and reset passwords are shown here for you to share.{' '}
              <Link to="/setup/email" className="text-accent hover:underline">Set up email</Link>
            </p>
          )}
          {error && <Alert tone="alarm" title={error} />}
          {emailed && (
            <Alert
              tone="verify"
              title={emailed.what === 'invite' ? <>Invite emailed to {emailed.to}</> : <>Temporary password emailed to {emailed.to}</>}
              action={<Button type="button" variant="ghost" size="xs" onClick={() => setEmailed(null)}>Dismiss</Button>}
            >
              <span className="font-mono">{emailed.username}</span> will be asked to choose a new password at first sign-in.
            </Alert>
          )}
          {revealed && (
            <Alert
              tone="amber"
              title={<>Password set for <span className="font-mono">{revealed.username}</span></>}
              action={<Button type="button" variant="ghost" size="xs" onClick={() => setRevealed(null)}>Dismiss</Button>}
            >
              <div className="mt-1 font-mono text-fg-0">{revealed.password}</div>
              <div className="mt-1">Copy this now — it will not be shown again. Share with the user over a secure channel.</div>
              {revealed.emailError && <div className="mt-1 text-danger">Email was not sent: {revealed.emailError}</div>}
            </Alert>
          )}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" size="sm" disabled={creating}>
              {creating ? 'Creating…' : 'Create user'}
            </Button>
          </div>
        </form>
      </Card>

      {/* User list */}
      {users.map(user => {
        const memberships = user.workspaces
        const ungranted = allWorkspaceSlugs.filter(ws => !memberships.some(m => m.workspace === ws)) as Workspace[]
        const isOpen = expanded === user.id
        return (
          <Card key={user.id} inset>
            <button
              type="button"
              onClick={() => setExpanded(isOpen ? null : user.id)}
              aria-expanded={isOpen}
              className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              <ChevronRight className={cn('h-4 w-4 shrink-0 text-fg-3 transition-transform', isOpen && 'rotate-90')} />
              <span className="text-sm font-medium text-fg-0">{user.username}</span>
              <Badge tone={user.role === 'admin' ? 'accent' : 'neutral'}>{humanize(user.role)}</Badge>
              {user.email && <span className="hidden truncate text-xs text-fg-2 sm:inline">{user.email}</span>}
              <span className="ml-auto text-xs text-fg-3">
                {memberships.length} workspace{memberships.length === 1 ? '' : 's'}
              </span>
            </button>

            {isOpen && (
              <div className="space-y-5 border-t border-line p-4">
                {/* Global role + password */}
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="Global role" id={`user-role-${user.id}`}>
                    <Select value={user.role} onChange={v => setUserRole(user, v as UserRole)}>
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </Select>
                  </Field>
                  <Button variant="secondary" onClick={() => resetPassword(user)}>Reset password</Button>
                </div>

                {/* Sign-in email (obj 720332) */}
                <Field
                  label="Sign-in email"
                  id={`user-email-${user.id}`}
                  hint="Behind Cloudflare Access, signing in at the Cloudflare door with this email opens the app as this user."
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      type="email" placeholder="name@company.com"
                      value={emailDraft[user.id] ?? user.email ?? ''}
                      onChange={e => setEmailDraft(d => ({ ...d, [user.id]: e.target.value }))}
                      className="min-w-0 flex-1 basis-56"
                    />
                    <Button
                      variant="secondary" loading={savingEmail === user.id}
                      disabled={(emailDraft[user.id] ?? user.email ?? '') === (user.email ?? '')}
                      onClick={() => saveEmail(user)}
                    >
                      Save email
                    </Button>
                  </div>
                </Field>

                {/* Memberships */}
                <SettingsSection title="Workspace access" level={3}>
                  <div className="space-y-2">
                    {memberships.map(m => (
                      <div key={m.workspace} className="space-y-2 rounded-md border border-line bg-surface-1 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-fg-0">{m.workspace}</span>
                          <RowActions
                            label={`Actions for ${m.workspace}`}
                            actions={[{ label: 'Revoke access', danger: true, onSelect: () => void revokeWorkspace(user, m.workspace) }]}
                          />
                        </div>
                        <div className="flex flex-wrap gap-4">
                          <Field label="Role" id={`ws-role-${user.id}-${m.workspace}`}>
                            <Select value={m.role} onChange={v => updateMembership(user, m.workspace, { role: v as UserRole })}>
                              <option value="member">Member</option>
                              <option value="admin">Admin</option>
                            </Select>
                          </Field>
                          <Field label="Sees" id={`ws-visibility-${user.id}-${m.workspace}`}>
                            <Select value={m.objective_visibility}
                                    onChange={v => updateMembership(user, m.workspace, { objective_visibility: v as ObjectiveVisibility })}>
                              <option value="own">Own cards</option>
                              <option value="all">All in workspace</option>
                            </Select>
                          </Field>
                        </div>
                      </div>
                    ))}
                    {memberships.length === 0 && <p className="text-xs text-fg-3">No workspace access — grant one below.</p>}
                  </div>

                  {/* Grant */}
                  {ungranted.length > 0 && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className="text-sm text-fg-2">Grant access:</span>
                      {ungranted.map(ws => (
                        <Button key={ws} size="sm" variant="secondary" leftIcon={<Plus className="h-3.5 w-3.5" />} onClick={() => grantWorkspace(user, ws)}>
                          {ws}
                        </Button>
                      ))}
                    </div>
                  )}
                </SettingsSection>

                {/* Danger zone — kept away from the everyday controls above */}
                <SettingsSection
                  title="Delete user"
                  level={3}
                  danger
                  description={<>Permanently deletes {user.username}. This cannot be undone.</>}
                  actions={<Button size="sm" variant="danger" onClick={() => deleteUser(user)}>Delete user</Button>}
                />
              </div>
            )}
          </Card>
        )
      })}
      {users.length === 0 && !loading && <p className="text-sm text-fg-3">No users yet.</p>}
    </div>
  )
}
