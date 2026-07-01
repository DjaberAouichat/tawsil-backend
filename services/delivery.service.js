import crypto from "crypto"
import { getPool, withTransaction, exec } from "../lib/db.js"
import { createError } from "../utils/response.js"
import { toBoundedPositiveInteger, toSqlDateTime, formatDurationText } from "../utils/helpers.js"
import { getRouteDirections, getRouteDistance } from "../utils/maps.js"
import { calculateCrossShippingPrice, calculateProfessionalDeliveryPrice, selectBestDriver } from "../utils/pricing.utils.js"
import { determineDeliveryMode } from "./matching.service.js"
import { getDriverLocation } from "../models/driver.model.js"
import { listDriverTrips as listDriverTripsModel } from "../models/trip.model.js"
import { getVehicleCategory, PERSONAL_VEHICLE_IDS, PROFESSIONAL_VEHICLE_IDS, getVehiclesForDriverType } from "../vehicle_capacities.js"




// ── Constants ──────────────────────────────────────────────────────────

const DELIVERY_ESTIMATE_TTL_MINUTES = Number.parseInt(String(process.env.DELIVERY_ESTIMATE_TTL_MINUTES || "30"), 10) || 30
const DELIVERY_OTP_TTL_MINUTES_DEFAULT = 15
const CENTRAL_REGION_SEARCH_RADIUS_METERS = Number.parseInt(String(process.env.CENTRAL_REGION_SEARCH_RADIUS_METERS || "50000"), 10) || 50000
const CENTRAL_REGION_MIN_DRIVERS = Number.parseInt(String(process.env.CENTRAL_REGION_MIN_DRIVERS || "3"), 10) || 3
const CENTRAL_REGION_MAX_DRIVERS = Number.parseInt(String(process.env.CENTRAL_REGION_MAX_DRIVERS || "10"), 10) || 10
const EXPANDED_REGION_SEARCH_RADIUS_METERS = Number.parseInt(String(process.env.EXPANDED_REGION_SEARCH_RADIUS_METERS || "150000"), 10) || 150000
const EXPANDED_REGION_MIN_DRIVERS = Number.parseInt(String(process.env.EXPANDED_REGION_MIN_DRIVERS || "5"), 10) || 5
const EXPANDED_REGION_MAX_DRIVERS = Number.parseInt(String(process.env.EXPANDED_REGION_MAX_DRIVERS || "15"), 10) || 15
const DRIVER_MATCH_MAX_PICKUP_DISTANCE_METERS = Number.parseInt(String(process.env.DRIVER_MATCH_MAX_PICKUP_DISTANCE_METERS || "30000"), 10) || 30000
const DRIVER_MATCH_MAX_ROUTE_CORRIDOR_METERS = Number.parseInt(String(process.env.DRIVER_MATCH_MAX_ROUTE_CORRIDOR_METERS || "10000"), 10) || 10000
const DRIVER_MATCH_MAX_TRIP_DETOUR_METERS = Number.parseInt(String(process.env.DRIVER_MATCH_MAX_TRIP_DETOUR_METERS || "20000"), 10) || 20000

const PACKAGE_SIZE_LEVEL = { small: 1, medium: 2, large: 3, xlarge: 4 }
const TRIP_ACCEPTED_SIZE_LEVEL = { any: 99, small: 1, medium: 2, large: 3, xlarge: 4 }

const MAX_ROUTING_EVALUATIONS = 3
const ROUTE_CACHE_TTL_MS = 15 * 60 * 1000
const routeCache = new Map()
let routeCacheHits = 0
let routeCacheMisses = 0

// ── Geo helpers ────────────────────────────────────────────────────────

export const toLatLng = (coordinates) => ({
  lng: Number(coordinates?.[0]),
  lat: Number(coordinates?.[1]),
})

export const toCoordinatePair = (point) => {
  const coordinates = point?.location?.coordinates
  if (!Array.isArray(coordinates) || coordinates.length !== 2) return null
  const lng = Number(coordinates[0])
  const lat = Number(coordinates[1])
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  return [lng, lat]
}

export const distanceMeters = (from, to) => {
  if (!from || !to) return null
  const toRad = (value) => (value * Math.PI) / 180
  const earthRadiusMeters = 6371000
  const dLat = toRad(to[1] - from[1])
  const dLng = toRad(to[0] - from[0])
  const lat1 = toRad(from[1])
  const lat2 = toRad(to[1])
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export const distancePointToSegmentMeters = (point, start, end) => {
  if (!point || !start || !end) return null
  const referenceLat = ((start[1] + end[1] + point[1]) / 3) * (Math.PI / 180)
  const metersPerDegreeLat = 111320
  const metersPerDegreeLng = 111320 * Math.cos(referenceLat)
  const toXY = ([lng, lat]) => ({ x: lng * metersPerDegreeLng, y: lat * metersPerDegreeLat })
  const p = toXY(point)
  const a = toXY(start)
  const b = toXY(end)
  const dx = b.x - a.x
  const dy = b.y - a.y
  const segmentLengthSquared = dx * dx + dy * dy
  if (segmentLengthSquared === 0) return distanceMeters(point, start)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / segmentLengthSquared))
  const projection = { x: a.x + t * dx, y: a.y + t * dy }
  return Math.sqrt((p.x - projection.x) ** 2 + (p.y - projection.y) ** 2)
}

