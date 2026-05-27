import { Hono } from 'hono'
import { ensureUserExists } from '../lib/db'

const app = new Hono()

app.post('/', async (c) => {
  const { name } = await c.req.json()

  try {
    const result = await c.env.DB.prepare(`
      INSERT INTO groups (name) VALUES (?)
    `).bind(name).run()

    return c.json({ status: 'success', id: result.lastInsertRowid })
  } catch (error) {
    return c.json({ status: 'error', message: error.message })
  }
})

app.post('/:id/members', async (c) => {
  const groupId = c.req.param('id')
  const { user_id: userId } = await c.req.json()
  await ensureUserExists(c.env.DB, userId, userId)

  try {
    await c.env.DB.prepare(`
      INSERT OR IGNORE INTO group_members (group_id, user_id)
      VALUES (?, ?)
    `).bind(groupId, userId).run()

    return c.json({ status: 'success' })
  } catch (error) {
    return c.json({ status: 'error', message: error.message })
  }
})

app.get('/:id/members', async (c) => {
  const groupId = c.req.param('id')

  try {
    const result = await c.env.DB.prepare(`
      SELECT u.*
      FROM group_members gm
      JOIN users u ON gm.user_id = u.user_id
      WHERE gm.group_id = ?
    `).bind(groupId).all()

    return c.json({ status: 'success', data: result.results })
  } catch (error) {
    return c.json({ status: 'error', message: error.message })
  }
})

app.post('/:id/messages', async (c) => {
  const groupId = c.req.param('id')
  const { user_id: userId, content } = await c.req.json()

  try {
    const result = await c.env.DB.prepare(`
      INSERT INTO messages (group_id, user_id, content)
      VALUES (?, ?, ?)
    `).bind(groupId, userId, content).run()

    const message = await c.env.DB.prepare(`
      SELECT m.*, u.username
      FROM messages m
      JOIN users u ON m.user_id = u.user_id
      WHERE m.id = ?
    `).bind(result.lastInsertRowid).first()

    return c.json({ status: 'success', message })
  } catch (error) {
    return c.json({ status: 'error', message: error.message })
  }
})

app.get('/:id/messages', async (c) => {
  const groupId = c.req.param('id')
  const limit = c.req.query('limit') || 50
  const offset = c.req.query('offset') || 0

  try {
    const result = await c.env.DB.prepare(`
      SELECT m.*, u.username
      FROM messages m
      JOIN users u ON m.user_id = u.user_id
      WHERE m.group_id = ?
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(groupId, limit, offset).all()

    return c.json({ status: 'success', data: result.results })
  } catch (error) {
    return c.json({ status: 'error', message: error.message })
  }
})

export default app
