import { Hono } from 'hono'
import { cors } from 'hono/cors'
import commentsRoutes from './routes/comments'
import groupsRoutes from './routes/groups'
import resourcesRoutes from './routes/resources'
import systemRoutes from './routes/system'
import agentRoutes from './routes/agent'

const app = new Hono()

app.use('*', cors())

app.route('/', systemRoutes)
app.route('/resources', resourcesRoutes)
app.route('/comments', commentsRoutes)
app.route('/groups', groupsRoutes)
app.route('/agent', agentRoutes)

const runAgentScheduler = async (env) => {
  if (!env.DB) return
  const { ensureAgentSchema } = await import('./lib/db')
  await ensureAgentSchema(env.DB)
  const now = Date.now()

  const dueTasks = await env.DB.prepare(`
    SELECT * FROM agent_tasks
    WHERE status = 'pending' AND due_at <= ?
    ORDER BY due_at ASC
    LIMIT 25
  `).bind(now).all()

  for (const task of dueTasks.results || []) {
    const outboxId = `agt_out_${now}_${crypto.randomUUID()}`
    await env.DB.prepare(`
      INSERT INTO agent_outbox (id, user_id, type, payload_json, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).bind(
      outboxId,
      task.user_id,
      task.type,
      task.payload_json || '{}',
      now
    ).run()
    await env.DB.prepare(`
      UPDATE agent_tasks
      SET status = 'done', result_json = ?, updated_at = ?
      WHERE id = ?
    `).bind(JSON.stringify({ outboxId }), now, task.id).run()
  }

  const checkins = await env.DB.prepare(`
    SELECT * FROM agent_configs
    WHERE enabled = 1 AND next_checkin_at IS NOT NULL AND next_checkin_at <= ?
    LIMIT 50
  `).bind(now).all()

  for (const config of checkins.results || []) {
    const takeover = JSON.parse(config.takeover_json || '{}')
    if (takeover.randomCheckin === false) continue
    const minIntervalMs = Math.max(60000, Number(config.min_interval_ms || 60000))
    const maxIntervalMs = Math.max(minIntervalMs, Number(config.max_interval_ms || 3600000))
    const nextCheckinAt = now + minIntervalMs + Math.floor(Math.random() * (maxIntervalMs - minIntervalMs + 1))
    await env.DB.prepare(`
      INSERT INTO agent_outbox (id, user_id, type, payload_json, status, created_at)
      VALUES (?, ?, 'random_checkin', ?, 'pending', ?)
    `).bind(
      `agt_out_${now}_${crypto.randomUUID()}`,
      config.user_id,
      JSON.stringify({ reason: 'random_checkin', scheduledAt: config.next_checkin_at }),
      now
    ).run()
    await env.DB.prepare(`
      UPDATE agent_configs
      SET last_checkin_at = ?, next_checkin_at = ?, updated_at = ?
      WHERE user_id = ?
    `).bind(now, nextCheckinAt, now, config.user_id).run()
  }
}

export default {
  fetch: app.fetch,
  scheduled: async (_event, env, ctx) => {
    ctx.waitUntil(runAgentScheduler(env))
  },
}
