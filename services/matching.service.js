import { exec } from "../lib/db.js"
import { getPool } from "../lib/db.js"
import { findDriverByUserId } from "../models/driver.model.js"
import { findDeliveryById } from "../models/delivery.model.js"
import { getDriverRatingAggregate } from "../models/rating.model.js"
import { getVehicleCategory, PACKAGE_SIZE_LEVEL } from "../vehicle_capacities.js"
import { listDriverTripsForCompatibility } from "./delivery.service.js"

// ── Constants ──

const MAX_PERSONAL_VEHICLE_WEIGHT_KG = 500

const MAX_ROUTE_CORRIDOR_METERS = 50000
const MAX_TRIP_DETOUR_METERS = 100000
const MAX_PICKUP_DISTANCE_METERS = 100000
const EARTH_RADIUS_KM = 6371

// Score weights (total = 100)
const WILAYA_WEIGHT = 40
const TRIP_WEIGHT = 20
const GPS_WEIGHT = 10
const VEHICLE_WEIGHT = 10
const WEIGHT_WEIGHT = 10
const SIZE_WEIGHT = 5
const REPUTATION_WEIGHT = 5

// ── Haversine distance ──

const haversineKm = (lat1, lng1, lat2, lng2) => {
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return EARTH_RADIUS_KM * c
}

const haversineMeters = (lat1, lng1, lat2, lng2) => {
  return haversineKm(lat1, lng1, lat2, lng2) * 1000
}

// ── Distance point to segment (for trip route matching) ──

const distancePointToSegmentMeters = (px, py, ax, ay, bx, by) => {
  const abx = bx - ax
  const aby = by - ay
  const apx = px - ax
  const apy = py - ay
  const ab2 = abx * abx + aby * aby
  if (ab2 === 0) return haversineMeters(py, px, ay, ax)
  let t = (apx * abx + apy * aby) / ab2
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * abx
  const cy = ay + t * aby
  return haversineMeters(py, px, cy, cx)
}

// ── Compute trip detour meters ──

const computeTripDetourMeters = ({ tripStartLat, tripStartLng, tripEndLat, tripEndLng, pickupLat, pickupLng, dropoffLat, dropoffLng }) => {
  const direct = haversineMeters(tripStartLat, tripStartLng, tripEndLat, tripEndLng)
  const viaPickup = haversineMeters(tripStartLat, tripStartLng, pickupLat, pickupLng) +
    haversineMeters(pickupLat, pickupLng, dropoffLat, dropoffLng) +
    haversineMeters(dropoffLat, dropoffLng, tripEndLat, tripEndLng)
  return viaPickup - direct
}

// ── Determine delivery mode from package characteristics ──

export const determineDeliveryMode = ({ sizeCategory, weightKg, packageType, description }) => {
  const weight = Number(weightKg) || 0
  const sizeLevel = PACKAGE_SIZE_LEVEL[sizeCategory] || 0
  const needsProTransporter = weight > MAX_PERSONAL_VEHICLE_WEIGHT_KG || sizeLevel > 4

  if (needsProTransporter) {
    return {
      pricingMode: "PROFESSIONAL_DELIVERY",
      deliveryMode: "pro_transporter",
      isProTransporter: true,
    }
  }

  return {
    pricingMode: "CROSS_SHIPPING",
    deliveryMode: "standard",
    isProTransporter: false,
  }
}

// ── Fetch driver context ──

