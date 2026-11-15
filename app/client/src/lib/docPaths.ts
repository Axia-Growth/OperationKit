/**
 * Which file paths in a session transcript open in the in-app doc editor
 * (obj 900803). Any markdown file under a home directory — `/home/<user>/…​.md`
 * or `~/…​.md` — not one hardcoded user's home. Whether the signed-in user may
 * actually read or write it is decided server-side (/api/docs/file read/write
 * roots); this only decides what is rendered as a link.
 */
export const DOC_PATH_RE = /(?:\/home\/[\w.-]+\/[\w./-]+\.md|~\/[\w./-]+\.md)/g

export function isEditableDocPath(p: string): boolean {
  return /^(?:\/home\/[\w.-]+\/.+|~\/.+)\.md$/.test(p)
}
