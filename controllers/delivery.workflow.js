import bcrypt from "bcryptjs"
import crypto from "crypto"
import { getPool, withTransaction, exec } from "../lib/db.js"
import { determineDeliveryMode } from "../services/matching.service.js"
import { findDriverByUserId, getDriverLocation, upsertDriverLocation } from "../models/driver.model.js"
import {
  countAdminDeliveries,
  countDriverDeliveries,
  countUserDeliveries,
  createDelivery as createDeliveryRecord,
  findDeliveryById,
  insertDeliveryStatusHistory,
  listAdminDeliveries as listAdminDeliveriesModel,
  listDriverAvailableDeliveries as listDriverAvailableDeliveriesModel,
  listDriverDeliveries as listDriverDeliveriesModel,
  listUserDeliveries as listUserDeliveriesModel,
  updateDeliveryStatus as updateDeliveryStatusModel,
} from "../models/delivery.model.js"
import { findTripById } from "../models/trip.model.js"
import { checkAndCompleteTrip } from "../models/trip.model.js"
import { sendSuccess, createError } from "../utils/response.js"
import { sendNewDeliveryNearbyNotifications } from "../services/notification.service.js"
import { toBoundedPositiveInteger, toSqlDateTime, getRequestBaseUrl } from "../utils/helpers.js"
import { selectBestDriver } from "../utils/pricing.utils.js"

import { createNotification } from "../utils/notification.utils.js"
import { notifyClient } from "../utils/client-notification.utils.js"
import {
  DELIVERY_STATUS,
  canTransitionDeliveryStatus,
  isTerminalDeliveryStatus,
  STATUS_DISPLAY_LABELS,
} from "../utils/delivery-status.utils.js"
import {
  loadDeliveryPrintContext,
  canAccessDeliveryPrint,
  generateDeliveryPdfBuffer,
  sendPdfInline,
} from "../utils/pdf.utils.js"
import {
  buildPrice,
  buildPricingPayload,
  buildTrackingPayload,
  buildDriverExecutionPayload,
  buildDeliveryCompatibility,
  buildDeliveryMatch,
  calculateDriverDeliveryCompatibility,
  listDriverTripsForCompatibility,
  findCompatibleDriversForDelivery,
  getEstimateById,
  resolvePricingForCreate,
  saveDeliveryEstimate,
  consumeEstimate,
  touchTimeline,
  assertCanAccessDelivery,
  generateOtpCode,
  getOtpConfig,
  computeTripDetourMeters,
  distanceMeters,
  distancePointToSegmentMeters,
  savePricingAnalytics,
} from "../services/delivery.service.js"
import { getRecommendedDeliveries, getMatchingDashboardStats } from "../services/matching.service.js"
import { distanceMeters as haversineDistance } from "../utils/maps.js"
import { emitToUser, getIO } from "../socket/index.js"

const ACTIVE_DRIVER_STATUSES = [
  DELIVERY_STATUS.ACCEPTED,
  DELIVERY_STATUS.DRIVER_ARRIVED_PICKUP,
  DELIVERY_STATUS.PICKED_UP,
  DELIVERY_STATUS.IN_TRANSIT,
  DELIVERY_STATUS.ARRIVED_DROPOFF,
]

const CLIENT_STATUS_GROUPS = new Set([
  "active",
  "pending",
  "inProgress",
  "delivered",
  "cancelled",
])

const STATUS_GROUP_DISPLAY_LABELS = {
  active: "Active",
  pending: "Pending",
  inProgress: "In Progress",
  delivered: "Delivered",
  cancelled: "Cancelled",
}

const STATUS_TO_TIMELINE_COLUMN = {
  [DELIVERY_STATUS.ACCEPTED]: "accepted_at",
  [DELIVERY_STATUS.DRIVER_ARRIVED_PICKUP]: "driver_arrived_pickup_at",
  [DELIVERY_STATUS.PICKED_UP]: "picked_up_at",
  [DELIVERY_STATUS.IN_TRANSIT]: "in_transit_at",
  [DELIVERY_STATUS.ARRIVED_DROPOFF]: "arrived_dropoff_at",
  [DELIVERY_STATUS.DELIVERED]: "delivered_at",
  [DELIVERY_STATUS.CANCELLED_BY_USER]: "cancelled_at",
  [DELIVERY_STATUS.CANCELLED_BY_DRIVER]: "cancelled_at",
  [DELIVERY_STATUS.FAILED_DELIVERY]: "failed_at",
  [DELIVERY_STATUS.REFUNDED]: "refunded_at",
}

const TRIP_ACCEPTED_SIZE_LEVEL = {
  small_only: 1,
  up_to_medium: 2,
  up_to_large: 3,
  any: 4,
}

const PACKAGE_SIZE_LEVEL = {
  small: 1,
  medium: 2,
  large: 3,
  xlarge: 4,
}

const DEFAULT_PAGE = 1
const DEFAULT_USER_LIMIT = 10
const DEFAULT_ADMIN_LIMIT = 20
const MAX_LIST_LIMIT = 100
const TRACKING_STREAM_INTERVAL_MS = Number.parseInt(String(process.env.TRACKING_STREAM_INTERVAL_MS || "5000"), 10) || 5000
const MAX_LEN = {
  address: 200,
  name: 100,
  description: 500,
  note: 300,
}

const sanitizeHtml = (s) => (typeof s === "string" ? s.replace(/<[^>]*>/g, "") : s)

const extractWilaya = (address) => {
  if (!address) return null
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean)
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0] || null
}

const sanitizeDeliveryInput = (body) => {
  if (!body || typeof body !== "object") return body
  const safe = { ...body }
  if (safe.pickup?.address) safe.pickup.address = sanitizeHtml(safe.pickup.address).slice(0, MAX_LEN.address)
  if (safe.dropoff?.address) safe.dropoff.address = sanitizeHtml(safe.dropoff.address).slice(0, MAX_LEN.address)
  if (safe.recipient?.name) safe.recipient.name = sanitizeHtml(safe.recipient.name).slice(0, MAX_LEN.name)
  if (safe.package?.description) safe.package.description = sanitizeHtml(safe.package.description).slice(0, MAX_LEN.description)
  if (safe.deliveryNote) safe.deliveryNote = sanitizeHtml(safe.deliveryNote).slice(0, MAX_LEN.note)
  return safe
}

const buildDeliveryPdfUrl = (req, deliveryId) => {
  return `${getRequestBaseUrl(req)}/api/deliveries/${deliveryId}/pdf`
}

const createNotificationAfterCommit = (payload) => {
  createNotification(payload).catch((err) => {
    console.error("[notification] Failed to create notification:", err)
  })
}

export const estimateDeliveryPrice = async (req, res, next) => {
  try {
    const match = determineDeliveryMode({
      sizeCategory: req.body.package?.sizeCategory,
      weightKg: req.body.package?.weightKg,
      packageType: req.body.package?.type,
      description: req.body.package?.description,
    })
    const deliveryMode = match.pricingMode

    let winningDriver = null
    let deviationKm = null

    if (deliveryMode === "CROSS_SHIPPING") {
      const compatibleDrivers = await findCompatibleDriversForDelivery(null, {
        pickupCoordinates: req.body.pickup.location.coordinates,
        dropoffCoordinates: req.body.dropoff.location.coordinates,
        packageSizeCategory: req.body.package?.sizeCategory,
      })

      if (compatibleDrivers.length > 0) {
        winningDriver = selectBestDriver(compatibleDrivers)
        if (winningDriver) {
          deviationKm = winningDriver.deviationKm
        }
      }
    }

    if (deviationKm === null && deliveryMode === "CROSS_SHIPPING") {
      const priceRoute = await buildPrice({
        pickupCoordinates: req.body.pickup.location.coordinates,
        dropoffCoordinates: req.body.dropoff.location.coordinates,
        packageInfo: req.body.package,
        isUrgent: req.body.isUrgent,
        mode: deliveryMode,
        deviationKm: 0,
      })
      const fallbackDeviation = Math.max(1, priceRoute.distanceKm * 0.05)
      deviationKm = fallbackDeviation
    }

    const pricing = await buildPrice({
      pickupCoordinates: req.body.pickup.location.coordinates,
      dropoffCoordinates: req.body.dropoff.location.coordinates,
      packageInfo: req.body.package,
      isUrgent: req.body.isUrgent,
      mode: deliveryMode,
      deviationKm: deviationKm ?? 0,
    })

    const estimateMeta = await saveDeliveryEstimate(null, {
      requesterId: req.user.id,
      pickup: req.body.pickup,
      dropoff: req.body.dropoff,
      packageInfo: req.body.package,
      isUrgent: !!req.body.isUrgent,
      pricing,
    })

    return sendSuccess(res, 200, "Delivery price estimated successfully", {
      estimateId: estimateMeta.estimateId,
      expiresAt: estimateMeta.expiresAt,
      pricing,
      deliveryMode: match.deliveryMode,
      isProTransporter: match.isProTransporter,
      winningDriver: winningDriver
        ? {
            driverId: winningDriver.driverId,
            score: winningDriver.score,
            deviationKm: winningDriver.deviationKm,
            isBestDeal: winningDriver.deviationKm <= 3,
          }
        : null,
    })
  } catch (error) {
    console.error(`[PRICE STEP ERROR] estimateDeliveryPrice failed:`, error?.message || error)
    next(error)
  }
}

export const createDelivery = async (req, res, next) => {
  try {
    req.body = sanitizeDeliveryInput(req.body)

    const publishNow = req.body.publishNow !== false
    let attachedTripId = null
    if (req.body.tripId) {
      const tripRows = await exec(
        null,
        `SELECT id
         FROM Trips
         WHERE id = ? AND status IN ('planned','active') AND available_capacity > 0
         LIMIT 1`,
        [req.body.tripId],
      )

      if (!tripRows.length) {
        return next(createError(400, "Selected trip is not available for attachment"))
      }

      attachedTripId = req.body.tripId
    }

    const deliveryId = crypto.randomUUID()
    const paymentMethod = req.body.paymentMethod || "cash"
    const paymentStatus = paymentMethod === "cash" ? "cash_pending" : "pending"

    const result = await withTransaction(async (connection) => {
      delete req.body.estimatedPrice
      delete req.body.estimated_price

      const pricingResult = await resolvePricingForCreate(connection, {
        body: req.body,
        requesterId: req.user.id,
      })

      const winningDriver = pricingResult.winningDriver
      const assignedTripId = winningDriver?.bestTrip?.tripId || attachedTripId
      const assignedDriverId = winningDriver?.driverId || null

      const pickupAddress = req.body.pickup?.address || ''
      const dropoffAddress = req.body.dropoff?.address || ''
      const pickupWilaya = extractWilaya(pickupAddress)
      const dropoffWilaya = extractWilaya(dropoffAddress)

      const delivery = await createDeliveryRecord(connection, {
        id: deliveryId,
        requesterId: req.user.id,
        tripId: assignedTripId,
        assignedDriverId,
        pickup: req.body.pickup,
        dropoff: req.body.dropoff,
        pickupWilaya,
        dropoffWilaya,
        recipient: req.body.recipient,
        packageInfo: req.body.package,
        packageImageUrl: req.body.packageImageUrl || "",
        deliveryNote: req.body.deliveryNote,
        isUrgent: !!req.body.isUrgent,
        deliveryMode: pricingResult.deliveryMode || "standard",
        pricing: buildPricingPayload(pricingResult.pricing),
        payment: {
          method: paymentMethod,
          status: paymentStatus,
          transactionId: null,
        },
        status: publishNow ? DELIVERY_STATUS.PENDING : DELIVERY_STATUS.DRAFT,
      })

      {
        const isBestDeal = winningDriver ? winningDriver.deviationKm <= 3 : false
        try {
          await savePricingAnalytics(connection, delivery.id, {
            mode: pricingResult.pricingMode || "CROSS_SHIPPING",
            distanceKm: pricingResult.pricing.distanceKm,
            baseFee: pricingResult.pricing.baseFee,
            distanceFee: pricingResult.pricing.distanceFee,
            sizeSurcharge: pricingResult.pricing.sizeSurcharge,
            weightSurcharge: pricingResult.pricing.weightSurcharge,
            deviationCost: pricingResult.pricing.deviationCost || 0,
            urgentSurcharge: pricingResult.pricing.urgentSurcharge,
            estimatedPrice: pricingResult.pricing.estimatedPrice,
            driverScore: winningDriver ? winningDriver.score : null,
            selectedDriverId: winningDriver ? winningDriver.driverId : null,
            isBestDeal,
          })
        } catch (analyticsError) {
          console.error("Failed to save pricing analytics (non-fatal):", analyticsError?.message || analyticsError)
        }

      }

      if (pricingResult.estimate?.id) {
        await consumeEstimate(connection, pricingResult.estimate.id)
      }

      return {
        delivery,
        pricingSource: pricingResult.source,
        estimateId: pricingResult.estimate?.id || null,
        winningDriver: winningDriver
          ? {
              driverId: winningDriver.driverId,
              score: winningDriver.score,
              deviationKm: winningDriver.deviationKm,
              isBestDeal: winningDriver.deviationKm <= 3,
            }
          : null,
      }
    })

    if (publishNow && result.delivery?.id) {
      sendNewDeliveryNearbyNotifications({ id: result.delivery.id }).catch(() => {})
    }

    const pdfUrl = buildDeliveryPdfUrl(req, result.delivery.id)
    return sendSuccess(res, 201, "Delivery created successfully", {
      delivery: result.delivery,
      pdfUrl,
      pricingSource: result.pricingSource,
      estimateId: result.estimateId,
      deliveryMode: result.delivery?.deliveryMode || "standard",
      nextStep: publishNow ? "created_pending" : "draft_created",
    })
  } catch (error) {
    next(error)
  }
}