export const getDriverMatchingContext = async (driverId) => {
  const driver = await findDriverByUserId(null, driverId)
  if (!driver) return null

  const userRows = await exec(null, `SELECT city FROM Users WHERE id = ?`, [driverId])
  const city = (userRows[0]?.city || '').trim()

  const locRows = await exec(null,
    `SELECT latitude, longitude FROM DriverLocation WHERE driver_id = ? ORDER BY timestamp DESC LIMIT 1`,
    [driverId]
  )
  const hasCoords = locRows[0]?.latitude != null && locRows[0]?.longitude != null
  const coordinates = hasCoords ? { lat: Number(locRows[0].latitude), lng: Number(locRows[0].longitude) } : null

  const trips = await listDriverTripsForCompatibility(null, driverId)
  const activeTrips = (trips || []).filter(t => ['planned', 'active'].includes(t.status))

  let reputation = 0
  try {
    const agg = await getDriverRatingAggregate(null, driverId)
    if (agg.totalRatings > 0) reputation = agg.bayesianScore
  } catch (_) {}

  const vehicle = getVehicleCategory(driver.vehicleType || 'city_car')
  const maxWeightKg = driver.maxWeightKg != null ? Number(driver.maxWeightKg) : (vehicle?.maxWeightKg || 80)
  const maxSizeLevel = vehicle?.maxSizeLevel || 2

  return {
    driverId,
    city,
    coordinates,
    driverType: driver.driverType || 'normal_driver',
    vehicleType: driver.vehicleType || 'city_car',
    vehicle,
    maxWeightKg,
    maxSizeLevel,
    activeTrips,
    totalTrips: (trips || []).length,
    reputation,
  }
}

// ── Score a single delivery for a driver context ──

