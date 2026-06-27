import crypto from "crypto"
import { createNotification as createNotificationRecord } from "../models/notification.model.js"
import { findUserById } from "../models/user.model.js"
import { sendNotificationEmail } from "./email.utils.js"

const emitSocketEvent = async (recipientId, notification) => {
  try {
    const { emitToUser } = await import("../socket/index.js")
    emitToUser(recipientId, "notification:new", notification)
  } catch (err) {
    console.warn("[socket] Failed to emit notification event:", err.message)
  }
}

export const createNotification = async (notificationData) => {
  try {
    const recipientId = notificationData?.recipient
    if (!recipientId) {
      return null
    }

    const notification = await createNotificationRecord(null, {
      id: crypto.randomUUID(),
      recipientId,
      title: notificationData.title,
      message: notificationData.message,
      type: notificationData.type,
      referenceId: notificationData.reference || notificationData.referenceId || null,
      referenceModel: notificationData.referenceModel || null,
      deliveryId: notificationData.deliveryId || null,
      tripId: notificationData.tripId || null,
      promotionId: notificationData.promotionId || null,
      actionUrl: notificationData.actionUrl || null,
    })

    emitSocketEvent(recipientId, notification)

    const shouldSendEmail = notificationData?.sendEmail !== false
    const user = shouldSendEmail ? await findUserById(null, recipientId) : null
    if (shouldSendEmail && user?.email) {
      await sendNotificationEmail(
        user.email,
        notificationData.title,
        `<h3>${notificationData.title}</h3><p>${notificationData.message}</p>`,
      )
    }

    return notification
  } catch (error) {
    console.error("Error creating notification:", error)
    return null
  }
}