export const computeTripDetourMeters = ({ tripStart, tripEnd, pickup, dropoff }) => {
  const tripDistance = distanceMeters(tripStart, tripEnd)
  const withDeliveryDistance = distanceMeters(tripStart, pickup) + distanceMeters(pickup, dropoff) + distanceMeters(dropoff, tripEnd)
  if (!Number.isFinite(tripDistance) || !Number.isFinite(withDeliveryDistance)) return null
  return Math.max(0, withDeliveryDistance - tripDistance)
}

// ── OTP ────────────────────────────────────────────────────────────────

export const generateOtpCode = () => String(Math.floor(100000 + Math.random() * 900000))

export const getOtpConfig = () => {
  const ttlMinutes = Number.parseInt(String(process.env.DELIVERY_OTP_TTL_MINUTES || "1440"), 10)
  const maxAttempts = Number.parseInt(String(process.env.DELIVERY_OTP_MAX_ATTEMPTS || "5"), 10)
  return {
    ttlMinutes: Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : DELIVERY_OTP_TTL_MINUTES_DEFAULT,
    maxAttempts: Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : 5,
  }
}

// ── Pricing ────────────────────────────────────────────────────────────

export const buildPrice = async ({ pickupCoordinates, dropoffCoordinates, packageInfo, isUrgent = false, mode = "CROSS_SHIPPING", deviationKm = 0 }) => {
  let route
  try {
    route = await getRouteDistance(toLatLng(pickupCoordinates), toLatLng(dropoffCoordinates))
  } catch (error) {
    throw createError(503, "Delivery pricing is temporarily unavailable.", {
      code: "ROUTING_SERVICE_UNAVAILABLE",
      providerMessage: error?.message || "Routing provider unavailable",
    })
  }

  const distance = route.distanceMeters
  const durationSeconds = Number(route.durationSeconds || 0)
  const distanceKm = distance / 1000
  const isInterWilaya = true

  let computed
  if (mode === "PROFESSIONAL_DELIVERY") {
    computed = calculateProfessionalDeliveryPrice({ distanceKm, sizeCategory: packageInfo.sizeCategory, weightKg: packageInfo.weightKg, isUrgent })
  } else {
    computed = calculateCrossShippingPrice({ distanceKm, deviationKm, sizeCategory: packageInfo.sizeCategory, weightKg: packageInfo.weightKg, isInterWilaya })
  }

  return {
    ...computed,
    distanceMeters: distance,
    distanceKm: Math.round(distanceKm * 100) / 100,
    durationSeconds,
    durationMinutes: Math.max(1, Math.ceil(durationSeconds / 60)),
    durationText: formatDurationText(durationSeconds),
  }
}

export const buildPricingPayload = (pricing) => ({
  baseFee: pricing.baseFee,
  distanceFee: pricing.distanceFee,
  weightSurcharge: pricing.weightSurcharge,
  sizeSurcharge: pricing.sizeSurcharge,
  urgentSurcharge: pricing.urgentSurcharge,
  estimatedPrice: pricing.estimatedPrice,
  currency: "DA",
})

