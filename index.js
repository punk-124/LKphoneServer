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

const parseTakeover = (row) => safeJsonParse(row?.takeover_json, {})

const insertWakeOutbox = async (env, userId, payload, now) => {
  const outboxId = `agt_out_${now}_${crypto.randomUUID()}`
  await env.DB.prepare(`
    INSERT INTO agent_outbox (id, user_id, type, payload_json, status, created_at)
    VALUES (?, ?, 'wake_request', ?, 'pending', ?)
  `).bind(outboxId, userId, JSON.stringify(payload), now).run()
  return outboxId
}

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
    const takeover = parseTakeover(config)
    if (takeover.randomCheckin === false) continue
    const minIntervalMs = Math.max(60000, Number(config.min_interval_ms || 60000))
    const maxIntervalMs = Math.max(minIntervalMs, Number(config.max_interval_ms || 3600000))
    const nextCheckinAt = now + minIntervalMs + Math.floor(Math.random() * (maxIntervalMs - minIntervalMs + 1))
    await insertWakeOutbox(
      env,
      config.user_id,
      makeWakePayload({
        wakeKind: 'wechat',
        taskType: 'random_checkin',
        payload: { reason: 'random_checkin' },
        scheduledAt: config.next_checkin_at,
      }),
      now
    )
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
    SELECT state.*, config.takeover_json, config.enabled
    FROM agent_wechat_proactive_state state
    JOIN agent_configs config ON config.user_id = state.user_id
    WHERE config.enabled = 1
      AND state.proactive_chat = 1
      AND state.is_active = 1
      AND state.updated_at >= ?
    ORDER BY state.updated_at DESC
    LIMIT 250
  `).bind(now - 24 * 60 * 60 * 1000).all()

  const dispatchedWechatUsers = new Set()
  for (const state of proactiveRows.results || []) {
    const takeover = parseTakeover(state)
    if (takeover.proactiveWechat === false) continue
    if (dispatchedWechatUsers.has(state.user_id)) continue

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

    const outboxId = await insertWakeOutbox(
      env,
      state.user_id,
      makeWakePayload({
        wakeKind: 'wechat',
        taskType: 'proactive_wechat_message',
        payload: {
          profileId: state.profile_id,
          chatId: state.chat_id,
          characterId: state.character_id,
          reason: 'proactive_state_due',
        },
        scheduledAt: now,
      }),
      now
    )
    await env.DB.prepare(`
      UPDATE agent_wechat_proactive_state
      SET last_dispatched_at = ?, updated_at = updated_at
      WHERE user_id = ? AND profile_id = ? AND chat_id = ? AND character_id = ?
    `).bind(now, state.user_id, state.profile_id, state.chat_id, state.character_id).run()
    dispatchedWechatUsers.add(state.user_id)
    console.log('wechat proactive dispatched', { outboxId, chatId: state.chat_id })
  }
}

export default {
  fetch: app.fetch,
  scheduled: async (_event, env, ctx) => {
    ctx.waitUntil(runAgentScheduler(env))
  },
}
