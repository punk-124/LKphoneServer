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
