import crypto from "crypto"

const ACTIVE_DELIVERY_STATUSES = [
  "Accepted",
  "DriverArrivedPickup",
  "PickedUp",
  "InTransit",
  "ArrivedDropoff",
]

import { exec } from "../lib/db.js"
import { STATUS_DISPLAY_LABELS } from "../utils/delivery-status.utils.js"
import { listUserDeliveries } from "../models/delivery.model.js"
import { listAvailableTrips } from "../models/trip.model.js"
import { sendSuccess } from "../utils/response.js"

const toPositiveInt = (v, fallback) => {
  const n = Number.parseInt(String(v || ""), 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n
}

const ETAG_WEAK = process.env.NODE_ENV === "production"

const fetchClientHomeData = async (userId, { deliveriesLimit = 5, tripsLimit = 5, notificationsLimit = 3 } = {}) => {
  const [deliveries, availableTrips, notificationsRows, statsRows, unreadRows] = await Promise.all([
    listUserDeliveries(null, userId, { limit: deliveriesLimit, offset: 0 }),
    listAvailableTrips(null, { limit: tripsLimit, offset: 0 }),
    exec(
      null,
      `SELECT id, title, message, type, reference_id, reference_model, is_read, created_at
       FROM Notifications
       WHERE recipient_id = ?
       ORDER BY created_at DESC
       LIMIT ${notificationsLimit}`,
      [userId],
    ),
    exec(
      null,
      `SELECT
         COUNT(*) AS totalDeliveries,
         SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) AS pendingDeliveries,
         SUM(CASE WHEN status IN (?, ?, ?, ?, ?) THEN 1 ELSE 0 END) AS activeDeliveries,
         SUM(CASE WHEN status = 'Delivered' THEN 1 ELSE 0 END) AS completedDeliveries,
         SUM(CASE WHEN status IN ('CancelledByUser','CancelledByDriver','FailedDelivery','Refunded') THEN 1 ELSE 0 END) AS cancelledDeliveries,
         COALESCE(SUM(CASE WHEN status = 'Delivered' THEN COALESCE(dp.final_price, dp.price) ELSE 0 END), 0) AS totalSpent
       FROM Deliveries d
       LEFT JOIN DeliveryPricing dp ON dp.delivery_id = d.id
       WHERE d.requester_id = ?`,
      [...ACTIVE_DELIVERY_STATUSES, userId],
    ),
    exec(
      null,
      `SELECT COUNT(*) AS unread FROM Notifications WHERE recipient_id = ? AND is_read = 0`,
      [userId],
    ),
  ])

  const stats = {
    totalDeliveries: Number(statsRows[0]?.totalDeliveries || 0),
    pendingDeliveries: Number(statsRows[0]?.pendingDeliveries || 0),
    activeDeliveries: Number(statsRows[0]?.activeDeliveries || 0),
    completedDeliveries: Number(statsRows[0]?.completedDeliveries || 0),
    cancelledDeliveries: Number(statsRows[0]?.cancelledDeliveries || 0),
    totalSpent: Number(statsRows[0]?.totalSpent || 0),
  }

  const recentDeliveriesSummary = deliveries.map((d) => ({
    id: d.id,
    pickupAddress: d.pickup?.address || "",
    dropoffAddress: d.dropoff?.address || "",
    status: d.status,
    statusLabel: STATUS_DISPLAY_LABELS[d.status] || d.status,
    estimatedPrice: d.pricing?.estimatedPrice ?? null,
    finalPrice: d.pricing?.finalPrice ?? null,
    assignedDriver: d.assignedDriver?.user
      ? {
          id: d.assignedDriver.user.id,
          firstName: d.assignedDriver.user.firstName,
          lastName: d.assignedDriver.user.lastName,
          phone: d.assignedDriver.user.phone || null,
          rating: d.assignedDriver.user.rating || null,
        }
      : null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }))

  const recentTripsSummary = availableTrips.map((t) => ({
    id: t.id,
    origin: t.origin?.address || "",
    destination: t.destination?.address || "",
    departureTime: t.departureTime,
    expectedArrivalTime: t.expectedArrivalTime,
    maxDeliveries: t.maxDeliveries,
    availableCapacity: t.availableCapacity,
    acceptsDeliveries: ["planned", "active"].includes(t.status) && Number(t.availableCapacity || 0) > 0,
    driver: t.driver
      ? {
          id: t.driver.id,
          firstName: t.driver.firstName,
          phone: t.driver.phone || null,
          rating: t.driver.rating || null,
        }
      : null,
  }))

  const notifications = (notificationsRows || []).map((r) => ({
    id: r.id,
    title: r.title,
    message: r.message,
    type: r.type,
    referenceId: r.reference_id || null,
    referenceModel: r.reference_model || null,
    isRead: !!r.is_read,
    createdAt: r.created_at,
  }))

  return {
    stats,
    recentDeliveries: recentDeliveriesSummary,
    recentTrips: recentTripsSummary,
    notifications,
    notificationsUnreadCount: Number(unreadRows[0]?.unread || 0),
    currency: "DZD",
  }
}

export const clientHome = async (req, res, next) => {
  try {
    const deliveriesLimit = toPositiveInt(req.query.deliveriesLimit, 5)
    const tripsLimit = toPositiveInt(req.query.tripsLimit, 5)
    const notificationsLimit = toPositiveInt(req.query.notificationsLimit, 3)

    const responseData = await fetchClientHomeData(req.user.id, {
      deliveriesLimit,
      tripsLimit,
      notificationsLimit,
    })

    const body = JSON.stringify(responseData)
    const etag = ETAG_WEAK
      ? `W/"${crypto.createHash("md5").update(body).digest("hex")}"`
      : `"${crypto.createHash("md5").update(body).digest("hex")}"`

    if (req.headers["if-none-match"] === etag) {
      return res.status(304).end()
    }

    res.set("ETag", etag)
    return sendSuccess(res, 200, "Client home fetched successfully", responseData)
  } catch (error) {
    next(error)
  }
}

export { fetchClientHomeData }

export default {
  clientHome,
}
