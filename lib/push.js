const textEncoder = new TextEncoder()

let cachedAccessToken = ''
let cachedAccessTokenExpiresAt = 0

const normalizeString = (value, max = 500) => String(value || '').trim().slice(0, max)

const compactPushText = (value, max = 120) => {
  const text = normalizeString(value, max * 2).replace(/\s+/g, ' ')
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

const resolveOutboxPushTitle = (type, payload) => {
  if (type === 'proactive_wechat_message') {
    return compactPushText(
      payload.senderName ||
      payload.characterName ||
      payload.chatTitle ||
      payload.title ||
      '微信新消息',
      48
    )
  }
  return compactPushText(payload.title || payload.senderName || 'Lucky幸运机', 48)
}

const resolveOutboxPushBody = (type, payload) => {
  if (type === 'proactive_wechat_message') {
    const firstBubble = Array.isArray(payload.bubbles) ? payload.bubbles.find(Boolean) : ''
    return compactPushText(firstBubble || payload.text || payload.body || payload.content || '发来一条新消息', 120)
  }
  return compactPushText(payload.body || payload.text || payload.content || '', 120)
}

const base64UrlEncode = (value) => {
  const bytes = value instanceof Uint8Array
    ? value
    : textEncoder.encode(String(value || ''))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

const pemToArrayBuffer = (pem) => {
  const base64 = String(pem || '')
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes.buffer
}

const parseServiceAccount = (env) => {
  const raw = normalizeString(env.FIREBASE_SERVICE_ACCOUNT_JSON || env.GOOGLE_SERVICE_ACCOUNT_JSON, 20000)
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      return {
        projectId: normalizeString(parsed.project_id || env.FIREBASE_PROJECT_ID, 120),
        clientEmail: normalizeString(parsed.client_email, 260),
        privateKey: normalizeString(parsed.private_key, 4000),
      }
    } catch {
      // Fall through to individual variables.
    }
  }

  return {
    projectId: normalizeString(env.FIREBASE_PROJECT_ID, 120),
    clientEmail: normalizeString(env.FIREBASE_CLIENT_EMAIL || env.GOOGLE_CLIENT_EMAIL, 260),
    privateKey: normalizeString(env.FIREBASE_PRIVATE_KEY || env.GOOGLE_PRIVATE_KEY, 4000),
  }
}

export const hasFirebaseConfig = (env) => {
  const account = parseServiceAccount(env)
  return Boolean(account.projectId && account.clientEmail && account.privateKey)
}

const createFirebaseJwt = async (account, nowSeconds) => {
  const header = { alg: 'RS256', typ: 'JWT' }
  const claim = {
    iss: account.clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  }
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claim))}`
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(account.privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    textEncoder.encode(signingInput)
  )
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`
}

const getFirebaseAccessToken = async (env) => {
  const now = Date.now()
  if (cachedAccessToken && cachedAccessTokenExpiresAt - now > 60_000) {
    return cachedAccessToken
  }

  const account = parseServiceAccount(env)
  if (!account.projectId || !account.clientEmail || !account.privateKey) {
    throw new Error('Firebase service account is not configured')
  }

  const assertion = await createFirebaseJwt(account, Math.floor(now / 1000))
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || !payload?.access_token) {
    throw new Error(payload?.error_description || payload?.error || `Firebase OAuth failed: ${response.status}`)
  }

  cachedAccessToken = String(payload.access_token)
  cachedAccessTokenExpiresAt = now + Math.max(60, Number(payload.expires_in || 3600) - 60) * 1000
  return cachedAccessToken
}

export const upsertPushDevice = async (db, userId, device) => {
  const token = normalizeString(device?.token, 1000)
  if (!token) throw new Error('Missing push token')
  const ts = Number(device?.updatedAt || Date.now())
  await db.prepare(`
    INSERT INTO agent_push_devices (
      user_id, token, platform, client_id, label, enabled, created_at, updated_at, last_seen_at
    )
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(user_id, token) DO UPDATE SET
      platform = excluded.platform,
      client_id = excluded.client_id,
      label = excluded.label,
      enabled = 1,
      updated_at = excluded.updated_at,
      last_seen_at = excluded.last_seen_at
  `).bind(
    userId,
    token,
    normalizeString(device?.platform, 40) || 'android',
    normalizeString(device?.clientId, 160) || null,
    normalizeString(device?.label, 160) || null,
    ts,
    ts,
    ts
  ).run()
}

