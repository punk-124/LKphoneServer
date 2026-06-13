import { Hono } from 'hono'
import { cors } from 'hono/cors'
import commentsRoutes from './routes/comments'
import groupsRoutes from './routes/groups'
import resourcesRoutes from './routes/resources'
import systemRoutes from './routes/system'
import agentRoutes from './routes/agent'
import mcpRoutes from './routes/mcp'
import { requireAuth } from './lib/auth'
import { ensureAgentSchema } from './lib/db'
import { notifyOutboxAvailable } from './lib/push'
export { GroupRoom } from './group-room'

const app = new Hono()

app.use('*', cors())
app.onError((error, c) => {
  console.error('Unhandled worker error', error)
  return c.json({
    status: 'error',
    message: error?.message || 'Internal Server Error',
  }, 500)
})

app.route('/', systemRoutes)
app.route('/resources', resourcesRoutes)
app.route('/comments', commentsRoutes)
app.route('/groups', groupsRoutes)
app.route('/agent', agentRoutes)
app.route('/mcp', mcpRoutes)

const makeWakePayload = ({ wakeKind, taskType, taskId, payload, scheduledAt, reason }) => ({
  wakeKind,
  taskType,
  taskId,
  payload: payload || {},
  scheduledAt,
  reason: reason || taskType || wakeKind,
  delivery: 'wake_frontend_first',
})

const safeJsonParse = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback
  } catch {
    return fallback
  }
}

const parseTakeover = (row) => {
  const parsed = safeJsonParse(row?.takeover_json, {})
  return {
    ...(parsed && typeof parsed === 'object' ? parsed : {}),
    proactiveWechat: parsed?.proactiveWechat === true,
    offlineDailyShare: parsed?.offlineDailyShare === true,
    lifelineTriggers: parsed?.lifelineTriggers !== false,
    lifelineBehaviors: parsed?.lifelineBehaviors !== false,
    randomCheckin: parsed?.randomCheckin !== false,
  }
}

const normalizeString = (value, max = 260) => String(value || '').trim().slice(0, max)

const makeWakeDedupeKey = (userId, payload = {}) => {
  const nested = payload?.payload && typeof payload.payload === 'object' ? payload.payload : {}
  const taskType = normalizeString(payload.taskType || payload.type || 'wake', 80)
  const wakeKind = normalizeString(payload.wakeKind || payload.kind || 'generic', 80)
  const taskId = normalizeString(payload.taskId || nested.taskId || nested.triggerId, 160)
  const profileId = normalizeString(payload.profileId || nested.profileId || nested.wechatProfileId, 120)
  const chatId = normalizeString(payload.chatId || nested.chatId || nested.targetId, 160)
  const characterId = normalizeString(payload.characterId || nested.characterId || nested.responderId, 160)
  const snapshot = normalizeString(payload.snapshotHash || nested.snapshotHash || nested.recentMessagesHash || nested.lastLocalMessageId, 180)
  const scheduledAt = Math.floor(Number(payload.scheduledAt || nested.scheduledAt || 0) || 0)
  const fiveMinuteBucket = scheduledAt > 0 ? Math.floor(scheduledAt / (5 * 60 * 1000)) : 'current'

  if (taskId) {
    return ['wake', userId, taskType, taskId, scheduledAt || 'unscheduled'].map(part => normalizeString(part, 180)).join(':')
  }
  if (profileId || chatId || characterId) {
    return ['wake', userId, wakeKind, taskType, profileId, chatId, characterId, snapshot || 'nosnapshot', fiveMinuteBucket].map(part => normalizeString(part, 180)).join(':')
  }
  return ['wake', userId, wakeKind, taskType, fiveMinuteBucket].map(part => normalizeString(part, 180)).join(':')
}

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

