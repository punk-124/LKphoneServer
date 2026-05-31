import { Hono } from 'hono'
import { requireAuth } from '../lib/auth'
import { ensureGroupSchema, ensureUserExists } from '../lib/db'
import { jsonError } from '../lib/http'

const app = new Hono()

const nowMs = () => Date.now()

const normalizeString = (value, maxLength = 500) =>
  String(value ?? '').trim().slice(0, maxLength)

const normalizeLimit = (value, fallback = 50, max = 200) => {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, max)
}

const parseJson = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback
  } catch {
    return fallback
  }
}

const insertOrUpdateGroupMember = async (db, {
  groupId,
  userId,
  memberType,
  memberId,
  ownerUserId,
  displayName,
  avatar = '',
  characterId = '',
  aiSnapshotJson = '',
  updatedAt,
}) => {
  const existing = await db.prepare(`
    SELECT id
    FROM group_members
    WHERE group_id = ? AND member_type = ? AND member_id = ?
    ORDER BY id ASC
    LIMIT 1
  `).bind(groupId, memberType, memberId).first()

  if (existing) {
    await db.prepare(`
      UPDATE group_members
      SET user_id = ?,
          owner_user_id = ?,
          display_name = ?,
          avatar = ?,
          character_id = COALESCE(NULLIF(?, ''), character_id),
          ai_snapshot_json = COALESCE(NULLIF(?, ''), ai_snapshot_json),
          updated_at = ?
      WHERE id = ?
    `).bind(
      userId,
      ownerUserId,
      displayName,
      avatar,
      characterId,
      aiSnapshotJson,
      updatedAt,
      existing.id,
    ).run()
    return { existed: true, id: existing.id }
  }

  const result = await db.prepare(`
    INSERT INTO group_members (
      group_id, user_id, member_type, member_id, owner_user_id,
      display_name, avatar, character_id, ai_snapshot_json, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    groupId,
    userId,
    memberType,
    memberId,
    ownerUserId,
    displayName,
    avatar,
    characterId,
    aiSnapshotJson,
    updatedAt,
  ).run()
  return { existed: false, id: result.meta?.last_row_id || result.lastInsertRowid }
}

const requireGroupAuth = async (c) => {
  await ensureGroupSchema(c.env.DB)
  const auth = await requireAuth(c)
  if (auth.error) return auth
  await ensureUserExists(c.env.DB, auth.user.id, auth.user.username || auth.user.id)
  return auth
}

const isUserGroupMember = async (db, groupId, userId) => {
  const row = await db.prepare(`
    SELECT 1
    FROM group_members
    WHERE group_id = ?
      AND member_type = 'user'
      AND member_id = ?
    LIMIT 1
  `).bind(groupId, userId).first()
  return Boolean(row)
}

const getGroupForMember = async (db, groupId, userId) => {
  const group = await db.prepare(`
    SELECT g.*
    FROM groups g
    JOIN group_members gm ON gm.group_id = g.id
    WHERE g.id = ?
      AND gm.member_type = 'user'
      AND gm.member_id = ?
    LIMIT 1
  `).bind(groupId, userId).first()
  return group || null
}

const readMembers = async (db, groupId) => {
  const result = await db.prepare(`
    SELECT
      gm.id,
      gm.group_id,
      gm.member_type,
      COALESCE(gm.member_id, gm.user_id) AS member_id,
      gm.user_id,
      gm.owner_user_id,
      gm.display_name,
      gm.avatar,
      gm.character_id,
      gm.ai_snapshot_json,
      gm.created_at,
      gm.updated_at,
      u.username
    FROM group_members gm
    LEFT JOIN users u ON u.user_id = COALESCE(gm.user_id, gm.member_id)
    WHERE gm.group_id = ?
    ORDER BY gm.id ASC
  `).bind(groupId).all()

  return (result.results || []).map((member) => ({
    id: member.id,
    group_id: member.group_id,
    member_type: member.member_type || 'user',
    member_id: member.member_id,
    user_id: member.user_id || (member.member_type === 'user' ? member.member_id : undefined),
    owner_user_id: member.owner_user_id,
    username: member.username || undefined,
    display_name: member.member_type === 'user'
      ? (member.display_name || member.username || member.member_id)
      : (member.display_name || member.member_id),
    avatar: member.avatar || '',
    character_id: member.character_id || undefined,
    ai_snapshot: parseJson(member.ai_snapshot_json, null),
    created_at: member.created_at,
    updated_at: member.updated_at,
  }))
}

const readMessageById = async (db, messageId) => {
  const row = await db.prepare(`
    SELECT
      m.*,
      actor.username AS actor_username,
      user_sender.username AS user_sender_username,
      ai_member.display_name AS ai_display_name,
      ai_member.avatar AS ai_avatar,
      ai_member.owner_user_id AS ai_owner_user_id,
      ai_member.character_id AS ai_character_id
    FROM messages m
    LEFT JOIN users actor ON actor.user_id = m.actor_user_id
    LEFT JOIN users user_sender ON user_sender.user_id = m.sender_id
    LEFT JOIN group_members ai_member
      ON ai_member.group_id = m.group_id
      AND ai_member.member_type = 'ai'
      AND ai_member.member_id = m.sender_id
    WHERE m.id = ?
  `).bind(messageId).first()
  return row ? formatMessage(row) : null
}

const formatMessage = (row) => ({
  id: row.id,
  group_id: row.group_id,
  sender_type: row.sender_type || 'user',
  sender_id: row.sender_id || row.user_id,
  actor_user_id: row.actor_user_id || row.user_id,
  actor_username: row.actor_username || row.actor_user_id || row.user_id,
  sender_name: row.sender_name || row.ai_display_name || row.user_sender_username || row.sender_id || row.user_id,
  sender_avatar: row.ai_avatar || '',
  ai_owner_user_id: row.ai_owner_user_id || undefined,
  ai_character_id: row.ai_character_id || undefined,
  content: row.content,
  message_type: row.message_type || 'text',
  client_message_id: row.client_message_id || undefined,
  metadata: parseJson(row.metadata_json, null),
  created_at: row.created_at,
  created_at_ms: Number(row.created_at_ms || 0),
})

const formatGroup = async (db, group) => ({
  id: group.id,
  name: group.name,
  creator_user_id: group.creator_user_id || undefined,
  owner_user_id: group.owner_user_id || group.creator_user_id || undefined,
  created_at: group.created_at,
  updated_at: group.updated_at || undefined,
  members: await readMembers(db, group.id),
})

const isGroupOwner = (group, userId) =>
  String(group?.owner_user_id || group?.creator_user_id || '') === String(userId || '')

const getGroupRoomStub = (env, groupId) => {
  if (!env.GROUP_ROOM) return null
  return env.GROUP_ROOM.get(env.GROUP_ROOM.idFromName(String(groupId)))
}

const broadcastToGroup = async (env, groupId, payload) => {
  const stub = getGroupRoomStub(env, groupId)
  if (!stub) return
  await stub.fetch('https://group-room.local/broadcast', {
    method: 'POST',
    body: JSON.stringify({
      ...payload,
      group_id: Number(groupId),
      ts: nowMs(),
    }),
  })
}

const getUserDisplayName = async (db, userId) => {
  const row = await db.prepare('SELECT username FROM users WHERE user_id = ? LIMIT 1').bind(userId).first()
  return row?.username || userId
}

const readUserMemberProfiles = (body) => {
  const source = Array.isArray(body.user_member_profiles)
    ? body.user_member_profiles
    : Array.isArray(body.userMemberProfiles)
      ? body.userMemberProfiles
      : []
  const profiles = new Map()
  for (const item of source) {
    const userId = normalizeString(item?.user_id || item?.userId || item?.id, 160)
    if (!userId) continue
    const displayName = normalizeString(
      item?.display_name || item?.displayName || item?.username || item?.name || userId,
      120
    )
    profiles.set(userId, {
      userId,
      displayName: displayName || userId,
      avatar: normalizeString(item?.avatar || item?.avatar_url || item?.avatarUrl, 5000),
    })
  }
  return profiles
}

const insertGroupNotification = async (db, { groupId, actorUserId, actorName, content, metadata = null, ts = nowMs() }) => {
  const result = await db.prepare(`
    INSERT INTO messages (
      group_id, user_id, content, sender_type, sender_id, actor_user_id,
      sender_name, message_type, client_message_id, metadata_json, created_at_ms
    )
    VALUES (?, ?, ?, 'system', 'system', ?, ?, 'notification', NULL, ?, ?)
  `).bind(
    groupId,
    actorUserId,
    content,
    actorUserId,
    actorName || '系统消息',
    metadata ? JSON.stringify(metadata) : null,
    ts
  ).run()
  const messageId = result.meta?.last_row_id || result.lastInsertRowid
  return readMessageById(db, messageId)
}


app.get('/users/search', async (c) => {
  const auth = await requireGroupAuth(c)
  if (auth.error) return auth.error

  const q = normalizeString(c.req.query('q'), 80)
  if (!q) return c.json({ status: 'success', data: [] })

  const result = await c.env.DB.prepare(`
    SELECT user_id, username, created_at
    FROM users
    WHERE username LIKE ? OR user_id LIKE ?
    ORDER BY
      CASE WHEN username = ? OR user_id = ? THEN 0 ELSE 1 END,
      username ASC
    LIMIT 20
  `).bind(`%${q}%`, `%${q}%`, q, q).all()

  return c.json({
    status: 'success',
    data: (result.results || [])
      .filter((user) => user.user_id !== auth.user.id)
      .map((user) => ({
        user_id: user.user_id,
        username: user.username,
        created_at: user.created_at,
      })),
  })
})

app.get('/', async (c) => {
  const auth = await requireGroupAuth(c)
  if (auth.error) return auth.error

  const result = await c.env.DB.prepare(`
    SELECT g.*
    FROM groups g
    JOIN group_members gm ON gm.group_id = g.id
    WHERE gm.member_type = 'user'
      AND gm.member_id = ?
    ORDER BY COALESCE(g.updated_at, unixepoch(g.created_at) * 1000) DESC
    LIMIT 100
  `).bind(auth.user.id).all()

  const groups = []
  const errors = []
  for (const group of result.results || []) {
    try {
      groups.push(await formatGroup(c.env.DB, group))
    } catch (error) {
      console.error('format group failed', { groupId: group?.id, error })
      errors.push({
        group_id: group?.id,
        message: error?.message || 'Failed to read group',
      })
    }
  }
  return c.json({ status: 'success', data: groups, warnings: errors })
})

app.post('/', async (c) => {
  const auth = await requireGroupAuth(c)
  if (auth.error) return auth.error

  const body = await c.req.json().catch(() => ({}))
  const name = normalizeString(body.name, 120)
  if (!name) return jsonError(c, 'Missing group name')

  const userMemberIds = Array.isArray(body.user_member_ids)
    ? body.user_member_ids.map((id) => normalizeString(id, 160)).filter(Boolean)
    : []
  const userMemberProfiles = readUserMemberProfiles(body)

  const ts = nowMs()
  const result = await c.env.DB.prepare(`
    INSERT INTO groups (name, creator_user_id, owner_user_id, updated_at)
    VALUES (?, ?, ?, ?)
  `).bind(name, auth.user.id, auth.user.id, ts).run()
  const groupId = result.meta?.last_row_id || result.lastInsertRowid

  const uniqueUserIds = Array.from(new Set([auth.user.id, ...userMemberIds]))
  for (const userId of uniqueUserIds) {
    const profile = userMemberProfiles.get(userId)
    const userName = userId === auth.user.id
      ? (profile?.displayName || auth.user.username || auth.user.id)
      : (profile?.displayName || await getUserDisplayName(c.env.DB, userId))
    const userAvatar = profile?.avatar || ''
    await ensureUserExists(c.env.DB, userId, userName)
    await insertOrUpdateGroupMember(c.env.DB, {
      groupId,
      userId,
      memberType: 'user',
      memberId: userId,
      ownerUserId: userId,
      displayName: userName,
      avatar: userAvatar,
      updatedAt: ts,
    })
  }

  const group = await c.env.DB.prepare('SELECT * FROM groups WHERE id = ?').bind(groupId).first()
  return c.json({ status: 'success', data: await formatGroup(c.env.DB, group) })
})

app.get('/:id/members', async (c) => {
  const auth = await requireGroupAuth(c)
  if (auth.error) return auth.error

  const groupId = c.req.param('id')
  const group = await getGroupForMember(c.env.DB, groupId, auth.user.id)
  if (!group) return jsonError(c, 'Group not found or access denied', 404)

  return c.json({ status: 'success', data: await readMembers(c.env.DB, groupId) })
})

app.get('/:id/ws', async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return jsonError(c, 'Expected WebSocket upgrade', 426)
  }

  const auth = await requireGroupAuth(c)
  if (auth.error) return auth.error

  const groupId = c.req.param('id')
  const group = await getGroupForMember(c.env.DB, groupId, auth.user.id)
  if (!group) return jsonError(c, 'Group not found or access denied', 404)

  const stub = getGroupRoomStub(c.env, groupId)
  if (!stub) return jsonError(c, 'GROUP_ROOM Durable Object binding is not configured', 500)

  const url = new URL(c.req.url)
  url.pathname = '/connect'
  url.searchParams.set('user_id', auth.user.id)
  url.searchParams.set('group_id', String(groupId))
  return stub.fetch(new Request(url.toString(), c.req.raw))
})

app.post('/:id/members', async (c) => {
  const auth = await requireGroupAuth(c)
  if (auth.error) return auth.error

  const groupId = c.req.param('id')
  const group = await getGroupForMember(c.env.DB, groupId, auth.user.id)
  if (!group) return jsonError(c, 'Group not found or access denied', 404)

  const body = await c.req.json().catch(() => ({}))
  const userId = normalizeString(body.user_id || body.userId, 160)
  if (!userId) return jsonError(c, 'Missing user_id')

  const userMemberProfiles = readUserMemberProfiles(body)
  const profile = userMemberProfiles.get(userId)
  const directName = normalizeString(body.display_name || body.displayName || body.username || body.name, 120)
  const invitedName = profile?.displayName || directName || await getUserDisplayName(c.env.DB, userId)
  const invitedAvatar = profile?.avatar || normalizeString(body.avatar || body.avatar_url || body.avatarUrl, 5000)
  await ensureUserExists(c.env.DB, userId, invitedName)
  const ts = nowMs()
  const existed = await c.env.DB.prepare(`
    SELECT 1
    FROM group_members
    WHERE group_id = ? AND member_type = 'user' AND member_id = ?
    LIMIT 1
  `).bind(groupId, userId).first()
  await insertOrUpdateGroupMember(c.env.DB, {
    groupId,
    userId,
    memberType: 'user',
    memberId: userId,
    ownerUserId: userId,
    displayName: invitedName,
    avatar: invitedAvatar,
    updatedAt: ts,
  })
  let members = await readMembers(c.env.DB, groupId)
  let notification = null
  if (!existed) {
    const actorName = auth.user.username || auth.user.id
    notification = await insertGroupNotification(c.env.DB, {
      groupId,
      actorUserId: auth.user.id,
      actorName,
      content: `${actorName} 邀请 ${invitedName} 加入了群聊`,
      metadata: { event: 'member_added', member_type: 'user', member_id: userId },
      ts,
    })
    await broadcastToGroup(c.env, groupId, {
      type: 'group_members_changed',
      event: 'member_added',
      message: notification,
      members,
    })
  }
  await c.env.DB.prepare('UPDATE groups SET updated_at = ? WHERE id = ?').bind(ts, groupId).run()

  return c.json({
    status: 'success',
    data: {
      members,
      message: notification,
    },
  })
})

app.patch('/:id/members/me', async (c) => {
  const auth = await requireGroupAuth(c)
  if (auth.error) return auth.error

  const groupId = c.req.param('id')
  const group = await getGroupForMember(c.env.DB, groupId, auth.user.id)
  if (!group) return jsonError(c, 'Group not found or access denied', 404)

  const body = await c.req.json().catch(() => ({}))
  const displayName = normalizeString(body.display_name || body.displayName || body.username || body.name, 120)
  const avatar = normalizeString(body.avatar || body.avatar_url || body.avatarUrl, 5000)
  if (!displayName && !avatar) return c.json({ status: 'success', data: await readMembers(c.env.DB, groupId) })

  await ensureUserExists(c.env.DB, auth.user.id, displayName || auth.user.username || auth.user.id)
  const ts = nowMs()
  await c.env.DB.prepare(`
    UPDATE group_members
    SET
      display_name = COALESCE(NULLIF(?, ''), display_name),
      avatar = COALESCE(NULLIF(?, ''), avatar),
      updated_at = ?
    WHERE group_id = ?
      AND member_type = 'user'
      AND member_id = ?
  `).bind(displayName, avatar, ts, groupId, auth.user.id).run()
  await c.env.DB.prepare('UPDATE groups SET updated_at = ? WHERE id = ?').bind(ts, groupId).run()

  return c.json({ status: 'success', data: await readMembers(c.env.DB, groupId) })
})

app.delete('/:id/members/:memberType/:memberId', async (c) => {
  const auth = await requireGroupAuth(c)
  if (auth.error) return auth.error

  const groupId = c.req.param('id')
  const group = await getGroupForMember(c.env.DB, groupId, auth.user.id)
  if (!group) return jsonError(c, 'Group not found or access denied', 404)
  if (!isGroupOwner(group, auth.user.id)) return jsonError(c, 'Only group owner can remove members', 403)

  const memberType = normalizeString(c.req.param('memberType'), 20)
  const memberId = normalizeString(c.req.param('memberId'), 220)
  if (!['user', 'ai'].includes(memberType) || !memberId) return jsonError(c, 'Invalid member')
  if (memberType === 'user' && memberId === auth.user.id) {
    return jsonError(c, 'Group owner cannot remove self; transfer ownership or dissolve group')
  }

  const target = await c.env.DB.prepare(`
    SELECT gm.*, u.username
    FROM group_members gm
    LEFT JOIN users u ON u.user_id = COALESCE(gm.user_id, gm.member_id)
    WHERE gm.group_id = ? AND gm.member_type = ? AND gm.member_id = ?
    LIMIT 1
  `).bind(groupId, memberType, memberId).first()
  if (!target) return jsonError(c, 'Member not found', 404)

  if (memberType === 'user') {
    await c.env.DB.prepare(`
      DELETE FROM group_members
      WHERE group_id = ?
        AND (
          (member_type = 'user' AND member_id = ?)
          OR (member_type = 'ai' AND owner_user_id = ?)
        )
    `).bind(groupId, memberId, memberId).run()
  } else {
    await c.env.DB.prepare(`
      DELETE FROM group_members
      WHERE group_id = ? AND member_type = 'ai' AND member_id = ?
    `).bind(groupId, memberId).run()
  }

  const ts = nowMs()
  const actorName = auth.user.username || auth.user.id
  const targetName = target.display_name || target.username || memberId
  const notification = await insertGroupNotification(c.env.DB, {
    groupId,
    actorUserId: auth.user.id,
    actorName,
    content: `${actorName} 将 ${targetName} 移出了群聊`,
    metadata: { event: 'member_removed', member_type: memberType, member_id: memberId },
    ts,
  })
  const members = await readMembers(c.env.DB, groupId)
  await broadcastToGroup(c.env, groupId, {
    type: 'group_members_changed',
    event: 'member_removed',
    message: notification,
    members,
  })
  await c.env.DB.prepare('UPDATE groups SET updated_at = ? WHERE id = ?').bind(ts, groupId).run()
  return c.json({ status: 'success', data: members })
})

app.post('/:id/leave', async (c) => {
  const auth = await requireGroupAuth(c)
  if (auth.error) return auth.error

  const groupId = c.req.param('id')
  const group = await getGroupForMember(c.env.DB, groupId, auth.user.id)
  if (!group) return jsonError(c, 'Group not found or access denied', 404)
  if (isGroupOwner(group, auth.user.id)) {
    return jsonError(c, 'Group owner cannot leave; dissolve group first', 403)
  }

  await c.env.DB.prepare(`
    DELETE FROM group_members
    WHERE group_id = ?
      AND (
        (member_type = 'user' AND member_id = ?)
        OR (member_type = 'ai' AND owner_user_id = ?)
      )
  `).bind(groupId, auth.user.id, auth.user.id).run()
  const ts = nowMs()
  const actorName = auth.user.username || auth.user.id
  const notification = await insertGroupNotification(c.env.DB, {
    groupId,
    actorUserId: auth.user.id,
    actorName,
    content: `${actorName} 退出了群聊`,
    metadata: { event: 'member_left', member_type: 'user', member_id: auth.user.id },
    ts,
  })
  const members = await readMembers(c.env.DB, groupId)
  await broadcastToGroup(c.env, groupId, {
    type: 'group_members_changed',
    event: 'member_left',
    message: notification,
    members,
  })
  await c.env.DB.prepare('UPDATE groups SET updated_at = ? WHERE id = ?').bind(ts, groupId).run()
  return c.json({ status: 'success' })
})

app.delete('/:id', async (c) => {
  const auth = await requireGroupAuth(c)
  if (auth.error) return auth.error

  const groupId = c.req.param('id')
  const group = await getGroupForMember(c.env.DB, groupId, auth.user.id)
  if (!group) return jsonError(c, 'Group not found or access denied', 404)
  if (!isGroupOwner(group, auth.user.id)) return jsonError(c, 'Only group owner can dissolve group', 403)

  await c.env.DB.prepare('DELETE FROM messages WHERE group_id = ?').bind(groupId).run()
  await c.env.DB.prepare('DELETE FROM group_members WHERE group_id = ?').bind(groupId).run()
  await c.env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(groupId).run()
  return c.json({ status: 'success' })
})

app.post('/:id/ai-members', async (c) => {
  try {
    const auth = await requireGroupAuth(c)
    if (auth.error) return auth.error

    const groupId = c.req.param('id')
    const group = await getGroupForMember(c.env.DB, groupId, auth.user.id)
    if (!group) return jsonError(c, 'Group not found or access denied', 404)

    const body = await c.req.json().catch(() => ({}))
    const characterId = normalizeString(body.character_id || body.characterId, 180)
    const displayName = normalizeString(body.display_name || body.displayName || body.name, 120)
    const avatar = normalizeString(body.avatar, 5000)
    if (!characterId || !displayName) return jsonError(c, 'Missing character_id or display_name')

    const aiMemberId = normalizeString(
      body.member_id || body.memberId || `ai_${auth.user.id}_${characterId}`,
      220
    )
    const snapshot = body.snapshot && typeof body.snapshot === 'object' ? body.snapshot : {}
    const snapshotJson = JSON.stringify(snapshot)
    const ts = nowMs()
    const existed = await c.env.DB.prepare(`
      SELECT 1
      FROM group_members
      WHERE group_id = ? AND member_type = 'ai' AND member_id = ?
      LIMIT 1
    `).bind(groupId, aiMemberId).first()

    await insertOrUpdateGroupMember(c.env.DB, {
      groupId,
      userId: auth.user.id,
      memberType: 'ai',
      memberId: aiMemberId,
      ownerUserId: auth.user.id,
      displayName,
      avatar,
      characterId,
      aiSnapshotJson: snapshotJson,
      updatedAt: ts,
    })

    await c.env.DB.prepare('UPDATE groups SET updated_at = ? WHERE id = ?').bind(ts, groupId).run()
    const members = await readMembers(c.env.DB, groupId)
    if (!existed) {
      const actorName = auth.user.username || auth.user.id
      const notification = await insertGroupNotification(c.env.DB, {
        groupId,
        actorUserId: auth.user.id,
        actorName,
        content: `${actorName} 添加了角色 ${displayName}`,
        metadata: { event: 'ai_member_added', member_type: 'ai', member_id: aiMemberId, character_id: characterId },
        ts,
      })
      try {
        await broadcastToGroup(c.env, groupId, {
          type: 'group_members_changed',
          event: 'ai_member_added',
          message: notification,
          members,
        })
      } catch (error) {
        console.warn('group ai member broadcast failed', error)
      }
    }

    return c.json({ status: 'success', data: members })
  } catch (error) {
    console.error('add group ai member failed', error)
    return jsonError(c, error?.message || 'Failed to add AI member', 500)
  }
})

app.post('/:id/messages', async (c) => {
  try {
    const auth = await requireGroupAuth(c)
    if (auth.error) return auth.error

    const groupId = c.req.param('id')
    const group = await getGroupForMember(c.env.DB, groupId, auth.user.id)
    if (!group) return jsonError(c, 'Group not found or access denied', 404)

    const body = await c.req.json().catch(() => ({}))
    const content = normalizeString(body.content ?? body.text, 20000)
    if (!content) return jsonError(c, 'Missing message content')

    const senderType = normalizeString(body.sender_type || body.senderType || 'user', 20)
    const messageType = normalizeString(body.message_type || body.messageType || 'text', 40) || 'text'
    const clientMessageId = normalizeString(body.client_message_id || body.clientMessageId, 160) || null
    const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : null
    const metadataJson = metadata ? JSON.stringify(metadata) : null
    const ts = nowMs()

    let senderId = auth.user.id
    let senderName = auth.user.username || auth.user.id

    if (senderType === 'ai') {
      senderId = normalizeString(body.sender_id || body.senderId, 220)
      if (!senderId) return jsonError(c, 'Missing AI sender_id')

      const aiMember = await c.env.DB.prepare(`
        SELECT *
        FROM group_members
        WHERE group_id = ?
          AND member_type = 'ai'
          AND member_id = ?
        LIMIT 1
      `).bind(groupId, senderId).first()

      if (!aiMember) return jsonError(c, 'AI member is not in this group', 403)
      if (aiMember.owner_user_id !== auth.user.id) {
        return jsonError(c, 'Cannot send as another user owned AI member', 403)
      }
      senderName = normalizeString(body.sender_name || body.senderName || aiMember.display_name, 120)
    } else if (senderType !== 'user') {
      return jsonError(c, 'Unsupported sender_type')
    }

    if (senderType === 'user') {
      const ok = await isUserGroupMember(c.env.DB, groupId, auth.user.id)
      if (!ok) return jsonError(c, 'User is not in this group', 403)
    }

    if (clientMessageId) {
      const existing = await c.env.DB.prepare(`
        SELECT id
        FROM messages
        WHERE group_id = ?
          AND actor_user_id = ?
          AND client_message_id = ?
        LIMIT 1
      `).bind(groupId, auth.user.id, clientMessageId).first()
      if (existing) {
        await c.env.DB.prepare(`
          UPDATE messages
          SET content = ?,
              sender_type = ?,
              sender_id = ?,
              sender_name = ?,
              message_type = ?,
              metadata_json = COALESCE(?, metadata_json),
              created_at_ms = COALESCE(created_at_ms, ?)
          WHERE id = ?
        `).bind(
          content,
          senderType,
          senderId,
          senderName,
          messageType,
          metadataJson,
          ts,
          existing.id
        ).run()
        return c.json({ status: 'success', data: await readMessageById(c.env.DB, existing.id), deduped: true })
      }
    }

    let result
    try {
      result = await c.env.DB.prepare(`
        INSERT INTO messages (
          group_id, user_id, content, sender_type, sender_id, actor_user_id,
          sender_name, message_type, client_message_id, metadata_json, created_at_ms
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        groupId,
        auth.user.id,
        content,
        senderType,
        senderId,
        auth.user.id,
        senderName,
        messageType,
        clientMessageId,
        metadataJson,
        ts
      ).run()
    } catch (error) {
      const message = String(error?.message || error || '')
      const isClientMessageDuplicate = clientMessageId
        && /UNIQUE constraint failed/i.test(message)
        && message.includes('messages.group_id')
        && message.includes('messages.actor_user_id')
        && message.includes('messages.client_message_id')
      if (isClientMessageDuplicate) {
        const existing = await c.env.DB.prepare(`
          SELECT id
          FROM messages
          WHERE group_id = ?
            AND actor_user_id = ?
            AND client_message_id = ?
          LIMIT 1
        `).bind(groupId, auth.user.id, clientMessageId).first()
        if (existing) {
          await c.env.DB.prepare(`
            UPDATE messages
            SET content = ?,
                sender_type = ?,
                sender_id = ?,
                sender_name = ?,
                message_type = ?,
                metadata_json = COALESCE(?, metadata_json),
                created_at_ms = COALESCE(created_at_ms, ?)
            WHERE id = ?
          `).bind(
            content,
            senderType,
            senderId,
            senderName,
            messageType,
            metadataJson,
            ts,
            existing.id
          ).run()
          return c.json({ status: 'success', data: await readMessageById(c.env.DB, existing.id), deduped: true })
        }
      }
      throw error
    }

    const messageId = result.meta?.last_row_id || result.lastInsertRowid
    await c.env.DB.prepare('UPDATE groups SET updated_at = ? WHERE id = ?').bind(ts, groupId).run()
    const message = await readMessageById(c.env.DB, messageId)
    try {
      await broadcastToGroup(c.env, groupId, {
        type: 'group_message',
        message,
      })
    } catch (error) {
      console.warn('group message broadcast failed', error)
    }
    return c.json({ status: 'success', data: message })
  } catch (error) {
    console.error('send group message failed', error)
    return jsonError(c, error?.message || 'Failed to send group message', 500)
  }
})