export const createDraftDelivery = async (req, res, next) => {
  try {
    req.body.publishNow = false
    return createDelivery(req, res, next)
  } catch (error) {
    next(error)
  }
}

export const publishDraftDelivery = async (req, res, next) => {
  try {
    const updated = await withTransaction(async (connection) => {
      const rows = await exec(
        connection,
        `SELECT id, requester_id, status
         FROM Deliveries
         WHERE id = ?
         FOR UPDATE`,
        [req.params.deliveryId],
      )

      const row = rows[0]
      if (!row) {
        throw createError(404, "Delivery not found")
      }

      if (row.requester_id !== req.user.id) {
        throw createError(403, "Only delivery owner can publish this draft")
      }

      if (row.status === DELIVERY_STATUS.PENDING) {
        return findDeliveryById(connection, req.params.deliveryId, { includeDriver: true, includeRequester: true, includeTrip: true })
      }

      if (row.status !== DELIVERY_STATUS.DRAFT) {
        throw createError(400, "Only draft deliveries can be published")
      }

      if (req.body.estimateId) {
        const estimate = await getEstimateById(connection, req.body.estimateId, req.user.id, { forUpdate: true })
        await exec(
          connection,
          `UPDATE DeliveryPricing
           SET base_fee = ?, distance_fee = ?, weight_surcharge = ?, size_surcharge = ?, urgent_surcharge = ?, price = ?, currency = ?
           WHERE delivery_id = ?`,
          [
            estimate.pricing.baseFee,
            estimate.pricing.distanceFee,
            estimate.pricing.weightSurcharge,
            estimate.pricing.sizeSurcharge,
            estimate.pricing.urgentSurcharge,
            estimate.pricing.estimatedPrice,
            estimate.pricing.currency || "DA",
            req.params.deliveryId,
          ],
        )
        await consumeEstimate(connection, req.body.estimateId)
      }

      await updateDeliveryStatusModel(connection, req.params.deliveryId, DELIVERY_STATUS.PENDING, row.status, req.user.id)

      return findDeliveryById(connection, req.params.deliveryId, { includeDriver: true, includeRequester: true, includeTrip: true })
    })

    return sendSuccess(res, 200, "Delivery published successfully", {
      delivery: updated,
      nextStep: "awaiting_driver_assignment",
    })
  } catch (error) {
    next(error)
  }
}

export const getDeliveryPdf = async (req, res, next) => {
  try {
    const context = await loadDeliveryPrintContext(req.params.deliveryId)
    if (!context || !canAccessDeliveryPrint({ delivery: context.delivery, user: req.user })) {
      return next(createError(403, "You are not authorized to access this delivery PDF"))
    }

    const buffer = await generateDeliveryPdfBuffer(context.payload)
    return sendPdfInline(res, {
      fileName: `delivery-${req.params.deliveryId}.pdf`,
      buffer,
    })
  } catch (error) {
    next(error)
  }
}

export const listUserDeliveries = async (req, res, next) => {
  try {
    const { status, statusGroup } = req.query

    if (statusGroup && !CLIENT_STATUS_GROUPS.has(statusGroup)) {
      return next(createError(400, "Invalid statusGroup value"))
    }

    const page = toBoundedPositiveInteger(req.query.page, {
      fallback: DEFAULT_PAGE,
      min: 1,
    })
    const limit = toBoundedPositiveInteger(req.query.limit, {
      fallback: DEFAULT_USER_LIMIT,
      min: 1,
      max: MAX_LIST_LIMIT,
    })
    const skip = (page - 1) * limit

    const deliveries = await listUserDeliveriesModel(null, req.user.id, {
      status: status || null,
      statusGroup: statusGroup || null,
      limit,
      offset: skip,
    })

    const total = await countUserDeliveries(null, req.user.id, {
      status: status || null,
      statusGroup: statusGroup || null,
    })

    // Always compute counts for all status groups (for tab badges)
    const [pendingCount, inProgressCount, deliveredCount, cancelledCount] = await Promise.all([
      countUserDeliveries(null, req.user.id, { statusGroup: "pending" }),
      countUserDeliveries(null, req.user.id, { statusGroup: "inProgress" }),
      countUserDeliveries(null, req.user.id, { statusGroup: "delivered" }),
      countUserDeliveries(null, req.user.id, { statusGroup: "cancelled" }),
    ])

    const deliveriesWithLabels = deliveries.map((delivery) => ({
      ...delivery,
      statusLabel: STATUS_DISPLAY_LABELS[delivery.status] || delivery.status,
      statusGroupLabel: STATUS_GROUP_DISPLAY_LABELS[delivery.statusGroup] || delivery.statusGroup,
    }))

    const overallTotal = pendingCount + inProgressCount + deliveredCount + cancelledCount

    return sendSuccess(res, 200, "User deliveries fetched successfully", {
      deliveries: deliveriesWithLabels,
      pagination: {
        total,
        page,
        pages: Math.ceil(total / limit),
        limit,
      },
      groupCounts: {
        all: overallTotal,
        pending: pendingCount,
        inProgress: inProgressCount,
        delivered: deliveredCount,
        cancelled: cancelledCount,
      },
    })
  } catch (error) {
    next(error)
  }
}

export const listAdminDeliveries = async (req, res, next) => {
  try {
    const {
      status,
      senderId,
      assignedDriverId,
      tripId,
      startDate,
      endDate,
    } = req.query

    const page = toBoundedPositiveInteger(req.query.page, {
      fallback: DEFAULT_PAGE,
      min: 1,
    })
    const limit = toBoundedPositiveInteger(req.query.limit, {
      fallback: DEFAULT_ADMIN_LIMIT,
      min: 1,
      max: MAX_LIST_LIMIT,
    })

    const skip = (page - 1) * limit

    const startValue = startDate ? new Date(startDate) : null
    const endValue = endDate ? new Date(endDate) : null

    const deliveries = await listAdminDeliveriesModel(null, {
      status: status || null,
      senderId: senderId || null,
      assignedDriverId: assignedDriverId || null,
      tripId: tripId || null,
      startDate: startValue && !Number.isNaN(startValue.getTime()) ? startValue : null,
      endDate: endValue && !Number.isNaN(endValue.getTime()) ? endValue : null,
      limit,
      offset: skip,
    })

    const total = await countAdminDeliveries(null, {
      status: status || null,
      senderId: senderId || null,
      assignedDriverId: assignedDriverId || null,
      tripId: tripId || null,
      startDate: startValue && !Number.isNaN(startValue.getTime()) ? startValue : null,
      endDate: endValue && !Number.isNaN(endValue.getTime()) ? endValue : null,
    })

    return sendSuccess(res, 200, "Admin delivery list fetched successfully", {
      deliveries,
      pagination: {
        total,
        page,
        pages: Math.ceil(total / limit),
        limit,
      },
    })
  } catch (error) {
    next(error)
  }
}

export const listDriverDeliveries = async (req, res, next) => {
  try {
   // Verify driver profile exists
   const driver = await findDriverByUserId(null, req.user.id)
   if (!driver) {
     return next(createError(404, "Driver profile not found"))
   }

    const { status } = req.query
    const page = toBoundedPositiveInteger(req.query.page, {
      fallback: DEFAULT_PAGE,
      min: 1,
    })
    const limit = toBoundedPositiveInteger(req.query.limit, {
      fallback: DEFAULT_USER_LIMIT,
      min: 1,
      max: MAX_LIST_LIMIT,
    })
    const skip = (page - 1) * limit

    const deliveries = await listDriverDeliveriesModel(null, req.user.id, {
      status: status || null,
      limit,
      offset: skip,
    })

    const total = await countDriverDeliveries(null, req.user.id, {
      status: status || null,
    })

    const deliveriesWithLabels = deliveries.map((delivery) => ({
      ...delivery,
      statusLabel: STATUS_DISPLAY_LABELS[delivery.status] || delivery.status,
      statusGroupLabel: STATUS_GROUP_DISPLAY_LABELS[delivery.statusGroup] || delivery.statusGroup,
    }))

    return sendSuccess(res, 200, "Driver deliveries fetched successfully", {
      deliveries: deliveriesWithLabels,
      pagination: {
        total,
        page,
        pages: Math.ceil(total / limit),
        limit,
      },
    })
  } catch (error) {
    next(error)
  }
}

export const getDeliveryById = async (req, res, next) => {
  try {
    const delivery = await findDeliveryById(null, req.params.deliveryId, {
      includeDriver: true,
      includeRequester: true,
      includeTrip: true,
    })

    if (!delivery) {
      return next(createError(404, "Delivery not found"))
    }

    // Allow drivers to view pending available deliveries (e.g. from notification)
    if (!(req.user.role === "driver" && delivery.status === "Pending" && !delivery.assignedDriverId)) {
      assertCanAccessDelivery({ delivery, user: req.user })
    }

    let tracking = null
    try {
      tracking = await buildTrackingPayload(delivery)
    } catch (_error) {
      tracking = null
    }

    const deliveryWithExtras = {
      ...delivery,
      statusLabel: STATUS_DISPLAY_LABELS[delivery.status] || delivery.status,
      statusGroupLabel: STATUS_GROUP_DISPLAY_LABELS[delivery.statusGroup] || delivery.statusGroup,
    }

    let compatibility = null
    let execution = null
    if (req.user.role === "driver") {
      const driverTrips = await listDriverTripsForCompatibility(null, req.user.id)
      compatibility = buildDeliveryCompatibility(deliveryWithExtras, driverTrips)
      execution = buildDriverExecutionPayload(deliveryWithExtras)
    }

    return sendSuccess(res, 200, "Delivery fetched successfully", {
      delivery: deliveryWithExtras,
      tracking,
      compatibility,
      execution,
    })
  } catch (error) {
    next(error)
  }
}