export const disablePushDevice = async (db, userId, token) => {
  const cleaned = normalizeString(token, 1000)
  if (!cleaned) return
  await db.prepare(`
    UPDATE agent_push_devices
    SET enabled = 0, updated_at = ?
    WHERE user_id = ? AND token = ?
  `).bind(Date.now(), userId, cleaned).run()
}

const getEnabledTokens = async (db, userId) => {
  const rows = await db.prepare(`
    SELECT token
    FROM agent_push_devices
    WHERE user_id = ? AND enabled = 1
    ORDER BY last_seen_at DESC, updated_at DESC
    LIMIT 10
  `).bind(userId).all()
  return (rows.results || [])
    .map(row => normalizeString(row.token, 1000))
    .filter(Boolean)
}

const toFcmData = (data) => {
  const result = {}
  for (const [key, value] of Object.entries(data || {})) {
    if (value === undefined || value === null) continue
    result[key] = String(value)
  }
  return result
}

const recordPushResult = async (db, userId, token, error = '') => {
  await db.prepare(`
    UPDATE agent_push_devices
    SET last_push_at = ?, last_push_error = ?, updated_at = ?
    WHERE user_id = ? AND token = ?
  `).bind(Date.now(), error || null, Date.now(), userId, token).run()
}

export const sendPushToUser = async (env, userId, message) => {
  if (!hasFirebaseConfig(env)) return { sent: 0, skipped: 'firebase_not_configured' }
  const tokens = await getEnabledTokens(env.DB, userId)
  if (tokens.length === 0) return { sent: 0, skipped: 'no_tokens' }

  const account = parseServiceAccount(env)
  const accessToken = await getFirebaseAccessToken(env)
  let sent = 0
  const failures = []
  const data = message?.data && typeof message.data === 'object' ? message.data : {}
  const title = normalizeString(message?.notification?.title || data.title || 'Lucky幸运机', 120)
  const body = normalizeString(message?.notification?.body || data.body || '有新的消息', 500)
  const channelId = normalizeString(message?.android?.channelId || data.channelId || env.FCM_ANDROID_CHANNEL_ID, 120)

  for (const token of tokens) {
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.projectId)}/messages:send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        message: {
          token,
          data: toFcmData({
            ...data,
            title,
            body,
            channelId,
          }),
          android: {
            priority: 'HIGH',
          },
        },
      }),
    })
    const payload = await response.json().catch(() => null)
    if (response.ok) {
      sent += 1
      await recordPushResult(env.DB, userId, token)
      continue
    }
    failures.push({ token, status: response.status, payload })
    await recordPushResult(env.DB, userId, token, payload?.error?.message || payload?.error?.status || `FCM ${response.status}`)
    const statusText = String(payload?.error?.status || payload?.error || '').toUpperCase()
    if (response.status === 404 || response.status === 400 || statusText.includes('UNREGISTERED') || statusText.includes('INVALID_ARGUMENT')) {
      await disablePushDevice(env.DB, userId, token)
    }
  }

  return { sent, failed: failures.length, failures: failures.slice(0, 3) }
}

export const notifyOutboxAvailable = async (env, userId, item = {}) => {
  try {
    const type = normalizeString(item.type || 'outbox', 80)
    const payload = item.payload && typeof item.payload === 'object' ? item.payload : {}
    const title = resolveOutboxPushTitle(type, payload)
    const body = resolveOutboxPushBody(type, payload)
    if (!body) {
      return { sent: 0, skipped: 'empty_push_body', outboxType: type }
    }
    return await sendPushToUser(env, userId, {
      data: {
        title,
        body,
        outbox: '1',
        outboxId: item.id || '',
        outboxType: type,
        chatId: payload.chatId || payload.targetId || payload.characterId || '',
        profileId: payload.profileId || payload.wechatProfileId || '',
        createdAt: item.createdAt || Date.now(),
      },
    })
  } catch (error) {
    console.warn('FCM push failed', {
      userId,
      outboxId: item.id,
      message: error?.message || 'unknown error',
    })
    return { sent: 0, error: error?.message || 'unknown error' }
  }
}
