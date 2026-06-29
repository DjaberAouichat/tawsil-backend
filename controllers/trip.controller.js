import crypto from "crypto"
import { getPool, withTransaction, exec } from "../lib/db.js"
import { findDriverByUserId } from "../models/driver.model.js"
import {
  autoCompleteExpiredTrips,
  checkAndCompleteTrip,
  countAvailableTrips,
  createTrip as createTripRecord,
  deleteTrip as deleteTripRecord,
  findTripById,
  findOverlappingTrips,
  listAvailableTrips as listAvailableTripRecords,
  listDriverTrips as listDriverTripRecords,
  updateTripDetails,
  updateTripStatus as updateTripStatusRecord,
} from "../models/trip.model.js"
import { findDeliveryById } from "../models/delivery.model.js"
import { touchTimeline } from "../services/delivery.service.js"
import { sendSuccess, createError } from "../utils/response.js"
import { getRequestBaseUrl, toBoundedPositiveInteger } from "../utils/helpers.js"
import { createNotification } from "../utils/notification.utils.js"
import {
  loadTripPrintContext,
  generateTripPdfBuffer,
  sendPdfInline,
} from "../utils/pdf.utils.js"
import { distanceMeters as haversineDistance } from "../utils/maps.js"

const buildTripPdfUrl = (req, tripId) => {
  return `${getRequestBaseUrl(req)}/api/trips/${tripId}/pdf`
}

const DEFAULT_DELIVERIES_PAGE = 1
const DEFAULT_DELIVERIES_LIMIT = 20
const MAX_DELIVERIES_LIMIT = 100
const DEFAULT_AVAILABLE_TRIPS_PAGE = 1
const DEFAULT_AVAILABLE_TRIPS_LIMIT = 20
const MAX_AVAILABLE_TRIPS_LIMIT = 100

