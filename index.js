import { Hono } from 'hono'
import { cors } from 'hono/cors'

const app = new Hono()

// CORS middleware
app.use('*', cors())

// Database initialization
app.get('/init', async (c) => {
  try {
    const schema = await c.env.DB.prepare(`
      -- Create users table
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT UNIQUE NOT NULL,
        username TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Create resources table
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
      );

      -- Create forums table
      CREATE TABLE IF NOT EXISTS forums (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Create comments table
      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        forum_id INTEGER,
        user_id TEXT NOT NULL,
        parent_id INTEGER,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (forum_id) REFERENCES forums(id),
        FOREIGN KEY (user_id) REFERENCES users(user_id),
        FOREIGN KEY (parent_id) REFERENCES comments(id)
      );

      -- Create groups table
      CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Create group members table
      CREATE TABLE IF NOT EXISTS group_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (group_id) REFERENCES groups(id),
        FOREIGN KEY (user_id) REFERENCES users(user_id)
      );

      -- Create messages table
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (group_id) REFERENCES groups(id),
        FOREIGN KEY (user_id) REFERENCES users(user_id)
      );

      -- Create user data table for sync
      CREATE TABLE IF NOT EXISTS user_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(user_id),
        UNIQUE (user_id, key)
      );
    `).run()

    return c.json({ status: 'success', message: 'Database initialized' })
  } catch (error) {
    return c.json({ status: 'error', message: error.message })
  }
})

// 1. Resource management

const jsonError = (c, message, status = 400) =>
  c.json({ status: 'error', message }, status)

const textEncoder = new TextEncoder()

const base64UrlToBytes = (value) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

const base64UrlToJson = (value) => {
  const bytes = base64UrlToBytes(value)
  return JSON.parse(new TextDecoder().decode(bytes))
}

