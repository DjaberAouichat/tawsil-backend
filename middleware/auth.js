import jwt from "jsonwebtoken"
import helmet from "helmet"
import rateLimit from "express-rate-limit"
import { createError } from "../utils/response.js"
import { findUserById, getUserRole } from "../models/user.model.js"
import { getPool } from "../lib/db.js"

// ── Authenticate ───────────────────────────────────────────────────────

const LOCAL_ADMIN_BOOTSTRAP_TOKEN = process.env.LOCAL_ADMIN_TOKEN

const resolveAdminUserId = async () => {
  try {
    const pool = getPool()
    const [adminRows] = await pool.execute(
      `SELECT u.id FROM Users u INNER JOIN Admins a ON a.user_id = u.id ORDER BY u.created_at ASC LIMIT 1`,
    )
    if (adminRows && adminRows[0] && adminRows[0].id) {
      const user = await findUserById(null, adminRows[0].id)
      if (user) return { ...user, role: "admin" }
    }
  } catch {
    // fallback
  }
  return { id: "local-admin", email: "admin@tawsil.dz", firstName: "Admin", lastName: "Tawsil", isBlocked: false, isSuspended: false, role: "admin" }
}

export const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return next(createError(401, "Authentication required. Please login."))
    }

    const token = authHeader.split(" ")[1]

    if (process.env.NODE_ENV !== "production" && LOCAL_ADMIN_BOOTSTRAP_TOKEN && token === LOCAL_ADMIN_BOOTSTRAP_TOKEN) {
      req.user = await resolveAdminUserId()
      next()
      return
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    const user = await findUserById(null, decoded.id)
    if (!user) return next(createError(401, "Invalid token. User not found."))

    if (user.tokenVersion !== decoded.tokenVersion) return next(createError(401, "Token has been revoked. Please login again."))
    if (user.isBlocked) return next(createError(403, "Your account has been blocked. Please contact support."))
    if (user.isSuspended) return next(createError(403, "Your account has been suspended. Please contact support."))

    const dbRole = await getUserRole(null, user.id)
    const role = dbRole || decoded.role
    req.user = { ...user, role }
    next()
  } catch (error) {
    if (error.name === "JsonWebTokenError") return next(createError(401, "Invalid token."))
    if (error.name === "TokenExpiredError") return next(createError(401, "Token expired. Please login again."))
    next(error)
  }
}

// ── Authorize (role guard) ─────────────────────────────────────────────

export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) return next(createError(401, "Authentication required. Please login."))
    const normalizedUserRole = String(req.user.role || "").trim().toLowerCase()
    const normalizedRoles = roles.map((role) => String(role || "").trim().toLowerCase())
    if (!normalizedRoles.includes(normalizedUserRole)) return next(createError(403, "You are not authorized to access this resource."))
    next()
  }
}

// ── Security headers + Rate limiters ───────────────────────────────────

const getWindowMs = (rawValue, fallbackMs) => {
  const parsed = Number.parseInt(String(rawValue || ""), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs
}

const getMaxRequests = (rawValue, fallbackMax) => {
  const parsed = Number.parseInt(String(rawValue || ""), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMax
}

const getClientIp = (req) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown"
  // Azure App Service sometimes appends the ephemeral port to the client IP
  // (e.g. "154.253.59.168:9262"). Strip the port for IPv4 addresses only,
  // leaving IPv6 addresses (which contain colons) untouched.
  if (typeof ip === "string") {
    const match = ip.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::\d+)?$/)
    if (match) return match[1]
  }
  return ip
}

const buildLimiter = ({ windowMs, max, message }) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getClientIp(req),
    message: { success: false, message, details: { code: "RATE_LIMITED" } },
  })

const authStrictWindowMs = getWindowMs(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000)
const authStrictMax = getMaxRequests(process.env.AUTH_RATE_LIMIT_MAX, 20)
const authEmailWindowMs = getWindowMs(process.env.AUTH_EMAIL_RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000)
const authEmailMax = getMaxRequests(process.env.AUTH_EMAIL_RATE_LIMIT_MAX, 8)

export const securityHeaders = helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } })

export const authStrictLimiter = buildLimiter({
  windowMs: authStrictWindowMs,
  max: authStrictMax,
  message: "Too many authentication attempts. Please try again later.",
})

export const authEmailLimiter = buildLimiter({
  windowMs: authEmailWindowMs,
  max: authEmailMax,
  message: "Too many email requests. Please try again later.",
})