const toOptionalDate = (value) => {
  if (!value) {
    return null
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

const withTripMeta = (trip) => ({
  ...trip,
  acceptsDeliveries: ["planned", "active"].includes(trip.status) && Number(trip.availableCapacity || 0) > 0,
})

const extractWilaya = (address) => {
  if (!address) return ""
  const parts = address.split(",").map((s) => s.trim()).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1].toLowerCase() : ""
}

const addressesMatch = (addr1, addr2) => {
  if (!addr1 || !addr2) return false
  const wilaya1 = extractWilaya(addr1)
  const wilaya2 = extractWilaya(addr2)
  if (wilaya1 && wilaya2 && wilaya1 === wilaya2) return true
  const words1 = addr1.toLowerCase().split(/[\s,]+/).filter((w) => w.length > 3)
  const words2 = addr2.toLowerCase().split(/[\s,]+/).filter((w) => w.length > 3)
  return words1.some((w) => words2.includes(w))
}

const notifyCompatibleDeliverySenders = async (trip) => {
  try {
    const pickupAddress = trip.origin?.address || ""
    const dropoffAddress = trip.destination?.address || ""

    if (!pickupAddress || !dropoffAddress) return

    const pendingDeliveries = await exec(
      null,
      `SELECT d.id, d.requester_id, d.status,
              pl.address AS pickup_address,
              dl.address AS dropoff_address
       FROM Deliveries d
       LEFT JOIN DeliveryLocations pl ON pl.delivery_id = d.id AND pl.type = 'PICKUP'
       LEFT JOIN DeliveryLocations dl ON dl.delivery_id = d.id AND dl.type = 'DROPOFF'
       WHERE d.status = 'Pending'
       ORDER BY d.created_at DESC`,
    )

    for (const delivery of pendingDeliveries) {
      const delPickup = delivery.pickup_address || ""
      const delDropoff = delivery.dropoff_address || ""

      if (addressesMatch(pickupAddress, delPickup) && addressesMatch(dropoffAddress, delDropoff)) {
        createNotification({
          recipient: delivery.requester_id,
          title: "Conducteur disponible trouvé",
          message: "Un conducteur effectue un trajet compatible avec votre livraison.",
          type: "trip_match",
          reference: trip.id,
          referenceModel: "Trip",
          deliveryId: delivery.id,
          tripId: trip.id,
          sendEmail: false,
        }).catch((err) => console.error("[trip] Failed to send match notification:", err))
      }
    }
  } catch (error) {
    console.error("[trip] Error notifying compatible deliveries:", error)
  }
}

const COMPATIBLE_ORIGIN_MAX_KM = Number(process.env.COMPATIBLE_ORIGIN_MAX_KM || 30)
const COMPATIBLE_DESTINATION_MAX_KM = Number(process.env.COMPATIBLE_DESTINATION_MAX_KM || 30)

const getCompatibilityLabel = (score) => {
  if (score >= 80) return "Parfait"
  if (score >= 60) return "Bon"
  if (score >= 40) return "Acceptable"
  return "Hors zone"
}

export const listCompatibleTripsForDelivery = async (req, res, next) => {
  try {
    const { deliveryId } = req.params

    const deliveryRows = await exec(
      null,
      `SELECT d.requester_id, d.status
       FROM Deliveries d
       WHERE d.id = ? LIMIT 1`,
      [deliveryId],
    )

    if (!deliveryRows[0]) {
      return next(createError(404, "Delivery not found"))
    }

    if (deliveryRows[0].requester_id !== req.user.id) {
      return next(createError(403, "Only the delivery owner can view compatible trips"))
    }

    const locRows = await exec(
      null,
      `SELECT type, latitude, longitude FROM DeliveryLocations WHERE delivery_id = ?`,
      [deliveryId],
    )
    let pickupLat = null, pickupLng = null, dropoffLat = null, dropoffLng = null
    for (const r of locRows) {
      if (r.type === "PICKUP" && r.latitude != null) { pickupLat = Number(r.latitude); pickupLng = Number(r.longitude) }
      if (r.type === "DROPOFF" && r.latitude != null) { dropoffLat = Number(r.latitude); dropoffLng = Number(r.longitude) }
    }

    if (!pickupLat || !dropoffLat) {
      return next(createError(400, "Delivery location coordinates are incomplete"))
    }

    const allTrips = await listAvailableTripRecords(null, {})
    const enriched = []

    for (const trip of allTrips) {
      const originCoords = trip.origin?.location?.coordinates
      const destCoords = trip.destination?.location?.coordinates
      if (!originCoords || !destCoords) continue

      const originDistance = haversineDistance(
        { lat: pickupLat, lng: pickupLng },
        { lat: originCoords[1], lng: originCoords[0] },
      )
      const destinationDistance = haversineDistance(
        { lat: dropoffLat, lng: dropoffLng },
        { lat: destCoords[1], lng: destCoords[0] },
      )

      const originKm = originDistance != null ? Math.round((originDistance / 1000) * 100) / 100 : null
      const destinationKm = destinationDistance != null ? Math.round((destinationDistance / 1000) * 100) / 100 : null

      const score = originKm != null && destinationKm != null
        ? Math.max(0, Math.min(100, Math.round(100 - (originKm + destinationKm))))
        : 0
      const isCompatible = originKm != null && destinationKm != null
        && originKm < COMPATIBLE_ORIGIN_MAX_KM && destinationKm < COMPATIBLE_DESTINATION_MAX_KM

      enriched.push({
        ...trip,
        acceptsDeliveries: ["planned", "active"].includes(trip.status) && Number(trip.availableCapacity || 0) > 0,
        compatibility: {
          originDistance: originKm,
          destinationDistance: destinationKm,
          score,
          isCompatible,
          label: getCompatibilityLabel(score),
        },
      })
    }

    enriched.sort((a, b) => b.compatibility.score - a.compatibility.score)

    return sendSuccess(res, 200, "Compatible trips fetched successfully", { trips: enriched })
  } catch (error) {
    next(error)
  }
}

export const createTrip = async (req, res, next) => {
  try {
    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    if (!driver.isDocumentsVerified) {
      return next(createError(403, "Driver account is not verified for trips"))
    }

    const departureTime = new Date(req.body.departureTime)
    const expectedArrivalTime = req.body.expectedArrivalTime ? new Date(req.body.expectedArrivalTime) : null

    const overlapping = await findOverlappingTrips(
      null,
      req.user.id,
      departureTime,
      expectedArrivalTime,
    )
    if (overlapping) {
      return next(createError(
        409,
        "Vous avez déjà un trajet planifié ou en cours pendant cette période. Terminez-le ou choisissez un autre horaire.",
      ))
    }

    const tripId = crypto.randomUUID()
    const routeData = req.body.route || null
    const routeGeometry = routeData?.points || null
    const routeDistanceMeters = routeData?.distanceMeters ?? null
    const routeDurationSeconds = routeData?.durationSeconds ?? null

    const trip = await withTransaction(async (connection) => {
      return createTripRecord(connection, {
        id: tripId,
        driverId: req.user.id,
        title: req.body.title,
        origin: req.body.origin,
        destination: req.body.destination,
        departureTime,
        expectedArrivalTime: expectedArrivalTime || null,
        maxDeliveries: req.body.maxDeliveries || 3,
        availableCapacity: req.body.maxDeliveries || 3,
        vehicleType: req.body.vehicleType || null,
        acceptedPackageSize: req.body.acceptedPackageSize || "any",
        status: "planned",
        notes: req.body.notes,
        routeGeometry,
        routeDistanceMeters,
        routeDurationSeconds,
      })
    })

    const pdfUrl = buildTripPdfUrl(req, trip.id)
    notifyCompatibleDeliverySenders(trip)
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[DRIVER ROUTE SELECTED] Trip ${trip.id} distance=${routeDistanceMeters}m duration=${routeDurationSeconds}s`)
    }
    return sendSuccess(res, 201, "Trip created successfully", { trip, pdfUrl })
  } catch (error) {
    next(error)
  }
}

export const getTripPdf = async (req, res, next) => {
  try {
    const context = await loadTripPrintContext(req.params.tripId)
    if (!context) {
      return next(createError(404, "Trip not found"))
    }

    const isAdminLike = req.user.role === "admin" || req.user.role === "authority"
    const isDriverOwner = context.trip.driverId === req.user.id

    if (!isAdminLike && !isDriverOwner) {
      return next(createError(403, "You are not authorized to access this trip PDF"))
    }

    const buffer = await generateTripPdfBuffer(context.payload)
    return sendPdfInline(res, {
      fileName: `trip-${req.params.tripId}.pdf`,
      buffer,
    })
  } catch (error) {
    next(error)
  }
}

export const listDriverTrips = async (req, res, next) => {
  try {
    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const trips = await listDriverTripRecords(null, req.user.id, {
      status: req.query.status || null,
    })

    return sendSuccess(res, 200, "Trips fetched successfully", { trips })
  } catch (error) {
    next(error)
  }
}

export const listDriverActiveTrips = async (req, res, next) => {
  try {
    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) {
      return next(createError(404, "Driver profile not found"))
    }

    const trips = await listDriverTripRecords(null, req.user.id, {
      status: null,
    })

    const activeTrips = trips.filter(
      (t) => t.status === "planned" || t.status === "active",
    )

    // Enrich with delivery counts
    const enriched = await Promise.all(activeTrips.map(async (trip) => {
      const countRows = await exec(
        null,
        `SELECT COUNT(*) AS total FROM Deliveries WHERE trip_id = ?`,
        [trip.id],
      )
      return {
        ...trip,
        totalDeliveries: Number(countRows[0]?.total || 0),
      }
    }))

    return sendSuccess(res, 200, "Active trips fetched successfully", {
      activeTrips: enriched,
      hasActiveTrip: enriched.length > 0,
    })
  } catch (error) {
    next(error)
  }
}

export const listAvailableTrips = async (req, res, next) => {
  try {
    const page = toBoundedPositiveInteger(req.query.page, {
      fallback: DEFAULT_AVAILABLE_TRIPS_PAGE,
      min: 1,
    })
    const limit = toBoundedPositiveInteger(req.query.limit, {
      fallback: DEFAULT_AVAILABLE_TRIPS_LIMIT,
      min: 1,
      max: MAX_AVAILABLE_TRIPS_LIMIT,
    })
    const offset = (page - 1) * limit

    const filters = {
      originText: req.query.originText ? String(req.query.originText).trim() : null,
      destinationText: req.query.destinationText ? String(req.query.destinationText).trim() : null,
      departureFrom: toOptionalDate(req.query.departureFrom),
      departureTo: toOptionalDate(req.query.departureTo),
      minCapacity: req.query.minCapacity ? Number(req.query.minCapacity) : null,
    }

    const trips = await listAvailableTripRecords(null, {
      ...filters,
      limit,
      offset,
    })
    const total = await countAvailableTrips(null, filters)

    return sendSuccess(res, 200, "Available trips fetched successfully", {
      trips: trips.map(withTripMeta),
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

export const getTripById = async (req, res, next) => {
  try {
    const { tripId } = req.params
    const trip = await findTripById(null, tripId, { includeDriver: true })

    if (!trip) {
      return next(createError(404, "Trip not found"))
    }

    const includeDeliveries = String(req.query.includeDeliveries || "").trim().toLowerCase() === "true"
    if (!includeDeliveries) {
      return sendSuccess(res, 200, "Trip fetched successfully", {
        trip: withTripMeta(trip),
        acceptsDeliveries: withTripMeta(trip).acceptsDeliveries,
      })
    }

    const page = toBoundedPositiveInteger(req.query.deliveriesPage, {
      fallback: DEFAULT_DELIVERIES_PAGE,
      min: 1,
    })
    const limit = toBoundedPositiveInteger(req.query.deliveriesLimit, {
      fallback: DEFAULT_DELIVERIES_LIMIT,
      min: 1,
      max: MAX_DELIVERIES_LIMIT,
    })
    const offset = (page - 1) * limit

    const deliveryRows = await exec(
      null,
      `SELECT d.id, d.status, d.recipient_name, d.created_at,
              pl.address AS pickup_address,
              dl.address AS dropoff_address
       FROM Deliveries d
       LEFT JOIN DeliveryLocations pl ON pl.delivery_id = d.id AND pl.type = 'PICKUP'
       LEFT JOIN DeliveryLocations dl ON dl.delivery_id = d.id AND dl.type = 'DROPOFF'
       WHERE d.trip_id = ?
       ORDER BY d.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      [tripId],
    )

    const totalRows = await exec(
      null,
      `SELECT COUNT(*) AS total FROM Deliveries WHERE trip_id = ?`,
      [tripId],
    )

    const linkedDeliveries = deliveryRows.map((row) => ({
      id: row.id,
      status: row.status,
      pickupAddress: row.pickup_address || "",
      dropoffAddress: row.dropoff_address || "",
      recipientName: row.recipient_name || "",
      createdAt: row.created_at,
    }))

    const total = Number(totalRows[0]?.total || 0)

    return sendSuccess(res, 200, "Trip fetched successfully", {
      trip: withTripMeta(trip),
      linkedDeliveries,
      linkedDeliveriesPagination: {
        total,
        page,
        pages: Math.ceil(total / limit),
        limit,
      },
      acceptsDeliveries: withTripMeta(trip).acceptsDeliveries,
    })
  } catch (error) {
    next(error)
  }
}

