const RESOURCE_OPTIONAL_COLUMNS = [
  ['uploader_name', 'TEXT'],
  ['description', 'TEXT'],
  ['preview_image_url', 'TEXT'],
  ['filename', 'TEXT'],
  ['mime_type', 'TEXT'],
  ['size_bytes', 'INTEGER DEFAULT 0'],
  ['file_type', 'TEXT'],
  ['content_encoding', "TEXT DEFAULT 'text'"],
  ['downloads', 'INTEGER DEFAULT 0'],
]

const BACKUP_OPTIONAL_COLUMNS = [
  ['base_path', 'TEXT'],
  ['object_key', 'TEXT'],
  ['size_bytes', 'INTEGER DEFAULT 0'],
  ['checksum', 'TEXT'],
  ['content_type', 'TEXT'],
]

const AGENT_WECHAT_PROACTIVE_OPTIONAL_COLUMNS = [
  ['character_name', 'TEXT'],
  ['chat_title', 'TEXT'],
  ['avatar_url', 'TEXT'],
  ['proactive_quiet_start', 'TEXT'],
  ['proactive_quiet_end', 'TEXT'],
  ['client_time_zone', 'TEXT'],
  ['client_utc_offset_minutes', 'INTEGER'],
  ['last_local_message_id', 'TEXT'],
  ['recent_messages_hash', 'TEXT'],
  ['offline_prompt_packet_json', 'TEXT'],
  ['last_offline_generated_hash', 'TEXT'],
  ['last_offline_generated_at', 'INTEGER'],
  ['client_id', 'TEXT'],
  ['client_kind', 'TEXT'],
  ['client_label', 'TEXT'],
]

const AGENT_CONFIG_OPTIONAL_COLUMNS = [
  ['offline_ai_json', 'TEXT'],
]

const AGENT_OUTBOX_OPTIONAL_COLUMNS = [
  ['dedupe_key', 'TEXT'],
]

const AGENT_PUSH_DEVICE_OPTIONAL_COLUMNS = [
  ['client_id', 'TEXT'],
  ['label', 'TEXT'],
  ['last_push_at', 'INTEGER'],
  ['last_push_error', 'TEXT'],
]

const AGENT_CLIENT_PRESENCE_OPTIONAL_COLUMNS = [
  ['profile_id', 'TEXT'],
  ['active_app_id', 'TEXT'],
  ['wechat_chat_id', 'TEXT'],
  ['visible', 'INTEGER DEFAULT 0'],
  ['foreground', 'INTEGER DEFAULT 0'],
  ['updated_at', 'INTEGER'],
]

const MCP_SERVER_OPTIONAL_COLUMNS = [
  ["transport_type", "TEXT DEFAULT 'streamable_http'"],
  ["headers_json", "TEXT DEFAULT '[]'"],
  ["disabled_tools_json", "TEXT DEFAULT '[]'"],
]

const GROUP_MEMBER_OPTIONAL_COLUMNS = [
  ["member_type", "TEXT DEFAULT 'user'"],
  ["member_id", "TEXT"],
  ["owner_user_id", "TEXT"],
  ["display_name", "TEXT"],
  ["avatar", "TEXT"],
  ["character_id", "TEXT"],
  ["ai_snapshot_json", "TEXT"],
  ["updated_at", "INTEGER"],
]

const GROUP_MESSAGE_OPTIONAL_COLUMNS = [
  ["sender_type", "TEXT DEFAULT 'user'"],
  ["sender_id", "TEXT"],
  ["actor_user_id", "TEXT"],
  ["sender_name", "TEXT"],
  ["message_type", "TEXT DEFAULT 'text'"],
  ["client_message_id", "TEXT"],
  ["metadata_json", "TEXT"],
  ["created_at_ms", "INTEGER"],
]

