import { createError, sendSuccess } from "../utils/response.js"
import { getPool, exec } from "../lib/db.js"
import { createNotification as createNotificationUtil } from "../utils/notification.utils.js"
import { emitToUser } from "../socket/index.js"

const toSafePaginationInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback
  }

  return parsed
}

const mapRow = (row) => {
  if (!row) return null
  return {
    id: row.id,
    recipientId: row.recipient_id,
    title: row.title,
    message: row.message,
    type: row.type,
    referenceId: row.reference_id || null,
    referenceModel: row.reference_model || null,
    deliveryId: row.delivery_id || null,
    tripId: row.trip_id || null,
    promotionId: row.promotion_id || null,
    isRead: !!row.is_read,
    actionUrl: row.action_url || null,
    createdAt: row.created_at,
  }
}

export const listNotifications = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100)
    const offset = parseInt(req.query.offset, 10) || 0
    const unreadOnly = req.query.unread === "true"

    let where = "WHERE recipient_id = ?"
    const params = [req.user.id]

    if (unreadOnly) {
      where += " AND is_read = 0"
    }

    const rows = await exec(
      null,
      `SELECT id, recipient_id, title, message, type,
              reference_id, reference_model,
              delivery_id, trip_id, promotion_id,
              is_read, action_url, created_at
       FROM Notifications
       ${where}
       ORDER BY created_at DESC
       LIMIT ${toSafePaginationInt(limit, 20)} OFFSET ${toSafePaginationInt(offset, 0)}`,
      params,
    )

    const countRows = await exec(
      null,
      `SELECT COUNT(*) AS total FROM Notifications ${where}`,
      params,
    )

    const unreadRows = await exec(
      null,
      `SELECT COUNT(*) AS unread FROM Notifications WHERE recipient_id = ? AND is_read = 0`,
      [req.user.id],
    )

    return sendSuccess(res, 200, "Notifications fetched successfully", {
      notifications: rows.map(mapRow),
      total: Number(countRows[0]?.total || 0),
      unread: Number(unreadRows[0]?.unread || 0),
      limit,
      offset,
    })
  } catch (error) {
    next(error)
  }
}

export const markNotificationRead = async (req, res, next) => {
  try {
    const { notificationId } = req.params

    const rows = await exec(
      null,
      `SELECT id, recipient_id FROM Notifications WHERE id = ? LIMIT 1`,
      [notificationId],
    )

    const row = rows[0]
    if (!row) {
      return next(createError(404, "Notification not found"))
    }

    if (row.recipient_id !== req.user.id) {
      return next(createError(403, "Access denied"))
    }

    await exec(null, `UPDATE Notifications SET is_read = 1 WHERE id = ?`, [notificationId])

    emitToUser(req.user.id, "notification:read", { notificationId })

    return sendSuccess(res, 200, "Notification marked as read")
  } catch (error) {
    next(error)
  }
}

export const markAllNotificationsRead = async (req, res, next) => {
  try {
    const result = await exec(
      null,
      `UPDATE Notifications SET is_read = 1 WHERE recipient_id = ? AND is_read = 0`,
      [req.user.id],
    )

    emitToUser(req.user.id, "notification:read-all", {
      count: result.affectedRows ?? 0,
    })

    return sendSuccess(res, 200, "All notifications marked as read", {
      updated: result.affectedRows ?? 0,
    })
  } catch (error) {
    next(error)
  }
}

export const deleteNotification = async (req, res, next) => {
  try {
    const { notificationId } = req.params

    const rows = await exec(
      null,
      `SELECT id, recipient_id FROM Notifications WHERE id = ? LIMIT 1`,
      [notificationId],
    )

    const row = rows[0]
    if (!row) {
      return next(createError(404, "Notification not found"))
    }

    if (row.recipient_id !== req.user.id) {
      return next(createError(403, "Access denied"))
    }

    await exec(null, `DELETE FROM Notifications WHERE id = ?`, [notificationId])

    emitToUser(req.user.id, "notification:deleted", { notificationId })

    return sendSuccess(res, 200, "Notification deleted")
  } catch (error) {
    next(error)
  }
}

// Dev-only: create a notification for a given recipient id (body: { recipient, title, message, type })
export const createNotificationTest = async (req, res, next) => {
  try {
    const { recipient, title, message, type } = req.body || {}
    if (!recipient) {
      return res.status(400).json({ success: false, message: 'recipient is required' })
    }

    const notif = await createNotificationUtil({
      recipient,
      title: title || 'Test notification',
      message: message || 'This is a test notification',
      type: type || 'test',
      sendEmail: false,
    })

    if (!notif) {
      return res.status(500).json({ success: false, message: 'Failed to create notification' })
    }

    return res.status(201).json({ success: true, message: 'Notification created', data: notif })
  } catch (err) {
    next(err)
  }
}
