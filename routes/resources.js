import { Hono } from 'hono'
import { requireAuth } from '../lib/auth'
import { ensureResourceSchema, ensureUserExists } from '../lib/db'
import { jsonError } from '../lib/http'
import { inferFileType, normalizeResourceRow, requireResourceManager } from '../lib/resource'

const app = new Hono()

app.post('/', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return auth.error

  const body = await c.req.json()
  const userId = auth.user.id
  const category = String(body.category || '').trim()
  const title = String(body.title || body.name || body.filename || '').trim()
  const filename = String(body.filename || body.name || title).trim()

  if (!userId || !category || !title) {
    return jsonError(c, 'Missing user_id, category or title')
  }

  await ensureResourceSchema(c.env.DB)
  await ensureUserExists(c.env.DB, userId, auth.user.username || userId)

  try {
    const result = await c.env.DB.prepare(`
      INSERT INTO resources (
        user_id,
        uploader_name,
        category,
        title,
        description,
        preview_image_url,
        filename,
        mime_type,
        size_bytes,
        file_type,
        content,
        content_encoding,
        downloads
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).bind(
      userId,
      auth.user.username || userId,
      category,
      title,
      body.description || '',
      body.preview_image_url || body.previewImageUrl || '',
      filename,
      body.mime_type || body.mimeType || 'application/octet-stream',
      Number(body.size_bytes || body.sizeBytes || 0),
      body.file_type || body.fileType || inferFileType(filename, body.mime_type || body.mimeType || ''),
      body.content || '',
      body.content_encoding || body.contentEncoding || 'text'
    ).run()

    const insertedId = result.meta?.last_row_id || result.lastInsertRowid
    const resource = await c.env.DB.prepare('SELECT * FROM resources WHERE id = ?').bind(insertedId).first()
    return c.json({ status: 'success', id: insertedId, data: normalizeResourceRow(resource, false) })
  } catch (error) {
    return jsonError(c, error.message, 500)
  }
})

app.get('/', async (c) => {
  const userId = c.req.query('user_id')
  const category = c.req.query('category')

  try {
    await ensureResourceSchema(c.env.DB)

    let query = 'SELECT * FROM resources WHERE 1 = 1'
    const params = []

    if (userId) {
      query += ' AND user_id = ?'
      params.push(userId)
    }

    if (category) {
      query += ' AND category = ?'
      params.push(category)
    }

    query += ' ORDER BY created_at DESC, id DESC'

    const result = await c.env.DB.prepare(query).bind(...params).all()
    return c.json({ status: 'success', data: (result.results || []).map((row) => normalizeResourceRow(row, false)) })
  } catch (error) {
    return jsonError(c, error.message, 500)
  }
})

app.get('/:id/download', async (c) => {
  const id = c.req.param('id')

  try {
    await ensureResourceSchema(c.env.DB)
    const resource = await c.env.DB.prepare('SELECT * FROM resources WHERE id = ?').bind(id).first()
    if (!resource) return jsonError(c, 'Resource not found', 404)

    await c.env.DB.prepare(`
      UPDATE resources
      SET downloads = COALESCE(downloads, 0) + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(id).run()

    return c.json({
      status: 'success',
      data: normalizeResourceRow({ ...resource, downloads: (resource.downloads || 0) + 1 }),
    })
  } catch (error) {
    return jsonError(c, error.message, 500)
  }
})

app.put('/:id', async (c) => {
  const id = c.req.param('id')
  const auth = await requireAuth(c)
  if (auth.error) return auth.error

  const body = await c.req.json()

  try {
    await ensureResourceSchema(c.env.DB)
    const existing = await c.env.DB.prepare('SELECT * FROM resources WHERE id = ?').bind(id).first()
    if (!existing) return jsonError(c, 'Resource not found', 404)

    const permissionError = requireResourceManager(c, existing, auth.user)
    if (permissionError) return permissionError

    await c.env.DB.prepare(`
      UPDATE resources
      SET
        title = ?,
        content = ?,
        category = ?,
        description = ?,
        preview_image_url = ?,
        filename = ?,
        mime_type = ?,
        size_bytes = ?,
        file_type = ?,
        content_encoding = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      body.title || existing.title,
      body.content ?? existing.content,
      body.category || existing.category,
      body.description ?? existing.description ?? '',
      body.preview_image_url ?? body.previewImageUrl ?? existing.preview_image_url ?? '',
      body.filename || existing.filename || body.title || existing.title,
      body.mime_type || body.mimeType || existing.mime_type || 'application/octet-stream',
      Number(body.size_bytes ?? body.sizeBytes ?? existing.size_bytes ?? 0),
      body.file_type || body.fileType || existing.file_type || inferFileType(body.filename || existing.filename || existing.title, body.mime_type || body.mimeType || existing.mime_type || ''),
      body.content_encoding || body.contentEncoding || existing.content_encoding || 'text',
      id
    ).run()

    const resource = await c.env.DB.prepare('SELECT * FROM resources WHERE id = ?').bind(id).first()
    return c.json({ status: 'success', data: normalizeResourceRow(resource, false) })
  } catch (error) {
    return jsonError(c, error.message, 500)
  }
})

app.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const auth = await requireAuth(c)
  if (auth.error) return auth.error

  try {
    await ensureResourceSchema(c.env.DB)
    const existing = await c.env.DB.prepare('SELECT * FROM resources WHERE id = ?').bind(id).first()
    if (!existing) return jsonError(c, 'Resource not found', 404)

    const permissionError = requireResourceManager(c, existing, auth.user)
    if (permissionError) return permissionError

    await c.env.DB.prepare('DELETE FROM resources WHERE id = ?').bind(id).run()
    return c.json({ status: 'success' })
  } catch (error) {
    return jsonError(c, error.message, 500)
  }
})

export default app
