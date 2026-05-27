import { Hono } from 'hono'
import { initializeDatabase } from '../lib/db'

const app = new Hono()

app.get('/init', async (c) => {
  try {
    await initializeDatabase(c.env.DB)
    return c.json({ status: 'success', message: 'Database initialized' })
  } catch (error) {
    return c.json({ status: 'error', message: error.message })
  }
})

app.get('/health', (c) => c.json({ status: 'ok' }))

export default app
