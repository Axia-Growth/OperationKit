/**
 * New card dialog draft (obj 901200).
 *
 * Escape, a click outside, the X and Cancel all close the New card dialog, and
 * the dialog unmounts. Before this, the typed title and description went with
 * it, silently. Now they are mirrored to localStorage (through the same
 * `cc.draft.*` store the chat composers use, so the 30-day / 50-entry sweep
 * covers them) and read back the next time the dialog opens. A draft is
 * forgotten only when the card is created or the person clicks "Discard draft".
 *
 * One draft per signed-in user, not per workspace: the person is writing ONE
 * card, and may switch the Workspace field while writing it.
 */
import { draftKey, draftStorage, dropDraft, readDraft, writeDraft } from './composerDrafts'

export interface NewCardDraft {
  title: string
  description: string
}

export function newCardDraftKeys(userId: number | string | null | undefined): { title: string; description: string } {
  const who = userId ?? 'anon'
  return {
    title: draftKey('new-card', `${who}.title`),
    description: draftKey('new-card', `${who}.description`),
  }
}

export function readNewCardDraft(userId: number | string | null | undefined, storage = draftStorage()): NewCardDraft {
  const keys = newCardDraftKeys(userId)
  return { title: readDraft(storage, keys.title), description: readDraft(storage, keys.description) }
}

/** Written on every change, synchronously: the dialog can unmount on the very next event. */
export function writeNewCardDraft(userId: number | string | null | undefined, draft: NewCardDraft, storage = draftStorage()): void {
  const keys = newCardDraftKeys(userId)
  writeDraft(storage, keys.title, draft.title)
  writeDraft(storage, keys.description, draft.description)
}

export function dropNewCardDraft(userId: number | string | null | undefined, storage = draftStorage()): void {
  const keys = newCardDraftKeys(userId)
  dropDraft(storage, keys.title)
  dropDraft(storage, keys.description)
}

export function hasDraftText(draft: NewCardDraft): boolean {
  return draft.title.trim().length > 0 || draft.description.trim().length > 0
}