export const updateTripStatus = async (req, res, next) => {
  try {
    const { tripId } = req.params
    const { status } = req.body

    const isAdminLike = req.user.role === "admin" || req.user.role === "authority"

    const trip = await findTripById(null, tripId)
    if (!trip) {
      return next(createError(404, "Trip not found"))
    }

    if (!isAdminLike && trip.driverId !== req.user.id) {
      return next(createError(403, "You are not authorized to update this trip"))
    }

    const updated = await updateTripStatusRecord(null, tripId, status)

    // If status changed to completed or cancelled, check if auto-complete is needed for other trips
    if (status === "completed" || status === "cancelled") {
      const driverTrips = await listDriverTripRecords(null, trip.driverId, { status: null })
      const activeTrips = driverTrips.filter((t) => t.id !== tripId && (t.status === "planned" || t.status === "active"))
      for (const t of activeTrips) {
        await checkAndCompleteTrip(null, t.id).catch(() => {})
      }
    }

    return sendSuccess(res, 200, "Trip status updated successfully", { trip: updated })
  } catch (error) {
    next(error)
  }
}

export const updateTrip = async (req, res, next) => {
  try {
    const { tripId } = req.params

    const trip = await findTripById(null, tripId)
    if (!trip) {
      return next(createError(404, "Trip not found"))
    }

    if (trip.driverId !== req.user.id) {
      return next(createError(403, "You are not authorized to update this trip"))
    }

    const isActiveOrPlanned = trip.status === "planned" || trip.status === "active"

    if (isActiveOrPlanned) {
      const protectedFields = [
        req.body.origin !== undefined && "origin",
        req.body.destination !== undefined && "destination",
        req.body.departureTime !== undefined && "departureTime",
      ].filter(Boolean)

      if (protectedFields.length > 0) {
        return next(createError(
          400,
          `Vous ne pouvez pas modifier les champs suivants pour un trajet ${trip.status} : ${protectedFields.join(", ")}`,
        ))
      }
    }

    const updates = {}
    if (req.body.title !== undefined) updates.title = req.body.title
    if (req.body.maxDeliveries !== undefined) updates.max_deliveries = req.body.maxDeliveries
    if (req.body.vehicleType !== undefined) updates.vehicle_type = req.body.vehicleType
    if (req.body.acceptedPackageSize !== undefined) updates.accepted_package_size = req.body.acceptedPackageSize
    if (req.body.notes !== undefined) updates.notes = req.body.notes
    if (req.body.expectedArrivalTime !== undefined) updates.expected_arrival_time = req.body.expectedArrivalTime

    const updated = await updateTripDetails(null, tripId, updates)
    return sendSuccess(res, 200, "Trip updated successfully", { trip: updated })
  } catch (error) {
    next(error)
  }
}

