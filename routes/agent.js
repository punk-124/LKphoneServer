import { Hono } from 'hono'
import { requireAuth } from '../lib/auth'
import { ensureAgentSchema, ensureUserExists } from '../lib/db'
import { jsonError } from '../lib/http'

const app = new Hono()

const DEFAULT_TAKEOVER = {
  proactiveWechat: false,
  offlineDailyShare: false,
  lifelineTriggers: true,
  lifelineBehaviors: true,
  randomCheckin: true,
}

const DEFAULT_OFFLINE_AI = {
  keyMode: 'server',
  baseUrl: '',
  model: '',
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
  proactiveWechat: value?.proactiveWechat === true,
  offlineDailyShare: value?.offlineDailyShare === true,
  lifelineTriggers: value?.lifelineTriggers !== false,
  randomCheckin: value?.randomCheckin !== false,
  lifelineBehaviors: value?.lifelineBehaviors !== false,
})

const normalizeInterval = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 60_000 ? Math.floor(parsed) : fallback
}

const normalizeMinuteInterval = (value, fallbackMinutes) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 1
    ? Math.floor(parsed) * 60_000
    : fallbackMinutes * 60_000
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

const normalizeUrl = (value, max = 500) => {
  const text = normalizeString(value, max).replace(/\/+$/, '')
  if (!text) return ''
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return ''
  }
}

const normalizeOfflineAi = (value = {}, fallback = DEFAULT_OFFLINE_AI) => {
  const source = value && typeof value === 'object' ? value : {}
  const readOptionalNumber = (key) => (
    Object.prototype.hasOwnProperty.call(source, key)
      ? (Number(source[key]) || undefined)
      : (Number(fallback[key] || 0) || undefined)
  )
  const baseUrl = normalizeUrl(source.baseUrl || fallback.baseUrl)
  const model = normalizeString(source.model || fallback.model, 120)
  const keyMode = source.keyMode === 'client_temporary' ? 'client_temporary' : 'server'
  return {
    ...DEFAULT_OFFLINE_AI,
    ...fallback,
    keyMode,
    baseUrl,
    model,
    temporaryKeyExpiresAt: readOptionalNumber('temporaryKeyExpiresAt'),
    temporaryKeyAuthorizedAt: readOptionalNumber('temporaryKeyAuthorizedAt'),
  }
}

const buildOpenAiUrl = (baseUrl, path) => {
  const cleanBase = normalizeUrl(baseUrl || 'https://api.openai.com/v1')
  if (!cleanBase) return ''
  return cleanBase.endsWith(path) ? cleanBase : `${cleanBase}${path}`
}

const getServerOfflineAiCredentials = (env) => {
  const apiKey = normalizeString(env.OFFLINE_AI_API_KEY || env.OPENAI_API_KEY || env.AI_API_KEY, 400)
  if (!apiKey) return null
  return {
    apiKey,
    baseUrl: normalizeUrl(env.OFFLINE_AI_BASE_URL || env.OPENAI_BASE_URL || 'https://api.openai.com/v1'),
    model: normalizeString(env.OFFLINE_AI_MODEL || env.OPENAI_MODEL || 'gpt-4.1-mini', 120),
  }
}

const resolveOfflineAiCredentials = async (env, userId) => {
  const current = await readAgentConfig(env.DB, userId)
  const offlineAi = normalizeOfflineAi(current.offlineAi)
  if (offlineAi.keyMode === 'client_temporary') {
    const row = await env.DB.prepare(`
      SELECT api_key, base_url, model, expires_at
      FROM agent_offline_ai_keys
      WHERE user_id = ?
    `).bind(userId).first()
    if (!row?.api_key) throw new Error('请先授权临时 API Key')
    const expiresAt = Number(row.expires_at || 0)
    if (expiresAt > 0 && expiresAt <= nowMs()) {
      await env.DB.prepare('DELETE FROM agent_offline_ai_keys WHERE user_id = ?').bind(userId).run()
      throw new Error('临时 API Key 已过期，请重新授权')
    }
    return {
      apiKey: String(row.api_key),
      baseUrl: normalizeUrl(row.base_url || offlineAi.baseUrl),
      model: normalizeString(row.model || offlineAi.model, 120),
      offlineAi,
    }
  }
  const server = getServerOfflineAiCredentials(env)
  if (!server?.apiKey) throw new Error('后端未配置 OFFLINE_AI_API_KEY')
  return {
    ...server,
    baseUrl: offlineAi.baseUrl || server.baseUrl,
    model: offlineAi.model || server.model,
    offlineAi,
  }
}

