import { Hono } from 'hono'
import { ensureUserExists } from '../lib/db'
import { jsonError } from '../lib/http'

const app = new Hono()

const FULL_BACKUP_KEY = 'lkphone_full_backup_v1'
const SYNC_CHUNK_KEY_PATTERN = /:chunk:\d+$/

const normalizeSyncRecordValue = (value) =>
  typeof value === 'string' ? value : JSON.stringify(value)

const parseStoredSyncValue = (key, value) => {
  if (SYNC_CHUNK_KEY_PATTERN.test(key)) {
    return { parsed: false, value }
  }

  try {
    return { parsed: true, value: JSON.parse(value) }
  } catch {
    return { parsed: false, value }
  }
}

app.post('/', async (c) => {
  const body = await c.req.json()
  const userId = String(body.user_id || body.userId || 'default_user').trim()

  const records = Array.isArray(body.entries)
    ? body.entries.map((entry) => ({
        key: String(entry?.key || '').trim(),
        value: entry?.value,
      }))
    : [{
        key: String(body.key || (body?.data ? FULL_BACKUP_KEY : '')).trim(),
        value: body.key ? body.value : (body?.data ? JSON.stringify(body) : undefined),
      }]

  const validRecords = records.filter((record) =>
    record.key && record.value !== undefined && record.value !== null
  )

  if (!userId || validRecords.length === 0) {
    return jsonError(c, 'Missing user_id or sync records')
  }

  try {
    await ensureUserExists(c.env.DB, userId, userId)

    const statement = c.env.DB.prepare(`
      INSERT OR REPLACE INTO user_data (user_id, key, value, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `)

    const boundStatements = validRecords.map((record) =>
      statement.bind(userId, record.key, normalizeSyncRecordValue(record.value))
    )

    for (let i = 0; i < boundStatements.length; i += 50) {
      await c.env.DB.batch(boundStatements.slice(i, i + 50))
    }

    return c.json({ status: 'success', count: validRecords.length })
  } catch (error) {
    return c.json({ status: 'error', message: error.message })
  }
})

app.get('/', async (c) => {
  const userId = String(c.req.query('user_id') || 'default_user').trim()
  const key = c.req.query('key')
  const lastSync = c.req.query('last_sync')

  try {
    let query = 'SELECT * FROM user_data WHERE user_id = ?'
    const params = [userId]

    if (key) {
      query += ' AND key = ?'
      params.push(key)
    }

    if (lastSync) {
      query += ' AND updated_at > ?'
      params.push(lastSync)
    }

    const result = await c.env.DB.prepare(query).bind(...params).all()
    if (key) {
      const row = result.results?.[0]
      if (!row) return jsonError(c, 'No synced backup found', 404)

      const stored = parseStoredSyncValue(key, row.value)
      if (stored.parsed) {
        return c.json(stored.value)
      }
      return c.json({ status: 'success', key: row.key, value: stored.value })
    }

    return c.json({ status: 'success', data: result.results })
  } catch (error) {
    return c.json({ status: 'error', message: error.message })
  }
})

export default app