export const deleteTrip = async (req, res, next) => {
  try {
    const { tripId } = req.params

    const trip = await findTripById(null, tripId)
    if (!trip) {
      return next(createError(404, "Trip not found"))
    }

    if (trip.driverId !== req.user.id) {
      return next(createError(403, "You are not authorized to delete this trip"))
    }

    if (trip.status === "active") {
      return next(createError(400, "Vous ne pouvez pas supprimer un trajet en cours (statut 'active'). Terminez-le d'abord."))
    }

    await deleteTripRecord(null, tripId)
    return sendSuccess(res, 200, "Trip deleted successfully", { tripId })
  } catch (error) {
    next(error)
  }
}

const WILAYA_MATCH_THRESHOLD_KM = Number(process.env.WILAYA_MATCH_THRESHOLD_KM || 50)

const extractWilayaFromAddress = (address) => {
  if (!address) return ""
  const parts = address.split(",").map((s) => s.trim()).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1].toLowerCase() : ""
}

const PACKAGE_SIZE_LEVEL = { small: 1, medium: 2, large: 3, xlarge: 4 }
const TRIP_ACCEPTED_SIZE_LEVEL = { any: 99, small: 1, medium: 2, large: 3, up_to_medium: 2, up_to_large: 3, small_only: 1 }

