import { jsonError } from './http'

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
  if (match) return match[1].trim()
  return String(c.req.query('token') || c.req.query('access_token') || '').trim()
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

export const requireAuth = async (c) => {
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