app.get('/:id/messages', async (c) => {
  const auth = await requireGroupAuth(c)
  if (auth.error) return auth.error

  const groupId = c.req.param('id')
  const group = await getGroupForMember(c.env.DB, groupId, auth.user.id)
  if (!group) return jsonError(c, 'Group not found or access denied', 404)

  const limit = normalizeLimit(c.req.query('limit'), 50, 200)
  const afterId = Math.max(0, Math.floor(Number(c.req.query('after_id') || c.req.query('afterId') || 0)))
  const beforeId = Math.max(0, Math.floor(Number(c.req.query('before_id') || c.req.query('beforeId') || 0)))

  const params = [groupId]
  let where = 'm.group_id = ?'
  let order = 'm.id DESC'
  if (afterId > 0) {
    where += ' AND m.id > ?'
    params.push(afterId)
    order = 'm.id ASC'
  } else if (beforeId > 0) {
    where += ' AND m.id < ?'
    params.push(beforeId)
    order = 'm.id DESC'
  }
  params.push(limit)

  const result = await c.env.DB.prepare(`
    SELECT
      m.*,
      actor.username AS actor_username,
      user_sender.username AS user_sender_username,
      ai_member.display_name AS ai_display_name,
      ai_member.avatar AS ai_avatar,
      ai_member.owner_user_id AS ai_owner_user_id,
      ai_member.character_id AS ai_character_id
    FROM messages m
    LEFT JOIN users actor ON actor.user_id = m.actor_user_id
    LEFT JOIN users user_sender ON user_sender.user_id = m.sender_id
    LEFT JOIN group_members ai_member
      ON ai_member.group_id = m.group_id
      AND ai_member.member_type = 'ai'
      AND ai_member.member_id = m.sender_id
    WHERE ${where}
    ORDER BY ${order}
    LIMIT ?
  `).bind(...params).all()

  const messages = (result.results || []).map(formatMessage)
  return c.json({
    status: 'success',
    data: afterId > 0 ? messages : messages.reverse(),
  })
})

export default app