export const ensureResourceSchema = async (db) => {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).run()

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      uploader_name TEXT,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      preview_image_url TEXT,
      filename TEXT,
      mime_type TEXT,
      size_bytes INTEGER DEFAULT 0,
      file_type TEXT,
      content TEXT,
      content_encoding TEXT DEFAULT 'text',
      downloads INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    )
  `).run()

  const result = await db.prepare('PRAGMA table_info(resources)').all()
  const columnNames = new Set((result.results || []).map((column) => column.name))

  for (const [name, definition] of RESOURCE_OPTIONAL_COLUMNS) {
    if (!columnNames.has(name)) {
      await db.prepare(`ALTER TABLE resources ADD COLUMN ${name} ${definition}`).run()
    }
  }
}

export const ensureUserExists = async (db, userId, username = userId) => {
  const normalizedUsername = String(username || userId || '').trim() || userId
  await db.prepare(`
    INSERT OR IGNORE INTO users (user_id, username)
    VALUES (?, ?)
  `).bind(userId, normalizedUsername).run()
  await db.prepare(`
    UPDATE users
    SET username = ?
    WHERE user_id = ?
      AND username != ?
      AND (? != ? OR username = user_id)
  `).bind(normalizedUsername, userId, normalizedUsername, normalizedUsername, userId).run()
}

let groupSchemaPromise = null

const ensureGroupSchemaInternal = async (db) => {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).run()

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      creator_user_id TEXT,
      owner_user_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at INTEGER,
      FOREIGN KEY (creator_user_id) REFERENCES users(user_id),
      FOREIGN KEY (owner_user_id) REFERENCES users(user_id)
    )
  `).run()

  const groupsInfo = await db.prepare('PRAGMA table_info(groups)').all()
  const groupColumns = new Set((groupsInfo.results || []).map((column) => column.name))
  for (const [name, definition] of [
    ["creator_user_id", "TEXT"],
    ["owner_user_id", "TEXT"],
    ["updated_at", "INTEGER"],
  ]) {
    if (!groupColumns.has(name)) {
      await db.prepare(`ALTER TABLE groups ADD COLUMN ${name} ${definition}`).run()
    }
  }

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      user_id TEXT,
      member_type TEXT DEFAULT 'user',
      member_id TEXT,
      owner_user_id TEXT,
      display_name TEXT,
      avatar TEXT,
      character_id TEXT,
      ai_snapshot_json TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at INTEGER,
      FOREIGN KEY (group_id) REFERENCES groups(id),
      FOREIGN KEY (user_id) REFERENCES users(user_id),
      FOREIGN KEY (owner_user_id) REFERENCES users(user_id)
    )
  `).run()

  const memberInfo = await db.prepare('PRAGMA table_info(group_members)').all()
  const memberColumns = new Set((memberInfo.results || []).map((column) => column.name))
  for (const [name, definition] of GROUP_MEMBER_OPTIONAL_COLUMNS) {
    if (!memberColumns.has(name)) {
      await db.prepare(`ALTER TABLE group_members ADD COLUMN ${name} ${definition}`).run()
    }
  }

  await db.prepare(`
    UPDATE group_members
    SET member_type = COALESCE(member_type, 'user'),
        member_id = COALESCE(member_id, user_id),
        owner_user_id = COALESCE(owner_user_id, user_id),
        user_id = COALESCE(user_id, owner_user_id, member_id),
        updated_at = COALESCE(updated_at, unixepoch() * 1000)
    WHERE member_id IS NULL OR member_type IS NULL OR owner_user_id IS NULL OR user_id IS NULL OR updated_at IS NULL
  `).run()

  // Index creation and historical dedupe are handled by migrations/repair scripts.
  // Keep runtime schema checks lightweight to avoid D1 timeouts on hot requests.

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      user_id TEXT,
      content TEXT NOT NULL,
      sender_type TEXT DEFAULT 'user',
      sender_id TEXT,
      actor_user_id TEXT,
      sender_name TEXT,
      message_type TEXT DEFAULT 'text',
      client_message_id TEXT,
      metadata_json TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at_ms INTEGER,
      FOREIGN KEY (group_id) REFERENCES groups(id),
      FOREIGN KEY (user_id) REFERENCES users(user_id),
      FOREIGN KEY (actor_user_id) REFERENCES users(user_id)
    )
  `).run()

  const messageInfo = await db.prepare('PRAGMA table_info(messages)').all()
  const messageColumns = new Set((messageInfo.results || []).map((column) => column.name))
  for (const [name, definition] of GROUP_MESSAGE_OPTIONAL_COLUMNS) {
    if (!messageColumns.has(name)) {
      await db.prepare(`ALTER TABLE messages ADD COLUMN ${name} ${definition}`).run()
    }
  }

  await db.prepare(`
    UPDATE messages
    SET sender_type = COALESCE(sender_type, 'user'),
        sender_id = COALESCE(sender_id, user_id),
        actor_user_id = COALESCE(actor_user_id, user_id),
        message_type = COALESCE(message_type, 'text'),
        created_at_ms = COALESCE(created_at_ms, unixepoch(created_at) * 1000)
    WHERE sender_id IS NULL OR sender_type IS NULL OR actor_user_id IS NULL OR message_type IS NULL OR created_at_ms IS NULL
  `).run()

  // Index creation and historical dedupe are handled by migrations/repair scripts.
  // Keep runtime schema checks lightweight to avoid D1 timeouts on hot requests.
}