const parseOfflineAi = (row) => {
  const parsed = safeJsonParse(row?.offline_ai_json, {})
  const source = parsed && typeof parsed === 'object' ? parsed : {}
  return {
    keyMode: source.keyMode === 'client_temporary' ? 'client_temporary' : 'server',
    baseUrl: normalizeUrl(source.baseUrl),
    model: normalizeString(source.model, 120),
  }
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

const getOfflineAiCredentials = async (env, state, now) => {
  const offlineAi = parseOfflineAi(state)
  if (offlineAi.keyMode === 'client_temporary') {
    const row = await env.DB.prepare(`
      SELECT api_key, base_url, model, expires_at
      FROM agent_offline_ai_keys
      WHERE user_id = ?
    `).bind(state.user_id).first()
    if (!row?.api_key) return null
    const expiresAt = Number(row.expires_at || 0)
    if (expiresAt > 0 && expiresAt <= now) {
      await env.DB.prepare('DELETE FROM agent_offline_ai_keys WHERE user_id = ?').bind(state.user_id).run()
      return null
    }
    return {
      apiKey: String(row.api_key),
      baseUrl: normalizeUrl(row.base_url || offlineAi.baseUrl),
      model: normalizeString(row.model || offlineAi.model, 120),
    }
  }
  const server = getServerOfflineAiCredentials(env)
  if (!server) return null
  return {
    ...server,
    baseUrl: offlineAi.baseUrl || server.baseUrl,
    model: offlineAi.model || server.model,
  }
}

const getOfflineAiCredentialStatus = async (env, state, now) => {
  const offlineAi = parseOfflineAi(state)
  if (offlineAi.keyMode === 'client_temporary') {
    const row = await env.DB.prepare(`
      SELECT api_key, base_url, model, expires_at
      FROM agent_offline_ai_keys
      WHERE user_id = ?
    `).bind(state.user_id).first()
    const expiresAt = Number(row?.expires_at || 0)
    return {
      keyMode: 'client_temporary',
      hasKey: Boolean(row?.api_key && (!expiresAt || expiresAt > now)),
      expired: Boolean(row?.api_key && expiresAt > 0 && expiresAt <= now),
      baseUrl: normalizeUrl(row?.base_url || offlineAi.baseUrl),
      model: normalizeString(row?.model || offlineAi.model, 120),
    }
  }
  const server = getServerOfflineAiCredentials(env)
  return {
    keyMode: 'server',
    hasKey: Boolean(server?.apiKey),
    expired: false,
    baseUrl: offlineAi.baseUrl || server?.baseUrl || '',
    model: offlineAi.model || server?.model || '',
  }
}

const isUserClientActive = async (env, userId, now) => {
  const row = await env.DB.prepare(`
    SELECT updated_at
    FROM agent_client_presence
    WHERE user_id = ?
      AND visible = 1
      AND foreground = 1
      AND updated_at >= ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).bind(userId, now - 90_000).first()
  return Boolean(row?.updated_at)
}

const buildChatCompletionsUrl = (baseUrl) => {
  const cleanBase = normalizeUrl(baseUrl || 'https://api.openai.com/v1')
  if (!cleanBase) return ''
  return cleanBase.endsWith('/chat/completions')
    ? cleanBase
    : `${cleanBase}/chat/completions`
}

const splitGeneratedBubbles = (text) => normalizeString(text, 2000)
  .replace(/^```(?:\w+)?\s*/i, '')
  .replace(/\s*```$/i, '')
  .split(/\s*\|\|\|\s*|\n{2,}/)
  .map((part) => part.replace(/^[-*\d.、\s]+/, '').trim())
  .filter(Boolean)
  .slice(0, 3)

const callOfflineAi = async ({ credentials, promptPacket }) => {
  const messages = Array.isArray(promptPacket?.messages) ? promptPacket.messages : []
  if (messages.length === 0) return ''
  const url = buildChatCompletionsUrl(credentials.baseUrl)
  if (!url || !credentials.apiKey || !credentials.model) return ''
  const startedAt = Date.now()
  const options = promptPacket.options && typeof promptPacket.options === 'object' ? promptPacket.options : {}
  const body = {
    model: credentials.model,
    messages,
    temperature: Number.isFinite(Number(options.temperature)) ? Number(options.temperature) : 0.9,
    max_tokens: Number.isFinite(Number(options.max_tokens)) ? Math.max(1, Math.floor(Number(options.max_tokens))) : 260,
    frequency_penalty: Number.isFinite(Number(options.frequency_penalty)) ? Number(options.frequency_penalty) : undefined,
    presence_penalty: Number.isFinite(Number(options.presence_penalty)) ? Number(options.presence_penalty) : undefined,
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credentials.apiKey}`,
    },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(`offline ai request failed: ${response.status} ${payload?.error?.message || ''}`.trim())
  }
  const text = String(payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text || '').trim()
  return {
    text,
    apiLog: {
      source: 'backend-offline-ai',
      method: 'POST',
      url,
      status: response.status,
      ok: true,
      durationMs: Date.now() - startedAt,
      model: credentials.model,
      responseBody: {
        usage: payload?.usage,
        choices: [{ message: { content: text } }],
      },
    },
  }
}

