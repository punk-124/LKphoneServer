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
  await db.prepare(`
    INSERT OR IGNORE INTO users (user_id, username)
    VALUES (?, ?)
  `).bind(userId, username).run()
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
      min_interval_ms INTEGER DEFAULT 60000,
      max_interval_ms INTEGER DEFAULT 3600000,
      next_checkin_at INTEGER,
      last_checkin_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    )
  `).run()

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS agent_generation_configs (
      user_id TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 0,
      base_url TEXT,
      api_key TEXT,
      model TEXT,
      created_at INTEGER NOT NULL,
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
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      consumed_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    )
  `).run()

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_agent_outbox_user_status
    ON agent_outbox (user_id, status, created_at)
  `).run()
}
