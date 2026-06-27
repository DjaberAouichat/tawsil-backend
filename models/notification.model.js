import { getPool, exec } from "../lib/db.js"

const mapNotificationRow = (row) => {
  if (!row) {
    return null
  }

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

export const createNotification = async (
  connection,
  {
    id,
    recipientId,
    title,
    message,
    type,
    referenceId = null,
    referenceModel = null,
    deliveryId = null,
    tripId = null,
    promotionId = null,
    actionUrl = null,
    isRead = false,
  },
) => {
  await exec(
    connection,
    `INSERT INTO Notifications (
        id, recipient_id, title, message, type,
        reference_id, reference_model,
        delivery_id, trip_id, promotion_id,
        is_read, action_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      recipientId,
      title,
      message,
      type,
      referenceId,
      referenceModel,
      deliveryId,
      tripId,
      promotionId,
      isRead ? 1 : 0,
      actionUrl,
    ],
  )

  const created = await findNotificationById(connection, id)
  return created
}

export const findNotificationById = async (connection, notificationId) => {
  const rows = await exec(
    connection,
    `SELECT id, recipient_id, title, message, type,
            reference_id, reference_model,
            delivery_id, trip_id, promotion_id,
            is_read, action_url, created_at
     FROM Notifications
     WHERE id = ?
     LIMIT 1`,
    [notificationId],
  )

  return mapNotificationRow(rows[0])
}