const formatElapsed = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '未知'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时${minutes % 60 ? `${minutes % 60}分钟` : ''}`
  return `${Math.floor(hours / 24)}天${hours % 24 ? `${hours % 24}小时` : ''}`
}

const insertWechatMessageOutbox = async (env, userId, payload, now) => {
  const outboxId = `agt_out_${now}_${crypto.randomUUID()}`
  const dedupeKey = normalizeString(payload?.dedupeKey, 260) || null
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO agent_outbox (id, user_id, type, payload_json, dedupe_key, status, created_at)
    VALUES (?, ?, 'proactive_wechat_message', ?, ?, 'pending', ?)
  `).bind(outboxId, userId, JSON.stringify(payload), dedupeKey, now).run()
  if (!dedupeKey) return { id: outboxId, inserted: true }
  const inserted = Number(result?.meta?.changes || 0) > 0
  const row = await env.DB.prepare(`
    SELECT id FROM agent_outbox
    WHERE dedupe_key = ? AND user_id = ?
    LIMIT 1
  `).bind(dedupeKey, userId).first()
  return { id: String(row?.id || outboxId), inserted }
}

const insertWechatMessageOutboxAndNotify = async (env, userId, payload, now) => {
  const result = await insertWechatMessageOutbox(env, userId, payload, now)
  if (result.inserted) {
    await notifyOutboxAvailable(env, userId, {
      id: result.id,
      type: 'proactive_wechat_message',
      payload,
      createdAt: now,
    })
  }
  return result
}

const makeOfflineWechatDedupeKey = (state, snapshotHash) => [
  'wechat_offline_daily_share',
  normalizeString(state.user_id, 120),
  normalizeString(state.profile_id, 120),
  normalizeString(state.chat_id, 160),
  normalizeString(state.character_id, 160),
  normalizeString(snapshotHash, 180),
].join(':')

const makeOfflineWechatDedupeKeyForSequence = (state, snapshotHash, sequence) =>
  `${makeOfflineWechatDedupeKey(state, snapshotHash)}:${Math.max(1, Math.floor(Number(sequence) || 1))}`

const getPendingOfflineWechatOutbox = async (env, state, snapshotHash) => {
  const baseKey = snapshotHash ? makeOfflineWechatDedupeKey(state, snapshotHash) : ''
  const result = await env.DB.prepare(`
    SELECT id, payload_json, dedupe_key, created_at
    FROM agent_outbox
    WHERE user_id = ?
      AND type = 'proactive_wechat_message'
      AND status = 'pending'
      AND (
        (? != '' AND (dedupe_key = ? OR dedupe_key LIKE ?))
        OR json_extract(payload_json, '$.profileId') = ?
        OR json_extract(payload_json, '$.chatId') = ?
      )
    ORDER BY created_at ASC, id ASC
    LIMIT 20
  `).bind(
    state.user_id,
    baseKey,
    baseKey,
    `${baseKey}:%`,
    normalizeString(state.profile_id, 120),
    normalizeString(state.chat_id, 160)
  ).all()

  return (result.results || []).map((row) => {
    const payload = safeJsonParse(row.payload_json, {})
    return {
      id: String(row.id || ''),
      dedupeKey: String(row.dedupe_key || ''),
      createdAt: Number(row.created_at || 0),
      payload,
      sequence: Math.max(1, Math.floor(Number(payload?.offlineSequence || 0) || 1)),
      text: normalizeString(payload?.text || '', 1200),
    }
  }).filter(item => item.id && item.text)
}

const withOfflineContinuationContext = (promptPacket, pendingMessages, now) => {
  if (!Array.isArray(pendingMessages) || pendingMessages.length === 0) return promptPacket
  const messages = Array.isArray(promptPacket?.messages) ? promptPacket.messages : []
  const lines = pendingMessages.slice(-8).map((item, index) => {
    const label = new Date(item.createdAt || now).toLocaleString()
    return `${index + 1}. [${label}，距今约${formatElapsed(now - Number(item.createdAt || now))}] ${normalizeString(item.text, 360)}`
  })
  const continuationSystem = [
    '### 已生成但用户尚未上线领取的离线留言',
    '下面这些是你在同一个本地聊天快照之后，已经留给用户、但用户还没有打开 App 领取的消息。它们不是用户回复，也不是新的聊天上下文。',
    lines.join('\n'),
    '',
    '继续生成时必须遵守：',
    '- 不要回答、解释、纠正或延续上一条留言里的问题；用户还没有看到，也没有回复。',
    '- 不要把上一条留言当作对话对象来自问自答。',
    '- 如果还要留新消息，要表现为过了一段时间后你又想到对方，换一个更具体的生活切片或更轻的思念表达。',
    '- 严禁复用相同开头、相同场景、相同情绪模板；如果没有新的自然内容，宁可输出空内容。',
  ].join('\n')
  const insertAt = Math.max(0, messages.length - 1)
  return {
    ...promptPacket,
    messages: [
      ...messages.slice(0, insertAt),
      { role: 'system', content: continuationSystem },
      ...messages.slice(insertAt),
    ],
    options: {
      ...(promptPacket.options || {}),
      frequency_penalty: Math.max(Number(promptPacket.options?.frequency_penalty || 0), 0.45),
      presence_penalty: Math.max(Number(promptPacket.options?.presence_penalty || 0), 0.65),
    },
  }
}

