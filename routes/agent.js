import { Hono } from 'hono'
import { requireAuth } from '../lib/auth'
import { ensureAgentSchema, ensureUserExists } from '../lib/db'
import { jsonError } from '../lib/http'

const app = new Hono()

const DEFAULT_TAKEOVER = {
  proactiveWechat: true,
  lifelineTriggers: true,
  nightlyDiary: true,
  randomCheckin: true,
}

const nowMs = () => Date.now()
const makeId = (prefix) => `${prefix}_${Date.now()}_${crypto.randomUUID()}`

const safeJsonParse = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback
  } catch {
    return fallback
  }
}

const normalizeTakeover = (value = {}) => ({
  ...DEFAULT_TAKEOVER,
  ...(value && typeof value === 'object' ? value : {}),
})

const normalizeInterval = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 60_000 ? Math.floor(parsed) : fallback
}

const pickNextCheckinAt = (minIntervalMs, maxIntervalMs, base = nowMs()) => {
  const min = Math.max(60_000, Number(minIntervalMs) || 60_000)
  const max = Math.max(min, Number(maxIntervalMs) || 3_600_000)
  return base + min + Math.floor(Math.random() * (max - min + 1))
}

const normalizeConfigRow = (row) => {
  if (!row) {
    return {
      enabled: false,
      takeover: DEFAULT_TAKEOVER,
      minIntervalMs: 60_000,
      maxIntervalMs: 3_600_000,
      nextCheckinAt: null,
      lastCheckinAt: null,
    }
  }

  return {
    enabled: Number(row.enabled || 0) === 1,
    takeover: normalizeTakeover(safeJsonParse(row.takeover_json, DEFAULT_TAKEOVER)),
    minIntervalMs: Number(row.min_interval_ms || 60_000),
    maxIntervalMs: Number(row.max_interval_ms || 3_600_000),
    nextCheckinAt: row.next_checkin_at ? Number(row.next_checkin_at) : null,
    lastCheckinAt: row.last_checkin_at ? Number(row.last_checkin_at) : null,
    updatedAt: row.updated_at ? Number(row.updated_at) : null,
  }
}

const normalizeGenerationRow = (row) => ({
  enabled: Number(row?.enabled || 0) === 1,
  baseUrl: String(row?.base_url || ''),
  model: String(row?.model || ''),
  hasApiKey: Boolean(row?.api_key),
  updatedAt: row?.updated_at ? Number(row.updated_at) : null,
})

const readAgentConfig = async (db, userId) => {
  const row = await db.prepare('SELECT * FROM agent_configs WHERE user_id = ?').bind(userId).first()
  return normalizeConfigRow(row)
}

const readGenerationConfig = async (db, userId) => {
  const row = await db.prepare('SELECT * FROM agent_generation_configs WHERE user_id = ?').bind(userId).first()
  return normalizeGenerationRow(row)
}

const requireAgentAuth = async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return auth
  await ensureAgentSchema(c.env.DB)
  await ensureUserExists(c.env.DB, auth.user.id, auth.user.username || auth.user.id)
  return auth
}

app.get('/status', async (c) => {
  const auth = await requireAgentAuth(c)
  if (auth.error) return auth.error

  const config = await readAgentConfig(c.env.DB, auth.user.id)
  const generation = await readGenerationConfig(c.env.DB, auth.user.id)
  const pendingResult = await c.env.DB.prepare(`
    SELECT COUNT(*) AS count FROM agent_tasks WHERE user_id = ? AND status = 'pending'
  `).bind(auth.user.id).first()
  const outboxResult = await c.env.DB.prepare(`
    SELECT COUNT(*) AS count FROM agent_outbox WHERE user_id = ? AND status = 'pending'
  `).bind(auth.user.id).first()

  return c.json({
    status: 'success',
    data: {
      server: 'lkphone-server',
      agent: config,
      generation,
      pendingTasks: Number(pendingResult?.count || 0),
      pendingOutbox: Number(outboxResult?.count || 0),
      now: nowMs(),
    },
  })
})

app.get('/config', async (c) => {
  const auth = await requireAgentAuth(c)
  if (auth.error) return auth.error
  return c.json({ status: 'success', data: await readAgentConfig(c.env.DB, auth.user.id) })
})

