export const toBoundedPositiveInteger = (value, { fallback, min = 1, max = Number.MAX_SAFE_INTEGER }) => {
  const parsed = Number.parseInt(String(value ?? ""), 10)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback
  return parsed
}

export const toSqlDateTime = (date) => {
  if (!date) return null
  const d = typeof date === "string" ? new Date(date) : date
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 19).replace("T", " ")
}

export const isAutoPdfRequest = (req) => String(req.query?.autoPdf || "").trim().toLowerCase() === "true"

export const getRequestBaseUrl = (req) => {
  const forwardedProto = req.headers["x-forwarded-proto"]
  const protocol = forwardedProto ? String(forwardedProto).split(",")[0].trim() : req.protocol
  const host = req.headers["x-forwarded-host"] || req.get("host")
  return `${protocol}://${host}`
}

export const formatDurationText = (durationSeconds) => {
  const totalMinutes = Math.ceil(durationSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes} mins`
  const hours = Math.floor(totalMinutes / 60)
  const mins = totalMinutes % 60
  return mins > 0 ? `${hours}h ${mins}min` : `${hours}h`
}