const parseTimeToMinutes = (value) => {
  const text = String(value || '').trim()
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) return null
  const [hour, minute] = text.split(':').map(Number)
  return hour * 60 + minute
}

const isWithinQuietHours = (startValue, endValue, date = new Date()) => {
  const start = parseTimeToMinutes(startValue)
  const end = parseTimeToMinutes(endValue)
  if (start === null || end === null || start === end) return false

  const current = date.getHours() * 60 + date.getMinutes()
  if (start < end) {
    return current >= start && current < end
  }
  return current >= start || current < end
}

const getClientMinutesOfDay = (now, timeZone, utcOffsetMinutes) => {
  const zone = String(timeZone || '').trim()
  if (zone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(new Date(now))
      const hour = Number(parts.find((part) => part.type === 'hour')?.value)
      const minute = Number(parts.find((part) => part.type === 'minute')?.value)
      if (Number.isFinite(hour) && Number.isFinite(minute)) {
        return (hour % 24) * 60 + minute
      }
    } catch {
      // Fall through to numeric offset.
    }
  }

  const offset = Number(utcOffsetMinutes)
  if (Number.isFinite(offset) && offset >= -14 * 60 && offset <= 14 * 60) {
    const localMs = now + offset * 60 * 1000
    const localDate = new Date(localMs)
    return localDate.getUTCHours() * 60 + localDate.getUTCMinutes()
  }

  const fallbackDate = new Date(now)
  return fallbackDate.getHours() * 60 + fallbackDate.getMinutes()
}

const isWithinClientQuietHours = (startValue, endValue, now, timeZone, utcOffsetMinutes) => {
  const start = parseTimeToMinutes(startValue)
  const end = parseTimeToMinutes(endValue)
  if (start === null || end === null || start === end) return false

  const current = getClientMinutesOfDay(now, timeZone, utcOffsetMinutes)
  if (start < end) {
    return current >= start && current < end
  }
  return current >= start || current < end
}

const cleanupAgentStorage = async (env, now) => {
  const dayMs = 24 * 60 * 60 * 1000
  await env.DB.prepare(`
    DELETE FROM agent_outbox
    WHERE status IN ('consumed', 'skipped')
      AND COALESCE(consumed_at, created_at) < ?
  `).bind(now - 2 * dayMs).run()

  await env.DB.prepare(`
    DELETE FROM agent_outbox
    WHERE status = 'pending'
      AND created_at < ?
  `).bind(now - 7 * dayMs).run()

  await env.DB.prepare(`
    DELETE FROM agent_wechat_proactive_state
    WHERE is_active = 0
      AND updated_at < ?
  `).bind(now - 7 * dayMs).run()

  await env.DB.prepare(`
    DELETE FROM agent_wechat_proactive_state
    WHERE updated_at < ?
  `).bind(now - 30 * dayMs).run()

  await env.DB.prepare(`
    DELETE FROM agent_tasks
    WHERE status != 'pending'
      AND updated_at < ?
  `).bind(now - 7 * dayMs).run()
}

