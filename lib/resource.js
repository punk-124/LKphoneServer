import { jsonError } from './http'

export const inferFileType = (filename = '', mimeType = '') => {
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

export const normalizeResourceRow = (row, includeContent = true) => ({
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

export const requireResourceManager = (c, resource, requester) => {
  if (canManageResource(resource, requester)) return null
  return jsonError(c, 'Permission denied: only the owner or admin can manage this resource', 403)
}