export const getDriverExecutionPayload = async (req, res, next) => {
  try {
    const delivery = await findDeliveryById(null, req.params.deliveryId, {
      includeDriver: true,
      includeRequester: true,
      includeTrip: true,
    })

    if (!delivery) {
      return next(createError(404, "Delivery not found"))
    }

    if (delivery.assignedDriverId !== req.user.id) {
      return next(createError(403, "Only assigned driver can access execution payload"))
    }

    return sendSuccess(res, 200, "Driver execution payload fetched successfully", {
      delivery,
      execution: buildDriverExecutionPayload(delivery),
    })
  } catch (error) {
    next(error)
  }
}

export const getDeliveryTracking = async (req, res, next) => {
  try {
    const rows = await exec(
      null,
      `SELECT id, requester_id FROM Deliveries WHERE id = ? LIMIT 1`,
      [req.params.deliveryId],
    )

    if (!rows[0] || rows[0].requester_id !== req.user.id) {
      return next(createError(403, "You are not authorized to access this delivery tracking"))
    }

    const delivery = await findDeliveryById(null, req.params.deliveryId, {
      includeDriver: true,
      includeRequester: true,
      includeTrip: true,
    })

    // Driver location
    let driverLocation = null
    if (delivery.assignedDriverId) {
      const locRows = await exec(
        null,
        `SELECT latitude, longitude, \`timestamp\` FROM DriverLocation WHERE driver_id = ? LIMIT 1`,
        [delivery.assignedDriverId],
      )
      if (locRows[0]) {
        driverLocation = {
          lat: Number(locRows[0].latitude),
          lng: Number(locRows[0].longitude),
          timestamp: locRows[0].timestamp,
        }
      }
    }

    // Pickup / dropoff coordinates
    const deliveryLocRows = await exec(
      null,
      `SELECT type, latitude, longitude FROM DeliveryLocations WHERE delivery_id = ?`,
      [req.params.deliveryId],
    )
    let pickupCoords = null
    let dropoffCoords = null
    for (const r of deliveryLocRows) {
      if (r.latitude != null && r.longitude != null) {
        if (r.type === "PICKUP") pickupCoords = { lat: Number(r.latitude), lng: Number(r.longitude) }
        if (r.type === "DROPOFF") dropoffCoords = { lat: Number(r.latitude), lng: Number(r.longitude) }
      }
    }

    // Estimated arrival from trip
    let estimatedArrival = null
    if (delivery.trip?.expectedArrivalTime) {
      estimatedArrival = delivery.trip.expectedArrivalTime
    }

    // Distance remaining (haversine driver -> dropoff)
    let distanceRemaining = null
    if (driverLocation && dropoffCoords) {
      const distM = haversineDistance(
        { lat: driverLocation.lat, lng: driverLocation.lng },
        { lat: dropoffCoords.lat, lng: dropoffCoords.lng },
      )
      if (distM != null) {
        distanceRemaining = Math.round((distM / 1000) * 100) / 100
      }
    }

    return sendSuccess(res, 200, "Delivery tracking fetched successfully", {
      deliveryId: delivery.id,
      status: delivery.status,
      statusLabel: STATUS_DISPLAY_LABELS[delivery.status] || delivery.status,
      driverLocation,
      pickupCoords,
      dropoffCoords,
      estimatedArrival,
      distanceRemaining,
    })
  } catch (error) {
    next(error)
  }
}

export const getDeliveryStatusHistory = async (req, res, next) => {
  try {
    const delivery = await findDeliveryById(null, req.params.deliveryId, {
      includeDriver: true,
      includeRequester: true,
      includeTrip: false,
    })

    if (!delivery) {
      return next(createError(403, "You are not authorized to access this delivery status history"))
    }

    assertCanAccessDelivery({ delivery, user: req.user })

    const rows = await exec(
      null,
      `SELECT status, changed_by, changed_at
       FROM DeliveryStatusHistory
       WHERE delivery_id = ?
       ORDER BY changed_at ASC`,
      [req.params.deliveryId],
    )

    const history = rows.map((r) => {
      let changedBy = "system"
      if (r.changed_by != null) {
        if (delivery.assignedDriverId && String(r.changed_by) === String(delivery.assignedDriverId)) {
          changedBy = "driver"
        } else if (String(r.changed_by) === String(delivery.senderId)) {
          changedBy = "client"
        }
      }
      return {
        status: r.status,
        statusLabel: STATUS_DISPLAY_LABELS[r.status] || r.status,
        changedAt: r.changed_at,
        changedBy,
      }
    })

    return sendSuccess(res, 200, "Delivery status history fetched successfully", history)
  } catch (error) {
    next(error)
  }
}

