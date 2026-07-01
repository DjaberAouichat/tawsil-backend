import { exec } from "../lib/db.js"
import { findDriverByUserId, updateDriverAvailability } from "../models/driver.model.js"
import { findDeliveryById } from "../models/delivery.model.js"
import { sendSuccess, createError } from "../utils/response.js"
import { getMatchingDashboardStats } from "../services/matching.service.js"
import { fetchClientHomeData } from "./client.controller.js"

const ACTIVE_DELIVERY_STATUSES = ["Accepted", "DriverArrivedPickup", "PickedUp", "InTransit", "ArrivedDropoff"]

const CANCELLED_DELIVERY_STATUSES = [
  "CancelledByUser",
  "CancelledByDriver",
  "Rejected",
  "FailedDelivery",
  "Refunded",
]

export const getClientDashboardSummary = async (req, res, next) => {
  try {
    const responseData = await fetchClientHomeData(req.user.id, {
      deliveriesLimit: 5,
      tripsLimit: 5,
      notificationsLimit: 5,
    })

    return sendSuccess(res, 200, "Client dashboard summary fetched successfully", {
      ...responseData,
      counters: responseData.stats,
    })
  } catch (error) {
    next(error)
  }
}

export const getDriverDashboardSummary = async (req, res, next) => {
  try {
    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const availableRequestsRows = await exec(
      null,
      `SELECT COUNT(*) AS total
       FROM Deliveries d
       LEFT JOIN DeliveryRejections r
         ON r.delivery_id = d.id AND r.driver_id = ?
       WHERE d.status = 'Pending'
         AND d.assigned_driver_id IS NULL
         AND r.id IS NULL
         AND (
           d.trip_id IS NULL
           OR d.trip_id IN (
             SELECT t.id FROM Trips t
             WHERE t.driver_id = ? AND t.status IN ('planned', 'active')
           )
         )`,
      [req.user.id, req.user.id],
    )

    const deliveryCounts = await exec(
      null,
      `SELECT
         COUNT(*) AS totalDeliveries,
         SUM(CASE WHEN status = 'Delivered' THEN 1 ELSE 0 END) AS completedDeliveries,
         SUM(CASE WHEN status IN (?, ?, ?, ?, ?) THEN 1 ELSE 0 END) AS activeDeliveries,
         SUM(CASE WHEN status IN (?, ?, ?, ?, ?) THEN 1 ELSE 0 END) AS cancelledDeliveries
       FROM Deliveries
       WHERE assigned_driver_id = ?`,
      [
        ...ACTIVE_DELIVERY_STATUSES,
        ...CANCELLED_DELIVERY_STATUSES,
        req.user.id,
      ],
    )

    const tripCounts = await exec(
      null,
      `SELECT
         COUNT(*) AS totalTrips,
         SUM(CASE WHEN status IN ('planned', 'active') THEN 1 ELSE 0 END) AS activeTrips,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completedTrips
       FROM Trips
       WHERE driver_id = ?`,
      [req.user.id],
    )

    const earningsRows = await exec(
      null,
      `SELECT COALESCE(SUM(COALESCE(dp.final_price, dp.price)), 0) AS totalEarnings
       FROM Deliveries d
       INNER JOIN DeliveryPricing dp ON dp.delivery_id = d.id
       LEFT JOIN DeliveryPayments py ON py.delivery_id = d.id
       WHERE d.assigned_driver_id = ?
         AND d.status = 'Delivered'
         AND (py.id IS NULL OR py.status IN ('completed', 'cash_received'))`,
      [req.user.id],
    )

    const ratingRows = await exec(
      null,
      `SELECT COUNT(*) AS ratingCount, COALESCE(AVG(rating), 0) AS averageRating
       FROM Rates
       WHERE to_user_id = ?`,
      [req.user.id],
    )

    const unreadNotificationsRows = await exec(
      null,
      `SELECT COUNT(*) AS unread
       FROM Notifications
       WHERE recipient_id = ? AND is_read = 0`,
      [req.user.id],
    )

    const activeDeliveryRows = await exec(
      null,
      `SELECT id
       FROM Deliveries
       WHERE assigned_driver_id = ?
         AND status IN ('Accepted','DriverArrivedPickup','PickedUp','InTransit','ArrivedDropoff')
       ORDER BY updated_at DESC
       LIMIT 1`,
      [req.user.id],
    )

    const activeDelivery = activeDeliveryRows[0]
      ? await findDeliveryById(null, activeDeliveryRows[0].id, {
          includeDriver: true,
          includeRequester: true,
          includeTrip: true,
        })
      : null

    const onTimeRows = await exec(
      null,
      `SELECT COUNT(*) AS onTime FROM DeliveryRatings WHERE driver_id = ? AND delivery_time_rating >= 4`,
      [req.user.id],
    )

    const memberRows = await exec(
      null,
      `SELECT created_at FROM Users WHERE id = ?`,
      [req.user.id],
    )

    const total = Number(deliveryCounts[0]?.totalDeliveries || 0)
    const completed = Number(deliveryCounts[0]?.completedDeliveries || 0)
    const cancelled = Number(deliveryCounts[0]?.cancelledDeliveries || 0)
    const successRate = total > 0 ? (completed / total) : 0

    const matchingStats = await getMatchingDashboardStats(req.user.id)

    return sendSuccess(res, 200, "Driver dashboard summary fetched successfully", {
      driver: {
        driverId: driver.driverId,
        isAvailable: !!driver.isAvailable,
        availability: driver.availability || "offline",
        isDocumentsVerified: !!driver.isDocumentsVerified,
        reviewStatus: driver.reviewStatus || (driver.isDocumentsVerified ? "approved" : "pending"),
        rating: Number(driver.rating || 0),
        ratingCount: Number(ratingRows[0]?.ratingCount || 0),
      },
      stats: {
        availableRequests: Number(availableRequestsRows[0]?.total || 0),
        totalDeliveries: Number(deliveryCounts[0]?.totalDeliveries || 0),
        activeDeliveries: Number(deliveryCounts[0]?.activeDeliveries || 0),
        completedDeliveries: Number(deliveryCounts[0]?.completedDeliveries || 0),
        cancelledDeliveries: Number(deliveryCounts[0]?.cancelledDeliveries || 0),
        totalTrips: Number(tripCounts[0]?.totalTrips || 0),
        activeTrips: Number(tripCounts[0]?.activeTrips || 0),
        completedTrips: Number(tripCounts[0]?.completedTrips || 0),
        earnings: Number(earningsRows[0]?.totalEarnings || 0),
        currency: "DZD",
        averageRating: Number(ratingRows[0]?.averageRating || 0),
        ratingCount: Number(ratingRows[0]?.ratingCount || 0),
        successRate,
        onTimeDeliveries: Number(onTimeRows?.onTime || 0),
        memberSince: memberRows[0]?.created_at || null,
      },
      shortcuts: {
        canCreateTrip: !!driver.isDocumentsVerified,
        hasActiveDelivery: !!activeDelivery,
        myTripsPath: "/api/trips/driver/mine",
        availableRequestsPath: "/api/deliveries/driver/available",
        activeDeliveryPath: "/api/deliveries/driver/active",
      },
      activeDelivery,
      notificationsUnreadCount: Number(unreadNotificationsRows[0]?.unread || 0),
      verification: {
        reviewStatus: driver.reviewStatus || (driver.isDocumentsVerified ? "approved" : "pending"),
        isDocumentsVerified: !!driver.isDocumentsVerified,
        needsResubmission: driver.reviewStatus === "rejected",
      },
      matchingStats: {
        recommendedCount: matchingStats.recommendedCount,
        potentialRevenue: matchingStats.potentialRevenue,
        averageCompatibility: matchingStats.averageCompatibility,
        averageDistance: matchingStats.averageDistance,
      },
    })
  } catch (error) {
    next(error)
  }
}

export const setDriverAvailability = async (req, res, next) => {
  try {
    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const { isAvailable, availability } = req.body || {}
    const nextAvailability = availability || (isAvailable === false ? "offline" : "available")

    await updateDriverAvailability(null, req.user.id, {
      isAvailable: isAvailable === undefined ? undefined : !!isAvailable,
      availability: nextAvailability,
    })

    const updated = await findDriverByUserId(null, req.user.id)

    return sendSuccess(res, 200, "Driver availability updated successfully", {
      driver: {
        driverId: updated.driverId,
        isAvailable: !!updated.isAvailable,
        availability: updated.availability || "offline",
        isDocumentsVerified: !!updated.isDocumentsVerified,
        rating: Number(updated.rating || 0),
      },
    })
  } catch (error) {
    next(error)
  }
}