const getWechatProactiveDiagnostics = async (env, userId, now = Date.now()) => {
  const config = await env.DB.prepare(`
    SELECT * FROM agent_configs WHERE user_id = ? LIMIT 1
  `).bind(userId).first()
  const configEnabled = Number(config?.enabled || 0) === 1
  const takeover = parseTakeover(config || {})
  const activeClient = await isUserClientActive(env, userId, now)
  const rows = await env.DB.prepare(`
    SELECT state.*, config.takeover_json, config.offline_ai_json, config.enabled
    FROM agent_wechat_proactive_state state
    LEFT JOIN agent_configs config ON config.user_id = state.user_id
    WHERE state.user_id = ?
      AND state.is_active = 1
    ORDER BY state.updated_at DESC
    LIMIT 50
  `).bind(userId).all()

  const items = []
  for (const state of rows.results || []) {
    const itemReasons = []
    const rowTakeover = parseTakeover({
      takeover_json: state.takeover_json || config?.takeover_json,
    })
    const proactiveChat = Number(state.proactive_chat || 0) === 1
    const promptPacket = safeJsonParse(state.offline_prompt_packet_json, null)
    const quietNow = isWithinClientQuietHours(
      state.proactive_quiet_start,
      state.proactive_quiet_end,
      now,
      state.client_time_zone,
      state.client_utc_offset_minutes
    )
    const frequency = Math.max(0.01, Number(state.chat_frequency || 2))
    const minIntervalMs = Math.max(0, Number(state.proactive_min_interval_hours || 6)) * 60 * 60 * 1000
    const maxStreak = Math.max(1, Number(state.proactive_max_streak || 1))
    const thresholdMs = (24 * 60 * 60 * 1000) / frequency
    const lastMessageAt = Number(state.last_message_at || 0)
    const lastAiMessageAt = Number(state.last_ai_message_at || 0)
    const lastAiProactiveAt = Number(state.last_ai_proactive_message_at || 0)
    const lastDispatchedAt = Number(state.last_dispatched_at || 0)
    const timeSinceLastActivity = lastMessageAt > 0 ? now - lastMessageAt : Number.POSITIVE_INFINITY
    const timeSinceAiMessage = lastAiMessageAt > 0 ? now - lastAiMessageAt : Number.POSITIVE_INFINITY
    const timeSinceProactive = Math.min(
      lastAiProactiveAt > 0 ? now - lastAiProactiveAt : Number.POSITIVE_INFINITY,
      lastDispatchedAt > 0 ? now - lastDispatchedAt : Number.POSITIVE_INFINITY
    )
    const minAiGapMs = Math.min(15 * 60 * 1000, minIntervalMs)
    const snapshotHash = normalizeString(state.recent_messages_hash || state.last_local_message_id, 180)
    const hasLocalSnapshotAnchor = Boolean(state.recent_messages_hash && state.last_local_message_id)
    const pendingOfflineMessages = snapshotHash
      ? await getPendingOfflineWechatOutbox(env, state, snapshotHash)
      : []
    const lastPendingOfflineAt = pendingOfflineMessages.reduce((latest, item) => Math.max(latest, Number(item.createdAt || 0)), 0)
    const timeSincePendingOffline = lastPendingOfflineAt > 0 ? now - lastPendingOfflineAt : Number.POSITIVE_INFINITY
    const aiStatus = await getOfflineAiCredentialStatus(env, state, now)

    if (!configEnabled) itemReasons.push('后端总开关未开启')
    if (activeClient) itemReasons.push('前台 90 秒内仍被判定活跃')
    if (rowTakeover.proactiveWechat !== true) itemReasons.push('微信主动唤醒未开启')
    if (!proactiveChat) itemReasons.push('该聊天未开启主动聊天')
    if (!state.offline_prompt_packet_json) itemReasons.push('没有离线 prompt，需开启 AI 离线生成授权并同步一次')
    if (state.offline_prompt_packet_json && !Array.isArray(promptPacket?.messages)) itemReasons.push('离线 prompt 无效')
    if (!hasLocalSnapshotAnchor) itemReasons.push('缺少本地最后消息锚点')
    if (quietNow) itemReasons.push('当前在安静时段')
    if (timeSinceLastActivity <= thresholdMs) itemReasons.push(`最近聊天未超过频率间隔，还差约 ${Math.ceil((thresholdMs - timeSinceLastActivity) / 60000)} 分钟`)
    if (timeSinceAiMessage <= minAiGapMs) itemReasons.push(`距离上一条 AI 消息太近，还差约 ${Math.ceil((minAiGapMs - timeSinceAiMessage) / 60000)} 分钟`)
    if (timeSinceProactive <= minIntervalMs) itemReasons.push(`距离上次主动消息太近，还差约 ${Math.ceil((minIntervalMs - timeSinceProactive) / 60000)} 分钟`)
    if (Number(state.today_proactive_count || 0) >= frequency) itemReasons.push('今日主动消息次数已达频率上限')
    if (Number(state.proactive_since_user_reply || 0) >= maxStreak) itemReasons.push('用户未回复前的主动连发已达上限')
    if (pendingOfflineMessages.length > 0) itemReasons.push(`已有 ${pendingOfflineMessages.length} 条未领取离线消息`)
    if (timeSincePendingOffline < minIntervalMs) itemReasons.push(`距离上一条未领取离线消息太近，还差约 ${Math.ceil((minIntervalMs - timeSincePendingOffline) / 60000)} 分钟`)
    if (!aiStatus.hasKey) itemReasons.push(aiStatus.expired ? '临时 AI Key 已过期' : 'AI Key 不可用')
    if (!aiStatus.model) itemReasons.push('AI 模型未配置')

    items.push({
      profileId: state.profile_id,
      chatId: state.chat_id,
      characterId: state.character_id,
      characterName: state.character_name || state.chat_title || '',
      ready: itemReasons.length === 0,
      reasons: itemReasons,
      checks: {
        configEnabled,
        activeClient,
        proactiveWechat: rowTakeover.proactiveWechat === true,
        proactiveChat,
        hasOfflinePrompt: Boolean(state.offline_prompt_packet_json),
        promptMessages: Array.isArray(promptPacket?.messages) ? promptPacket.messages.length : 0,
        hasLocalSnapshotAnchor,
        quietNow,
        pendingOfflineCount: pendingOfflineMessages.length,
        frequency,
        minIntervalHours: minIntervalMs / (60 * 60 * 1000),
        aiKeyMode: aiStatus.keyMode,
        hasAiKey: aiStatus.hasKey,
        aiModel: aiStatus.model,
      },
      updatedAt: Number(state.updated_at || 0),
    })
  }

  return {
    ranAt: now,
    configEnabled,
    takeover,
    activeClient,
    candidateCount: items.length,
    readyCount: items.filter(item => item.ready).length,
    items,
  }
}