const pemToArrayBuffer = (pem) => {
  const base64 = String(pem || '')
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')
  return base64UrlToBytes(base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')).buffer
}

const getBearerToken = (c) => {
  const authHeader = c.req.header('Authorization') || ''
  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

const verifyJwt = async (token, publicKeyPem) => {
  const [encodedHeader, encodedPayload, signature] = token.split('.')
  if (!encodedHeader || !encodedPayload || !signature) {
    throw new Error('Invalid auth token')
  }

  const header = base64UrlToJson(encodedHeader)
  if (header.alg !== 'RS256') {
    throw new Error('Unsupported auth token algorithm')
  }

  const publicKey = await crypto.subtle.importKey(
    'spki',
    pemToArrayBuffer(publicKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  )
  const signedPart = `${encodedHeader}.${encodedPayload}`
  const isValid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    base64UrlToBytes(signature),
    textEncoder.encode(signedPart)
  )
  if (!isValid) {
    throw new Error('Invalid auth token signature')
  }

  const payload = base64UrlToJson(encodedPayload)
  if (payload.exp && Number(payload.exp) * 1000 < Date.now()) {
    throw new Error('Auth token expired')
  }

  return payload
}

const getAuthPublicKey = (env) => env.AUTH_PUBLIC_KEY_PEM || env.JWT_PUBLIC_KEY_PEM

const requireAuth = async (c) => {
  const publicKey = getAuthPublicKey(c.env)
  if (!publicKey) {
    return { error: jsonError(c, 'AUTH_PUBLIC_KEY_PEM or JWT_PUBLIC_KEY_PEM is not configured', 500) }
  }

  const token = getBearerToken(c)
  if (!token) {
    return { error: jsonError(c, 'Missing authorization token', 401) }
  }

  try {
    const payload = await verifyJwt(token, publicKey)
    const id = String(payload.sub || payload.id || payload.user_id || '').trim()
    const username = String(payload.username || payload.name || id).trim()
    const role = String(payload.role || 'user').trim().toLowerCase()
    const status = String(payload.status || 'active').trim().toLowerCase()

    if (!id) return { error: jsonError(c, 'Auth token missing user id', 401) }
    if (status === 'banned') return { error: jsonError(c, 'User is banned', 403) }

    return { user: { id, username, role, status } }
  } catch (error) {
    return { error: jsonError(c, error.message || 'Invalid authorization token', 401) }
  }
}

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

const ensureResourceSchema = async (db) => {
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

const inferFileType = (filename = '', mimeType = '') => {
  const ext = String(filename).split('.').pop()?.toUpperCase()
  if (ext && ext !== String(filename).toUpperCase()) return ext
  if (mimeType.includes('json')) return 'JSON'
  if (mimeType.startsWith('image/')) return 'IMAGE'
  if (mimeType.startsWith('video/')) return 'VIDEO'
  if (mimeType.includes('javascript')) return 'JS'
  if (mimeType.includes('css')) return 'CSS'
  if (mimeType.startsWith('text/')) return 'TEXT'
  return 'DATA'
}

const normalizeResourceRow = (row, includeContent = true) => ({
  id: String(row.id),
  user_id: row.user_id,
  uploader_name: row.uploader_name || row.user_id,
  category: row.category,
  title: row.title,
  description: row.description || '',
  preview_image_url: row.preview_image_url || '',
  filename: row.filename || row.title,
  mime_type: row.mime_type || 'application/octet-stream',
  size_bytes: row.size_bytes || 0,
  file_type: row.file_type || inferFileType(row.filename || row.title, row.mime_type || ''),
  ...(includeContent ? { content: row.content || '' } : {}),
  content_encoding: row.content_encoding || 'text',
  downloads: row.downloads || 0,
  created_at: row.created_at,
  updated_at: row.updated_at,
})

const canManageResource = (resource, requester) =>
  requester.role === 'admin' || (requester.id && String(resource.user_id) === requester.id)

const requireResourceManager = (c, resource, requester) => {
  if (canManageResource(resource, requester)) return null
  return jsonError(c, 'Permission denied: only the owner or admin can manage this resource', 403)
}

// Add resource
app.post('/resources', async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return auth.error

  const body = await c.req.json()
  const user_id = auth.user.id
  const category = String(body.category || '').trim()
  const title = String(body.title || body.name || body.filename || '').trim()
  const filename = String(body.filename || body.name || title).trim()

  if (!user_id || !category || !title) {
    return jsonError(c, 'Missing user_id, category or title')
  }

  await ensureResourceSchema(c.env.DB)
  
  // Ensure user exists
  await c.env.DB.prepare(`
    INSERT OR IGNORE INTO users (user_id, username) 
    VALUES (?, ?)
  `).bind(user_id, auth.user.username || user_id).run()

  try {
    const result = await c.env.DB.prepare(`
      INSERT INTO resources (
        user_id,
        uploader_name,
        category,
        title,
        description,
        preview_image_url,
        filename,
        mime_type,
        size_bytes,
        file_type,
        content,
        content_encoding,
        downloads
      ) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).bind(
      user_id,
      auth.user.username || user_id,
      category,
      title,
      body.description || '',
      body.preview_image_url || body.previewImageUrl || '',
      filename,
      body.mime_type || body.mimeType || 'application/octet-stream',
      Number(body.size_bytes || body.sizeBytes || 0),
      body.file_type || body.fileType || inferFileType(filename, body.mime_type || body.mimeType || ''),
      body.content || '',
      body.content_encoding || body.contentEncoding || 'text'
    ).run()

    const insertedId = result.meta?.last_row_id || result.lastInsertRowid
    const resource = await c.env.DB.prepare('SELECT * FROM resources WHERE id = ?')
      .bind(insertedId)
      .first()

    return c.json({ status: 'success', id: insertedId, data: normalizeResourceRow(resource, false) })
  } catch (error) {
    return jsonError(c, error.message, 500)
  }
})

// Get resources by optional user and category
app.get('/resources', async (c) => {
  const user_id = c.req.query('user_id')
  const category = c.req.query('category')

  try {
    await ensureResourceSchema(c.env.DB)

    let query = 'SELECT * FROM resources WHERE 1 = 1'
    const params = []

    if (user_id) {
      query += ' AND user_id = ?'
      params.push(user_id)
    }

    if (category) {
      query += ' AND category = ?'
      params.push(category)
    }

    query += ' ORDER BY created_at DESC, id DESC'

    const result = await c.env.DB.prepare(query).bind(...params).all()
    return c.json({ status: 'success', data: (result.results || []).map((row) => normalizeResourceRow(row, false)) })
  } catch (error) {
    return jsonError(c, error.message, 500)
  }
})

// Download resource and increment download count
app.get('/resources/:id/download', async (c) => {
  const id = c.req.param('id')

  try {
    await ensureResourceSchema(c.env.DB)
    const resource = await c.env.DB.prepare('SELECT * FROM resources WHERE id = ?').bind(id).first()
    if (!resource) return jsonError(c, 'Resource not found', 404)

    await c.env.DB.prepare(`
      UPDATE resources
      SET downloads = COALESCE(downloads, 0) + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(id).run()

    return c.json({
      status: 'success',
      data: normalizeResourceRow({ ...resource, downloads: (resource.downloads || 0) + 1 }),
    })
  } catch (error) {
    return jsonError(c, error.message, 500)
  }
})

// Update resource
app.put('/resources/:id', async (c) => {
  const id = c.req.param('id')
  const auth = await requireAuth(c)
  if (auth.error) return auth.error

  const body = await c.req.json()

  try {
    await ensureResourceSchema(c.env.DB)
    const existing = await c.env.DB.prepare('SELECT * FROM resources WHERE id = ?').bind(id).first()
    if (!existing) return jsonError(c, 'Resource not found', 404)
    const permissionError = requireResourceManager(c, existing, auth.user)
    if (permissionError) return permissionError

    await c.env.DB.prepare(`
      UPDATE resources 
      SET
        title = ?,
        content = ?,
        category = ?,
        description = ?,
        preview_image_url = ?,
        filename = ?,
        mime_type = ?,
        size_bytes = ?,
        file_type = ?,
        content_encoding = ?,
        updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `).bind(
      body.title || existing.title,
      body.content ?? existing.content,
      body.category || existing.category,
      body.description ?? existing.description ?? '',
      body.preview_image_url ?? body.previewImageUrl ?? existing.preview_image_url ?? '',
      body.filename || existing.filename || body.title || existing.title,
      body.mime_type || body.mimeType || existing.mime_type || 'application/octet-stream',
      Number(body.size_bytes ?? body.sizeBytes ?? existing.size_bytes ?? 0),
      body.file_type || body.fileType || existing.file_type || inferFileType(body.filename || existing.filename || existing.title, body.mime_type || body.mimeType || existing.mime_type || ''),
      body.content_encoding || body.contentEncoding || existing.content_encoding || 'text',
      id
    ).run()

    const resource = await c.env.DB.prepare('SELECT * FROM resources WHERE id = ?').bind(id).first()
    return c.json({ status: 'success', data: normalizeResourceRow(resource, false) })
  } catch (error) {
    return jsonError(c, error.message, 500)
  }
})

// Delete resource
app.delete('/resources/:id', async (c) => {
  const id = c.req.param('id')
  const auth = await requireAuth(c)
  if (auth.error) return auth.error

  try {
    await ensureResourceSchema(c.env.DB)
    const existing = await c.env.DB.prepare('SELECT * FROM resources WHERE id = ?').bind(id).first()
    if (!existing) return jsonError(c, 'Resource not found', 404)
    const permissionError = requireResourceManager(c, existing, auth.user)
    if (permissionError) return permissionError

    await c.env.DB.prepare('DELETE FROM resources WHERE id = ?').bind(id).run()
    return c.json({ status: 'success' })
  } catch (error) {
    return jsonError(c, error.message, 500)
  }
})

// 2. Forum comments

// Get comments by forum
app.get('/comments', async (c) => {
  const forum_id = c.req.query('forum_id')

  try {
    const result = await c.env.DB.prepare(`
      SELECT c.*, u.username 
      FROM comments c 
      JOIN users u ON c.user_id = u.user_id 
      WHERE c.forum_id = ? 
      ORDER BY c.created_at DESC
    `).bind(forum_id).all()

    return c.json({ status: 'success', data: result.results })
  } catch (error) {
    return c.json({ status: 'error', message: error.message })
  }
})

// Add comment
app.post('/comments', async (c) => {
  const { user_id, forum_id, parent_id, content } = await c.req.json()

  // Ensure user exists
  await c.env.DB.prepare(`
    INSERT OR IGNORE INTO users (user_id, username) 
    VALUES (?, ?)
  `).bind(user_id, user_id).run()

  try {
    const result = await c.env.DB.prepare(`
      INSERT INTO comments (user_id, forum_id, parent_id, content) 
      VALUES (?, ?, ?, ?)
    `).bind(user_id, forum_id, parent_id, content).run()

    return c.json({ status: 'success', id: result.lastInsertRowid })
  } catch (error) {
    return c.json({ status: 'error', message: error.message })
  }
})

// Delete comment
app.delete('/comments/:id', async (c) => {
  const id = c.req.param('id')

  try {
    await c.env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(id).run()
    return c.json({ status: 'success' })
  } catch (error) {
    return c.json({ status: 'error', message: error.message })
  }
})

// 3. Group chat

// Create group
app.post('/groups', async (c) => {
  const { name } = await c.req.json()

  try {
    const result = await c.env.DB.prepare(`
      INSERT INTO groups (name) VALUES (?)
    `).bind(name).run()

    return c.json({ status: 'success', id: result.lastInsertRowid })
  } catch (error) {
    return c.json({ status: 'error', message: error.message })
  }
})

// Add group member
app.post('/groups/:id/members', async (c) => {
  const group_id = c.req.param('id')
  const { user_id } = await c.req.json()

  // Ensure user exists
  await c.env.DB.prepare(`
    INSERT OR IGNORE INTO users (user_id, username) 
    VALUES (?, ?)
  `).bind(user_id, user_id).run()

  try {
    await c.env.DB.prepare(`
      INSERT OR IGNORE INTO group_members (group_id, user_id) 
      VALUES (?, ?)
    `).bind(group_id, user_id).run()

    return c.json({ status: 'success' })
  } catch (error) {
    return c.json({ status: 'error', message: error.message })
  }
})

// Get group members
app.get('/groups/:id/members', async (c) => {
  const group_id = c.req.param('id')

  try {
    const result = await c.env.DB.prepare(`
      SELECT u.* 
      FROM group_members gm 
      JOIN users u ON gm.user_id = u.user_id 
      WHERE gm.group_id = ?
    `).bind(group_id).all()

    return c.json({ status: 'success', data: result.results })
  } catch (error) {
    return c.json({ status: 'error', message: error.message })
  }
})

// Send message
app.post('/groups/:id/messages', async (c) => {
  const group_id = c.req.param('id')
  const { user_id, content } = await c.req.json()

  try {
    const result = await c.env.DB.prepare(`
      INSERT INTO messages (group_id, user_id, content) 
      VALUES (?, ?, ?)
    `).bind(group_id, user_id, content).run()

    // Get the message with user info
    const message = await c.env.DB.prepare(`
      SELECT m.*, u.username 
      FROM messages m 
      JOIN users u ON m.user_id = u.user_id 
      WHERE m.id = ?
    `).bind(result.lastInsertRowid).first()

    return c.json({ status: 'success', message })
  } catch (error) {
    return c.json({ status: 'error', message: error.message })
  }
})

// Get messages
app.get('/groups/:id/messages', async (c) => {
  const group_id = c.req.param('id')
  const limit = c.req.query('limit') || 50
  const offset = c.req.query('offset') || 0

  try {
    const result = await c.env.DB.prepare(`
      SELECT m.*, u.username 
      FROM messages m 
      JOIN users u ON m.user_id = u.user_id 
      WHERE m.group_id = ? 
      ORDER BY m.created_at DESC 
      LIMIT ? OFFSET ?
    `).bind(group_id, limit, offset).all()

    return c.json({ status: 'success', data: result.results })
  } catch (error) {
    return c.json({ status: 'error', message: error.message })
  }
})

// 4. User data sync

const FULL_BACKUP_KEY = 'lkphone_full_backup_v1'
const SYNC_CHUNK_KEY_PATTERN = /:chunk:\d+$/

const normalizeSyncRecordValue = (value) =>
  typeof value === 'string' ? value : JSON.stringify(value)

const parseStoredSyncValue = (key, value) => {
  if (SYNC_CHUNK_KEY_PATTERN.test(key)) {
    return { parsed: false, value }
  }

  try {
    return { parsed: true, value: JSON.parse(value) }
  } catch {
    return { parsed: false, value }
  }
}

// Store user data
app.post('/sync', async (c) => {
  const body = await c.req.json()
  const user_id = String(body.user_id || body.userId || 'default_user').trim()

  const records = Array.isArray(body.entries)
    ? body.entries.map((entry) => ({
      key: String(entry?.key || '').trim(),
      value: entry?.value
    }))
    : [{
      key: String(body.key || (body?.data ? FULL_BACKUP_KEY : '')).trim(),
      value: body.key ? body.value : (body?.data ? JSON.stringify(body) : undefined)
    }]

  const validRecords = records.filter((record) =>
    record.key && record.value !== undefined && record.value !== null
  )

  if (!user_id || validRecords.length === 0) {
    return jsonError(c, 'Missing user_id or sync records')
  }

  try {
    await c.env.DB.prepare(`
      INSERT OR IGNORE INTO users (user_id, username) 
      VALUES (?, ?)
    `).bind(user_id, user_id).run()

    const statement = c.env.DB.prepare(`
      INSERT OR REPLACE INTO user_data (user_id, key, value, updated_at) 
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `)

    const boundStatements = validRecords.map((record) =>
      statement.bind(user_id, record.key, normalizeSyncRecordValue(record.value))
    )

    for (let i = 0; i < boundStatements.length; i += 50) {
      await c.env.DB.batch(boundStatements.slice(i, i + 50))
    }

    return c.json({ status: 'success', count: validRecords.length })
  } catch (error) {
    return c.json({ status: 'error', message: error.message })
  }
})

// Get user data for sync
app.get('/sync', async (c) => {
  const user_id = String(c.req.query('user_id') || 'default_user').trim()
  const key = c.req.query('key')
  const last_sync = c.req.query('last_sync')

  try {
    let query = 'SELECT * FROM user_data WHERE user_id = ?'
    const params = [user_id]

    if (key) {
      query += ' AND key = ?'
      params.push(key)
    }

    if (last_sync) {
      query += ' AND updated_at > ?'
      params.push(last_sync)
    }

    const result = await c.env.DB.prepare(query).bind(...params).all()
    if (key) {
      const row = result.results?.[0]
      if (!row) return jsonError(c, 'No synced backup found', 404)

      const stored = parseStoredSyncValue(key, row.value)
      if (stored.parsed) {
        return c.json(stored.value)
      }
      return c.json({ status: 'success', key: row.key, value: stored.value })
    }

    return c.json({ status: 'success', data: result.results })
  } catch (error) {
    return c.json({ status: 'error', message: error.message })
  }
})

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok' })
})

export default app
