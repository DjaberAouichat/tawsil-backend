import crypto from "crypto"
import { exec } from "../lib/db.js"
import { createNotification as createNotificationRecord } from "../models/notification.model.js"
import { distanceMeters } from "../utils/maps.js"
import { emitToUser } from "../socket/index.js"

const parseNotificationPreferences = (raw) => {
  if (!raw) return { nearbyDeliveries: true, newTripsOnRoute: true, earningsUpdates: true }
  try {
    const prefs = typeof raw === "string" ? JSON.parse(raw) : raw
    return {
      nearbyDeliveries: prefs.nearbyDeliveries !== false,
      newTripsOnRoute: prefs.newTripsOnRoute !== false,
      earningsUpdates: prefs.earningsUpdates !== false,
    }
  } catch {
    return { nearbyDeliveries: true, newTripsOnRoute: true, earningsUpdates: true }
  }
}

const checkRateLimit = async (driverId, type, maxPerHour) => {
  const rows = await exec(
    null,
    `SELECT COUNT(*) AS cnt FROM Notifications
     WHERE recipient_id = ? AND type = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
    [driverId, type],
  )
  return Number(rows[0]?.cnt || 0)
}

export const sendNewDeliveryNearbyNotifications = async (delivery) => {
  try {
    const pickupRows = await exec(
      null,
      `SELECT latitude, longitude, address FROM DeliveryLocations WHERE delivery_id = ? AND type = 'PICKUP' LIMIT 1`,
      [delivery.id],
    )
    const pickupRow = pickupRows[0]
    if (!pickupRow || pickupRow.latitude == null || pickupRow.longitude == null) return

    const pickupLat = Number(pickupRow.latitude)
    const pickupLng = Number(pickupRow.longitude)
    const pickupAddress = pickupRow.address || ""

    const priceRows = await exec(
      null,
      `SELECT price FROM DeliveryPricing WHERE delivery_id = ? LIMIT 1`,
      [delivery.id],
    )
    const price = priceRows[0] ? Number(priceRows[0].price) : 0

    const drivers = await exec(
      null,
      `SELECT d.participant_id AS driverId, dl.latitude, dl.longitude, d.notification_preferences AS notificationPreferences
       FROM Drivers d
       JOIN DriverLocation dl ON dl.driver_id = d.participant_id
       WHERE d.availability = 'available'
         AND d.is_available = 1
         AND d.review_status = 'approved'
         AND d.is_documents_verified = 1
         AND dl.latitude IS NOT NULL
         AND dl.longitude IS NOT NULL`,
    )

    for (const driver of drivers) {
      const driverLat = Number(driver.latitude)
      const driverLng = Number(driver.longitude)

      const distance = distanceMeters({ lat: pickupLat, lng: pickupLng }, { lat: driverLat, lng: driverLng })
      if (distance == null) continue

      const distanceKm = distance / 1000
      if (distanceKm > 50) continue

      const prefs = parseNotificationPreferences(driver.notificationPreferences)
      if (!prefs.nearbyDeliveries) continue

      const recentCount = await checkRateLimit(driver.driverId, "new_delivery_nearby", 5)
      if (recentCount >= 5) continue

      const notificationId = crypto.randomUUID()
      await createNotificationRecord(null, {
        id: notificationId,
        recipientId: driver.driverId,
        title: "Nouvelle livraison près de chez vous",
        message: `Une nouvelle livraison est disponible à ${Math.round(distanceKm)} km de votre position`,
        type: "new_delivery_nearby",
        deliveryId: delivery.id,
        actionUrl: null,
      })

      emitToUser(driver.driverId, "notification:new_delivery_nearby", {
        deliveryId: delivery.id,
        pickupAddress,
        price,
        distanceKm: Math.round(distanceKm * 100) / 100,
      })

      // Also emit a dedicated event for the real-time list update
      emitToUser(driver.driverId, "notification:compatible_delivery", {
        deliveryId: delivery.id,
        timestamp: new Date().toISOString(),
      })
    }
  } catch (error) {
    console.error("sendNewDeliveryNearbyNotifications error:", error)
  }
}

export { parseNotificationPreferences }
