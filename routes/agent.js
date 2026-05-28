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

const normalizeNumber = (value, fallback, min = 0) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback
}

const normalizeString = (value, max = 260) => String(value || '').trim().slice(0, max)

const normalizeTimeValue = (value) => {
  const text = normalizeString(value, 5)
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : null
}

const normalizeTimeZone = (value) => {
  const text = normalizeString(value, 80)
  return /^[A-Za-z0-9_+\-./]+$/.test(text) ? text : null
}

const normalizeUtcOffsetMinutes = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= -14 * 60 && parsed <= 14 * 60 ? Math.floor(parsed) : null
}

const normalizeParticipants = (value) => (
  Array.isArray(value)
    ? value.map((item) => normalizeString(item, 120)).filter(Boolean).slice(0, 24)
    : []
)

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

const readAgentConfig = async (db, userId) => {
  const row = await db.prepare('SELECT * FROM agent_configs WHERE user_id = ?').bind(userId).first()
  return normalizeConfigRow(row)
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

app.put('/wechat/proactive-state', async (c) => {
  const auth = await requireAgentAuth(c)
  if (auth.error) return auth.error

  const body = await c.req.json()
  const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 500) : []
  const ts = nowMs()

  for (const item of candidates) {
    const profileId = normalizeString(item.profileId, 120)
    const chatId = normalizeString(item.chatId, 160)
    const characterId = normalizeString(item.characterId, 160)
    if (!profileId || !chatId || !characterId) continue

    await c.env.DB.prepare(`
      INSERT INTO agent_wechat_proactive_state (
        user_id, profile_id, chat_id, character_id, proactive_chat, chat_frequency,
        proactive_min_interval_hours, proactive_max_streak, proactive_quiet_start,
        proactive_quiet_end, client_time_zone, client_utc_offset_minutes, last_message_at,
        last_user_reply_at, last_ai_message_at, last_ai_proactive_message_at,
        today_proactive_count, proactive_since_user_reply, is_active, is_group, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, profile_id, chat_id, character_id) DO UPDATE SET
        proactive_chat = excluded.proactive_chat,
        chat_frequency = excluded.chat_frequency,
        proactive_min_interval_hours = excluded.proactive_min_interval_hours,
        proactive_max_streak = excluded.proactive_max_streak,
        proactive_quiet_start = excluded.proactive_quiet_start,
        proactive_quiet_end = excluded.proactive_quiet_end,
        client_time_zone = excluded.client_time_zone,
        client_utc_offset_minutes = excluded.client_utc_offset_minutes,
        last_message_at = excluded.last_message_at,
        last_user_reply_at = excluded.last_user_reply_at,
        last_ai_message_at = excluded.last_ai_message_at,
        last_ai_proactive_message_at = excluded.last_ai_proactive_message_at,
        today_proactive_count = excluded.today_proactive_count,
        proactive_since_user_reply = excluded.proactive_since_user_reply,
        is_active = excluded.is_active,
        is_group = excluded.is_group,
        updated_at = excluded.updated_at
    `).bind(
      auth.user.id,
      profileId,
      chatId,
      characterId,
      item.proactiveChat === true ? 1 : 0,
      normalizeNumber(item.chatFrequency, 2, 0.01),
      normalizeNumber(item.proactiveMinIntervalHours, 6, 0),
      Math.max(1, Math.floor(normalizeNumber(item.proactiveMaxStreak, 1, 1))),
      normalizeTimeValue(item.proactiveQuietStart),
      normalizeTimeValue(item.proactiveQuietEnd),
      normalizeTimeZone(item.clientTimeZone),
      normalizeUtcOffsetMinutes(item.clientUtcOffsetMinutes),
      Math.floor(normalizeNumber(item.lastMessageAt, 0, 0)),
      Math.floor(normalizeNumber(item.lastUserReplyAt, 0, 0)),
      Math.floor(normalizeNumber(item.lastAiMessageAt, 0, 0)),
      Math.floor(normalizeNumber(item.lastAiProactiveMessageAt, 0, 0)),
      Math.max(0, Math.floor(normalizeNumber(item.todayProactiveCount, 0, 0))),
      Math.max(0, Math.floor(normalizeNumber(item.proactiveSinceUserReply, 0, 0))),
      item.isActive === false ? 0 : 1,
      item.isGroup === true ? 1 : 0,
      Math.floor(normalizeNumber(item.updatedAt, ts, 0))
    ).run()
  }

  return c.json({ status: 'success', data: { synced: candidates.length, updatedAt: ts } })
})

app.put('/lifeline/triggers', async (c) => {
  const auth = await requireAgentAuth(c)
  if (auth.error) return auth.error

  const body = await c.req.json()
  const triggers = Array.isArray(body.triggers) ? body.triggers.slice(0, 500) : []
  const ts = nowMs()

  for (const item of triggers) {
    const characterId = normalizeString(item.characterId, 160)
    const triggerId = normalizeString(item.triggerId, 160)
    const instruction = normalizeString(item.instruction, 520)
    if (!characterId || !triggerId || !instruction) continue

    await c.env.DB.prepare(`
      INSERT INTO agent_lifeline_triggers (
        user_id, character_id, trigger_id, trigger_at, intent, instruction,
        status, visibility, participants_json, backend_only, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, character_id, trigger_id) DO UPDATE SET
        trigger_at = excluded.trigger_at,
        intent = excluded.intent,
        instruction = excluded.instruction,
        status = excluded.status,
        visibility = excluded.visibility,
        participants_json = excluded.participants_json,
        backend_only = excluded.backend_only,
        updated_at = excluded.updated_at
    `).bind(
      auth.user.id,
      characterId,
      triggerId,
      item.triggerAt ? Math.floor(normalizeNumber(item.triggerAt, 0, 0)) : null,
      normalizeString(item.intent || 'check_in', 60),
      instruction,
      normalizeString(item.status || 'pending', 40),
      normalizeString(item.visibility || 'profile', 60),
      JSON.stringify(normalizeParticipants(item.participants)),
      item.backendOnly === false ? 0 : 1,
      Math.floor(normalizeNumber(item.updatedAt, ts, 0))
    ).run()
  }

  return c.json({ status: 'success', data: { synced: triggers.length, updatedAt: ts } })
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

app.get('/events', async (c) => {
  const auth = await requireAgentAuth(c)
  if (auth.error) return auth.error

  const encoder = new TextEncoder()
  let lastEventId = ''

  const writeEvent = (controller, event, data) => {
    controller.enqueue(encoder.encode(`event: ${event}\n`))
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
  }

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false

      const poll = async () => {
        if (closed) return
        try {
          const row = await c.env.DB.prepare(`
            SELECT id, type, created_at FROM agent_outbox
            WHERE user_id = ? AND status = 'pending'
            ORDER BY created_at ASC
            LIMIT 1
          `).bind(auth.user.id).first()

          if (row && row.id !== lastEventId) {
            lastEventId = row.id
            writeEvent(controller, 'outbox', {
              id: row.id,
              type: row.type,
              createdAt: Number(row.created_at || 0),
              now: nowMs(),
            })
          } else {
            writeEvent(controller, 'heartbeat', { now: nowMs() })
          }
        } catch (error) {
          writeEvent(controller, 'error', { message: error?.message || 'event poll failed' })
        }
      }

      await poll()
      const interval = setInterval(poll, 15000)
      c.req.raw.signal.addEventListener('abort', () => {
        closed = true
        clearInterval(interval)
        try {
          controller.close()
        } catch {}
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
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
