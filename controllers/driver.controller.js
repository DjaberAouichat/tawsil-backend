import { exec } from "../lib/db.js"
import { findDriverByUserId, getDriverLocation } from "../models/driver.model.js"
import { distanceMeters } from "../utils/maps.js"
import { reverseGeocode } from "../utils/maps.js"
import { sendSuccess, createError } from "../utils/response.js"

export const getCurrentLocation = async (req, res, next) => {
  try {
    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const location = await getDriverLocation(null, req.user.id)
    if (!location) {
      return sendSuccess(res, 200, "No location data available", {
        location: null,
        stale: false,
      })
    }

    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000)
    const lastSeen = new Date(location.timestamp)
    const isStale = lastSeen < tenMinutesAgo

    if (isStale) {
      return sendSuccess(res, 200, "Location is stale", {
        location: null,
        stale: true,
        lastSeen: location.timestamp,
      })
    }

    return sendSuccess(res, 200, "Current location fetched successfully", {
      location: {
        lat: Number(location.latitude),
        lng: Number(location.longitude),
        accuracy: location.accuracy != null ? Number(location.accuracy) : null,
        heading: location.heading != null ? Number(location.heading) : null,
        speed: location.speed != null ? Number(location.speed) : null,
        updatedAt: location.timestamp,
      },
      stale: false,
    })
  } catch (error) {
    next(error)
  }
}

export const getNearbyDeliveries = async (req, res, next) => {
  try {
    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const lat = Number(req.query.lat)
    const lng = Number(req.query.lng)
    const radiusKm = Number(req.query.radius_km) || 50

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return next(createError(400, "Valid lat and lng query parameters are required"))
    }

    const rows = await exec(
      null,
      `SELECT d.id
       FROM Deliveries d
       LEFT JOIN DeliveryRejections r
         ON r.delivery_id = d.id AND r.driver_id = ?
       WHERE d.status = 'Pending'
         AND d.assigned_driver_id IS NULL
         AND r.id IS NULL`,
      [req.user.id],
    )

    const nearby = []
    for (const row of rows) {
      const locRows = await exec(
        null,
        `SELECT latitude, longitude, address
         FROM DeliveryLocations
         WHERE delivery_id = ? AND type = 'PICKUP'`,
        [row.id],
      )

      const pickup = locRows[0]
      if (!pickup || pickup.latitude == null || pickup.longitude == null) continue

      const pickupLat = Number(pickup.latitude)
      const pickupLng = Number(pickup.longitude)
      const distance = distanceMeters({ lat: pickupLat, lng: pickupLng }, { lat, lng })

      if (distance == null) continue

      const distanceKm = distance / 1000
      if (distanceKm <= radiusKm) {
        nearby.push({
          deliveryId: row.id,
          distanceKm: Math.round(distanceKm * 100) / 100,
          pickupLat,
          pickupLng,
          pickupAddress: pickup.address || "",
        })
      }
    }

    nearby.sort((a, b) => a.distanceKm - b.distanceKm)

    return sendSuccess(res, 200, "Nearby deliveries fetched successfully", {
      deliveries: nearby,
      total: nearby.length,
      origin: { lat, lng },
      radiusKm,
    })
  } catch (error) {
    next(error)
  }
}