export const saveDeliveryEstimate = async (connection, { requesterId, pickup, dropoff, packageInfo, isUrgent, pricing }) => {
  const estimateId = crypto.randomUUID()
  const expiresAt = new Date(Date.now() + DELIVERY_ESTIMATE_TTL_MINUTES * 60 * 1000)

  await exec(
    connection,
    `INSERT INTO DeliveryEstimates (
      id, requester_id,
      pickup_address, pickup_latitude, pickup_longitude,
      dropoff_address, dropoff_latitude, dropoff_longitude,
      package_type, package_description, package_size_category, package_weight_kg,
      package_length_cm, package_width_cm, package_height_cm, package_volume_m3,
      is_urgent,
      base_fee, distance_fee, weight_surcharge, size_surcharge, urgent_surcharge,
      estimated_price, currency, distance_meters, duration_seconds,
      expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      estimateId, requesterId,
      pickup.address,
      pickup.location.coordinates[1], pickup.location.coordinates[0],
      dropoff.address,
      dropoff.location.coordinates[1], dropoff.location.coordinates[0],
      packageInfo.type, packageInfo.description, packageInfo.sizeCategory, packageInfo.weightKg ?? null,
      packageInfo.dimensionsCm?.length ?? null, packageInfo.dimensionsCm?.width ?? null, packageInfo.dimensionsCm?.height ?? null, packageInfo.volumeM3 ?? null,
      isUrgent ? 1 : 0,
      pricing.baseFee, pricing.distanceFee, pricing.weightSurcharge, pricing.sizeSurcharge, pricing.urgentSurcharge,
      pricing.estimatedPrice, "DA", pricing.distanceMeters, pricing.durationSeconds,
      toSqlDateTime(expiresAt),
    ],
  )

  return { estimateId, expiresAt: expiresAt.toISOString() }
}

export const getEstimateById = async (connection, estimateId, requesterId, { forUpdate = false } = {}) => {
  const lockClause = forUpdate ? "FOR UPDATE" : ""
  const rows = await exec(
    connection,
    `SELECT id, requester_id, estimated_price, expires_at, consumed_at,
            base_fee, distance_fee, weight_surcharge, size_surcharge, urgent_surcharge, currency,
            distance_meters, duration_seconds
     FROM DeliveryEstimates
     WHERE id = ? AND requester_id = ?
     LIMIT 1
     ${lockClause}`,
    [estimateId, requesterId],
  )

  const row = rows[0]
  if (!row) throw createError(404, "Estimate not found")
  if (row.consumed_at) throw createError(409, "Estimate has already been used")

  const expiresAt = new Date(row.expires_at)
  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) throw createError(400, "Estimate has expired")

  return {
    id: row.id,
    expiresAt,
    pricing: {
      baseFee: Number(row.base_fee || 0),
      distanceFee: Number(row.distance_fee || 0),
      weightSurcharge: Number(row.weight_surcharge || 0),
      sizeSurcharge: Number(row.size_surcharge || 0),
      urgentSurcharge: Number(row.urgent_surcharge || 0),
      estimatedPrice: Number(row.estimated_price || 0),
      currency: row.currency || "DA",
      distanceMeters: Number(row.distance_meters || 0),
      durationSeconds: Number(row.duration_seconds || 0),
      durationMinutes: Math.max(1, Math.ceil(Number(row.duration_seconds || 0) / 60)),
      durationText: formatDurationText(Number(row.duration_seconds || 0)),
    },
  }
}

export const consumeEstimate = async (connection, estimateId) => {
  await exec(connection, `UPDATE DeliveryEstimates SET consumed_at = NOW() WHERE id = ?`, [estimateId])
}

export const resolvePricingForCreate = async (connection, { body, requesterId }) => {
  const match = determineDeliveryMode({
    sizeCategory: body.package?.sizeCategory,
    weightKg: body.package?.weightKg,
    packageType: body.package?.type,
    description: body.package?.description,
  })
  const deliveryMode = match.pricingMode

  if (body.estimateId) {
    const estimate = await getEstimateById(connection, body.estimateId, requesterId, { forUpdate: true })
    return { estimate, pricing: estimate.pricing, source: "estimate", winningDriver: null, deliveryMode: match.deliveryMode, pricingMode: deliveryMode, isProTransporter: match.isProTransporter }
  }

  let winningDriver = null
  let deviationKm = null

  if (deliveryMode === "CROSS_SHIPPING") {
    const compatibleDrivers = await findCompatibleDriversForDelivery(connection, {
      pickupCoordinates: body.pickup.location.coordinates,
      dropoffCoordinates: body.dropoff.location.coordinates,
      packageSizeCategory: body.package?.sizeCategory,
    })
    if (compatibleDrivers.length > 0) {
      winningDriver = selectBestDriver(compatibleDrivers)
      if (winningDriver) deviationKm = winningDriver.deviationKm
    }
  }

  if (deviationKm === null && deliveryMode === "CROSS_SHIPPING") {
    const priceRoute = await buildPrice({
      pickupCoordinates: body.pickup.location.coordinates,
      dropoffCoordinates: body.dropoff.location.coordinates,
      packageInfo: body.package,
      isUrgent: body.isUrgent,
      mode: deliveryMode,
      deviationKm: 0,
    })
    deviationKm = Math.max(1, priceRoute.distanceKm * 0.05)
  }

  const pricing = await buildPrice({
    pickupCoordinates: body.pickup.location.coordinates,
    dropoffCoordinates: body.dropoff.location.coordinates,
    packageInfo: body.package,
    isUrgent: body.isUrgent,
    mode: deliveryMode,
    deviationKm: deviationKm ?? 0,
  })

  return { estimate: null, pricing, source: "recalculated", winningDriver, deliveryMode: match.deliveryMode, pricingMode: deliveryMode, isProTransporter: match.isProTransporter }
}

// ── Tracking ───────────────────────────────────────────────────────────

export const buildTrackingPayload = async (delivery) => {
  if (!delivery.assignedDriverId) {
    return { deliveryId: delivery.id, status: delivery.status, driver: null, driverLocation: null, route: null, etaSeconds: null, etaText: null, lastUpdatedAt: delivery.updatedAt, fallbackState: "no_assigned_driver" }
  }

  const driverLocationRow = await getDriverLocation(null, delivery.assignedDriverId)
  const liveCoordinates = driverLocationRow ? [Number(driverLocationRow.longitude), Number(driverLocationRow.latitude)] : null
  const pickupCoordinates = delivery.pickup?.location?.coordinates
  const dropoffCoordinates = delivery.dropoff?.location?.coordinates

  let route = null
  let etaSeconds = null
  let etaText = null
  let fallbackState = null

  if (liveCoordinates && dropoffCoordinates) {
    const liveRoute = await getRouteDirections(liveCoordinates, dropoffCoordinates)
    route = { polyline: liveRoute.polyline, geometry: liveRoute.geometry }
    etaSeconds = Number(liveRoute.durationSeconds || 0)
    etaText = formatDurationText(etaSeconds)
  } else if (pickupCoordinates && dropoffCoordinates) {
    const fallbackRoute = await getRouteDirections(pickupCoordinates, dropoffCoordinates)
    route = { polyline: fallbackRoute.polyline, geometry: fallbackRoute.geometry }
    etaSeconds = Number(fallbackRoute.durationSeconds || 0)
    etaText = formatDurationText(etaSeconds)
    fallbackState = "driver_location_unavailable"
  }

  return {
    deliveryId: delivery.id,
    status: delivery.status,
    driver: delivery.assignedDriver?.user ? { id: delivery.assignedDriver.user.id, firstName: delivery.assignedDriver.user.firstName, lastName: delivery.assignedDriver.user.lastName, phone: delivery.assignedDriver.user.phone || null } : null,
    driverLocation: driverLocationRow ? { coordinates: [Number(driverLocationRow.longitude), Number(driverLocationRow.latitude)], heading: driverLocationRow.heading === null ? null : Number(driverLocationRow.heading), speed: driverLocationRow.speed === null ? null : Number(driverLocationRow.speed), timestamp: driverLocationRow.timestamp } : null,
    route,
    etaSeconds,
    etaText,
    lastUpdatedAt: driverLocationRow?.timestamp || delivery.updatedAt,
    fallbackState,
  }
}

// ── Driver matching ────────────────────────────────────────────────────

export const buildDeliveryCompatibility = (delivery, driverTrips = []) => {
  const sizeCategory = String(delivery?.package?.sizeCategory || "").toLowerCase()
  const packageLevel = PACKAGE_SIZE_LEVEL[sizeCategory] || null
  const reasons = []
  const activeTrips = (driverTrips || []).filter((trip) => ["planned", "active"].includes(trip.status))
  const directlyAttachedToDriverTrip = !!delivery?.tripId && activeTrips.some((trip) => trip.id === delivery.tripId)

  if (!activeTrips.length) reasons.push("No active trip available")

  const matchedTrip = activeTrips.find((trip) => {
    if (trip.availableCapacity <= 0) return false
    const acceptedSize = String(trip.acceptedPackageSize || "any")
    const tripSizeLevel = TRIP_ACCEPTED_SIZE_LEVEL[acceptedSize] || TRIP_ACCEPTED_SIZE_LEVEL.any
    if (packageLevel && packageLevel > tripSizeLevel) return false
    if (delivery.tripId && delivery.tripId !== trip.id) return false
    return true
  })

  if (!matchedTrip && activeTrips.length) {
    if (!directlyAttachedToDriverTrip && delivery.tripId) reasons.push("Delivery is attached to another trip")
    const hasCapacity = activeTrips.some((trip) => Number(trip.availableCapacity || 0) > 0)
    if (!hasCapacity) reasons.push("No trip has available capacity")
    const supportsSize = activeTrips.some((trip) => {
      const acceptedSize = String(trip.acceptedPackageSize || "any")
      const tripSizeLevel = TRIP_ACCEPTED_SIZE_LEVEL[acceptedSize] || TRIP_ACCEPTED_SIZE_LEVEL.any
      return !packageLevel || packageLevel <= tripSizeLevel
    })
    if (!supportsSize) reasons.push("Package size is not compatible with your active trips")
  }

  return {
    suitableForTrip: !!matchedTrip || directlyAttachedToDriverTrip,
    reasons,
    matchedTripId: matchedTrip?.id || null,
    requiredPackageSize: sizeCategory || null,
    tripConstraints: matchedTrip ? { acceptedPackageSize: matchedTrip.acceptedPackageSize || "any", availableCapacity: Number(matchedTrip.availableCapacity || 0) } : null,
  }
}

export const buildDeliveryMatch = ({ delivery, driverTrips = [], driverLocation = null }) => {
  const pickup = toCoordinatePair(delivery.pickup)
  const dropoff = toCoordinatePair(delivery.dropoff)
  const driverCoordinates = driverLocation ? [Number(driverLocation.longitude), Number(driverLocation.latitude)] : null
  const pickupDistanceMeters = distanceMeters(driverCoordinates, pickup)
  const activeTrips = (driverTrips || []).filter((trip) => ["planned", "active"].includes(trip.status))
  let bestTripMatch = null

  for (const trip of activeTrips) {
    const tripStart = toCoordinatePair(trip.origin)
    const tripEnd = toCoordinatePair(trip.destination)
    if (!tripStart || !tripEnd || !pickup || !dropoff) continue
    const pickupToRouteMeters = distancePointToSegmentMeters(pickup, tripStart, tripEnd)
    const dropoffToRouteMeters = distancePointToSegmentMeters(dropoff, tripStart, tripEnd)
    const detourMeters = computeTripDetourMeters({ tripStart, tripEnd, pickup, dropoff })
    const score = (pickupToRouteMeters ?? DRIVER_MATCH_MAX_ROUTE_CORRIDOR_METERS * 2) + (dropoffToRouteMeters ?? DRIVER_MATCH_MAX_ROUTE_CORRIDOR_METERS * 2) + (detourMeters ?? DRIVER_MATCH_MAX_TRIP_DETOUR_METERS * 2)
    if (!bestTripMatch || score < bestTripMatch.score) {
      bestTripMatch = { tripId: trip.id, pickupToRouteMeters, dropoffToRouteMeters, detourMeters, score }
    }
  }

  const isNearDriver = Number.isFinite(pickupDistanceMeters) && pickupDistanceMeters <= DRIVER_MATCH_MAX_PICKUP_DISTANCE_METERS
  const isOnActiveRoute = !!bestTripMatch && Number.isFinite(bestTripMatch.pickupToRouteMeters) && Number.isFinite(bestTripMatch.dropoffToRouteMeters) && Number.isFinite(bestTripMatch.detourMeters) && bestTripMatch.pickupToRouteMeters <= DRIVER_MATCH_MAX_ROUTE_CORRIDOR_METERS && bestTripMatch.dropoffToRouteMeters <= DRIVER_MATCH_MAX_ROUTE_CORRIDOR_METERS && bestTripMatch.detourMeters <= DRIVER_MATCH_MAX_TRIP_DETOUR_METERS

  const score = Math.round((isNearDriver ? pickupDistanceMeters : DRIVER_MATCH_MAX_PICKUP_DISTANCE_METERS * 2) + (bestTripMatch?.score ?? DRIVER_MATCH_MAX_ROUTE_CORRIDOR_METERS * 4))

  return {
    isSuggested: isNearDriver || isOnActiveRoute || !!delivery.tripId,
    isNearDriver,
    isOnActiveRoute,
    score,
    pickupDistanceMeters: Number.isFinite(pickupDistanceMeters) ? Math.round(pickupDistanceMeters) : null,
    route: bestTripMatch ? { tripId: bestTripMatch.tripId, pickupToRouteMeters: Math.round(bestTripMatch.pickupToRouteMeters), dropoffToRouteMeters: Math.round(bestTripMatch.dropoffToRouteMeters), estimatedDetourMeters: Math.round(bestTripMatch.detourMeters) } : null,
    thresholds: { maxPickupDistanceMeters: DRIVER_MATCH_MAX_PICKUP_DISTANCE_METERS, maxRouteCorridorMeters: DRIVER_MATCH_MAX_ROUTE_CORRIDOR_METERS, maxTripDetourMeters: DRIVER_MATCH_MAX_TRIP_DETOUR_METERS },
  }
}

const SIZE_LABELS = { small: 'Petit', medium: 'Moyen', large: 'Grand', xlarge: 'Très grand' }
const PACKAGE_VOLUME_LABEL = { small: 'Petit', medium: 'Moyen', large: 'Grand', xlarge: 'Très grand' }

/**
 * Calculate a delivery compatibility score (0-100) for a given driver and delivery.
 * Returns { score, reasons, compatible } where:
 *   - score: 0-100 integer
 *   - reasons: human-readable list of matching criteria
 *   - compatible: boolean — false if any mandatory criterion fails
 */
export const calculateDriverDeliveryCompatibility = ({
  delivery,
  driverCity,
  driverType,
  driverMaxWeightKg,
  driverVehicleType,
  driverTrips = [],
  driverCoordinates = null,
}) => {
  const reasons = []
  let score = 0

  // 1. Wilaya — mandatory (40%)
  const pickupRaw = delivery?.pickupWilaya || delivery?.pickup?.address || ''
  const pickupLower = pickupRaw.toLowerCase()
  const cityLower = (driverCity || '').toLowerCase()
  const sameWilaya = cityLower && (
    pickupLower === cityLower ||
    pickupLower.includes(cityLower) ||
    pickupLower.split(',').map(p => p.trim()).includes(cityLower)
  )
  if (!sameWilaya) {
    return { score: 0, reasons: ['Wilaya différente — livraison non compatible'], compatible: false }
  }
  score += 40
  reasons.push('Même wilaya')

  // 2. Vehicle / Driver type compatibility (10%)
  const sizeCategory = String(delivery?.package?.sizeCategory || '').toLowerCase()
  const packageSizeLevel = PACKAGE_SIZE_LEVEL[sizeCategory] || null

  const vehicle = getVehicleCategory(driverVehicleType)
  const vehicleLimits = vehicle || { maxSizeLevel: 2, maxWeightKg: 80 }

  const maxAllowedSize = vehicleLimits.maxSizeLevel
  const packageWeight = delivery?.package?.weightKg !== null && delivery?.package?.weightKg !== undefined
    ? Number(delivery.package.weightKg)
    : null
  const driverWeightCapacity = driverMaxWeightKg != null ? Number(driverMaxWeightKg) : vehicleLimits.maxWeightKg

  if (packageSizeLevel && packageSizeLevel > maxAllowedSize) {
    return { score: 0, reasons: ['Taille trop grande pour votre véhicule'], compatible: false }
  }
  if (packageWeight != null && packageWeight > driverWeightCapacity) {
    return { score: 0, reasons: ['Poids trop élevé pour votre capacité'], compatible: false }
  }
  if (packageSizeLevel) score += 10
  reasons.push('Taille compatible')

  // 3. Weight compatibility (15%)
  if (packageWeight != null && packageWeight <= driverWeightCapacity) {
    score += 15
    reasons.push('Poids compatible')
  } else if (packageWeight != null) {
    return { score: 0, reasons: ['Poids trop élevé'], compatible: false }
  }

  // 4. Route / itinerary compatibility (20%)
  const activeTrips = (driverTrips || []).filter((t) => ['planned', 'active'].includes(t.status))
  let routeScore = 0
  let routeReason = null

  if (activeTrips.length > 0) {
    const pickupCoords = toCoordinatePair(delivery.pickup)
    const dropoffCoords = toCoordinatePair(delivery.dropoff)

    for (const trip of activeTrips) {
      const tripStart = toCoordinatePair(trip.origin)
      const tripEnd = toCoordinatePair(trip.destination)
      if (!tripStart || !tripEnd || !pickupCoords || !dropoffCoords) continue

      const pickupDist = distancePointToSegmentMeters(pickupCoords, tripStart, tripEnd)
      const dropoffDist = distancePointToSegmentMeters(dropoffCoords, tripStart, tripEnd)
      const detour = computeTripDetourMeters({ tripStart, tripEnd, pickup: pickupCoords, dropoff: dropoffCoords })

      const isOnRoute = Number.isFinite(pickupDist) && Number.isFinite(dropoffDist) &&
        pickupDist <= DRIVER_MATCH_MAX_ROUTE_CORRIDOR_METERS &&
        dropoffDist <= DRIVER_MATCH_MAX_ROUTE_CORRIDOR_METERS &&
        Number.isFinite(detour) && detour <= DRIVER_MATCH_MAX_TRIP_DETOUR_METERS

      if (isOnRoute) {
        routeScore = 20
        routeReason = 'Même itinéraire'
        break
      }

      // Partial: pickup is on route but dropoff isn't
      if (Number.isFinite(pickupDist) && pickupDist <= DRIVER_MATCH_MAX_ROUTE_CORRIDOR_METERS) {
        routeScore = Math.max(routeScore, 10)
        routeReason = 'Point de ramassage sur votre itinéraire'
      }
    }
  } else {
    // No active trip — no route to compare, give partial score
    routeScore = 10
    routeReason = 'Aucun trajet actif — compatibilité de zone'
  }

  score += routeScore
  if (routeReason) reasons.push(routeReason)

  // 5. Proximité du conducteur (bonus — if driver coordinates available)
  if (driverCoordinates && pickupCoords) {
    const dist = distanceMeters(
      [Number(driverCoordinates[0]), Number(driverCoordinates[1])],
      [Number(pickupCoords[0]), Number(pickupCoords[1])]
    )
    if (Number.isFinite(dist) && dist <= DRIVER_MATCH_MAX_PICKUP_DISTANCE_METERS) {
      // Already included in route score
    }
  }

  // Clamp and round
  score = Math.min(100, Math.round(score))

  return { score, reasons, compatible: true }
}

/**
 * Extract a wilaya name from an address string (simple heuristic).
 */
const extractWilaya = (address) => {
  if (!address) return null
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean)
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0] || null
}

export const listDriverTripsForCompatibility = async (connection, driverId) => {
  return listDriverTripsModel(connection, driverId, { status: null })
}

export const makeCacheKey = (a, b) => {
  const round = (v) => Number(v).toFixed(6)
  return `${round(a[0])},${round(a[1])}|${round(b[0])},${round(b[1])}`
}

export const getRouteDistanceCached = async (origin, destination) => {
  const key = makeCacheKey(origin, destination)
  const now = Date.now()
  const cached = routeCache.get(key)
  if (cached && (now - cached.cachedAt) < ROUTE_CACHE_TTL_MS) {
    routeCacheHits++
    return { distanceMeters: cached.distanceMeters, durationSeconds: cached.durationSeconds }
  }
  routeCacheMisses++
  const result = await getRouteDistance(origin, destination)
  routeCache.set(key, { distanceMeters: result.distanceMeters, durationSeconds: result.durationSeconds, cachedAt: now })
  return result
}

export const findCompatibleDriversForDelivery = async (connection, { pickupCoordinates, dropoffCoordinates, packageSizeCategory }) => {
  const pool = connection || getPool()
  const sizeLevel = PACKAGE_SIZE_LEVEL[String(packageSizeCategory || "").toLowerCase()] || null

  const sizeFilter = sizeLevel === null
    ? "TRUE"
    : "(t.accepted_package_size = 'any'" +
      " OR (t.accepted_package_size = 'small_only' AND " + sizeLevel + " <= 1)" +
      " OR (t.accepted_package_size = 'up_to_medium' AND " + sizeLevel + " <= 2)" +
      " OR (t.accepted_package_size = 'up_to_large' AND " + sizeLevel + " <= 3))"

  const pickupLat = Number(pickupCoordinates[1])
  const pickupLng = Number(pickupCoordinates[0])
  const dropoffLat = Number(dropoffCoordinates[1])
  const dropoffLng = Number(dropoffCoordinates[0])

  const radiusMeters = CENTRAL_REGION_SEARCH_RADIUS_METERS
  const radiusDeg = radiusMeters / 111000.0

  const pickupLatMin = pickupLat - radiusDeg
  const pickupLatMax = pickupLat + radiusDeg
  const pickupLngMin = pickupLng - radiusDeg
  const pickupLngMax = pickupLng + radiusDeg
  const dropoffLatMin = dropoffLat - radiusDeg
  const dropoffLatMax = dropoffLat + radiusDeg
  const dropoffLngMin = dropoffLng - radiusDeg
  const dropoffLngMax = dropoffLng + radiusDeg

  const sql =
    "SELECT" +
    " d.participant_id AS driver_id," +
    " d.driver_type AS driverType," +
    " v.id AS vehicle_id, v.type AS vehicleType," +
    " dl.latitude, dl.longitude, dl.heading," +
    " dl.speed, dl.timestamp AS locationTimestamp," +
    " t.id AS trip_id," +
    " origin_loc.address AS origin_address," +
    " dest_loc.address AS destination_address," +
    " t.departure_time," +
    " JSON_ARRAY(origin_loc.longitude, origin_loc.latitude) AS tripOriginCoordinates," +
    " JSON_ARRAY(dest_loc.longitude, dest_loc.latitude) AS tripDestinationCoordinates," +
    " t.available_capacity AS availableCapacity," +
    " t.accepted_package_size AS acceptedPackageSize" +
    " FROM Drivers d" +
    " INNER JOIN Trips t ON t.driver_id = d.participant_id AND t.status IN ('planned', 'active')" +
    " LEFT JOIN DriverLocation dl ON dl.driver_id = d.participant_id" +
    " LEFT JOIN Vehicles v ON v.driver_id = d.participant_id AND v.is_verified = 1" +
    " LEFT JOIN TripLocations origin_loc ON origin_loc.trip_id = t.id AND origin_loc.type = 'START'" +
    " LEFT JOIN TripLocations dest_loc ON dest_loc.trip_id = t.id AND dest_loc.type = 'END'" +
    " WHERE d.is_available = 1" +
    " AND d.availability = 'available'" +
    " AND d.review_status = 'approved'" +
    " AND " + sizeFilter +
    " AND (" +
    "   (origin_loc.latitude BETWEEN ? AND ? AND origin_loc.longitude BETWEEN ? AND ?)" +
    "   OR" +
    "   (dest_loc.latitude BETWEEN ? AND ? AND dest_loc.longitude BETWEEN ? AND ?)" +
    " )" +
    " AND (" +
    "   dl.latitude IS NULL" +
    "   OR (dl.latitude BETWEEN ? AND ? AND dl.longitude BETWEEN ? AND ?)" +
    " )" +
    " ORDER BY dl.timestamp DESC"

  const rows = await exec(pool, sql, [
    pickupLatMin, pickupLatMax, pickupLngMin, pickupLngMax,
    dropoffLatMin, dropoffLatMax, dropoffLngMin, dropoffLngMax,
    pickupLatMin, pickupLatMax, pickupLngMin, pickupLngMax,
  ])

  const candidates = []
  const visited = new Set()
  for (const row of rows) {
    if (visited.has(row.driver_id)) continue
    visited.add(row.driver_id)
    candidates.push(row)
  }

  const results = []
  for (const row of candidates) {
    const originCoords = parseJsonCoords(row.tripOriginCoordinates)
    const destCoords = parseJsonCoords(row.tripDestinationCoordinates)
    if (!originCoords || !destCoords) continue

    const driverLocation = row.latitude ? [Number(row.longitude), Number(row.latitude)] : null
    const detour = computeTripDetourMeters({ tripStart: originCoords, tripEnd: destCoords, pickup: pickupCoordinates, dropoff: dropoffCoordinates })
    if (!Number.isFinite(detour) || detour > DRIVER_MATCH_MAX_TRIP_DETOUR_METERS) continue

    const pickupToRoute = distancePointToSegmentMeters(pickupCoordinates, originCoords, destCoords)
    if (!Number.isFinite(pickupToRoute) || pickupToRoute > DRIVER_MATCH_MAX_ROUTE_CORRIDOR_METERS) continue

    const dropoffToRoute = distancePointToSegmentMeters(dropoffCoordinates, originCoords, destCoords)
    if (!Number.isFinite(dropoffToRoute)) continue

    const pickupDistance = driverLocation ? distanceMeters(driverLocation, pickupCoordinates) : null
    const isNear = Number.isFinite(pickupDistance) && pickupDistance <= DRIVER_MATCH_MAX_PICKUP_DISTANCE_METERS

    const haversinePickupToOrigin = distanceMeters(pickupCoordinates, originCoords)
    const haversineDropoffToDest = distanceMeters(dropoffCoordinates, destCoords)
    const haversineDistanceMeters = Math.min(
      Number.isFinite(haversinePickupToOrigin) ? haversinePickupToOrigin : Infinity,
      Number.isFinite(haversineDropoffToDest) ? haversineDropoffToDest : Infinity,
      Number.isFinite(pickupDistance) ? pickupDistance : Infinity,
    )
    if (!Number.isFinite(haversineDistanceMeters) || haversineDistanceMeters > radiusMeters) continue

    const pickupToRouteScore = pickupToRoute / DRIVER_MATCH_MAX_ROUTE_CORRIDOR_METERS
    const dropoffToRouteScore = dropoffToRoute / DRIVER_MATCH_MAX_ROUTE_CORRIDOR_METERS
    const detourScore = detour / DRIVER_MATCH_MAX_TRIP_DETOUR_METERS
    const proximityScore = isNear && Number.isFinite(pickupDistance) ? pickupDistance / DRIVER_MATCH_MAX_PICKUP_DISTANCE_METERS : 1

    const score = Math.round(pickupToRouteScore * 100 + dropoffToRouteScore * 100 + detourScore * 100 + proximityScore * 100)

    results.push({
      driverId: row.driver_id,
      driverType: row.driverType,
      tripId: row.trip_id,
      score,
      deviationKm: Math.round((detour / 1000) * 100) / 100,
      pickupDistanceMeters: Number.isFinite(pickupDistance) ? Math.round(pickupDistance) : null,
      pickupToRouteMeters: Math.round(pickupToRoute),
      dropoffToRouteMeters: Math.round(dropoffToRoute),
      detourMeters: Math.round(detour),
      isNearDriver: isNear,
      isOnRoute: pickupToRoute <= DRIVER_MATCH_MAX_ROUTE_CORRIDOR_METERS,
      haversineDistanceMeters: Math.round(haversineDistanceMeters),
      driverLocation: driverLocation ? { coordinates: driverLocation, heading: row.heading === null ? null : Number(row.heading), speed: row.speed === null ? null : Number(row.speed), timestamp: row.locationTimestamp } : null,
    })
  }

  results.sort((a, b) => a.haversineDistanceMeters - b.haversineDistanceMeters || a.score - b.score)
  return results
}

const parseJsonCoords = (jsonValue) => {
  if (!jsonValue) return null
  let arr
  if (Array.isArray(jsonValue)) {
    arr = jsonValue
  } else if (typeof jsonValue === "string") {
    try { arr = JSON.parse(jsonValue) } catch { return null }
  } else {
    return null
  }
  if (!Array.isArray(arr) || arr.length < 2) return null
  const lng = Number(arr[0])
  const lat = Number(arr[1])
  return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null
}

// ── Timeline ───────────────────────────────────────────────────────────

export const touchTimeline = async (connection, deliveryId, column) => {
  if (!column) return
  await exec(
    connection,
    `INSERT INTO DeliveryTimeline (id, delivery_id, ${column})
     VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE ${column} = NOW()`,
    [crypto.randomUUID(), deliveryId],
  )
}

// ── Access ─────────────────────────────────────────────────────────────

export const assertCanAccessDelivery = ({ delivery, user }) => {
  const isOwner = delivery.senderId === user.id
  const isAssignedDriver = delivery.assignedDriverId && delivery.assignedDriverId === user.id
  const isAdminLike = user.role === "admin" || user.role === "authority"
  if (!isOwner && !isAssignedDriver && !isAdminLike) throw createError(403, "You are not authorized to access this delivery")
  return { isOwner, isAssignedDriver, isAdminLike }
}

// ── Execution payload ──────────────────────────────────────────────────

export const buildDriverExecutionPayload = (delivery) => {
  let currentPickupIndex = 0
  let currentDropoffIndex = 0
  const enteredStatuses = []
  const statuses = delivery.statusLog || []
  for (const log of statuses) {
    enteredStatuses.push(log.status)
    if (log.status === "PickedUp") currentPickupIndex = 1
    if (log.status === "Delivered") currentDropoffIndex = 1
  }

  return {
    deliveryId: delivery.id,
    status: delivery.status,
    enteredStatuses,
    pickup: {
      address: delivery.pickup?.address,
      location: { coordinates: delivery.pickup?.location?.coordinates },
      contact: { name: delivery.recipient?.name, phone: delivery.recipient?.phone },
    },
    dropoff: {
      address: delivery.dropoff?.address,
      location: { coordinates: delivery.dropoff?.location?.coordinates },
    },
    package: delivery.package,
    notes: delivery.deliveryNote || null,
    route: delivery.route || null,
    timeline: {
      pickupWindow: currentPickupIndex || null,
      dropoffWindow: currentDropoffIndex || null,
    },
    proofOfDelivery: delivery.proofOfDelivery || null,
  }
}

// ── Pricing analytics ──────────────────────────────────────────────────

export const savePricingAnalytics = async (connection, deliveryId, { mode, distanceKm, baseFee, distanceFee, sizeSurcharge, weightSurcharge, deviationCost, urgentSurcharge, estimatedPrice, driverScore, selectedDriverId, isBestDeal }) => {
  await exec(
    connection,
    `INSERT INTO DeliveryPricingAnalytics (
      id, delivery_id, pricing_mode,
      distance_km, base_fee, distance_fee, size_surcharge,
      weight_surcharge, deviation_cost, urgent_surcharge,
      estimated_price, driver_score, selected_driver_id, is_best_deal
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(), deliveryId, mode,
      distanceKm, baseFee, distanceFee, sizeSurcharge,
      weightSurcharge, deviationCost, urgentSurcharge,
      estimatedPrice, driverScore, selectedDriverId, isBestDeal ? 1 : 0,
    ],
  )
}
