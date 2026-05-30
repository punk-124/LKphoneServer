export class GroupRoom {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.clients = new Set()
  }

  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/connect') return this.connect(request, url)
    if (url.pathname === '/broadcast' && request.method === 'POST') return this.broadcast(request)
    return new Response('Not found', { status: 404 })
  }

  connect(request, url) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    const userId = String(url.searchParams.get('user_id') || '').trim()
    const groupId = String(url.searchParams.get('group_id') || '').trim()
    const connection = { ws: server, userId, groupId }

    server.accept()
    this.clients.add(connection)

    const remove = () => this.clients.delete(connection)
    server.addEventListener('close', remove)
    server.addEventListener('error', remove)
    server.addEventListener('message', (event) => {
      if (String(event.data || '') === 'ping') {
        this.safeSend(connection, { type: 'pong', group_id: Number(groupId), ts: Date.now() })
      }
    })

    this.safeSend(connection, {
      type: 'hello',
      user_id: userId,
      group_id: Number(groupId),
      ts: Date.now(),
    })

    return new Response(null, { status: 101, webSocket: client })
  }

  async broadcast(request) {
    const payload = await request.json().catch(() => null)
    if (!payload || typeof payload !== 'object') {
      return new Response('Invalid payload', { status: 400 })
    }

    let sent = 0
    for (const connection of Array.from(this.clients)) {
      if (this.safeSend(connection, payload)) sent += 1
      else this.clients.delete(connection)
    }

    return Response.json({ status: 'success', sent })
  }

  safeSend(connection, payload) {
    try {
      connection.ws.send(JSON.stringify(payload))
      return true
    } catch {
      return false
    }
  }
}