export const scoreDelivery = (delivery, context) => {
  const reasons = []
  let score = 0
  let compatible = true

  const {
    city: driverCity,
    coordinates: driverCoords,
    maxWeightKg,
    maxSizeLevel,
    vehicleType,
    vehicle,
    activeTrips,
    reputation,
  } = context

  // ── Extract delivery data ──
  const pickupWilaya = delivery?.pickupWilaya || delivery?.pickup?.wilaya || ''
  const dropoffWilaya = delivery?.dropoffWilaya || delivery?.dropoff?.wilaya || ''
  const sizeCategory = String(delivery?.package?.sizeCategory || '').toLowerCase()
  const packageSizeLevel = PACKAGE_SIZE_LEVEL[sizeCategory] || null
  const packageWeight = delivery?.package?.weightKg != null ? Number(delivery.package.weightKg) : null

  let pickupLat = null, pickupLng = null, dropoffLat = null, dropoffLng = null
  const p = delivery?.pickup
  if (p?.latitude != null && p?.longitude != null) {
    pickupLat = Number(p.latitude)
    pickupLng = Number(p.longitude)
  }
  const d = delivery?.dropoff
  if (d?.latitude != null && d?.longitude != null) {
    dropoffLat = Number(d.latitude)
    dropoffLng = Number(d.longitude)
  }

  // Also check DeliveryLocations
  const locs = delivery?.locations || []

  // ── 1. WILAYA (40%) ──
  const pickupLower = pickupWilaya.toLowerCase()
  const cityLower = (driverCity || '').toLowerCase()
  const sameWilaya = cityLower && (
    pickupLower === cityLower ||
    pickupLower.includes(cityLower) ||
    pickupLower.split(',').map(p => p.trim()).includes(cityLower)
  )

  if (!sameWilaya) {
    return { score: 0, reasons: ['Wilaya différente'], compatible: false, distanceKm: null, estimatedProfit: null, estimatedDetourKm: null }
  }
  score += WILAYA_WEIGHT
  reasons.push({ label: 'Même wilaya', points: WILAYA_WEIGHT, max: WILAYA_WEIGHT })

  // ── 2. TRIP ROUTE (20%) ──
  let tripScore = 0
  let tripReason = 'Aucun trajet actif'
  let detourKm = null

  if (activeTrips.length > 0 && pickupLat != null && dropoffLat != null) {
    for (const trip of activeTrips) {
      const tOrigin = trip.origin || trip.originCoordinates
      const tDest = trip.destination || trip.destinationCoordinates
      if (!tOrigin?.latitude || !tOrigin?.longitude || !tDest?.latitude || !tDest?.longitude) continue

      const oLat = Number(tOrigin.latitude)
      const oLng = Number(tOrigin.longitude)
      const dLat = Number(tDest.latitude)
      const dLng = Number(tDest.longitude)

      const pickupDist = distancePointToSegmentMeters(pickupLng, pickupLat, oLng, oLat, dLng, dLat)
      const dropoffDist = distancePointToSegmentMeters(dropoffLng, dropoffLat, oLng, oLat, dLng, dLat)
      const detour = computeTripDetourMeters({
        tripStartLat: oLat, tripStartLng: oLng,
        tripEndLat: dLat, tripEndLng: dLng,
        pickupLat, pickupLng,
        dropoffLat, dropoffLng,
      })

      const isOnRoute = Number.isFinite(pickupDist) && pickupDist <= MAX_ROUTE_CORRIDOR_METERS &&
        Number.isFinite(dropoffDist) && dropoffDist <= MAX_ROUTE_CORRIDOR_METERS &&
        Number.isFinite(detour) && detour <= MAX_TRIP_DETOUR_METERS

      if (isOnRoute) {
        tripScore = TRIP_WEIGHT
        tripReason = 'Même itinéraire'
        detourKm = Math.round((detour / 1000) * 10) / 10
        break
      }

      if (Number.isFinite(pickupDist) && pickupDist <= MAX_ROUTE_CORRIDOR_METERS) {
        tripScore = Math.max(tripScore, Math.round(TRIP_WEIGHT * 0.5))
        tripReason = 'Point de ramassage sur votre itinéraire'
        detourKm = Math.round((detour / 1000) * 10) / 10
      }
    }
  } else {
    tripScore = Math.round(TRIP_WEIGHT * 0.5)
    tripReason = 'Aucun trajet actif — compatibilité de zone'
  }

  score += tripScore
  if (tripScore > 0) {
    reasons.push({ label: tripReason, points: tripScore, max: TRIP_WEIGHT })
  }

  // ── 3. GPS DISTANCE (10%) ──
  let gpsScore = 0
  let distanceKm = null

  if (driverCoords && pickupLat != null && pickupLng != null) {
    distanceKm = Math.round(haversineKm(driverCoords.lat, driverCoords.lng, pickupLat, pickupLng) * 10) / 10

    if (distanceKm <= 1) gpsScore = GPS_WEIGHT
    else if (distanceKm <= 3) gpsScore = Math.round(GPS_WEIGHT * 0.9)
    else if (distanceKm <= 5) gpsScore = Math.round(GPS_WEIGHT * 0.75)
    else if (distanceKm <= 10) gpsScore = Math.round(GPS_WEIGHT * 0.5)
    else if (distanceKm <= 20) gpsScore = Math.round(GPS_WEIGHT * 0.25)
    else gpsScore = Math.round(GPS_WEIGHT * 0.1)
  } else {
    gpsScore = Math.round(GPS_WEIGHT * 0.5)
  }

  score += gpsScore
  if (gpsScore > 0) {
    reasons.push({ label: distanceKm != null ? `${distanceKm} km` : 'Position non disponible', points: gpsScore, max: GPS_WEIGHT })
  }

  // ── 4. VEHICLE COMPATIBILITY (10%) ──
  if (packageSizeLevel != null && packageSizeLevel > maxSizeLevel) {
    return { score: 0, reasons: ['Taille trop grande pour votre véhicule'], compatible: false, distanceKm, estimatedProfit: null, estimatedDetourKm: detourKm }
  }
  if (packageWeight != null && packageWeight > maxWeightKg) {
    return { score: 0, reasons: ['Poids trop élevé pour votre capacité'], compatible: false, distanceKm, estimatedProfit: null, estimatedDetourKm: detourKm }
  }
  score += VEHICLE_WEIGHT
  reasons.push({ label: `${vehicle?.labelFr || vehicleType} compatible`, points: VEHICLE_WEIGHT, max: VEHICLE_WEIGHT })

  // ── 5. WEIGHT (10%) ──
  if (packageWeight != null) {
    const ratio = packageWeight / maxWeightKg
    if (ratio <= 0.25) score += WEIGHT_WEIGHT
    else if (ratio <= 0.5) score += Math.round(WEIGHT_WEIGHT * 0.8)
    else if (ratio <= 0.75) score += Math.round(WEIGHT_WEIGHT * 0.5)
    else score += Math.round(WEIGHT_WEIGHT * 0.3)
    reasons.push({ label: `${packageWeight} kg / ${maxWeightKg} kg`, points: score - (score - WEIGHT_WEIGHT + (score > WEIGHT_WEIGHT ? 0 : 0)), max: WEIGHT_WEIGHT })
  }

  // ── 6. SIZE (5%) ──
  if (packageSizeLevel != null) {
    const ratio = packageSizeLevel / maxSizeLevel
    if (ratio <= 0.25) score += SIZE_WEIGHT
    else if (ratio <= 0.5) score += Math.round(SIZE_WEIGHT * 0.8)
    else if (ratio <= 0.75) score += Math.round(SIZE_WEIGHT * 0.5)
    else score += Math.round(SIZE_WEIGHT * 0.3)
    reasons.push({ label: `${sizeCategory || 'standard'} / ${vehicle?.maxSizeLabel || 'standard'}`, points: SIZE_WEIGHT, max: SIZE_WEIGHT })
  }

  // ── 7. REPUTATION (5%) ──
  if (reputation > 0) {
    const bonus = Math.round(REPUTATION_WEIGHT * (reputation / 5))
    score += bonus
    reasons.push({ label: reputation >= 4.5 ? 'Excellente réputation' : reputation >= 4.0 ? 'Bonne réputation' : 'Réputation correcte', points: bonus, max: REPUTATION_WEIGHT })
  }

  // ── Estimated profit ──
  let estimatedProfit = null
  if (delivery?.price != null) {
    estimatedProfit = Math.round(Number(delivery.price) * 100) / 100
  } else if (delivery?.pricing?.price != null) {
    estimatedProfit = Math.round(Number(delivery.pricing.price) * 100) / 100
  }

  // Clamp
  score = Math.min(100, Math.max(0, Math.round(score)))

  return {
    score,
    compatible: true,
    reasons,
    distanceKm,
    estimatedProfit,
    estimatedDetourKm: detourKm,
  }
}

