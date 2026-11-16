// ── Chat browser screenshot storage (obj 901027 security review) ──
//
// card_browser used to hand the PNG back inline as a base64 data URL in the
// tool result (up to 3 MB, straight into the model's context and the stored
// chat history, never through an authenticated route). Storage here mirrors
// agent_chat_attachments / attachments.ts exactly: the bytes live in the DB,
// a per-person ownership check (the person chatting when the shot was taken)
// gates the one route that serves them, and the tool only ever gets a
// reference back.
import { getDb } from '../../db/index.js'

export interface StoredSandboxScreenshot {
  id: number
  final_url: string
  media_type: string
  size: number
  url: string
}

export function sandboxScreenshotUrl(id: number): string {
  return `/api/agent-chat/sandbox-screenshots/${id}`
}

export function saveSandboxScreenshot(input: {
  userId: number
  slug: string
  objectiveId: number | null
  finalUrl: string
  bytes: Buffer
  mediaType?: string
}): StoredSandboxScreenshot {
  const mediaType = input.mediaType ?? 'image/png'
  const info = getDb()
    .prepare(
      `INSERT INTO agent_chat_sandbox_screenshots (user_id, agent_slug, objective_id, final_url, media_type, size, bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.userId, input.slug, input.objectiveId, input.finalUrl, mediaType, input.bytes.length, input.bytes)
  const id = Number(info.lastInsertRowid)
  return { id, final_url: input.finalUrl, media_type: mediaType, size: input.bytes.length, url: sandboxScreenshotUrl(id) }
}

/** The bytes, for the one route that serves them. Owner check (user_id) is the caller's. */
export function getSandboxScreenshot(id: number): { id: number; user_id: number; media_type: string; bytes: Buffer } | null {
  const r = getDb().prepare('SELECT id, user_id, media_type, bytes FROM agent_chat_sandbox_screenshots WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!r) return null
  return {
    id: Number(r.id),
    user_id: Number(r.user_id),
    media_type: String(r.media_type),
    bytes: Buffer.isBuffer(r.bytes) ? r.bytes : Buffer.from(r.bytes as Uint8Array),
  }
}