export const ensureGroupSchema = async (db) => {
  if (!groupSchemaPromise) {
    groupSchemaPromise = ensureGroupSchemaInternal(db).catch((error) => {
      groupSchemaPromise = null
      throw error
    })
  }
  return groupSchemaPromise
}

export const ensureBackupSchema = async (db) => {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).run()

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      base_path TEXT NOT NULL,
      object_key TEXT NOT NULL,
      size_bytes INTEGER DEFAULT 0,
      checksum TEXT,
      content_type TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(user_id),
      UNIQUE (user_id, object_key)
    )
  `).run()

  const result = await db.prepare('PRAGMA table_info(backups)').all()
  const columnNames = new Set((result.results || []).map((column) => column.name))

  for (const [name, definition] of BACKUP_OPTIONAL_COLUMNS) {
    if (!columnNames.has(name)) {
      await db.prepare(`ALTER TABLE backups ADD COLUMN ${name} ${definition}`).run()
    }
  }
}

export const ensureAgentSchema = async (db) => {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).run()

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS agent_configs (
      user_id TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 0,
      takeover_json TEXT NOT NULL,
      offline_ai_json TEXT,
      min_interval_ms INTEGER DEFAULT 60000,
      max_interval_ms INTEGER DEFAULT 3600000,
      next_checkin_at INTEGER,
      last_checkin_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    )
  `).run()

  const agentConfigInfo = await db.prepare('PRAGMA table_info(agent_configs)').all()
  const agentConfigColumnNames = new Set((agentConfigInfo.results || []).map((column) => column.name))

  for (const [name, definition] of AGENT_CONFIG_OPTIONAL_COLUMNS) {
    if (!agentConfigColumnNames.has(name)) {
      await db.prepare(`ALTER TABLE agent_configs ADD COLUMN ${name} ${definition}`).run()
    }
  }

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS agent_offline_ai_keys (
      user_id TEXT PRIMARY KEY,
      api_key TEXT NOT NULL,
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      expires_at INTEGER,
      authorized_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    )
  `).run()

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      due_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      result_json TEXT,
      attempts INTEGER DEFAULT 0,
      locked_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    )
  `).run()

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_agent_tasks_due
    ON agent_tasks (status, due_at)
  `).run()

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS agent_outbox (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      dedupe_key TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      consumed_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    )
  `).run()

  const outboxInfo = await db.prepare('PRAGMA table_info(agent_outbox)').all()
  const outboxColumnNames = new Set((outboxInfo.results || []).map((column) => column.name))

  for (const [name, definition] of AGENT_OUTBOX_OPTIONAL_COLUMNS) {
    if (!outboxColumnNames.has(name)) {
      await db.prepare(`ALTER TABLE agent_outbox ADD COLUMN ${name} ${definition}`).run()
    }
  }

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_agent_outbox_user_status
    ON agent_outbox (user_id, status, created_at)
  `).run()

  await db.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_outbox_dedupe_key
    ON agent_outbox (dedupe_key)
  `).run()

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS agent_push_devices (
      user_id TEXT NOT NULL,
      token TEXT NOT NULL,
      platform TEXT DEFAULT 'android',
      client_id TEXT,
      label TEXT,
      enabled INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      last_push_at INTEGER,
      last_push_error TEXT,
      PRIMARY KEY (user_id, token),
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    )
  `).run()

  const pushDeviceInfo = await db.prepare('PRAGMA table_info(agent_push_devices)').all()
  const pushDeviceColumnNames = new Set((pushDeviceInfo.results || []).map((column) => column.name))

  for (const [name, definition] of AGENT_PUSH_DEVICE_OPTIONAL_COLUMNS) {
    if (!pushDeviceColumnNames.has(name)) {
      await db.prepare(`ALTER TABLE agent_push_devices ADD COLUMN ${name} ${definition}`).run()
    }
  }

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_agent_push_devices_user_enabled
    ON agent_push_devices (user_id, enabled, updated_at)
  `).run()

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS agent_client_presence (
      user_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      client_kind TEXT,
      client_label TEXT,
      profile_id TEXT,
      active_app_id TEXT,
      wechat_chat_id TEXT,
      visible INTEGER DEFAULT 0,
      foreground INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, client_id),
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    )
  `).run()

  const clientPresenceInfo = await db.prepare('PRAGMA table_info(agent_client_presence)').all()
  const clientPresenceColumnNames = new Set((clientPresenceInfo.results || []).map((column) => column.name))

  for (const [name, definition] of AGENT_CLIENT_PRESENCE_OPTIONAL_COLUMNS) {
    if (!clientPresenceColumnNames.has(name)) {
      await db.prepare(`ALTER TABLE agent_client_presence ADD COLUMN ${name} ${definition}`).run()
    }
  }

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_agent_client_presence_user_visible
    ON agent_client_presence (user_id, visible, foreground, updated_at)
  `).run()

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS agent_wechat_proactive_state (
      user_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      character_name TEXT,
      chat_title TEXT,
      avatar_url TEXT,
      proactive_chat INTEGER DEFAULT 0,
      chat_frequency REAL DEFAULT 2,
      proactive_min_interval_hours REAL DEFAULT 6,
      proactive_max_streak INTEGER DEFAULT 1,
      proactive_quiet_start TEXT,
      proactive_quiet_end TEXT,
      client_time_zone TEXT,
      client_utc_offset_minutes INTEGER,
      last_local_message_id TEXT,
      recent_messages_hash TEXT,
      offline_prompt_packet_json TEXT,
      last_offline_generated_hash TEXT,
      last_offline_generated_at INTEGER,
      last_message_at INTEGER DEFAULT 0,
      last_user_reply_at INTEGER DEFAULT 0,
      last_ai_message_at INTEGER DEFAULT 0,
      last_ai_proactive_message_at INTEGER DEFAULT 0,
      today_proactive_count INTEGER DEFAULT 0,
      proactive_since_user_reply INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      is_group INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL,
      last_dispatched_at INTEGER,
      PRIMARY KEY (user_id, profile_id, chat_id, character_id),
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    )
  `).run()

  const proactiveStateInfo = await db.prepare('PRAGMA table_info(agent_wechat_proactive_state)').all()
  const proactiveStateColumnNames = new Set((proactiveStateInfo.results || []).map((column) => column.name))

  for (const [name, definition] of AGENT_WECHAT_PROACTIVE_OPTIONAL_COLUMNS) {
    if (!proactiveStateColumnNames.has(name)) {
      await db.prepare(`ALTER TABLE agent_wechat_proactive_state ADD COLUMN ${name} ${definition}`).run()
    }
  }

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_agent_wechat_proactive_due
    ON agent_wechat_proactive_state (user_id, proactive_chat, is_active, updated_at)
  `).run()

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS agent_lifeline_triggers (
      user_id TEXT NOT NULL,
      character_id TEXT NOT NULL,
      trigger_id TEXT NOT NULL,
      trigger_at INTEGER,
      intent TEXT NOT NULL,
      instruction TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      visibility TEXT DEFAULT 'profile',
      participants_json TEXT NOT NULL DEFAULT '[]',
      backend_only INTEGER DEFAULT 1,
      updated_at INTEGER NOT NULL,
      last_dispatched_at INTEGER,
      PRIMARY KEY (user_id, character_id, trigger_id),
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    )
  `).run()

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_agent_lifeline_triggers_due
    ON agent_lifeline_triggers (user_id, status, trigger_at)
  `).run()
}

export const ensureMcpSchema = async (db) => {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).run()

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      user_id TEXT NOT NULL,
      server_id TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      token TEXT,
      transport_type TEXT DEFAULT 'streamable_http',
      headers_json TEXT DEFAULT '[]',
      disabled_tools_json TEXT DEFAULT '[]',
      enabled INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, server_id),
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    )
  `).run()

  const result = await db.prepare('PRAGMA table_info(mcp_servers)').all()
  const columnNames = new Set((result.results || []).map((column) => column.name))
  for (const [name, definition] of MCP_SERVER_OPTIONAL_COLUMNS) {
    if (!columnNames.has(name)) {
      await db.prepare(`ALTER TABLE mcp_servers ADD COLUMN ${name} ${definition}`).run()
    }
  }
}