const isSizeCompatible = (tripAcceptedSize, deliverySize) => {
  const tripLevel = TRIP_ACCEPTED_SIZE_LEVEL[String(tripAcceptedSize || "any").toLowerCase()] || 99
  const deliveryLevel = PACKAGE_SIZE_LEVEL[String(deliverySize || "small").toLowerCase()] || 1
  return deliveryLevel <= tripLevel
}

const isWeightCompatible = (deliveryWeightKg, tripMaxWeightKg) => {
  if (!deliveryWeightKg || !tripMaxWeightKg) return true
  return Number(deliveryWeightKg) <= Number(tripMaxWeightKg)
}

export const getCompatibleDeliveriesForTrip = async (req, res, next) => {
  try {
    const { tripId } = req.params

    const trip = await findTripById(null, tripId)
    if (!trip) return next(createError(404, "Trip not found"))
    if (trip.driverId !== req.user.id) return next(createError(403, "Not your trip"))

    const tripOrigin = trip.origin?.address || ""
    const tripDest = trip.destination?.address || ""
    const tripOriginWilaya = extractWilayaFromAddress(tripOrigin)
    const tripDestWilaya = extractWilayaFromAddress(tripDest)
    const tripDeparture = trip.departureTime ? new Date(trip.departureTime) : null

    const pendingRows = await exec(
      null,
      `SELECT d.id
       FROM Deliveries d
       WHERE d.status = 'Pending'
         AND d.assigned_driver_id IS NULL
         AND (d.trip_id IS NULL OR d.trip_id = '')
       ORDER BY d.created_at DESC`,
    )

    const compatibleDeliveries = []
    for (const row of pendingRows) {
      const delivery = await findDeliveryById(null, row.id, {
        includeDriver: false,
        includeRequester: true,
        includeTrip: false,
      })
      if (!delivery) continue

      const pickupAddress = delivery.pickup?.address || ""
      const dropoffAddress = delivery.dropoff?.address || ""
      const pickupWilaya = extractWilayaFromAddress(pickupAddress)
      const dropoffWilaya = extractWilayaFromAddress(dropoffAddress)

      const originMatch = tripOriginWilaya && pickupWilaya && tripOriginWilaya === pickupWilaya
      const destMatch = tripDestWilaya && dropoffWilaya && tripDestWilaya === dropoffWilaya

      if (!originMatch || !destMatch) continue

      const sizeOk = isSizeCompatible(trip.acceptedPackageSize, delivery.packageSizeCategory)
      if (!sizeOk) continue

      const weightOk = isWeightCompatible(delivery.packageWeightKg, null)
      if (!weightOk) continue

      compatibleDeliveries.push({
        ...delivery,
        compatibility: {
          originMatch,
          destMatch,
          sizeOk,
          weightOk,
        },
      })
    }

    return sendSuccess(res, 200, "Compatible deliveries fetched successfully", {
      deliveries: compatibleDeliveries,
    })
  } catch (error) {
    next(error)
  }
}