app.put('/config', async (c) => {
  const auth = await requireAgentAuth(c)
  if (auth.error) return auth.error

  const body = await c.req.json()
  const current = await readAgentConfig(c.env.DB, auth.user.id)
  const minIntervalMs = normalizeInterval(body.minIntervalMs, current.minIntervalMs)
  const maxIntervalMs = Math.max(minIntervalMs, normalizeInterval(body.maxIntervalMs, current.maxIntervalMs))
  const enabled = body.enabled === true
  const takeover = normalizeTakeover(body.takeover || current.takeover)
  const ts = nowMs()
  const nextCheckinAt = enabled && takeover.randomCheckin
    ? pickNextCheckinAt(minIntervalMs, maxIntervalMs, ts)
    : null

  await c.env.DB.prepare(`
    INSERT INTO agent_configs (
      user_id, enabled, takeover_json, min_interval_ms, max_interval_ms,
      next_checkin_at, last_checkin_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      enabled = excluded.enabled,
      takeover_json = excluded.takeover_json,
      min_interval_ms = excluded.min_interval_ms,
      max_interval_ms = excluded.max_interval_ms,
      next_checkin_at = excluded.next_checkin_at,
      updated_at = excluded.updated_at
  `).bind(
    auth.user.id,
    enabled ? 1 : 0,
    JSON.stringify(takeover),
    minIntervalMs,
    maxIntervalMs,
    nextCheckinAt,
    current.lastCheckinAt,
    ts,
    ts
  ).run()

  return c.json({ status: 'success', data: await readAgentConfig(c.env.DB, auth.user.id) })
})

app.get('/generation-config', async (c) => {
  const auth = await requireAgentAuth(c)
  if (auth.error) return auth.error
  return c.json({ status: 'success', data: await readGenerationConfig(c.env.DB, auth.user.id) })
})

app.put('/generation-config', async (c) => {
  const auth = await requireAgentAuth(c)
  if (auth.error) return auth.error

  const body = await c.req.json()
  const enabled = body.enabled === true
  const baseUrl = String(body.baseUrl || '').trim()
  const model = String(body.model || '').trim()
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''

  if (enabled && !baseUrl) return jsonError(c, 'Missing AI API URL')
  if (enabled && !model) return jsonError(c, 'Missing model')
  if (enabled && !apiKey) return jsonError(c, 'Missing API key')

  const ts = nowMs()
  await c.env.DB.prepare(`
    INSERT INTO agent_generation_configs (
      user_id, enabled, base_url, api_key, model, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      enabled = excluded.enabled,
      base_url = excluded.base_url,
      api_key = excluded.api_key,
      model = excluded.model,
      updated_at = excluded.updated_at
  `).bind(
    auth.user.id,
    enabled ? 1 : 0,
    baseUrl,
    apiKey,
    model,
    ts,
    ts
  ).run()

  return c.json({ status: 'success', data: await readGenerationConfig(c.env.DB, auth.user.id) })
})

app.post('/tasks', async (c) => {
  const auth = await requireAgentAuth(c)
  if (auth.error) return auth.error

  const body = await c.req.json()
  const type = String(body.type || '').trim()
  const dueAt = Number(body.dueAt || body.triggerAt || Date.now())
  if (!type) return jsonError(c, 'Missing task type')
  if (!Number.isFinite(dueAt)) return jsonError(c, 'Invalid dueAt')

  const id = String(body.id || makeId('agt_task'))
  const ts = nowMs()
  await c.env.DB.prepare(`
    INSERT INTO agent_tasks (id, user_id, type, status, due_at, payload_json, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
  `).bind(id, auth.user.id, type, dueAt, JSON.stringify(body.payload || {}), ts, ts).run()

  return c.json({ status: 'success', data: { id, type, dueAt } })
})

app.get('/outbox', async (c) => {
  const auth = await requireAgentAuth(c)
  if (auth.error) return auth.error

  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || 50)))
  const result = await c.env.DB.prepare(`
    SELECT * FROM agent_outbox
    WHERE user_id = ? AND status = 'pending'
    ORDER BY created_at ASC
    LIMIT ?
  `).bind(auth.user.id, limit).all()

  return c.json({
    status: 'success',
    data: (result.results || []).map((row) => ({
      id: row.id,
      type: row.type,
      payload: safeJsonParse(row.payload_json, {}),
      createdAt: Number(row.created_at || 0),
    })),
  })
})

app.post('/outbox/:id/ack', async (c) => {
  const auth = await requireAgentAuth(c)
  if (auth.error) return auth.error

  const id = c.req.param('id')
  await c.env.DB.prepare(`
    UPDATE agent_outbox
    SET status = 'consumed', consumed_at = ?
    WHERE id = ? AND user_id = ?
  `).bind(nowMs(), id, auth.user.id).run()
  return c.json({ status: 'success' })
})

export default app
