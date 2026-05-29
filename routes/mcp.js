import { Hono } from 'hono'
import { requireAuth } from '../lib/auth'
import { ensureMcpSchema, ensureUserExists } from '../lib/db'
import { jsonError } from '../lib/http'

const app = new Hono()

const nowMs = () => Date.now()

const normalizeString = (value, max = 260) => String(value || '').trim().slice(0, max)

const normalizeServer = (value) => ({
  id: normalizeString(value?.id || value?.serverId, 120) || `mcp_${nowMs()}_${crypto.randomUUID()}`,
  name: normalizeString(value?.name || 'MCP 服务', 80) || 'MCP 服务',
  url: normalizeString(value?.url, 520),
  token: normalizeString(value?.token, 1000),
  enabled: value?.enabled !== false,
})

const rowToServer = (row) => ({
  id: row.server_id,
  name: row.name,
  url: row.url,
  token: row.token || '',
  enabled: Number(row.enabled || 0) === 1,
  lastStatus: 'online',
  lastCheckedAt: Number(row.updated_at || 0) || undefined,
})

const requireMcpAuth = async (c) => {
  const auth = await requireAuth(c)
  if (auth.error) return auth
  await ensureMcpSchema(c.env.DB)
  await ensureUserExists(c.env.DB, auth.user.id, auth.user.username || auth.user.id)
  return auth
}

const parseSseJson = (text) => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
  if (lines.length === 0) throw new Error('MCP 服务没有返回 JSON 数据')
  return JSON.parse(lines[lines.length - 1])
}

const parseMcpResponse = async (response) => {
  const text = await response.text()
  if (!text.trim()) throw new Error(`MCP 服务返回为空：${response.status}`)
  try {
    return JSON.parse(text)
  } catch {
    return parseSseJson(text)
  }
}

const postJsonRpc = async (server, method, params = {}, id = Date.now()) => {
  const headers = new Headers()
  headers.set('Content-Type', 'application/json')
  headers.set('Accept', 'application/json, text/event-stream')
  if (server.token) headers.set('Authorization', `Bearer ${server.token}`)

  const response = await fetch(server.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    }),
  })
  const payload = await parseMcpResponse(response)
  if (!response.ok || payload?.error) {
    throw new Error(payload?.error?.message || `MCP 请求失败：${response.status}`)
  }
  return payload?.result
}

const initializeServer = async (server) => {
  await postJsonRpc(server, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: {
      name: 'LuckyPhone Server',
      version: '1.0.0',
    },
  }, 1)
}

const listServerTools = async (server) => {
  await initializeServer(server)
  const result = await postJsonRpc(server, 'tools/list', {}, 2)
  const tools = Array.isArray(result?.tools) ? result.tools : []
  return tools
    .map((tool) => ({
      serverId: server.id,
      name: normalizeString(tool?.name, 160),
      description: normalizeString(tool?.description, 1000) || undefined,
      inputSchema: tool?.inputSchema,
      enabled: true,
      dangerLevel: 'low',
    }))
    .filter((tool) => tool.name)
}

const readServers = async (db, userId, enabledOnly = false) => {
  const sql = enabledOnly
    ? 'SELECT * FROM mcp_servers WHERE user_id = ? AND enabled = 1 ORDER BY updated_at DESC'
    : 'SELECT * FROM mcp_servers WHERE user_id = ? ORDER BY updated_at DESC'
  const result = await db.prepare(sql).bind(userId).all()
  return (result.results || []).map(rowToServer)
}

app.put('/servers', async (c) => {
  const auth = await requireMcpAuth(c)
  if (auth.error) return auth.error

  const body = await c.req.json()
  const servers = (Array.isArray(body.servers) ? body.servers : [])
    .map(normalizeServer)
    .filter((server) => server.url)
    .slice(0, 24)
  const ts = nowMs()

  await c.env.DB.prepare('DELETE FROM mcp_servers WHERE user_id = ?').bind(auth.user.id).run()
  for (const server of servers) {
    await c.env.DB.prepare(`
      INSERT INTO mcp_servers (
        user_id, server_id, name, url, token, enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      auth.user.id,
      server.id,
      server.name,
      server.url,
      server.token,
      server.enabled ? 1 : 0,
      ts,
      ts
    ).run()
  }

  return c.json({ status: 'success', data: { servers: await readServers(c.env.DB, auth.user.id) } })
})

app.get('/servers', async (c) => {
  const auth = await requireMcpAuth(c)
  if (auth.error) return auth.error
  return c.json({ status: 'success', data: { servers: await readServers(c.env.DB, auth.user.id) } })
})

app.get('/tools', async (c) => {
  const auth = await requireMcpAuth(c)
  if (auth.error) return auth.error

  const serverId = normalizeString(c.req.query('serverId'), 120)
  let servers = await readServers(c.env.DB, auth.user.id, true)
  if (serverId) servers = servers.filter((server) => server.id === serverId)

  const tools = []
  for (const server of servers) {
    try {
      tools.push(...await listServerTools(server))
    } catch (error) {
      return jsonError(c, `${server.name || server.url}: ${error?.message || 'MCP 工具刷新失败'}`, 502)
    }
  }

  return c.json({ status: 'success', data: { tools } })
})

app.post('/call', async (c) => {
  const auth = await requireMcpAuth(c)
  if (auth.error) return auth.error

  const body = await c.req.json()
  const serverId = normalizeString(body.serverId, 120)
  const tool = normalizeString(body.tool || body.name, 160)
  if (!serverId) return jsonError(c, 'Missing serverId')
  if (!tool) return jsonError(c, 'Missing tool')

  const servers = await readServers(c.env.DB, auth.user.id, true)
  const server = servers.find((item) => item.id === serverId)
  if (!server) return jsonError(c, 'MCP server not found', 404)

  try {
    await initializeServer(server)
    const result = await postJsonRpc(server, 'tools/call', {
      name: tool,
      arguments: body.arguments || {},
    }, 3)
    return c.json({ status: 'success', data: result })
  } catch (error) {
    return jsonError(c, error?.message || 'MCP tool call failed', 502)
  }
})

export default app