export const getDeliveryTrackingStream = async (req, res, next) => {
  try {
    const delivery = await findDeliveryById(null, req.params.deliveryId, {
      includeDriver: true,
      includeRequester: true,
      includeTrip: true,
    })

    if (!delivery) {
      return next(createError(403, "You are not authorized to access this delivery tracking stream"))
    }

    assertCanAccessDelivery({ delivery, user: req.user })

    const lastEventId = String(req.headers["last-event-id"] || req.query.lastEventId || "").trim() || null

    res.setHeader("Content-Type", "text/event-stream")
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("Connection", "keep-alive")

    if (typeof res.flushHeaders === "function") {
      res.flushHeaders()
    }

    let eventIndex = 1
    const emitTrackingEvent = async () => {
      const fresh = await findDeliveryById(null, req.params.deliveryId, {
        includeDriver: true,
        includeRequester: true,
        includeTrip: true,
      })

      if (!fresh) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: "Delivery not found" })}\n\n`)
        return
      }

      const payload = await buildTrackingPayload(fresh)
      const eventId = String(Date.now() + eventIndex)
      eventIndex += 1

      if (lastEventId && eventId <= lastEventId) {
        return
      }

      res.write(`id: ${eventId}\n`)
      res.write(`event: tracking\n`)
      res.write(`data: ${JSON.stringify({ ...payload, streamUpdatedAt: new Date().toISOString() })}\n\n`)
    }

    await emitTrackingEvent()

    const interval = setInterval(() => {
      emitTrackingEvent().catch((error) => {
        res.write(`event: error\ndata: ${JSON.stringify({ message: error?.message || "Tracking stream error" })}\n\n`)
      })
    }, TRACKING_STREAM_INTERVAL_MS)

    req.on("close", () => {
      clearInterval(interval)
      res.end()
    })
  } catch (error) {
    next(error)
  }
}

export const attachDeliveryToTrip = async (req, res, next) => {
  try {
    let tripDriverId = null

    const updated = await withTransaction(async (connection) => {
      const rows = await exec(
        connection,
        `SELECT requester_id, assigned_driver_id, status
         FROM Deliveries
         WHERE id = ?
         FOR UPDATE`,
        [req.params.deliveryId],
      )

      const deliveryRow = rows[0]
      if (!deliveryRow) {
        throw createError(404, "Delivery not found")
      }

      if (deliveryRow.requester_id !== req.user.id) {
        throw createError(403, "Only delivery owner can attach this delivery to a trip")
      }

      if (deliveryRow.status !== DELIVERY_STATUS.PENDING || deliveryRow.assigned_driver_id) {
        throw createError(400, "Only unassigned pending deliveries can be attached to a trip")
      }

      const tripRows = await exec(
        connection,
        `SELECT id, driver_id
         FROM Trips
         WHERE id = ? AND status IN ('planned','active') AND available_capacity > 0
         LIMIT 1`,
        [req.body.tripId],
      )

      if (!tripRows.length) {
        throw createError(400, "Selected trip is not available for attachment")
      }

      tripDriverId = tripRows[0].driver_id

      await exec(connection, `UPDATE Deliveries SET trip_id = ? WHERE id = ?`, [req.body.tripId, req.params.deliveryId])
      return findDeliveryById(connection, req.params.deliveryId, { includeDriver: true, includeRequester: false, includeTrip: true })
    })

    // Notify driver and client via socket
    if (tripDriverId) {
      const deliverySummary = {
        deliveryId: updated.id,
        pickupAddress: updated.pickup?.address || "",
        dropoffAddress: updated.dropoff?.address || "",
        recipientName: updated.recipient?.name || "",
        packageType: updated.package?.type || "",
        estimatedPrice: updated.pricing?.estimatedPrice ?? null,
        tripId: req.body.tripId,
      }
      emitToUser(tripDriverId, "driver:new_delivery_on_trip", deliverySummary)
    }

    if (updated.trip) {
      emitToUser(req.user.id, "client:trip_attached", {
        tripId: updated.trip.id,
        tripTitle: updated.trip.title || "",
        departureTime: updated.trip.departureTime,
        expectedArrivalTime: updated.trip.expectedArrivalTime,
        driverId: updated.trip.driverId,
      })
    }

    return sendSuccess(res, 200, "Delivery attached to trip successfully", { delivery: updated })
  } catch (error) {
    next(error)
  }
}

export const detachDeliveryFromTrip = async (req, res, next) => {
  try {
    let tripDriverId = null
    let tripId = null

    await withTransaction(async (connection) => {
      const rows = await exec(
        connection,
        `SELECT requester_id, assigned_driver_id, status, trip_id
         FROM Deliveries
         WHERE id = ?
         FOR UPDATE`,
        [req.params.deliveryId],
      )

      const row = rows[0]
      if (!row) {
        throw createError(404, "Delivery not found")
      }

      if (row.requester_id !== req.user.id) {
        throw createError(403, "Only delivery owner can detach this delivery from a trip")
      }

      if (row.status !== DELIVERY_STATUS.PENDING) {
        throw createError(400, "Only pending deliveries can be detached from a trip")
      }

      if (!row.trip_id) {
        throw createError(400, "Delivery is not attached to any trip")
      }

      tripDriverId = null
      tripId = row.trip_id

      const tripRows = await exec(
        connection,
        `SELECT driver_id FROM Trips WHERE id = ? LIMIT 1`,
        [row.trip_id],
      )
      if (tripRows[0]) {
        tripDriverId = tripRows[0].driver_id
      }

      await exec(connection, `UPDATE Deliveries SET trip_id = NULL WHERE id = ?`, [req.params.deliveryId])
    })

    // Notify driver via socket
    if (tripDriverId) {
      emitToUser(tripDriverId, "driver:delivery_removed_from_trip", {
        deliveryId: req.params.deliveryId,
        tripId,
      })
    }

    return sendSuccess(res, 200, "Delivery detached from trip successfully", {
      deliveryId: req.params.deliveryId,
      previousTripId: tripId,
    })
  } catch (error) {
    next(error)
  }
}

export const cancelDelivery = async (req, res, next) => {
  try {
    let originalTripId = null

    const result = await withTransaction(async (connection) => {
      const rows = await exec(
        connection,
        `SELECT id, requester_id, assigned_driver_id, trip_id, status, capacity_reserved
         FROM Deliveries
         WHERE id = ?
         FOR UPDATE`,
        [req.params.deliveryId],
      )

      const row = rows[0]
      if (!row) {
        throw createError(404, "Delivery not found")
      }

      const isAdminLike = req.user.role === "admin" || req.user.role === "authority"
      const isOwner = row.requester_id === req.user.id
      const isAssignedDriver = row.assigned_driver_id && row.assigned_driver_id === req.user.id

      if (!isOwner && !isAssignedDriver && !isAdminLike) {
        throw createError(403, "Only delivery owner, assigned driver or admin can cancel this delivery")
      }

      const cancellationStatuses = new Set([
        DELIVERY_STATUS.CANCELLED_BY_USER,
        DELIVERY_STATUS.CANCELLED_BY_DRIVER,
      ])

      if (cancellationStatuses.has(row.status)) {
        return findDeliveryById(connection, req.params.deliveryId, { includeDriver: true, includeRequester: true, includeTrip: true })
      }

      const ownerCancelAllowed = new Set([
        DELIVERY_STATUS.DRAFT,
        DELIVERY_STATUS.PENDING,
        DELIVERY_STATUS.ACCEPTED,
      ])

      if (isOwner && !ownerCancelAllowed.has(row.status)) {
        throw createError(400, "Delivery cannot be cancelled in the current status")
      }

      if (isTerminalDeliveryStatus(row.status)) {
        throw createError(400, "Terminal delivery records cannot be changed")
      }

      const nextStatus = isAssignedDriver ? DELIVERY_STATUS.CANCELLED_BY_DRIVER : DELIVERY_STATUS.CANCELLED_BY_USER

      if (row.trip_id) {
        originalTripId = row.trip_id
      }

      if (row.assigned_driver_id) {
        await exec(connection, `UPDATE Drivers SET is_available = 1 WHERE participant_id = ?`, [row.assigned_driver_id])
      }

      if (row.trip_id && Number(row.capacity_reserved || 0) > 0) {
        await exec(connection, `UPDATE Trips SET available_capacity = available_capacity + 1 WHERE id = ?`, [row.trip_id])
      }

      await exec(
        connection,
        `UPDATE Deliveries
         SET status = ?, assigned_driver_id = NULL, trip_id = NULL, capacity_reserved = 0
         WHERE id = ?`,
        [nextStatus, req.params.deliveryId],
      )

      await insertDeliveryStatusHistory(connection, req.params.deliveryId, nextStatus, isAdminLike ? req.user.id : (isOwner ? req.user.id : null))
      await touchTimeline(connection, req.params.deliveryId, STATUS_TO_TIMELINE_COLUMN[nextStatus])

      const defaultReason = isAssignedDriver ? "Cancelled by driver" : isAdminLike ? "Cancelled by admin" : "Cancelled by user"
      const cancelledByUserId = isAssignedDriver ? null : req.user.id
      const cancelledByDriverId = isAssignedDriver ? req.user.id : null
      await exec(
        connection,
        `INSERT INTO DeliveryCancellation (id, delivery_id, cancelled_by_user_id, cancelled_by_driver_id, reason)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           cancelled_by_user_id = VALUES(cancelled_by_user_id),
           cancelled_by_driver_id = VALUES(cancelled_by_driver_id),
           reason = VALUES(reason),
           cancelled_at = CURRENT_TIMESTAMP`,
        [crypto.randomUUID(), req.params.deliveryId, cancelledByUserId, cancelledByDriverId, req.body.reason || defaultReason],
      )

      return findDeliveryById(connection, req.params.deliveryId, { includeDriver: true, includeRequester: true, includeTrip: true })
    })

    // Auto-complete the trip if no more active deliveries
    if (originalTripId) {
      checkAndCompleteTrip(null, originalTripId).catch(() => {})
    }

    if (result.status === DELIVERY_STATUS.CANCELLED_BY_DRIVER) {
      notifyClient(
        result.senderId,
        "notification:cancelled",
        { deliveryId: result.id },
        {
          recipient: result.senderId,
          title: "Delivery cancelled",
          message: "Le livreur a annulé votre livraison. Elle est de nouveau en attente.",
          type: "cancelled",
          reference: result.id,
          referenceModel: "Delivery",
          deliveryId: result.id,
        },
      )
    }

    return sendSuccess(res, 200, "Delivery cancelled successfully", { delivery: result })
  } catch (error) {
    next(error)
  }
}

export const listDriverAvailableDeliveries = async (req, res, next) => {
  try {
    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const filters = req.query || {}
    const page = Math.max(1, Number(filters.page) || 1)
    const limit = Math.min(100, Math.max(1, Number(filters.limit) || 20))

    const driverLocation = await getDriverLocation(null, req.user.id)
    const hasLocation = driverLocation && driverLocation.latitude != null && driverLocation.longitude != null
    const locationWarning = !hasLocation
    const driverLat = hasLocation ? Number(driverLocation.latitude) : null
    const driverLng = hasLocation ? Number(driverLocation.longitude) : null

    const driverTripsPromise = listDriverTripsForCompatibility(null, req.user.id)

    const params = [req.user.id, req.user.id]
    const clauses = [
      "d.status = 'Pending'",
      "d.assigned_driver_id IS NULL",
      "r.id IS NULL",
      "(d.trip_id IS NULL OR d.trip_id IN (SELECT t.id FROM Trips t WHERE t.driver_id = ? AND t.status IN ('planned','active')))",
    ]
    const joins = [
      "LEFT JOIN DeliveryRejections r ON r.delivery_id = d.id AND r.driver_id = ?",
      "LEFT JOIN DeliveryPricing dp ON dp.delivery_id = d.id",
      "LEFT JOIN DeliveryLocations pl ON pl.delivery_id = d.id AND pl.type = 'PICKUP'",
    ]

    if (filters.min_price != null) {
      clauses.push("dp.price >= ?")
      params.push(Number(filters.min_price))
    }
    if (filters.max_price != null) {
      clauses.push("dp.price <= ?")
      params.push(Number(filters.max_price))
    }
    if (filters.package_size) {
      clauses.push("d.package_size_category = ?")
      params.push(String(filters.package_size).toUpperCase())
    }
    if (filters.max_weight_kg != null) {
      clauses.push("d.package_weight_kg <= ?")
      params.push(Number(filters.max_weight_kg))
    }
    if (filters.wilaya_pickup) {
      clauses.push("d.pickup_wilaya = ?")
      params.push(filters.wilaya_pickup)
    }
    if (filters.wilaya_dropoff) {
      clauses.push("d.dropoff_wilaya = ?")
      params.push(filters.wilaya_dropoff)
    }

    const where = clauses.join(" AND ")
    const joinSql = joins.join(" ")

    const rows = await exec(
      null,
      `SELECT d.id, ANY_VALUE(pl.latitude) AS pickup_lat, ANY_VALUE(pl.longitude) AS pickup_lng,
               ANY_VALUE(dp.price) AS price, ANY_VALUE(d.created_at) AS created_at
       FROM Deliveries d
       ${joinSql}
       WHERE ${where}
       GROUP BY d.id
       ORDER BY d.created_at DESC
       LIMIT 500`,
      params,
    )

    const candidates = []
    for (const row of rows) {
      let distanceKm = null
      if (hasLocation && row.pickup_lat != null) {
        const dist = distanceMeters(
          [Number(row.pickup_lng), Number(row.pickup_lat)],
          [driverLng, driverLat],
        )
        if (dist != null) distanceKm = Math.round((dist / 1000) * 100) / 100
      }

      if (hasLocation && filters.radius_km != null && distanceKm != null && distanceKm > Number(filters.radius_km)) {
        continue
      }

      candidates.push({ id: row.id, distanceKm, price: Number(row.price || 0), createdAt: row.created_at })
    }

    if (filters.sort_by === "distance_asc") {
      candidates.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity))
    } else if (filters.sort_by === "price_asc") {
      candidates.sort((a, b) => a.price - b.price)
    } else if (filters.sort_by === "price_desc") {
      candidates.sort((a, b) => b.price - a.price)
    }

    const total = candidates.length
    const paginatedCandidates = candidates.slice((page - 1) * limit, page * limit)

    const driverTrips = await driverTripsPromise
    const deliveries = []

    for (const c of paginatedCandidates) {
      const delivery = await findDeliveryById(null, c.id, {
        includeDriver: false,
        includeRequester: false,
        includeTrip: true,
      })
      if (!delivery) continue

      const compatibility = buildDeliveryCompatibility(delivery, driverTrips)
      const match = buildDeliveryMatch({ delivery, driverTrips, driverLocation })

      deliveries.push({
        ...delivery,
        distanceKm: c.distanceKm,
        compatibility,
        match,
      })
    }

    if (!filters.sort_by) {
      deliveries.sort((a, b) => a.match.score - b.match.score)
    }

    const response = {
      deliveries,
      total,
      page,
      limit,
    }

    if (locationWarning) {
      response.locationWarning = true
    }

    return sendSuccess(res, 200, "Available deliveries fetched successfully", response)
  } catch (error) {
    next(error)
  }
}

export const getEarningsPreview = async (req, res, next) => {
  try {
    const deliveryId = req.params.deliveryId
    const driverId = req.user.id

    const delivery = await findDeliveryById(null, deliveryId)
    if (!delivery) return next(createError(403, "You are not authorized to access this delivery"))
    if (delivery.status !== 'Pending') return next(createError(400, "Delivery is no longer available"))
    if (delivery.assignedDriverId) return next(createError(400, "Delivery already has an assigned driver"))

    const pricing = delivery.pricing
    if (!pricing) return next(createError(500, "Pricing data not found"))
    const basePrice = Number(pricing.estimatedPrice)

    const platformFee = Math.round(basePrice * 0.1 * 100) / 100
    const driverEarnings = basePrice - platformFee

    const driverLoc = await getDriverLocation(null, driverId)
    if (!driverLoc) return next(createError(400, "Driver location not available. Update your location first."))

    const locRows = await exec(
      null,
      `SELECT latitude, longitude FROM DeliveryLocations WHERE delivery_id = ? AND type = 'PICKUP' LIMIT 1`,
      [deliveryId],
    )
    if (!locRows[0]) return next(createError(500, "Pickup location not found"))

    const distanceM = distanceMeters(
      [Number(driverLoc.longitude), Number(driverLoc.latitude)],
      [Number(locRows[0].longitude), Number(locRows[0].latitude)],
    )
    const distanceKm = Math.round((distanceM / 1000) * 100) / 100

    const settingRows = await exec(
      null,
      `SELECT setting_value FROM Settings WHERE setting_key = 'fuel_cost_per_km'`,
    )
    const fuelCostPerKm = Number(settingRows[0]?.setting_value) || 8

    const estimatedFuelCost = Math.round(distanceKm * fuelCostPerKm * 100) / 100
    const netProfit = Math.round((driverEarnings - estimatedFuelCost) * 100) / 100

    let profitabilityScore
    if (distanceKm <= 0) {
      profitabilityScore = 'fair'
    } else {
      const ratio = netProfit / distanceKm
      if (ratio >= 50) profitabilityScore = 'excellent'
      else if (ratio >= 25) profitabilityScore = 'good'
      else if (ratio >= 10) profitabilityScore = 'fair'
      else profitabilityScore = 'low'
    }

    const breakdown = [
      { label: 'Prix de livraison', amount: basePrice },
      { label: 'Commission Tawsil (10%)', amount: -platformFee },
      { label: 'Carburant estimé', amount: -estimatedFuelCost },
      { label: 'Bénéfice net', amount: netProfit, highlight: true },
    ]

    return sendSuccess(res, 200, 'Earnings preview calculated', {
      deliveryId,
      basePrice,
      platformFee,
      driverEarnings,
      distanceFromDriver: distanceKm,
      estimatedFuelCost,
      netProfit,
      profitabilityScore,
      breakdown,
    })
  } catch (error) {
    next(error)
  }
}

export const acceptDelivery = async (req, res, next) => {
  try {
    const deliveryId = req.params.deliveryId
    const driverId = req.user.id
    const requestedTripId = req.body.tripId || null

    let requesterId = null
    let originalTripId = null

    const txResult = await withTransaction(async (connection) => {
      const deliveryRows = await exec(
        connection,
        `SELECT requester_id, assigned_driver_id, trip_id, status, package_size_category
         FROM Deliveries
         WHERE id = ?
         FOR UPDATE`,
        [deliveryId],
      )

      const deliveryRow = deliveryRows[0]
      if (!deliveryRow) {
        throw createError(404, "Delivery not found")
      }

      requesterId = deliveryRow.requester_id
      originalTripId = deliveryRow.trip_id || null

      if (deliveryRow.assigned_driver_id) {
        if (deliveryRow.assigned_driver_id === driverId) {
          const current = await findDeliveryById(connection, deliveryId, { includeDriver: true, includeRequester: false, includeTrip: true })
          return { delivery: current }
        }

        throw createError(409, "Delivery has already been claimed by another driver")
      }

      if (deliveryRow.status !== DELIVERY_STATUS.PENDING) {
        throw createError(409, "Delivery is no longer available")
      }

      const rejectionRows = await exec(
        connection,
        `SELECT 1 FROM DeliveryRejections WHERE delivery_id = ? AND driver_id = ? LIMIT 1`,
        [deliveryId, driverId],
      )
      if (rejectionRows.length) {
        throw createError(400, "Delivery is no longer available for this driver")
      }

      const driverRows = await exec(
        connection,
        `SELECT participant_id, is_documents_verified, is_available
         FROM Drivers
         WHERE participant_id = ?
         FOR UPDATE`,
        [driverId],
      )

      const driverRow = driverRows[0]
      if (!driverRow) {
        throw createError(404, "Driver profile not found")
      }

      if (!driverRow.is_documents_verified) {
        throw createError(403, "Driver is not eligible to accept deliveries")
      }

      if (!driverRow.is_available) {
        throw createError(403, "Driver is not eligible to accept deliveries")
      }

      let tripId = requestedTripId || deliveryRow.trip_id || null
      if (deliveryRow.trip_id && requestedTripId && deliveryRow.trip_id !== requestedTripId) {
        throw createError(400, "Delivery is already attached to a different trip")
      }

      if (tripId) {
        const tripRows = await exec(
          connection,
          `SELECT id, driver_id, status, available_capacity, accepted_package_size,
                  departure_time, expected_arrival_time
           FROM Trips
           WHERE id = ?
           FOR UPDATE`,
          [tripId],
        )

        const tripRow = tripRows[0]
        if (!tripRow) {
          throw createError(400, "Trip is not available or has no capacity")
        }

        if (tripRow.driver_id !== driverId) {
          throw createError(403, "Trip is not available or has no capacity")
        }

        if (!['planned','active'].includes(tripRow.status)) {
          throw createError(400, "Trip is not available or has no capacity")
        }

        if (Number(tripRow.available_capacity) <= 0) {
          throw createError(400, "Trip is not available or has no capacity")
        }

        const packageLevel = PACKAGE_SIZE_LEVEL[String(deliveryRow.package_size_category || "").toLowerCase()] || null
        const acceptedSize = String(tripRow.accepted_package_size || "any")
        const tripSizeLevel = TRIP_ACCEPTED_SIZE_LEVEL[acceptedSize] || TRIP_ACCEPTED_SIZE_LEVEL.any
        if (packageLevel && packageLevel > tripSizeLevel) {
          throw createError(400, "Package size is not compatible with this trip")
        }

        // Check that the delivery can be completed before the trip's expected arrival
        if (tripRow.expected_arrival_time) {
          const tripArrival = new Date(tripRow.expected_arrival_time)
          const now = new Date()
          if (tripArrival <= now) {
            throw createError(400, "Le trajet est déjà terminé. Vous ne pouvez pas accepter de livraison.")
          }
        }

        // Check route compatibility (wilaya-level)
        const tripLocRows = await exec(
          connection,
          `SELECT type, address FROM TripLocations WHERE trip_id = ?`,
          [tripId],
        )
        const delLocRows = await exec(
          connection,
          `SELECT type, address FROM DeliveryLocations WHERE delivery_id = ?`,
          [deliveryId],
        )

        const extractWilaya = (addr) => {
          if (!addr) return ""
          const parts = addr.split(",").map((s) => s.trim()).filter(Boolean)
          return parts.length > 0 ? parts[parts.length - 1].toLowerCase() : ""
        }

        const tripOriginWilaya = extractWilaya(tripLocRows.find((l) => l.type === "START")?.address || "")
        const tripDestWilaya = extractWilaya(tripLocRows.find((l) => l.type === "END")?.address || "")
        const delPickupWilaya = extractWilaya(delLocRows.find((l) => l.type === "PICKUP")?.address || "")
        const delDropoffWilaya = extractWilaya(delLocRows.find((l) => l.type === "DROPOFF")?.address || "")

        const wilayaMatch = (a, b) => a && b && a === b

        if (tripOriginWilaya && delPickupWilaya && !wilayaMatch(tripOriginWilaya, delPickupWilaya)) {
          throw createError(400, "La livraison n'est pas sur l'itinéraire de votre trajet (wilaya de départ incompatible).")
        }
        if (tripDestWilaya && delDropoffWilaya && !wilayaMatch(tripDestWilaya, delDropoffWilaya)) {
          throw createError(400, "La livraison n'est pas sur l'itinéraire de votre trajet (wilaya de destination incompatible).")
        }

        const updateTripResult = await exec(
          connection,
          `UPDATE Trips SET available_capacity = available_capacity - 1 WHERE id = ? AND available_capacity > 0`,
          [tripId],
        )

        if (updateTripResult?.affectedRows === 0) {
          throw createError(400, "Trip is not available or has no capacity")
        }
      }

      await exec(
        connection,
        `UPDATE Deliveries
         SET assigned_driver_id = ?, trip_id = ?, status = ?, capacity_reserved = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [driverId, tripId, DELIVERY_STATUS.ACCEPTED, tripId ? 1 : 0, deliveryId],
      )

      await insertDeliveryStatusHistory(connection, deliveryId, DELIVERY_STATUS.ACCEPTED, driverId)
      await touchTimeline(connection, deliveryId, STATUS_TO_TIMELINE_COLUMN[DELIVERY_STATUS.ACCEPTED])

      await exec(connection, `UPDATE Drivers SET is_available = 0 WHERE participant_id = ?`, [driverId])

      const delivery = await findDeliveryById(connection, deliveryId, {
        includeDriver: true,
        includeRequester: false,
        includeTrip: true,
      })

      const pricingRows = await exec(
        connection,
        `SELECT price FROM DeliveryPricing WHERE delivery_id = ? LIMIT 1`,
        [deliveryId],
      )
      const basePrice = Number(pricingRows[0]?.price || 0)
      const platformFee = Math.round(basePrice * 0.1 * 100) / 100
      const driverEarningsVal = basePrice - platformFee

      const locRows = await exec(
        connection,
        `SELECT latitude, longitude FROM DeliveryLocations WHERE delivery_id = ? AND type = 'PICKUP' LIMIT 1`,
        [deliveryId],
      )
      const dlRows = await exec(
        connection,
        `SELECT latitude, longitude FROM DriverLocation WHERE driver_id = ? LIMIT 1`,
        [driverId],
      )

      let distanceKm = 0
      if (locRows[0] && dlRows[0]) {
        const dist = distanceMeters(
          [Number(dlRows[0].longitude), Number(dlRows[0].latitude)],
          [Number(locRows[0].longitude), Number(locRows[0].latitude)],
        )
        distanceKm = Math.round((dist / 1000) * 100) / 100
      }

      const settingRows = await exec(
        connection,
        `SELECT setting_value FROM Settings WHERE setting_key = 'fuel_cost_per_km'`,
      )
      const fuelCostPerKm = Number(settingRows[0]?.setting_value) || 8
      const estimatedFuelCost = Math.round(distanceKm * fuelCostPerKm * 100) / 100
      const netProfitVal = Math.round((driverEarningsVal - estimatedFuelCost) * 100) / 100

      const snapshotData = { basePrice, platformFee, driverEarnings: driverEarningsVal, distanceKm, fuelCostPerKm, estimatedFuelCost, netProfit: netProfitVal }

      await exec(
        connection,
        `INSERT INTO DeliveryEarningsSnapshot (id, delivery_id, driver_id, estimated_earnings, snapshot_data)
         VALUES (?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), deliveryId, driverId, netProfitVal, JSON.stringify(snapshotData)],
      )

      return { delivery, earningsSnapshot: snapshotData }
    })

    const acceptedDelivery = txResult.delivery
    const driverName = [
      acceptedDelivery.assignedDriver?.user?.firstName,
      acceptedDelivery.assignedDriver?.user?.lastName,
    ].filter(Boolean).join(" ")

    notifyClient(
      requesterId,
      "notification:delivery_accepted",
      {
        deliveryId: acceptedDelivery.id,
        driverName,
        driverPhone: acceptedDelivery.assignedDriver?.user?.phone || null,
        estimatedPickupTime: acceptedDelivery.trip?.departureTime || null,
      },
      {
        recipient: requesterId,
        title: "Delivery accepted",
        message: `Votre colis a été accepté par ${driverName}. Il arrivera bientôt.`,
        type: "delivery_accepted",
        reference: acceptedDelivery.id,
        referenceModel: "Delivery",
        deliveryId: acceptedDelivery.id,
        sendEmail: false,
      },
    )

    return sendSuccess(res, 200, "Delivery accepted successfully", {
      delivery: acceptedDelivery,
    })
  } catch (error) {
    next(error)
  }
}

export const rejectDelivery = async (req, res, next) => {
  try {
    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const delivery = await withTransaction(async (connection) => {
      const rows = await exec(
        connection,
        `SELECT status, assigned_driver_id
         FROM Deliveries
         WHERE id = ?
         FOR UPDATE`,
        [req.params.deliveryId],
      )

      const row = rows[0]
      if (!row) {
        throw createError(404, "Delivery not found")
      }

      if (row.status !== DELIVERY_STATUS.PENDING || row.assigned_driver_id) {
        throw createError(400, "Delivery is no longer available for rejection")
      }

      try {
        await exec(
          connection,
          `INSERT INTO DeliveryRejections (id, delivery_id, driver_id, reason)
           VALUES (?, ?, ?, ?)`,
          [crypto.randomUUID(), req.params.deliveryId, req.user.id, req.body.reason || null],
        )
      } catch (error) {
        if (error?.code !== "ER_DUP_ENTRY") {
          throw error
        }
      }

      return findDeliveryById(connection, req.params.deliveryId, { includeDriver: false, includeRequester: false, includeTrip: true })
    })

    return sendSuccess(res, 200, "Delivery rejected successfully", {
      delivery,
      reason: req.body.reason || null,
    })
  } catch (error) {
    next(error)
  }
}

export const getDriverActiveDelivery = async (req, res, next) => {
  try {
    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const rows = await exec(
      null,
      `SELECT id FROM Deliveries
       WHERE assigned_driver_id = ? AND status IN ('Accepted','DriverArrivedPickup','PickedUp','InTransit','ArrivedDropoff')
       ORDER BY updated_at DESC
       LIMIT 1`,
      [req.user.id],
    )

    const row = rows[0]
    const delivery = row
      ? await findDeliveryById(null, row.id, { includeDriver: true, includeRequester: true, includeTrip: true })
      : null

    return sendSuccess(res, 200, "Active delivery fetched successfully", {
      delivery,
      execution: delivery ? buildDriverExecutionPayload(delivery) : null,
    })
  } catch (error) {
    next(error)
  }
}

export const updateDriverLiveLocation = async (req, res, next) => {
  try {
    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const [lng, lat] = req.body.coordinates

    if (Math.abs(lng) > 180 || Math.abs(lat) > 90) {
      return next(createError(400, "Invalid coordinates"))
    }

    await upsertDriverLocation(null, {
      driverId: req.user.id,
      latitude: lat,
      longitude: lng,
    })

    // Broadcast to clients watching this driver's active deliveries
    try {
      const io = getIO()
      if (io) {
        const activeRows = await exec(
          null,
          `SELECT id, requester_id FROM Deliveries
           WHERE assigned_driver_id = ?
             AND status IN ('Accepted','DriverArrivedPickup','PickedUp','InTransit','ArrivedDropoff')`,
          [req.user.id],
        )
        for (const row of activeRows) {
          io.to(`client:${row.requester_id}`).emit("delivery:driver_location", {
            deliveryId: row.id,
            coordinates: [lng, lat],
            heading: null,
            speed: null,
            accuracy: null,
            isLowAccuracy: false,
            timestamp: new Date().toISOString(),
          })
        }
      }
    } catch (_) {}

    return sendSuccess(res, 200, "Driver location updated successfully", {
      currentLocation: {
        type: "Point",
        coordinates: [lng, lat],
      },
    })
  } catch (error) {
    next(error)
  }
}

export const markPickupCompleted = async (req, res, next) => {
  try {
    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    // OTP verification for pickup (optional, can be skipped if not required)
    const otpCode = String(req.body?.otp || "").trim()
    const { maxAttempts } = getOtpConfig()

    const updated = await withTransaction(async (connection) => {
      const rows = await exec(
        connection,
        `SELECT status, assigned_driver_id, requester_id
         FROM Deliveries
         WHERE id = ?
         FOR UPDATE`,
        [req.params.deliveryId],
      )

      const row = rows[0]
      if (!row) {
        throw createError(404, "Delivery not found")
      }

      if (!row.assigned_driver_id || row.assigned_driver_id !== req.user.id) {
        throw createError(403, "Only assigned driver can update this delivery")
      }

      if ([DELIVERY_STATUS.PICKED_UP, DELIVERY_STATUS.IN_TRANSIT, DELIVERY_STATUS.ARRIVED_DROPOFF, DELIVERY_STATUS.DELIVERED].includes(row.status)) {
        throw createError(409, "Pickup has already been completed for this delivery")
      }

      if (![DELIVERY_STATUS.ACCEPTED, DELIVERY_STATUS.DRIVER_ARRIVED_PICKUP].includes(row.status)) {
        throw createError(400, `Pickup cannot be completed from status ${row.status}`)
      }

      // Optional OTP verification if provided
      if (otpCode) {
        const otpRows = await exec(
          connection,
          `SELECT otp_hash, expires_at, attempts
           FROM DeliveryOtps
           WHERE delivery_id = ?
           FOR UPDATE`,
          [req.params.deliveryId],
        )

        const otpRow = otpRows[0]
        if (otpRow) {
          const expiresAt = new Date(otpRow.expires_at)
          if (!Number.isNaN(expiresAt.getTime()) && expiresAt > new Date()) {
            if (Number(otpRow.attempts || 0) < maxAttempts) {
              const otpOk = await bcrypt.compare(otpCode, otpRow.otp_hash)
              if (!otpOk) {
                await exec(connection, `UPDATE DeliveryOtps SET attempts = attempts + 1 WHERE delivery_id = ?`, [req.params.deliveryId])
                throw createError(400, "Invalid OTP")
              }
            }
          }
        }
      }

      if (row.status === DELIVERY_STATUS.ACCEPTED) {
        await updateDeliveryStatusModel(connection, req.params.deliveryId, DELIVERY_STATUS.DRIVER_ARRIVED_PICKUP, row.status, req.user.id)
        await touchTimeline(connection, req.params.deliveryId, STATUS_TO_TIMELINE_COLUMN[DELIVERY_STATUS.DRIVER_ARRIVED_PICKUP])
        row.status = DELIVERY_STATUS.DRIVER_ARRIVED_PICKUP
      }

      await updateDeliveryStatusModel(connection, req.params.deliveryId, DELIVERY_STATUS.PICKED_UP, row.status, req.user.id)
      await touchTimeline(connection, req.params.deliveryId, STATUS_TO_TIMELINE_COLUMN[DELIVERY_STATUS.PICKED_UP])

      return findDeliveryById(connection, req.params.deliveryId, { includeDriver: true, includeRequester: true, includeTrip: true })
    })

    // Notify requester of pickup
    createNotificationAfterCommit({
      recipient: updated.senderId,
      title: "Package picked up",
      message: "Your package has been picked up by the driver",
      type: "delivery_picked_up",
      reference: updated.id,
      referenceModel: "Delivery",
      deliveryId: updated.id,
    })

    return sendSuccess(res, 200, "Pickup status updated successfully", {
      delivery: updated,
      execution: buildDriverExecutionPayload(updated),
    })
  } catch (error) {
    next(error)
  }
}

export const updateDeliveryProgress = async (req, res, next) => {
  try {
    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const { status } = req.body
    if (!status) {
      return next(createError(400, "status is required"))
    }

    let generatedOtp = null

    const updated = await withTransaction(async (connection) => {
      const rows = await exec(
        connection,
        `SELECT status, assigned_driver_id
         FROM Deliveries
         WHERE id = ?
         FOR UPDATE`,
        [req.params.deliveryId],
      )

      const row = rows[0]
      if (!row) {
        throw createError(404, "Delivery not found")
      }

      if (!row.assigned_driver_id || row.assigned_driver_id !== req.user.id) {
        throw createError(403, "Only assigned driver can update this delivery")
      }

      if (row.status !== status && !canTransitionDeliveryStatus(row.status, status)) {
        throw createError(400, `Invalid status transition from ${row.status} to ${status}`)
      }

      if (row.status !== status) {
        await updateDeliveryStatusModel(connection, req.params.deliveryId, status, row.status, req.user.id)
        await touchTimeline(connection, req.params.deliveryId, STATUS_TO_TIMELINE_COLUMN[status])
      }

      if (status === DELIVERY_STATUS.ARRIVED_DROPOFF) {
        const { ttlMinutes } = getOtpConfig()
        const otp = generateOtpCode()
        const otpHash = await bcrypt.hash(String(otp), 10)
        const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000)
        const expiresSql = toSqlDateTime(expiresAt)

        await exec(
          connection,
          `INSERT INTO DeliveryOtps (id, delivery_id, otp_hash, expires_at, attempts)
           VALUES (?, ?, ?, ?, 0)
           ON DUPLICATE KEY UPDATE
             otp_hash = VALUES(otp_hash),
             expires_at = VALUES(expires_at),
             attempts = 0`,
          [crypto.randomUUID(), req.params.deliveryId, otpHash, expiresSql],
        )
        generatedOtp = otp
      }

      if (status === DELIVERY_STATUS.FAILED_DELIVERY) {
        await exec(connection, `UPDATE Drivers SET is_available = 1 WHERE participant_id = ?`, [req.user.id])
      }

      return findDeliveryById(connection, req.params.deliveryId, { includeDriver: true, includeRequester: true, includeTrip: true })
    })

    if (status === DELIVERY_STATUS.DRIVER_ARRIVED_PICKUP) {
      const driverName = [
        updated.assignedDriver?.user?.firstName,
        updated.assignedDriver?.user?.lastName,
      ].filter(Boolean).join(" ")

      notifyClient(
        updated.senderId,
        "notification:driver_arrived_pickup",
        { deliveryId: updated.id, driverName },
        {
          recipient: updated.senderId,
          title: "Driver arrived at pickup",
          message: `${driverName || "Le livreur"} est arrivé à votre point de collecte.`,
          type: "driver_arrived",
          reference: updated.id,
          referenceModel: "Delivery",
          deliveryId: updated.id,
        },
      )
    }

    if (status === DELIVERY_STATUS.IN_TRANSIT) {
      const dropoffCity = updated.dropoff?.address || "la destination"

      notifyClient(
        updated.senderId,
        "notification:in_transit",
        { deliveryId: updated.id, dropoffCity },
        {
          recipient: updated.senderId,
          title: "Package in transit",
          message: `Votre colis est en route vers ${dropoffCity}.`,
          type: "in_transit",
          reference: updated.id,
          referenceModel: "Delivery",
          deliveryId: updated.id,
        },
      )
    }

    if (status === DELIVERY_STATUS.ARRIVED_DROPOFF && generatedOtp) {
      const otpMessage = `Votre code de confirmation est : ${generatedOtp}. Communiquez ce code au livreur afin de confirmer la livraison.`

      notifyClient(
        updated.senderId,
        "notification:delivery_otp",
        { deliveryId: updated.id, otpCode: generatedOtp },
        {
          recipient: updated.senderId,
          title: "Code de confirmation de livraison",
          message: otpMessage,
          type: "delivery_otp",
          reference: updated.id,
          referenceModel: "Delivery",
          deliveryId: updated.id,
          sendEmail: false,
        },
      )
    }

    // Auto-complete trip if delivery reached a terminal status
    if (updated?.tripId && isTerminalDeliveryStatus(updated.status)) {
      checkAndCompleteTrip(null, updated.tripId).catch(() => {})
    }

    return sendSuccess(res, 200, "Delivery progress updated successfully", {
      delivery: updated,
      execution: buildDriverExecutionPayload(updated),
    })
  } catch (error) {
    next(error)
  }
}

export const markDeliveryCompleted = async (req, res, next) => {
  try {
    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const proof = req.body?.proofOfDelivery || {}
    const otpCode = String(proof.recipientCode || "").trim()
    if (!otpCode) {
      return next(createError(400, "recipientCode is required to confirm delivery"))
    }

    const { maxAttempts } = getOtpConfig()

    const updated = await withTransaction(async (connection) => {
      const rows = await exec(
        connection,
        `SELECT requester_id, assigned_driver_id, status
         FROM Deliveries
         WHERE id = ?
         FOR UPDATE`,
        [req.params.deliveryId],
      )

      const row = rows[0]
      if (!row) {
        throw createError(404, "Delivery not found")
      }

      if (row.assigned_driver_id !== req.user.id) {
        throw createError(403, "Only assigned driver can complete this delivery")
      }

      if (row.status === DELIVERY_STATUS.DELIVERED) {
        return findDeliveryById(connection, req.params.deliveryId, { includeDriver: true, includeRequester: true, includeTrip: true })
      }

      if (!canTransitionDeliveryStatus(row.status, DELIVERY_STATUS.DELIVERED)) {
        throw createError(400, `Invalid status transition from ${row.status} to ${DELIVERY_STATUS.DELIVERED}`)
      }

      const otpRows = await exec(
        connection,
        `SELECT otp_hash, expires_at, attempts
         FROM DeliveryOtps
         WHERE delivery_id = ?
         FOR UPDATE`,
        [req.params.deliveryId],
      )

      const otpRow = otpRows[0]
      if (!otpRow) {
        throw createError(409, "Delivery OTP is missing")
      }

      const expiresAt = new Date(otpRow.expires_at)
      if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
        throw createError(400, "Delivery OTP is expired")
      }

      if (Number(otpRow.attempts || 0) >= maxAttempts) {
        throw createError(429, "Too many OTP attempts")
      }

      const otpOk = await bcrypt.compare(otpCode, otpRow.otp_hash)
      if (!otpOk) {
        await exec(connection, `UPDATE DeliveryOtps SET attempts = attempts + 1 WHERE delivery_id = ?`, [req.params.deliveryId])
        throw createError(400, "Invalid delivery OTP")
      }

      await updateDeliveryStatusModel(connection, req.params.deliveryId, DELIVERY_STATUS.DELIVERED, row.status, req.user.id)
      await touchTimeline(connection, req.params.deliveryId, STATUS_TO_TIMELINE_COLUMN[DELIVERY_STATUS.DELIVERED])

      await exec(
        connection,
        `INSERT INTO DeliveryProofs (id, delivery_id, photo_url, recipient_name, recipient_signature, notes, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           photo_url = VALUES(photo_url),
           recipient_name = VALUES(recipient_name),
           recipient_signature = VALUES(recipient_signature),
           notes = VALUES(notes),
           confirmed_at = VALUES(confirmed_at)`,
        [
          crypto.randomUUID(),
          req.params.deliveryId,
          proof.photoUrl || null,
          proof.recipientName || null,
          proof.recipientSignature || null,
          proof.notes || null,
        ],
      )

      if (typeof req.body.finalPrice === "number") {
        await exec(connection, `UPDATE DeliveryPricing SET final_price = ? WHERE delivery_id = ?`, [req.body.finalPrice, req.params.deliveryId])
      } else {
        await exec(connection, `UPDATE DeliveryPricing SET final_price = COALESCE(final_price, price) WHERE delivery_id = ?`, [req.params.deliveryId])
      }

      const fpRows = await exec(
        connection,
        `SELECT price, final_price FROM DeliveryPricing WHERE delivery_id = ? LIMIT 1`,
        [req.params.deliveryId],
      )
      const finalPriceVal = Number(fpRows[0]?.final_price || fpRows[0]?.price || 0)
      const platformFeeActual = Math.round(finalPriceVal * 0.1 * 100) / 100
      const actualEarnings = finalPriceVal - platformFeeActual

      await exec(
        connection,
        `UPDATE DeliveryEarningsSnapshot SET actual_earnings = ? WHERE delivery_id = ?`,
        [actualEarnings, req.params.deliveryId],
      )

      const paymentRows = await exec(
        connection,
        `SELECT method FROM DeliveryPayments WHERE delivery_id = ? FOR UPDATE`,
        [req.params.deliveryId],
      )

      const method = paymentRows[0]?.method
      if (method) {
        const nextPaymentStatus = method === "cash" ? "cash_received" : "completed"
        await exec(connection, `UPDATE DeliveryPayments SET status = ? WHERE delivery_id = ?`, [nextPaymentStatus, req.params.deliveryId])
      }

      await exec(connection, `UPDATE Drivers SET is_available = 1 WHERE participant_id = ?`, [req.user.id])

      return findDeliveryById(connection, req.params.deliveryId, { includeDriver: true, includeRequester: true, includeTrip: true })
    })

    notifyClient(
      updated.senderId,
      "notification:delivered",
      {
        deliveryId: updated.id,
        type: "rate_delivery",
        referenceId: updated.id,
        actionUrl: "/rate-delivery/${updated.id}",
      },
      {
        recipient: updated.senderId,
        title: "Votre livraison est terminée \u2B50",
        message: "Merci d'avoir utilisé TawsilGO. Prenez quelques secondes pour \u00E9valuer votre exp\u00E9rience.",
        type: "rate_delivery",
        reference: updated.id,
        referenceModel: "Delivery",
        deliveryId: updated.id,
        actionUrl: "/rate-delivery/${updated.id}",
      },
    )

    // Notify driver to rate the client
    createNotification({
      recipientId: req.user.id,
      title: "\u00C9valuez votre client \u2B50",
      message: "Votre livraison est termin\u00E9e. Merci de partager votre exp\u00E9rience avec le client.",
      type: "rate_client",
      deliveryId: updated.id,
      reference: updated.id,
      referenceModel: "Delivery",
    }).catch(() => {})

    // Auto-complete trip if all deliveries are done
    if (updated?.tripId) {
      checkAndCompleteTrip(null, updated.tripId).catch(() => {})
    }

    return sendSuccess(res, 200, "Delivery completed successfully", {
      delivery: updated,
      execution: buildDriverExecutionPayload(updated),
    })
  } catch (error) {
    next(error)
  }
}

export const getDriverHome = async (req, res, next) => {
  try {
    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    // Get stats
    const statsRows = await exec(
      null,
      `SELECT
         SUM(CASE WHEN status IN ('Accepted','DriverArrivedPickup','PickedUp','InTransit','ArrivedDropoff') THEN 1 ELSE 0 END) AS activeDeliveries,
         SUM(CASE WHEN status = 'Delivered' AND DATE(updated_at) = CURDATE() THEN 1 ELSE 0 END) AS completedToday,
         COALESCE(SUM(CASE WHEN status = 'Delivered' THEN COALESCE(dp.final_price, dp.price) ELSE 0 END), 0) AS totalEarnings,
         COUNT(*) AS totalDeliveries
       FROM Deliveries d
       LEFT JOIN DeliveryPricing dp ON dp.delivery_id = d.id
       WHERE d.assigned_driver_id = ?`,
      [req.user.id],
    )

    const stats = {
      activeDeliveries: Number(statsRows[0]?.activeDeliveries || 0),
      completedToday: Number(statsRows[0]?.completedToday || 0),
      totalEarnings: Number(statsRows[0]?.totalEarnings || 0),
      rating: Number(driver.rating || 0),
      availability: driver.availability || "offline",
    }

    // Get current active delivery
    const activeDeliveryRows = await exec(
      null,
      `SELECT id FROM Deliveries
       WHERE assigned_driver_id = ? AND status IN ('Accepted','DriverArrivedPickup','PickedUp','InTransit','ArrivedDropoff')
       ORDER BY updated_at DESC
       LIMIT 1`,
      [req.user.id],
    )

    let currentDelivery = null
    if (activeDeliveryRows[0]) {
      currentDelivery = await findDeliveryById(null, activeDeliveryRows[0].id, {
        includeDriver: true,
        includeRequester: true,
        includeTrip: true,
      })
    }

    // Get active trip
    const activeTripsRows = await exec(
      null,
      `SELECT id FROM Trips
       WHERE driver_id = ? AND status IN ('planned', 'active')
       ORDER BY departure_time ASC
       LIMIT 1`,
      [req.user.id],
    )

    let currentTrip = null
    if (activeTripsRows[0]) {
      currentTrip = await findTripById(null, activeTripsRows[0].id, { includeDriver: false })
      const tripDeliveryRows = await exec(
        null,
        `SELECT id, status FROM Deliveries WHERE trip_id = ?`,
        [currentTrip.id],
      )
      currentTrip.shipmentsCount = tripDeliveryRows.length
      currentTrip.shipments = tripDeliveryRows.map(d => ({
        id: d.id,
        status: d.status,
      }))
    }

    // Get recent deliveries (last 5)
    const recentDeliveryRows = await exec(
      null,
      `SELECT id FROM Deliveries
       WHERE assigned_driver_id = ?
       ORDER BY updated_at DESC
       LIMIT 5`,
      [req.user.id],
    )

    const recentDeliveries = []
    for (const row of recentDeliveryRows) {
      const delivery = await findDeliveryById(null, row.id, {
        includeDriver: false,
        includeRequester: true,
        includeTrip: false,
      })
      recentDeliveries.push({
        id: delivery.id,
        status: delivery.status,
        statusLabel: STATUS_DISPLAY_LABELS[delivery.status] || delivery.status,
        pickupAddress: delivery.pickup?.address || "",
        dropoffAddress: delivery.dropoff?.address || "",
        estimatedPrice: delivery.pricing?.estimatedPrice ?? null,
        recipientName: delivery.recipient?.name || null,
        updatedAt: delivery.updatedAt,
      })
    }

    let filterPreferences = null
    if (driver.filterPreferences) {
      try {
        filterPreferences = typeof driver.filterPreferences === "string"
          ? JSON.parse(driver.filterPreferences)
          : driver.filterPreferences
      } catch {
        filterPreferences = null
      }
    }

    return sendSuccess(res, 200, "Driver home fetched successfully", {
      driverId: driver.driverId,
      stats,
      currentDelivery: currentDelivery ? {
        id: currentDelivery.id,
        status: currentDelivery.status,
        statusLabel: STATUS_DISPLAY_LABELS[currentDelivery.status] || currentDelivery.status,
        pickupAddress: currentDelivery.pickup?.address || "",
        dropoffAddress: currentDelivery.dropoff?.address || "",
        estimatedPrice: currentDelivery.pricing?.estimatedPrice ?? null,
      } : null,
      currentTrip: currentTrip ? {
        id: currentTrip.id,
        status: currentTrip.status,
        departureTime: currentTrip.departureTime,
        expectedArrivalTime: currentTrip.expectedArrivalTime,
        maxDeliveries: currentTrip.maxDeliveries,
        availableCapacity: currentTrip.availableCapacity,
        shipmentsCount: currentTrip.shipmentsCount,
        shipments: currentTrip.shipments,
      } : null,
      recentDeliveries,
      filterPreferences,
      currency: "DA",
    })
  } catch (error) {
    next(error)
  }
}

export const getDriverCurrentTrip = async (req, res, next) => {
  try {
    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    // Get the active/planned trip for driver
    const tripRows = await exec(
      null,
      `SELECT id FROM Trips
       WHERE driver_id = ? AND status IN ('planned', 'active')
       ORDER BY departure_time ASC
       LIMIT 1`,
      [req.user.id],
    )

    if (!tripRows[0]) {
      return sendSuccess(res, 200, "No active trip found", {
        trip: null,
        waypoints: [],
        shipments: [],
      })
    }

    const trip = await findTripById(null, tripRows[0].id, { includeDriver: true })

    // Get all deliveries attached to this trip
    const deliveryRows = await exec(
      null,
      `SELECT id FROM Deliveries WHERE trip_id = ? ORDER BY created_at ASC`,
      [trip.id],
    )

    const shipments = []
    for (const row of deliveryRows) {
      const delivery = await findDeliveryById(null, row.id, {
        includeDriver: false,
        includeRequester: true,
        includeTrip: false,
      })
      shipments.push({
        id: delivery.id,
        status: delivery.status,
        statusLabel: STATUS_DISPLAY_LABELS[delivery.status] || delivery.status,
        pickupAddress: delivery.pickup?.address || "",
        pickupCoordinates: delivery.pickup?.location?.coordinates || null,
        dropoffAddress: delivery.dropoff?.address || "",
        dropoffCoordinates: delivery.dropoff?.location?.coordinates || null,
        packageType: delivery.package?.type || null,
        packageSize: delivery.package?.sizeCategory || null,
        recipientName: delivery.recipient?.name || null,
        estimatedPrice: delivery.pricing?.estimatedPrice ?? null,
      })
    }

    return sendSuccess(res, 200, "Driver current trip fetched successfully", {
      trip: {
        id: trip.id,
        status: trip.status,
        title: trip.title || "",
        departureTime: trip.departureTime,
        expectedArrivalTime: trip.expectedArrivalTime,
        maxDeliveries: trip.maxDeliveries,
        availableCapacity: trip.availableCapacity,
        vehicleType: trip.vehicleType || null,
        acceptedPackageSize: trip.acceptedPackageSize || null,
        origin: trip.origin,
        destination: trip.destination,
        notes: trip.notes || "",
      },
      shipments,
      waypointsCount: shipments.length,
      currency: "DA",
    })
  } catch (error) {
    next(error)
  }
}

export const updatePaymentStatus = async (req, res, next) => {
  try {
    const updated = await withTransaction(async (connection) => {
      const rows = await exec(
        connection,
        `SELECT status
         FROM Deliveries
         WHERE id = ?
         FOR UPDATE`,
        [req.params.deliveryId],
      )

      const row = rows[0]
      if (!row) {
        throw createError(404, "Delivery not found")
      }

      await exec(
        connection,
        `UPDATE DeliveryPayments
         SET status = ?, transaction_id = ?
         WHERE delivery_id = ?`,
        [req.body.status, req.body.transactionId || null, req.params.deliveryId],
      )

      if (req.body.status === "refunded") {
        if (!canTransitionDeliveryStatus(row.status, DELIVERY_STATUS.REFUNDED)) {
          throw createError(400, "This delivery cannot be refunded in the current status")
        }

        await updateDeliveryStatusModel(connection, req.params.deliveryId, DELIVERY_STATUS.REFUNDED, row.status, req.user.id)
        await touchTimeline(connection, req.params.deliveryId, STATUS_TO_TIMELINE_COLUMN[DELIVERY_STATUS.REFUNDED])
      }

      return findDeliveryById(connection, req.params.deliveryId, { includeDriver: true, includeRequester: true, includeTrip: true })
    })

    return sendSuccess(res, 200, "Payment status updated successfully", { delivery: updated })
  } catch (error) {
    next(error)
  }
}

// ── Helpers for wilaya backfill and matching ──

const fallbackPickupWilaya = async (deliveryId) => {
  try {
    const locRows = await exec(
      null,
      `SELECT address FROM DeliveryLocations WHERE delivery_id = ? AND type = 'PICKUP' LIMIT 1`,
      [deliveryId],
    )
    const address = locRows[0]?.address || ''
    return extractWilaya(address) || address.split(',').map((p) => p.trim()).filter(Boolean)[0] || ''
  } catch (_) {
    return ''
  }
}

const fallbackDropoffWilaya = async (deliveryId) => {
  try {
    const locRows = await exec(
      null,
      `SELECT address FROM DeliveryLocations WHERE delivery_id = ? AND type = 'DROPOFF' LIMIT 1`,
      [deliveryId],
    )
    const address = locRows[0]?.address || ''
    return extractWilaya(address) || address.split(',').map((p) => p.trim()).filter(Boolean)[0] || ''
  } catch (_) {
    return ''
  }
}

export const listDriverAvailablePackagesByWilaya = async (req, res, next) => {
  try {
    // ═══════════════════════════════════════════════════════════════
    // ÉTAPE 1-2: Identifier route, controller, requête SQL
    // Route:   GET /api/deliveries/driver/available-by-wilaya
    // Fichier: backend/routes/delivery.routes.js:90
    // Controller: backend/controllers/delivery.workflow.js
    //   → listDriverAvailablePackagesByWilaya (ligne 2462)
    // Modèle:  backend/models/delivery.model.js → findDeliveryById
    // ═══════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════
    // ÉTAPE 3: Récupération zone du Driver
    // ═══════════════════════════════════════════════════════════════
    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const userRows = await exec(null, `SELECT city FROM Users WHERE id = ?`, [req.user.id])
    const driverCityRaw = (userRows[0]?.city || '').trim()
    const driverCity = driverCityRaw

    const driverLocation = await getDriverLocation(null, req.user.id)
    const hasCoordinates = driverLocation && driverLocation.latitude != null && driverLocation.longitude != null
    const driverCoordinates = hasCoordinates ? [Number(driverLocation.longitude), Number(driverLocation.latitude)] : null

    console.log('')
    console.log('╔══════════════════════════════════════════════════════╗')
    console.log('║  [available-by-wilaya]   DEBUG SESSION              ║')
    console.log('╚══════════════════════════════════════════════════════╝')
    console.log(`Driver ID:       ${req.user.id}`)
    console.log(`Driver Wilaya:   "${driverCity}"`)
    console.log(`Driver GPS:      ${hasCoordinates ? `[${driverCoordinates}]` : 'NON DISPONIBLE'}`)
    console.log(`Driver Type:     ${driver.driverType}`)
    console.log(`Driver Vehicle:  ${driver.vehicleType || 'city_car (default)'}`)
    console.log(`Driver Max Kg:   ${driver.maxWeightKg}`)

    const driverType = driver.driverType || 'normal_driver'
    const driverMaxWeightKg = driver.maxWeightKg != null ? Number(driver.maxWeightKg) : null
    const driverTrips = await listDriverTripsForCompatibility(null, req.user.id)
    const driverVehicleType = driver.vehicleType || 'city_car'

    // ═══════════════════════════════════════════════════════════════
    // Requête SQL: récupérer les livraisons Pending non assignées
    // ═══════════════════════════════════════════════════════════════
    const baseParams = [req.user.id, req.user.id]
    const joins = [
      'LEFT JOIN DeliveryRejections r ON r.delivery_id = d.id AND r.driver_id = ?',
      'LEFT JOIN DeliveryPricing dp ON dp.delivery_id = d.id',
      'LEFT JOIN DeliveryLocations pl ON pl.delivery_id = d.id AND pl.type = \'PICKUP\'',
    ]
    const clauses = [
      "d.status = 'Pending'",
      'd.assigned_driver_id IS NULL',
      'r.id IS NULL',
      "(d.trip_id IS NULL OR d.trip_id IN (SELECT t.id FROM Trips t WHERE t.driver_id = ? AND t.status IN ('planned','active')))",
    ]

    // Wilaya filter: si le driver a une wilaya, filtrer par pickup_wilaya
    // SINON, prendre toutes les livraisons Pending (pas de restriction)
    if (driverCity) {
      clauses.push('d.pickup_wilaya = ?')
      baseParams.push(driverCity)
      console.log(`Wilaya filter:   d.pickup_wilaya = "${driverCity}"`)
    } else {
      console.log(`Wilaya filter:   AUCUN — driver sans wilaya, pas de filtre`)
    }

    const sqlQuery = `SELECT d.id,
        ANY_VALUE(pl.latitude) AS pickup_lat,
        ANY_VALUE(pl.longitude) AS pickup_lng,
        ANY_VALUE(pl.address) AS pickup_address,
        ANY_VALUE(dp.price) AS price,
        ANY_VALUE(d.created_at) AS created_at,
        ANY_VALUE(d.package_weight_kg) AS weight
 FROM Deliveries d
 ${joins.join(' ')}
 WHERE ${clauses.join(' AND ')}
 GROUP BY d.id
 ORDER BY d.created_at DESC
 LIMIT 500`

    console.log(`\n--- SQL QUERY ---\n${sqlQuery}`)
    console.log(`SQL Params:      ${JSON.stringify(baseParams)}`)

    const rows = await exec(null, sqlQuery, baseParams)

    console.log(`\nSQL RESULT:      ${rows.length} ligne(s) retournée(s)`)

    // ═══════════════════════════════════════════════════════════════
    // ÉTAPE 4: Analyser chaque livraison
    // ═══════════════════════════════════════════════════════════════
    const scoredDeliveries = []
    for (const row of rows) {
      const delivery = await findDeliveryById(null, row.id, {
        includeDriver: false,
        includeRequester: false,
        includeTrip: false,
      })
      if (!delivery) {
        console.log(`  Delivery ${row.id}: findDeliveryById returned null — SKIP`)
        continue
      }

      // ══════════════════════════════════════════════════════════
      // Récupérer pickup_wilaya: d'abord depuis le modèle,
      // sinon fallback depuis DeliveryLocations
      // ══════════════════════════════════════════════════════════
      let pickupWilaya = delivery?.pickupWilaya || null
      let dropoffWilaya = delivery?.dropoffWilaya || null

      if (!pickupWilaya) {
        pickupWilaya = await fallbackPickupWilaya(delivery.id)
        delivery.pickupWilaya = pickupWilaya
        console.log(`  Delivery ${delivery.id}: pickupWilaya NULL, fallback → "${pickupWilaya}"`)
      }
      if (!dropoffWilaya) {
        dropoffWilaya = await fallbackDropoffWilaya(delivery.id)
        delivery.dropoffWilaya = dropoffWilaya
      }

      console.log(`\n  ─── Delivery ${delivery.id} ───`)
      console.log(`  Pickup Wilaya:  "${pickupWilaya}"`)
      console.log(`  Dropoff Wilaya: "${dropoffWilaya}"`)
      console.log(`  Status:         ${delivery.status}`)
      console.log(`  Package:        ${delivery?.package?.sizeCategory || 'N/A'} / ${delivery?.package?.weightKg || '?'} kg`)

      // Vérifier compatibilité wilaya avant le calcul complet
      const cityMatch = driverCity && pickupWilaya
        ? pickupWilaya.toLowerCase() === driverCity.toLowerCase()
        : false
      if (!cityMatch) {
        console.log(`  Compatible:     NO — Wilaya différente`)
        console.log(`    Raison:       pickup="${pickupWilaya}" ≠ driverCity="${driverCity}"`)
        // Ne pas exclure — laisser calculateDriverDeliveryCompatibility décider
      }

      const compatibility = calculateDriverDeliveryCompatibility({
        delivery,
        driverCity,
        driverType,
        driverMaxWeightKg,
        driverVehicleType,
        driverTrips,
        driverCoordinates,
      })

      console.log(`  Compatible:     ${compatibility.compatible ? 'YES' : 'NO'}`)
      console.log(`  Score:          ${compatibility.score}/100`)
      console.log(`  Raisons:        ${compatibility.reasons.join(', ') || 'aucune'}`)

      scoredDeliveries.push({
        ...delivery,
        compatibilityScore: compatibility.score,
        compatibilityReasons: compatibility.reasons,
        compatible: compatibility.compatible,
      })
    }

    // Afficher le résumé
    const totalCompatible = scoredDeliveries.filter((d) => d.compatible).length
    console.log(`\n═══ RÉSUMÉ ═══`)
    console.log(`Total lignes SQL:    ${rows.length}`)
    console.log(`Total compatibles:   ${totalCompatible}`)
    console.log(`Total rejetés:       ${scoredDeliveries.length - totalCompatible}`)

    // Afficher les livraisons rejetées avec raison
    for (const d of scoredDeliveries) {
      if (!d.compatible) {
        const reason = d.compatibilityReasons?.join(', ') || 'inconnue'
        console.log(`  ✗ ${d.id}: ${reason}`)
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // ÉTAPE 5: Retourner uniquement les livraisons compatibles
    // ═══════════════════════════════════════════════════════════════
    const compatibleOnly = scoredDeliveries
      .filter((d) => d.compatible)
      .sort((a, b) => b.compatibilityScore - a.compatibilityScore || new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())

    const result = compatibleOnly.map(({ compatible, ...rest }) => rest)

    if (result.length === 0) {
      // Déterminer la raison du vide
      let emptyReason = 'Aucune livraison Pending trouvée dans votre zone.'
      if (rows.length === 0) {
        emptyReason = driverCity
          ? `Aucune livraison Pending trouvée dans la wilaya "${driverCity}". Vérifiez que des livraisons existent avec pickup_wilaya = "${driverCity}".`
          : `Aucune livraison Pending trouvée. Complétez votre profil (wilaya) pour filtrer par zone.`
      } else if (totalCompatible === 0) {
        emptyReason = `Des livraisons existent (${scoredDeliveries.length}) mais aucune n'est compatible avec votre profil (véhicule, poids, taille).`
      }
      console.log(`\n⚠ RÉSULTAT VIDE: ${emptyReason}`)
      return sendSuccess(res, 200, emptyReason, {
        deliveries: [],
        total: 0,
        debug: {
          driverCity,
          driverVehicleType,
          driverType,
          totalPending: rows.length,
          totalAfterCompatibility: totalCompatible,
          emptyReason,
        },
      })
    }

    return sendSuccess(res, 200, "Compatible packages fetched successfully", {
      deliveries: result,
      total: result.length,
    })
  } catch (error) {
    console.error(`[available-by-wilaya] ERREUR:`, error)
    next(error)
  }
}

// ── NEW: Intelligent recommended deliveries with matching engine ──

const VALID_SIZES = new Set(['small', 'medium', 'large', 'xlarge'])
const VALID_WEIGHTS = new Set(['0-5', '5-20', '20-100', '100+'])
const VALID_DAYS = new Set(['today', 'tomorrow'])

export const listDriverRecommendedDeliveries = async (req, res, next) => {
  try {
    const filters = {}
    const day = req.query.day?.toLowerCase()
    if (day && VALID_DAYS.has(day)) filters.day = day
    const size = req.query.size?.toLowerCase()
    if (size && VALID_SIZES.has(size)) filters.size = size
    const weight = req.query.weight?.toLowerCase()
    if (weight && VALID_WEIGHTS.has(weight)) filters.weight = weight

    const { deliveries } = await getRecommendedDeliveries(req.user.id, filters)

    return sendSuccess(res, 200, 'Deliveries scored successfully', {
      deliveries,
      total: deliveries.length,
    })
  } catch (error) {
    console.error('[recommended-deliveries] ERROR:', error)
    next(error)
  }
}
