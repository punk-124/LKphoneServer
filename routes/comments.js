import { Hono } from 'hono'
import { ensureUserExists } from '../lib/db'

const app = new Hono()

app.get('/', async (c) => {
  const forumId = c.req.query('forum_id')

  try {
    const result = await c.env.DB.prepare(`
      SELECT c.*, u.username
      FROM comments c
      JOIN users u ON c.user_id = u.user_id
      WHERE c.forum_id = ?
      ORDER BY c.created_at DESC
    `).bind(forumId).all()

    return c.json({ status: 'success', data: result.results })
  } catch (error) {
    return c.json({ status: 'error', message: error.message })
  }
})

app.post('/', async (c) => {
  const { user_id: userId, forum_id: forumId, parent_id: parentId, content } = await c.req.json()
  await ensureUserExists(c.env.DB, userId, userId)

  try {
    const result = await c.env.DB.prepare(`
      INSERT INTO comments (user_id, forum_id, parent_id, content)
      VALUES (?, ?, ?, ?)
    `).bind(userId, forumId, parentId, content).run()

    return c.json({ status: 'success', id: result.lastInsertRowid })
  } catch (error) {
    return c.json({ status: 'error', message: error.message })
  }
})

app.delete('/:id', async (c) => {
  const id = c.req.param('id')

  try {
    await c.env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(id).run()
    return c.json({ status: 'success' })
  } catch (error) {
    return c.json({ status: 'error', message: error.message })
  }
})

export default app