const insertWakeOutbox = async (env, userId, payload, now) => {
  const outboxId = `agt_out_${now}_${crypto.randomUUID()}`
  const dedupeKey = normalizeString(payload?.dedupeKey || makeWakeDedupeKey(userId, payload), 260) || null
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO agent_outbox (id, user_id, type, payload_json, dedupe_key, status, created_at)
    VALUES (?, ?, 'wake_request', ?, ?, 'pending', ?)
  `).bind(outboxId, userId, JSON.stringify(payload), dedupeKey, now).run()
  const inserted = Number(result?.meta?.changes || 0) > 0
  const row = dedupeKey
    ? await env.DB.prepare(`
      SELECT id FROM agent_outbox
      WHERE dedupe_key = ? AND user_id = ?
      LIMIT 1
    `).bind(dedupeKey, userId).first()
    : null
  const id = String(row?.id || outboxId)
  if (inserted) {
    await notifyOutboxAvailable(env, userId, {
      id,
      type: 'wake_request',
      payload,
      createdAt: now,
    })
  }
  return id
}

const runAgentScheduler = async (env) => {
  if (!env.DB) return
  const { ensureAgentSchema } = await import('./lib/db')
  await ensureAgentSchema(env.DB)
  const now = Date.now()
  await cleanupAgentStorage(env, now)

  const dueTasks = await env.DB.prepare(`
    SELECT task.*
    FROM agent_tasks task
    JOIN agent_configs config ON config.user_id = task.user_id
    WHERE config.enabled = 1
      AND task.status = 'pending'
      AND task.due_at <= ?
    ORDER BY due_at ASC
    LIMIT 25
  `).bind(now).all()

  for (const task of dueTasks.results || []) {
    const taskPayload = (() => {
      try {
        return JSON.parse(task.payload_json || '{}')
      } catch {
        return {}
      }
    })()
    const outboxId = await insertWakeOutbox(
      env,
      task.user_id,
      makeWakePayload({
        wakeKind: task.type === 'wechat_message' || task.type === 'proactive_wechat_message'
          ? 'wechat'
          : task.type === 'lifeline_trigger'
            ? 'lifeline'
            : task.type === 'nightly_diary'
              ? 'diary'
              : 'generic',
        taskType: task.type,
        taskId: task.id,
        payload: taskPayload,
        scheduledAt: task.due_at,
      }),
      now
    )
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
    if (await isUserClientActive(env, config.user_id, now)) continue
    const takeover = parseTakeover(config)
    if (takeover.randomCheckin === false) continue
    const minIntervalMs = Math.max(60000, Number(config.min_interval_ms || 60000))
    const maxIntervalMs = Math.max(minIntervalMs, Number(config.max_interval_ms || 3600000))
    const nextCheckinAt = now + minIntervalMs + Math.floor(Math.random() * (maxIntervalMs - minIntervalMs + 1))
    const isLifelineBehavior = takeover.lifelineBehaviors === true && Math.random() < 0.35
    if (isLifelineBehavior) {
      await insertWakeOutbox(
        env,
        config.user_id,
        makeWakePayload({
          wakeKind: 'lifeline_behavior',
          taskType: 'lifeline_random_behavior',
          payload: { reason: 'lifeline_random_behavior' },
          scheduledAt: config.next_checkin_at,
        }),
        now
      )
    }
    await env.DB.prepare(`
      UPDATE agent_configs
      SET last_checkin_at = ?, next_checkin_at = ?, updated_at = ?
      WHERE user_id = ?
    `).bind(now, nextCheckinAt, now, config.user_id).run()
  }

  const dueLifeline = await env.DB.prepare(`
    SELECT trigger.*, config.takeover_json, config.enabled
    FROM agent_lifeline_triggers trigger
    JOIN agent_configs config ON config.user_id = trigger.user_id
    WHERE config.enabled = 1
      AND trigger.status IN ('pending', 'due')
      AND trigger.trigger_at IS NOT NULL
      AND trigger.trigger_at <= ?
      AND (trigger.last_dispatched_at IS NULL OR trigger.last_dispatched_at < trigger.trigger_at)
    ORDER BY trigger.trigger_at ASC
    LIMIT 25
  `).bind(now).all()

  for (const trigger of dueLifeline.results || []) {
    const takeover = parseTakeover(trigger)
    if (takeover.lifelineTriggers === false) continue
    const participants = safeJsonParse(trigger.participants_json, [])
    const chatId = trigger.visibility === 'chat_only' && Array.isArray(participants) ? participants[0] : undefined
    const outboxId = await insertWakeOutbox(
      env,
      trigger.user_id,
      makeWakePayload({
        wakeKind: 'lifeline',
        taskType: 'lifeline_trigger',
        taskId: trigger.trigger_id,
        payload: {
          characterId: trigger.character_id,
          triggerId: trigger.trigger_id,
          chatId,
          intent: trigger.intent,
          scheduledAt: trigger.trigger_at,
        },
        scheduledAt: trigger.trigger_at,
      }),
      now
    )
    await env.DB.prepare(`
      UPDATE agent_lifeline_triggers
      SET status = 'due', last_dispatched_at = ?, updated_at = ?
      WHERE user_id = ? AND character_id = ? AND trigger_id = ?
    `).bind(now, now, trigger.user_id, trigger.character_id, trigger.trigger_id).run()
    console.log('lifeline trigger dispatched', { outboxId, triggerId: trigger.trigger_id })
  }

  const proactiveRows = await env.DB.prepare(`
    SELECT state.*, config.takeover_json, config.offline_ai_json, config.enabled
    FROM agent_wechat_proactive_state state
    JOIN agent_configs config ON config.user_id = state.user_id
    WHERE config.enabled = 1
      AND state.is_active = 1
      AND state.updated_at >= ?
    ORDER BY state.updated_at DESC
    LIMIT 250
  `).bind(now - 24 * 60 * 60 * 1000).all()

  const dispatchedWechatUsers = new Set()
  for (const state of proactiveRows.results || []) {
    if (await isUserClientActive(env, state.user_id, now)) continue
    const takeover = parseTakeover(state)
    const canWakeFrontend = takeover.proactiveWechat === true && Number(state.proactive_chat || 0) === 1
    const canGenerateOffline = takeover.proactiveWechat === true
      && Number(state.proactive_chat || 0) === 1
      && state.offline_prompt_packet_json
    if (!canWakeFrontend && !canGenerateOffline) continue
    if (dispatchedWechatUsers.has(state.user_id)) continue
    if (
      isWithinClientQuietHours(
        state.proactive_quiet_start,
        state.proactive_quiet_end,
        now,
        state.client_time_zone,
        state.client_utc_offset_minutes
      )
    ) continue

    const frequency = Math.max(0.01, Number(state.chat_frequency || 2))
    const minIntervalMs = Math.max(0, Number(state.proactive_min_interval_hours || 6)) * 60 * 60 * 1000
    const maxStreak = Math.max(1, Number(state.proactive_max_streak || 1))
    const thresholdMs = (24 * 60 * 60 * 1000) / frequency
    const lastMessageAt = Number(state.last_message_at || 0)
    const lastAiMessageAt = Number(state.last_ai_message_at || 0)
    const lastAiProactiveAt = Number(state.last_ai_proactive_message_at || 0)
    const lastDispatchedAt = Number(state.last_dispatched_at || 0)
    const timeSinceLastActivity = lastMessageAt > 0 ? now - lastMessageAt : Number.POSITIVE_INFINITY
    const timeSinceAiMessage = lastAiMessageAt > 0 ? now - lastAiMessageAt : Number.POSITIVE_INFINITY
    const timeSinceProactive = Math.min(
      lastAiProactiveAt > 0 ? now - lastAiProactiveAt : Number.POSITIVE_INFINITY,
      lastDispatchedAt > 0 ? now - lastDispatchedAt : Number.POSITIVE_INFINITY
    )
    const minAiGapMs = Math.min(15 * 60 * 1000, minIntervalMs)

    if (
      timeSinceLastActivity <= thresholdMs ||
      timeSinceAiMessage <= minAiGapMs ||
      timeSinceProactive <= minIntervalMs ||
      Number(state.today_proactive_count || 0) >= frequency ||
      Number(state.proactive_since_user_reply || 0) >= maxStreak
    ) {
      continue
    }

    let outboxId = ''
    let offlineGenerated = false
    const snapshotHash = normalizeString(state.recent_messages_hash || state.last_local_message_id, 180)
    const hasLocalSnapshotAnchor = Boolean(state.recent_messages_hash && state.last_local_message_id)
    const pendingOfflineMessages = snapshotHash
      ? await getPendingOfflineWechatOutbox(env, state, snapshotHash)
      : []
    const pendingOfflineCount = pendingOfflineMessages.length
    const lastPendingOfflineAt = pendingOfflineMessages.reduce((latest, item) => Math.max(latest, Number(item.createdAt || 0)), 0)
    const timeSincePendingOffline = lastPendingOfflineAt > 0 ? now - lastPendingOfflineAt : Number.POSITIVE_INFINITY
    if (
      canGenerateOffline &&
      hasLocalSnapshotAnchor &&
      snapshotHash &&
      pendingOfflineCount === 0 &&
      timeSincePendingOffline >= minIntervalMs
    ) {
      try {
        const credentials = await getOfflineAiCredentials(env, state, now)
        const promptPacket = safeJsonParse(state.offline_prompt_packet_json, null)
        if (credentials && promptPacket?.messages) {
          const nextOfflineSequence = pendingOfflineCount + 1
          const promptWithContinuation = withOfflineContinuationContext(promptPacket, pendingOfflineMessages, now)
          const aiResult = await callOfflineAi({ credentials, promptPacket: promptWithContinuation })
          const generatedText = aiResult?.text || ''
          const bubbles = splitGeneratedBubbles(generatedText)
          const text = bubbles.join('\n')
          if (text) {
            const offlineDedupeKey = makeOfflineWechatDedupeKeyForSequence(state, snapshotHash, nextOfflineSequence)
            const insertResult = await insertWechatMessageOutboxAndNotify(
              env,
              state.user_id,
              {
                profileId: state.profile_id,
                chatId: state.chat_id,
                characterId: state.character_id,
                senderId: state.character_id,
                senderName: state.character_name || state.chat_title || undefined,
                characterName: state.character_name || undefined,
                chatTitle: state.chat_title || undefined,
                avatarUrl: state.avatar_url || undefined,
                text,
                bubbles,
                timestamp: now,
                reason: 'offline_daily_share',
                aiTaskId: `offline_daily_${now}_${state.chat_id}`,
                dedupeKey: offlineDedupeKey,
                offlineSequence: nextOfflineSequence,
                previousServerMessageId: pendingOfflineMessages[pendingOfflineMessages.length - 1]?.id || undefined,
                previousServerMessageIds: pendingOfflineMessages.map(item => item.id).slice(-8),
                baseLastLocalMessageId: state.last_local_message_id || undefined,
                lastLocalMessageId: state.last_local_message_id || undefined,
                baseRecentMessagesHash: state.recent_messages_hash || undefined,
                recentMessagesHash: state.recent_messages_hash || undefined,
                apiLog: aiResult?.apiLog,
              },
              now
            )
            outboxId = insertResult.id
            offlineGenerated = insertResult.inserted
            if (insertResult.inserted) {
              await env.DB.prepare(`
                UPDATE agent_wechat_proactive_state
                SET last_offline_generated_hash = ?, last_offline_generated_at = ?
                WHERE user_id = ? AND profile_id = ? AND chat_id = ? AND character_id = ?
              `).bind(`${snapshotHash}:${nextOfflineSequence}`, now, state.user_id, state.profile_id, state.chat_id, state.character_id).run()
            }
          }
        }
      } catch (error) {
        console.warn('offline daily share generation failed', {
          userId: state.user_id,
          chatId: state.chat_id,
          message: error?.message || 'unknown error',
        })
      }
    }

    if (!outboxId) continue
    await env.DB.prepare(`
      UPDATE agent_wechat_proactive_state
      SET last_dispatched_at = ?, updated_at = updated_at
      WHERE user_id = ? AND profile_id = ? AND chat_id = ? AND character_id = ?
    `).bind(now, state.user_id, state.profile_id, state.chat_id, state.character_id).run()
    dispatchedWechatUsers.add(state.user_id)
    console.log('wechat proactive dispatched', { outboxId, chatId: state.chat_id, offlineGenerated })
  }
}

app.get('/agent/debug/run-scheduler', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return auth.error
  await ensureAgentSchema(c.env.DB)
  await runAgentScheduler(c.env)
  return c.json({ status: 'success', data: { ranAt: Date.now() } })
})

app.post('/agent/debug/run-scheduler', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return auth.error
  await ensureAgentSchema(c.env.DB)
  await runAgentScheduler(c.env)
  return c.json({ status: 'success', data: { ranAt: Date.now() } })
})

app.get('/agent/debug/proactive-diagnostics', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return auth.error
  await ensureAgentSchema(c.env.DB)
  const data = await getWechatProactiveDiagnostics(c.env, auth.user.id)
  return c.json({ status: 'success', data })
})

export default {
  fetch: app.fetch,
  scheduled: async (_event, env, ctx) => {
    ctx.waitUntil(runAgentScheduler(env))
  },
}
