import { Hono } from 'hono'
import { requireAuth } from '../lib/auth'
import { ensureBackupSchema, ensureUserExists } from '../lib/db'
import { jsonError } from '../lib/http'

const app = new Hono()
const textEncoder = new TextEncoder()

const sanitizePath = (value, fallback = 'lkphone-backup') =>
  String(value || fallback)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\.\./g, '_')
    .slice(0, 480) || fallback

const getR2Bucket = (c) => c.env.BACKUPS || c.env.R2_BACKUPS || c.env.BACKUP_BUCKET

const getKeyFromRequest = (c) => sanitizePath(c.req.query('key') || '', '')

const userScopedKey = (userId, key) => {
  const safeUserId = String(userId || 'user').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120)
  return `users/${safeUserId}/${sanitizePath(key, 'backup')}`
}

const sha256Hex = async (value) => {
  const bytes = typeof value === 'string' ? textEncoder.encode(value) : value
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

const requireBackupAccess = async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return { error: auth.error }

  const bucket = getR2Bucket(c)
  if (!bucket) {
    return { error: jsonError(c, 'R2 backup bucket is not configured', 500) }
  }

  await ensureBackupSchema(c.env.DB)
  await ensureUserExists(c.env.DB, auth.user.id, auth.user.username || auth.user.id)
  return { user: auth.user, bucket }
}

app.get('/health', async (c) => {
  const auth = await requireBackupAccess(c)
  if (auth.error) return auth.error
  return c.json({ status: 'success', storage: 'r2' })
})

app.get('/object', async (c) => {
  const auth = await requireBackupAccess(c)
  if (auth.error) return auth.error

  const objectKey = getKeyFromRequest(c)
  if (!objectKey) return jsonError(c, 'Missing backup object key')

  const scopedKey = userScopedKey(auth.user.id, objectKey)
  const object = await auth.bucket.get(scopedKey)
  if (!object) return jsonError(c, 'Backup object not found', 404)

  const content = await object.text()
  const sizeBytes = Number(object.size || content.length || 0)
  return c.json({
    status: 'success',
    key: objectKey,
    sizeBytes,
    checksum: object.customMetadata?.checksum || '',
    content
  })
})

app.put('/object', async (c) => {
  const auth = await requireBackupAccess(c)
  if (auth.error) return auth.error

  const objectKey = getKeyFromRequest(c)
  if (!objectKey) return jsonError(c, 'Missing backup object key')

  const contentType = c.req.header('Content-Type') || 'text/plain; charset=utf-8'
  const basePath = sanitizePath(c.req.header('X-Backup-Base-Path') || objectKey.split('/')[0] || 'lkphone-backup')
  const content = await c.req.text()
  const bytes = textEncoder.encode(content)
  const checksum = await sha256Hex(bytes)
  const scopedKey = userScopedKey(auth.user.id, objectKey)

  await auth.bucket.put(scopedKey, content, {
    httpMetadata: { contentType },
    customMetadata: {
      checksum,
      originalKey: objectKey,
      userId: auth.user.id
    }
  })

  await c.env.DB.prepare(`
    INSERT INTO backups (user_id, base_path, object_key, size_bytes, checksum, content_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, object_key) DO UPDATE SET
      base_path = excluded.base_path,
      size_bytes = excluded.size_bytes,
      checksum = excluded.checksum,
      content_type = excluded.content_type,
      updated_at = CURRENT_TIMESTAMP
  `).bind(auth.user.id, basePath, objectKey, bytes.byteLength, checksum, contentType).run()

  return c.json({
    status: 'success',
    key: objectKey,
    sizeBytes: bytes.byteLength,
    checksum
  })
})

app.get('/', async (c) => {
  const auth = await requireBackupAccess(c)
  if (auth.error) return auth.error

  const basePath = sanitizePath(c.req.query('basePath') || 'lkphone-backup')
  const result = await c.env.DB.prepare(`
    SELECT object_key, base_path, size_bytes, checksum, content_type, created_at, updated_at
    FROM backups
    WHERE user_id = ? AND base_path = ?
    ORDER BY updated_at DESC, id DESC
  `).bind(auth.user.id, basePath).all()

  return c.json({ status: 'success', data: result.results || [] })
})

app.delete('/object', async (c) => {
  const auth = await requireBackupAccess(c)
  if (auth.error) return auth.error

  const objectKey = getKeyFromRequest(c)
  if (!objectKey) return jsonError(c, 'Missing backup object key')

  await auth.bucket.delete(userScopedKey(auth.user.id, objectKey))
  await c.env.DB.prepare('DELETE FROM backups WHERE user_id = ? AND object_key = ?').bind(auth.user.id, objectKey).run()
  return c.json({ status: 'success' })
})

export default app
