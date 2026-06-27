const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "proxy-authorization",
])

const stripSensitiveHeaders = (headers) => {
  if (!headers || typeof headers !== "object") return headers
  const safe = { ...headers }
  for (const key of Object.keys(safe)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      safe[key] = "[REDACTED]"
    }
  }
  return safe
}

const safeStringify = (obj) => {
  try {
    return JSON.stringify(obj, (key, value) => {
      if (SENSITIVE_HEADERS.has(key.toLowerCase())) return "[REDACTED]"
      return value
    })
  } catch {
    return "[Unserializable]"
  }
}

export const logger = {
  info: (message, meta = {}) => {
    if (meta.headers) meta.headers = stripSensitiveHeaders(meta.headers)
    console.log(`[INFO] ${message}`, Object.keys(meta).length ? safeStringify(meta) : "")
  },

  warn: (message, meta = {}) => {
    if (meta.headers) meta.headers = stripSensitiveHeaders(meta.headers)
    console.warn(`[WARN] ${message}`, Object.keys(meta).length ? safeStringify(meta) : "")
  },

  error: (message, meta = {}) => {
    if (meta.headers) meta.headers = stripSensitiveHeaders(meta.headers)
    console.error(`[ERROR] ${message}`, Object.keys(meta).length ? safeStringify(meta) : "")
  },
}

export const requestLogger = (req, _res, next) => {
  const safeHeaders = stripSensitiveHeaders(req.headers)
  logger.info(`${req.method} ${req.originalUrl || req.url}`, {
    headers: safeHeaders,
    ip: req.ip,
  })
  next()
}
