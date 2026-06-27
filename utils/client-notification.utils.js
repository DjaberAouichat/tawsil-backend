import { exec } from "../lib/db.js"
import { createNotification } from "./notification.utils.js"

const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000

export const NOTIFICATION_TYPES = {
  DELIVERY_ACCEPTED: "delivery_accepted",
  DRIVER_ARRIVED: "driver_arrived",
  IN_TRANSIT: "in_transit",
  DELIVERED: "delivered",
  CANCELLED: "cancelled",
}

export const notifyClient = async (requesterId, event, payload, notificationData) => {
  if (!requesterId) return null

  try {
    const oneHourAgo = new Date(Date.now() - RATE_LIMIT_WINDOW_MS)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ")

    const countRows = await exec(
      null,
      `SELECT COUNT(*) AS cnt FROM Notifications WHERE recipient_id = ? AND created_at >= ?`,
      [requesterId, oneHourAgo],
    )

    if (Number(countRows[0]?.cnt || 0) >= RATE_LIMIT_MAX) {
      console.warn(`[notifyClient] Rate limit (${RATE_LIMIT_MAX}/h) exceeded for ${requesterId}`)
      return null
    }

    const notification = await createNotification(notificationData)
    if (!notification) return null

    try {
      const { getIO } = await import("../socket/index.js")
      const io = getIO()
      if (io) {
        io.to(`client:${requesterId}`).emit(event, payload)
      }
    } catch (err) {
      console.warn("[notifyClient] Socket emit failed:", err.message)
    }

    return notification
  } catch (error) {
    console.error("[notifyClient] Error:", error)
    return null
  }
}