// ── Get recommended deliveries for a driver ──

export const getRecommendedDeliveries = async (driverId, filters = {}) => {
  const context = await getDriverMatchingContext(driverId)
  if (!context) return { deliveries: [], context: null }

  const { city } = context
  const params = [driverId, driverId]
  const clauses = [
    "d.status = 'Pending'",
    'd.assigned_driver_id IS NULL',
    'r.id IS NULL',
    "(d.trip_id IS NULL OR d.trip_id IN (SELECT t.id FROM Trips t WHERE t.driver_id = ? AND t.status IN ('planned','active')))",
  ]

  // Wilaya filter
  if (city) {
    clauses.push('d.pickup_wilaya = ?')
    params.push(city)
  }

  // Day filter
  if (filters.day === 'today') {
    clauses.push('DATE(d.created_at) = CURDATE()')
  } else if (filters.day === 'tomorrow') {
    clauses.push('DATE(d.created_at) = DATE_ADD(CURDATE(), INTERVAL 1 DAY)')
  }

  // Size filter
  if (filters.size === 'small') clauses.push("d.package_size_category = 'small'")
  else if (filters.size === 'medium') clauses.push("d.package_size_category = 'medium'")
  else if (filters.size === 'large') clauses.push("d.package_size_category = 'large'")
  else if (filters.size === 'xlarge') clauses.push("d.package_size_category = 'xlarge'")

  // Weight filter
  if (filters.weight === '0-5') clauses.push('d.package_weight_kg IS NOT NULL AND d.package_weight_kg <= 5')
  else if (filters.weight === '5-20') clauses.push('d.package_weight_kg IS NOT NULL AND d.package_weight_kg > 5 AND d.package_weight_kg <= 20')
  else if (filters.weight === '20-100') clauses.push('d.package_weight_kg IS NOT NULL AND d.package_weight_kg > 20 AND d.package_weight_kg <= 100')
  else if (filters.weight === '100+') clauses.push('d.package_weight_kg IS NOT NULL AND d.package_weight_kg > 100')

  const sql = `SELECT d.id FROM Deliveries d
    LEFT JOIN DeliveryRejections r ON r.delivery_id = d.id AND r.driver_id = ?
    WHERE ${clauses.join(' AND ')}
    ORDER BY d.created_at DESC
    LIMIT 200`

  const rows = await exec(null, sql, params)
  if (rows.length === 0) return { deliveries: [], context }

  const results = []
  for (const row of rows) {
    try {
      const delivery = await findDeliveryById(null, row.id, { includePricing: true, includeLocations: true })
      if (!delivery) continue

      const scoring = scoreDelivery(delivery, context)
      if (!scoring.compatible) continue

      results.push({
        id: delivery.id,
        compatibilityScore: scoring.score,
        compatibilityReasons: scoring.reasons,
        distanceKm: scoring.distanceKm,
        estimatedProfit: scoring.estimatedProfit,
        estimatedDetourKm: scoring.estimatedDetourKm,
        pickupWilaya: delivery.pickupWilaya,
        dropoffWilaya: delivery.dropoffWilaya,
        package: delivery.package ? {
          sizeCategory: delivery.package.sizeCategory,
          weightKg: delivery.package.weightKg,
          description: delivery.package.description,
        } : null,
        pricing: scoring.estimatedProfit != null ? {
          estimatedPrice: scoring.estimatedProfit,
          currency: 'DZD',
        } : null,
        pickup: delivery.pickup ? {
          address: delivery.pickup.address,
          latitude: delivery.pickup.latitude,
          longitude: delivery.pickup.longitude,
        } : null,
        dropoff: delivery.dropoff ? {
          address: delivery.dropoff.address,
          latitude: delivery.dropoff.latitude,
          longitude: delivery.dropoff.longitude,
        } : null,
        createdAt: delivery.createdAt,
        updatedAt: delivery.updatedAt,
        status: delivery.status,
      })
    } catch (_) {}
  }

  results.sort((a, b) => b.compatibilityScore - a.compatibilityScore || new Date(b.createdAt || 0) - new Date(a.createdAt || 0))

  return { deliveries: results, context }
}

// ── Dashboard stats for matching ──

export const getMatchingDashboardStats = async (driverId) => {
  try {
    const { deliveries, context } = await getRecommendedDeliveries(driverId)
    if (deliveries.length === 0) {
      return {
        recommendedCount: 0,
        potentialRevenue: 0,
        averageCompatibility: 0,
        averageDistance: null,
      }
    }

    const totalRevenue = deliveries.reduce((sum, d) => sum + (d.estimatedProfit || 0), 0)
    const avgScore = Math.round(deliveries.reduce((sum, d) => sum + d.compatibilityScore, 0) / deliveries.length)
    const distances = deliveries.filter(d => d.distanceKm != null).map(d => d.distanceKm)
    const avgDistance = distances.length > 0
      ? Math.round((distances.reduce((s, v) => s + v, 0) / distances.length) * 10) / 10
      : null

    return {
      recommendedCount: deliveries.length,
      potentialRevenue: Math.round(totalRevenue * 100) / 100,
      averageCompatibility: avgScore,
      averageDistance: avgDistance,
    }
  } catch (_) {
    return { recommendedCount: 0, potentialRevenue: 0, averageCompatibility: 0, averageDistance: null }
  }
}