export const getJoinRequestsForTrip = async (req, res, next) => {
  try {
    const { tripId } = req.params

    const trip = await findTripById(null, tripId)
    if (!trip) return next(createError(404, "Trip not found"))
    if (trip.driverId !== req.user.id) return next(createError(403, "Not your trip"))

    const joinRows = await exec(
      null,
      `SELECT d.id
       FROM Deliveries d
       WHERE d.trip_id = ?
         AND d.status = 'Pending'
         AND d.assigned_driver_id IS NULL
       ORDER BY d.created_at DESC`,
      [tripId],
    )

    const joinRequests = []
    for (const row of joinRows) {
      const delivery = await findDeliveryById(null, row.id, {
        includeDriver: false,
        includeRequester: true,
        includeTrip: false,
      })
      if (delivery) {
        joinRequests.push(delivery)
      }
    }

    return sendSuccess(res, 200, "Join requests fetched successfully", {
      joinRequests,
    })
  } catch (error) {
    next(error)
  }
}

export const acceptJoinRequest = async (req, res, next) => {
  try {
    const { tripId, deliveryId } = req.params

    const trip = await findTripById(null, tripId)
    if (!trip) return next(createError(404, "Trip not found"))
    if (trip.driverId !== req.user.id) return next(createError(403, "Not your trip"))

    const updated = await withTransaction(async (connection) => {
      const deliveryRows = await exec(
        connection,
        `SELECT id, requester_id, status, assigned_driver_id
         FROM Deliveries
         WHERE id = ? AND trip_id = ?
         FOR UPDATE`,
        [deliveryId, tripId],
      )

      if (!deliveryRows.length) {
        throw createError(404, "Join request not found or not linked to this trip")
      }

      const delivery = deliveryRows[0]
      if (delivery.status !== "Pending") {
        throw createError(400, "Delivery is not in pending status")
      }
      if (delivery.assigned_driver_id) {
        throw createError(400, "Delivery already has an assigned driver")
      }

      const tripRows = await exec(
        connection,
        `SELECT status, available_capacity
         FROM Trips
         WHERE id = ?
         FOR UPDATE`,
        [tripId],
      )
      if (!tripRows.length) throw createError(404, "Trip not found")
      if (tripRows[0].status !== "planned" && tripRows[0].status !== "active") {
        throw createError(400, "Trip is not active")
      }
      if ((tripRows[0].available_capacity || 0) <= 0) {
        throw createError(400, "Trip has no available capacity")
      }

      await exec(
        connection,
        `UPDATE Deliveries
         SET assigned_driver_id = ?, status = 'Accepted', updated_at = NOW()
         WHERE id = ?`,
        [req.user.id, deliveryId],
      )

      await touchTimeline(connection, deliveryId, "accepted_at")

      await exec(
        connection,
        `UPDATE Trips SET available_capacity = GREATEST(available_capacity - 1, 0) WHERE id = ?`,
        [tripId],
      )

      return findDeliveryById(connection, deliveryId, {
        includeDriver: true,
        includeRequester: true,
        includeTrip: true,
      })
    })

    createNotification({
      recipient: updated.senderId,
      title: "Demande d'adhésion acceptée",
      message: `Votre demande d\'adhésion au trajet a été acceptée par le conducteur.`,
      type: "join_request_accepted",
      reference: tripId,
      referenceModel: "Trip",
      deliveryId: updated.id,
      tripId,
      sendEmail: false,
    }).catch(() => {})

    return sendSuccess(res, 200, "Join request accepted successfully", { delivery: updated })
  } catch (error) {
    next(error)
  }
}