export const getCoverageZones = async (req, res, next) => {
  try {
    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const historyRows = await exec(
      null,
      `SELECT ROUND(latitude, 2) AS lat, ROUND(longitude, 2) AS lng,
              COUNT(*) AS frequency
       FROM DriverLocationHistory
       WHERE driver_id = ?
         AND timestamp >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       GROUP BY ROUND(latitude, 2), ROUND(longitude, 2)
       ORDER BY frequency DESC
       LIMIT 10`,
      [req.user.id],
    )

    const deliveryRows = await exec(
      null,
      `SELECT dl.latitude, dl.longitude, dl.address
       FROM Deliveries d
       JOIN DeliveryLocations dl ON dl.delivery_id = d.id AND dl.type = 'DROPOFF'
       WHERE d.assigned_driver_id = ?
         AND d.status = 'Delivered'
         AND d.updated_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       LIMIT 10`,
      [req.user.id],
    )

    const points = []
    for (const row of historyRows) {
      points.push({ lat: Number(row.lat), lng: Number(row.lng), weight: Number(row.frequency) })
    }
    for (const row of deliveryRows) {
      if (row.latitude != null && row.longitude != null) {
        points.push({ lat: Number(row.latitude), lng: Number(row.longitude), weight: 3 })
      }
    }

    if (points.length === 0) {
      return sendSuccess(res, 200, "No coverage data available", { zones: [] })
    }

    const seen = new Set()
    const uniquePoints = points.filter((p) => {
      const key = `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, 10)

    const geoResults = await Promise.allSettled(
      uniquePoints.map((p) => reverseGeocode(p.lat, p.lng)),
    )

    const wilayaCount = {}
    for (let i = 0; i < geoResults.length; i++) {
      const result = geoResults[i]
      if (result.status === "fulfilled") {
        const state = result.value?.address?.state || result.value?.address?.county || null
        if (state) {
          wilayaCount[state] = (wilayaCount[state] || 0) + (uniquePoints[i]?.weight || 1)
        }
      }
    }

    if (Object.keys(wilayaCount).length === 0) {
      for (const row of deliveryRows) {
        if (row.address) {
          const parts = row.address.split(",").map((s) => s.trim()).filter(Boolean)
          const wilaya = parts.length >= 2 ? parts[parts.length - 2].toLowerCase() : null
          if (wilaya) {
            wilayaCount[wilaya] = (wilayaCount[wilaya] || 0) + 1
          }
        }
      }
    }

    const sorted = Object.entries(wilayaCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([wilaya, deliveryCount]) => ({ wilaya, deliveryCount }))

    return sendSuccess(res, 200, "Coverage zones fetched successfully", {
      zones: sorted,
    })
  } catch (error) {
    next(error)
  }
}

export const saveNotificationPreferences = async (req, res, next) => {
  try {
    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const { nearbyDeliveries, newTripsOnRoute, earningsUpdates } = req.body || {}

    const prefs = {
      nearbyDeliveries: typeof nearbyDeliveries === "boolean" ? nearbyDeliveries : true,
      newTripsOnRoute: typeof newTripsOnRoute === "boolean" ? newTripsOnRoute : true,
      earningsUpdates: typeof earningsUpdates === "boolean" ? earningsUpdates : true,
    }

    await exec(
      null,
      `UPDATE Drivers SET notification_preferences = ? WHERE participant_id = ?`,
      [JSON.stringify(prefs), req.user.id],
    )

    return sendSuccess(res, 200, "Notification preferences saved successfully", { preferences: prefs })
  } catch (error) {
    next(error)
  }
}

export const getDriverStats = async (req, res, next) => {
  try {
    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const period = (req.query.period || "week").toLowerCase()
    let dateFrom = null
    const now = new Date()

    switch (period) {
      case "today":
        dateFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        break
      case "week":
        dateFrom = new Date(now)
        dateFrom.setDate(dateFrom.getDate() - 7)
        dateFrom.setHours(0, 0, 0, 0)
        break
      case "month":
        dateFrom = new Date(now.getFullYear(), now.getMonth(), 1)
        break
      case "all":
        dateFrom = null
        break
      default:
        dateFrom = new Date(now)
        dateFrom.setDate(dateFrom.getDate() - 7)
        dateFrom.setHours(0, 0, 0, 0)
    }

    const driverId = driver.participant_id
    const dateFilter = dateFrom ? "AND d.updated_at >= ?" : ""
    const dateParams = dateFrom ? [driverId, dateFrom] : [driverId]

    const statsRows = await exec(
      null,
      `SELECT
         COUNT(*) AS deliveriesCount,
         COALESCE(SUM(COALESCE(dp.final_price, dp.price)), 0) AS totalEarnings
       FROM Deliveries d
       LEFT JOIN DeliveryPricing dp ON dp.delivery_id = d.id
       WHERE d.assigned_driver_id = ?
         AND d.status IN ('Delivered', 'CancelledByUser', 'CancelledByDriver', 'FailedDelivery', 'Refunded')
         ${dateFilter}`,
      dateParams,
    )

    const deliveriesCount = Number(statsRows[0]?.deliveriesCount || 0)
    const totalEarnings = Number(statsRows[0]?.totalEarnings || 0)
    const avgPerDelivery = deliveriesCount > 0 ? totalEarnings / deliveriesCount : 0

    const ratingRows = await exec(
      null,
      `SELECT COALESCE(AVG(rating), 0) AS avgRating
       FROM Rates
       WHERE to_user_id = ?`,
      [req.user.id],
    )
    const ratingAvg = Number(ratingRows[0]?.avgRating || 0)

    const responseTimeRows = await exec(
      null,
      `SELECT COALESCE(AVG(TIMESTAMPDIFF(SECOND, d.created_at, dt.accepted_at)), 0) AS avgResponseSeconds
       FROM Deliveries d
       JOIN DeliveryTimeline dt ON dt.delivery_id = d.id
       WHERE d.assigned_driver_id = ?
         AND dt.accepted_at IS NOT NULL
         ${dateFilter}`,
      dateParams,
    )
    const avgResponseSeconds = Number(responseTimeRows[0]?.avgResponseSeconds || 0)
    const avgResponseMinutes = Math.round(avgResponseSeconds / 60)

    const acceptedRows = await exec(
      null,
      `SELECT COUNT(*) AS cnt
       FROM Deliveries
       WHERE assigned_driver_id = ?
         AND status NOT IN ('Pending', 'Draft')
         ${dateFilter}`,
      dateParams,
    )
    const rejectedRows = await exec(
      null,
      `SELECT COUNT(*) AS cnt
       FROM DeliveryRejections
       WHERE driver_id = ?
         ${dateFilter ? "AND created_at >= ?" : ""}`,
      dateFrom ? [driverId, dateFrom] : [driverId],
    )
    const acceptedCount = Number(acceptedRows[0]?.cnt || 0)
    const rejectedCount = Number(rejectedRows[0]?.cnt || 0)
    const totalOffers = acceptedCount + rejectedCount
    const acceptanceRate = totalOffers > 0 ? (acceptedCount / totalOffers) * 100 : 0

    const earningsByDayRows = await exec(
      null,
      `SELECT DATE(d.updated_at) AS day,
              COALESCE(SUM(COALESCE(dp.final_price, dp.price)), 0) AS amount
       FROM Deliveries d
       LEFT JOIN DeliveryPricing dp ON dp.delivery_id = d.id
       WHERE d.assigned_driver_id = ?
         AND d.status IN ('Delivered', 'CancelledByUser', 'CancelledByDriver', 'FailedDelivery', 'Refunded')
         AND d.updated_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
       GROUP BY DATE(d.updated_at)
       ORDER BY day ASC`,
      [driverId],
    )

    const earningsByDay = earningsByDayRows.map((r) => ({
      date: r.day,
      amount: Number(r.amount),
    }))

    const statusRows = await exec(
      null,
      `SELECT
         COALESCE(SUM(CASE WHEN d.status = 'Delivered' THEN 1 ELSE 0 END), 0) AS delivered,
         COALESCE(SUM(CASE WHEN d.status IN ('CancelledByUser','CancelledByDriver','FailedDelivery') THEN 1 ELSE 0 END), 0) AS cancelled
       FROM Deliveries d
       WHERE d.assigned_driver_id = ?
         ${dateFilter}`,
      dateParams,
    )

    const statusBreakdown = {
      delivered: Number(statusRows[0]?.delivered || 0),
      cancelled: Number(statusRows[0]?.cancelled || 0),
    }

    const wilayaRows = await exec(
      null,
      `SELECT dl.address, COUNT(*) AS cnt
       FROM DeliveryLocations dl
       JOIN Deliveries d ON d.id = dl.delivery_id
       WHERE d.assigned_driver_id = ?
         AND d.status = 'Delivered'
         AND dl.type IN ('PICKUP','DROPOFF')
         ${dateFilter}
       GROUP BY dl.address
       ORDER BY cnt DESC
       LIMIT 1`,
      dateParams,
    )

    const mostActiveWilaya = wilayaRows[0]?.address || null

    const recentRows = await exec(
      null,
      `SELECT d.id, d.status, d.updated_at,
              COALESCE(dp.final_price, dp.price, 0) AS amount
       FROM Deliveries d
       LEFT JOIN DeliveryPricing dp ON dp.delivery_id = d.id
       WHERE d.assigned_driver_id = ?
         AND d.status IN ('Delivered','CancelledByUser','CancelledByDriver','FailedDelivery','Refunded')
         ${dateFilter}
       ORDER BY d.updated_at DESC
       LIMIT 20`,
      dateParams,
    )

    const recentEarnings = recentRows.map((r) => ({
      id: r.id,
      status: r.status,
      amount: Number(r.amount),
      date: r.updated_at,
    }))

    return sendSuccess(res, 200, "Driver stats fetched successfully", {
      totalEarnings,
      deliveriesCount,
      avgPerDelivery,
      ratingAvg,
      acceptanceRate: Math.round(acceptanceRate * 100) / 100,
      avgResponseMinutes,
      earningsByDay,
      statusBreakdown,
      mostActiveWilaya,
      recentEarnings,
      period,
    })
  } catch (error) {
    next(error)
  }
}

export const saveFilterPreferences = async (req, res, next) => {
  try {
    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const preferences = req.body || {}

    await exec(
      null,
      `UPDATE Drivers SET filter_preferences = ? WHERE participant_id = ?`,
      [JSON.stringify(preferences), req.user.id],
    )

    return sendSuccess(res, 200, "Filter preferences saved successfully", { preferences })
  } catch (error) {
    next(error)
  }
}
