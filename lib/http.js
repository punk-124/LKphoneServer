export const jsonError = (c, message, status = 400) =>
  c.json({ status: 'error', message }, status)