const fetchOpenAiCompatibleModels = async (credentials) => {
  const url = buildOpenAiUrl(credentials.baseUrl, '/models')
  if (!url || !credentials.apiKey) throw new Error('AI Base URL 或 Key 不完整')
  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${credentials.apiKey}` },
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(payload?.error?.message || `模型列表请求失败：${response.status}`)
  }
  return (Array.isArray(payload?.data) ? payload.data : [])
    .map((item) => normalizeString(item?.id || item?.name || item, 160))
    .filter(Boolean)
    .slice(0, 200)
}

const testOfflineAiGeneration = async (credentials, modelOverride) => {
  const model = normalizeString(modelOverride || credentials.model, 120)
  const url = buildOpenAiUrl(credentials.baseUrl, '/chat/completions')
  if (!url || !credentials.apiKey || !model) throw new Error('AI Base URL、Key 或模型名不完整')
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credentials.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: '你是 LuckyPhone 后端离线生成配置测试器。' },
        { role: 'user', content: '请用一句很短的中文回复：后端离线生成可用。' },
      ],
      temperature: 0.2,
      max_tokens: 40,
    }),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(payload?.error?.message || `测试生成失败：${response.status}`)
  }
  return normalizeString(payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text || '', 500)
}

const sanitizePromptPacket = (value) => {
  if (!value || typeof value !== 'object') return null
  const kind = String(value.kind || '').trim()
  if (kind !== 'wechat_offline_daily_share' && kind !== 'wechat_proactive') return null
  const rawMessages = Array.isArray(value.messages) ? value.messages : []
  const messages = rawMessages.slice(0, 12).map((message) => {
    const role = String(message?.role || '').trim()
    if (!['system', 'user', 'assistant'].includes(role)) return null
    const content = normalizeString(message?.content, 12000)
    if (!content) return null
    return { role, content }
  }).filter(Boolean)
  if (messages.length === 0) return null
  const rawOptions = value.options && typeof value.options === 'object' ? value.options : {}
  const options = {}
  for (const key of ['temperature', 'max_tokens', 'frequency_penalty', 'presence_penalty']) {
    const parsed = Number(rawOptions[key])
    if (Number.isFinite(parsed)) options[key] = parsed
  }
  return { version: 1, kind, messages, options }
}

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
      offlineAi: DEFAULT_OFFLINE_AI,
      minIntervalMs: 60_000,
      maxIntervalMs: 3_600_000,
      nextCheckinAt: null,
      lastCheckinAt: null,
    }
  }

  return {
    enabled: Number(row.enabled || 0) === 1,
    takeover: normalizeTakeover(safeJsonParse(row.takeover_json, DEFAULT_TAKEOVER)),
    offlineAi: normalizeOfflineAi(safeJsonParse(row.offline_ai_json, DEFAULT_OFFLINE_AI)),
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
  const intervalMinutes = body.pollIntervalMinutes && typeof body.pollIntervalMinutes === 'object'
    ? body.pollIntervalMinutes
    : null
  const minIntervalMs = normalizeInterval(
    body.minIntervalMs,
    intervalMinutes ? normalizeMinuteInterval(intervalMinutes.min, Math.max(1, Math.floor(current.minIntervalMs / 60_000))) : current.minIntervalMs
  )
  const maxIntervalMs = Math.max(
    minIntervalMs,
    normalizeInterval(
      body.maxIntervalMs,
      intervalMinutes ? normalizeMinuteInterval(intervalMinutes.max, Math.max(1, Math.floor(current.maxIntervalMs / 60_000))) : current.maxIntervalMs
    )
  )
  const enabled = body.enabled === true
  const takeover = normalizeTakeover(body.takeover || current.takeover)
  const offlineAi = normalizeOfflineAi(body.offlineAi || current.offlineAi, current.offlineAi)
  const ts = nowMs()
  const nextCheckinAt = enabled && takeover.randomCheckin
    ? pickNextCheckinAt(minIntervalMs, maxIntervalMs, ts)
    : null

  await c.env.DB.prepare(`
    INSERT INTO agent_configs (
      user_id, enabled, takeover_json, offline_ai_json, min_interval_ms, max_interval_ms,
      next_checkin_at, last_checkin_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      enabled = excluded.enabled,
      takeover_json = excluded.takeover_json,
      offline_ai_json = excluded.offline_ai_json,
      min_interval_ms = excluded.min_interval_ms,
      max_interval_ms = excluded.max_interval_ms,
      next_checkin_at = excluded.next_checkin_at,
      updated_at = excluded.updated_at
  `).bind(
    auth.user.id,
    enabled ? 1 : 0,
    JSON.stringify(takeover),
    JSON.stringify(offlineAi),
    minIntervalMs,
    maxIntervalMs,
    nextCheckinAt,
    current.lastCheckinAt,
    ts,
    ts
  ).run()

  return c.json({ status: 'success', data: await readAgentConfig(c.env.DB, auth.user.id) })
})

app.post('/offline-ai/temporary-key', async (c) => {
  const auth = await requireAgentAuth(c)
  if (auth.error) return auth.error

  const body = await c.req.json()
  const apiKey = normalizeString(body.apiKey, 400)
  const baseUrl = normalizeUrl(body.baseUrl)
  const model = normalizeString(body.model, 120)
  const ttlHours = Math.floor(normalizeNumber(body.ttlHours, 24, 0))
  if (!apiKey) return jsonError(c, 'Missing API key')
  if (!baseUrl) return jsonError(c, 'Invalid Base URL')
  if (ttlHours > 168) return jsonError(c, 'ttlHours must be between 0 and 168')

  const ts = nowMs()
  const expiresAt = ttlHours === 0 ? null : ts + ttlHours * 60 * 60 * 1000
  const offlineAi = normalizeOfflineAi({
    keyMode: 'client_temporary',
    baseUrl,
    model,
    temporaryKeyAuthorizedAt: ts,
    temporaryKeyExpiresAt: expiresAt || undefined,
  })

  await c.env.DB.prepare(`
    INSERT INTO agent_offline_ai_keys (
      user_id, api_key, base_url, model, expires_at, authorized_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      api_key = excluded.api_key,
      base_url = excluded.base_url,
      model = excluded.model,
      expires_at = excluded.expires_at,
      authorized_at = excluded.authorized_at,
      updated_at = excluded.updated_at
  `).bind(auth.user.id, apiKey, baseUrl, model, expiresAt, ts, ts).run()

  const current = await readAgentConfig(c.env.DB, auth.user.id)
  await c.env.DB.prepare(`
    INSERT INTO agent_configs (
      user_id, enabled, takeover_json, offline_ai_json, min_interval_ms, max_interval_ms,
      next_checkin_at, last_checkin_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      offline_ai_json = excluded.offline_ai_json,
      updated_at = excluded.updated_at
  `).bind(
    auth.user.id,
    current.enabled ? 1 : 0,
    JSON.stringify(current.takeover),
    JSON.stringify(offlineAi),
    current.minIntervalMs,
    current.maxIntervalMs,
    current.nextCheckinAt,
    current.lastCheckinAt,
    ts,
    ts
  ).run()

  return c.json({ status: 'success', data: { offlineAi } })
})

app.delete('/offline-ai/temporary-key', async (c) => {
  const auth = await requireAgentAuth(c)
  if (auth.error) return auth.error

  const ts = nowMs()
  await c.env.DB.prepare('DELETE FROM agent_offline_ai_keys WHERE user_id = ?').bind(auth.user.id).run()
  const current = await readAgentConfig(c.env.DB, auth.user.id)
  const offlineAi = normalizeOfflineAi({ ...current.offlineAi, keyMode: 'server', temporaryKeyExpiresAt: undefined, temporaryKeyAuthorizedAt: undefined }, current.offlineAi)
  await c.env.DB.prepare(`
    UPDATE agent_configs
    SET offline_ai_json = ?, updated_at = ?
    WHERE user_id = ?
  `).bind(JSON.stringify(offlineAi), ts, auth.user.id).run()

  return c.json({ status: 'success', data: { offlineAi } })
})

app.get('/offline-ai/models', async (c) => {
  const auth = await requireAgentAuth(c)
  if (auth.error) return auth.error

  try {
    const credentials = await resolveOfflineAiCredentials(c.env, auth.user.id)
    const models = await fetchOpenAiCompatibleModels(credentials)
    return c.json({
      status: 'success',
      data: {
        models,
        baseUrl: credentials.baseUrl,
        model: credentials.model,
      },
    })
  } catch (error) {
    return jsonError(c, error?.message || '拉取模型失败')
  }
})

app.post('/offline-ai/test', async (c) => {
  const auth = await requireAgentAuth(c)
  if (auth.error) return auth.error

  const body = await c.req.json().catch(() => ({}))
  try {
    const credentials = await resolveOfflineAiCredentials(c.env, auth.user.id)
    const text = await testOfflineAiGeneration(credentials, body?.model)
    return c.json({
      status: 'success',
      data: {
        ok: true,
        model: normalizeString(body?.model || credentials.model, 120),
        sample: text,
      },
    })
  } catch (error) {
    return jsonError(c, error?.message || '测试生成失败')
  }
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
        proactive_quiet_end, client_time_zone, client_utc_offset_minutes,
        last_local_message_id, recent_messages_hash, offline_prompt_packet_json, last_message_at,
        last_user_reply_at, last_ai_message_at, last_ai_proactive_message_at,
        today_proactive_count, proactive_since_user_reply, is_active, is_group, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, profile_id, chat_id, character_id) DO UPDATE SET
        proactive_chat = excluded.proactive_chat,
        chat_frequency = excluded.chat_frequency,
        proactive_min_interval_hours = excluded.proactive_min_interval_hours,
        proactive_max_streak = excluded.proactive_max_streak,
        proactive_quiet_start = excluded.proactive_quiet_start,
        proactive_quiet_end = excluded.proactive_quiet_end,
        client_time_zone = excluded.client_time_zone,
        client_utc_offset_minutes = excluded.client_utc_offset_minutes,
        last_local_message_id = excluded.last_local_message_id,
        recent_messages_hash = excluded.recent_messages_hash,
        offline_prompt_packet_json = excluded.offline_prompt_packet_json,
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
      normalizeString(item.lastLocalMessageId, 180) || null,
      normalizeString(item.recentMessagesHash, 120) || null,
      (() => {
        const packet = sanitizePromptPacket(item.offlineDailySharePromptPacket)
        return packet ? JSON.stringify(packet) : null
      })(),
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
