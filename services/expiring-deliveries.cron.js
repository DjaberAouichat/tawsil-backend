import cron from "node-cron"
import crypto from "crypto"
import { exec } from "../lib/db.js"
import { createNotification as createNotificationRecord } from "../models/notification.model.js"
import { emitToUser } from "../socket/index.js"
import { parseNotificationPreferences } from "./notification.service.js"

export const startExpiringDeliveryCron = () => {
  cron.schedule("*/5 * * * *", async () => {
    try {
      const staleDeliveries = await exec(
        null,
        `SELECT d.id, d.assigned_driver_id, d.updated_at
         FROM Deliveries d
         WHERE d.status = 'Accepted'
           AND d.updated_at <= DATE_SUB(NOW(), INTERVAL 30 MINUTE)
           AND d.assigned_driver_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM Notifications n
             WHERE n.delivery_id = d.id
               AND n.recipient_id = d.assigned_driver_id
               AND n.type = 'accepted_expiring'
               AND n.created_at >= DATE_SUB(NOW(), INTERVAL 25 MINUTE)
           )`,
      )

      for (const delivery of staleDeliveries) {
        const prefRows = await exec(
          null,
          `SELECT notification_preferences FROM Drivers WHERE participant_id = ? LIMIT 1`,
          [delivery.assigned_driver_id],
        )
        if (!prefRows.length) continue

        const prefs = parseNotificationPreferences(prefRows[0].notification_preferences)
        if (!prefs.nearbyDeliveries) continue

        const notificationId = crypto.randomUUID()
        await createNotificationRecord(null, {
          id: notificationId,
          recipientId: delivery.assigned_driver_id,
          title: "Livraison sur le point d'expirer",
          message:
            "Vous avez accepté une livraison il y a plus de 30 minutes. Veuillez débuter le ramassage pour éviter l'annulation.",
          type: "accepted_expiring",
          deliveryId: delivery.id,
          actionUrl: null,
        })

        emitToUser(delivery.assigned_driver_id, "notification:accepted_expiring", {
          deliveryId: delivery.id,
        })
      }
    } catch (error) {
      console.error("[cron] expiring-deliveries error:", error)
    }
  })

  if (process.env.NODE_ENV !== "production") {
    console.log("[cron] Expiring delivery reminder scheduled every 5 minutes")
  }
}