export const rejectJoinRequest = async (req, res, next) => {
  try {
    const { tripId, deliveryId } = req.params

    const trip = await findTripById(null, tripId)
    if (!trip) return next(createError(404, "Trip not found"))
    if (trip.driverId !== req.user.id) return next(createError(403, "Not your trip"))

    let requesterId = null

    await withTransaction(async (connection) => {
      const rows = await exec(
        connection,
        `SELECT id, requester_id, status, assigned_driver_id
         FROM Deliveries
         WHERE id = ? AND trip_id = ?
         FOR UPDATE`,
        [deliveryId, tripId],
      )

      if (!rows.length) {
        throw createError(404, "Join request not found or not linked to this trip")
      }

      const delivery = rows[0]
      if (delivery.assigned_driver_id) {
        throw createError(400, "Delivery already has an assigned driver")
      }

      requesterId = delivery.requester_id

      await exec(
        connection,
        `UPDATE Deliveries SET trip_id = NULL, updated_at = NOW() WHERE id = ?`,
        [deliveryId],
      )

      await exec(
        connection,
        `INSERT INTO DeliveryRejections (id, delivery_id, driver_id, reason, created_at)
         VALUES (?, ?, ?, ?, NOW())`,
        [crypto.randomUUID(), deliveryId, req.user.id, req.body.reason || "Conducteur a refusé la demande"],
      )
    })

    if (requesterId) {
      createNotification({
        recipient: requesterId,
        title: "Demande d'adhésion refusée",
        message: "Votre demande d'adhésion au trajet a été refusée par le conducteur.",
        type: "join_request_rejected",
        reference: tripId,
        referenceModel: "Trip",
        deliveryId,
        tripId,
        sendEmail: false,
      }).catch(() => {})
    }

    return sendSuccess(res, 200, "Join request rejected successfully")
  } catch (error) {
    next(error)
  }
}
