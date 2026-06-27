import axios from "axios"
import { createError } from "./response.js"
import { formatDurationText } from "./helpers.js"

const GEOAPIFY_BASE_URL = (process.env.GEOAPIFY_BASE_URL || "https://api.geoapify.com/v1").trim().replace(/\/+$/, "")
const GEOAPIFY_API_KEY = (process.env.GEOAPIFY_API_KEY || "").trim()

const toRadians = (value) => (Number(value) * Math.PI) / 180

const haversineDistance = (from, to) => {
  if (!from || !to) return null
  const earthRadius = 6371000
  const lat1 = toRadians(from.lat ?? from[1])
  const lat2 = toRadians(to.lat ?? to[1])
  const deltaLat = lat2 - lat1
  const deltaLng = toRadians((to.lng ?? to[0]) - (from.lng ?? from[0]))
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return earthRadius * c
}

const toNumber = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const parseLatLngString = (value) => {
  const [latPart, lngPart] = String(value).split(",").map((part) => part.trim())
  const lat = toNumber(latPart)
  const lng = toNumber(lngPart)
  return lat !== null && lng !== null ? { lat, lng } : null
}

const normalizePoint = (point) => {
  if (Array.isArray(point) && point.length === 2) {
    const lng = toNumber(point[0])
    const lat = toNumber(point[1])
    return lat !== null && lng !== null ? { lat, lng } : null
  }
  if (typeof point === "string") return parseLatLngString(point)
  if (point && typeof point === "object") {
    const lat = toNumber(point.lat ?? point.latitude)
    const lng = toNumber(point.lng ?? point.lon ?? point.longitude)
    return lat !== null && lng !== null ? { lat, lng } : null
  }
  return null
}

const normalizeWaypoints = (waypoints) => {
  if (!Array.isArray(waypoints)) return []
  return waypoints.map((p) => normalizePoint(p)).filter((p) => p !== null)
}

const buildRoutePath = (points) => points.map((p) => `${p.lat},${p.lng}`).join("|")

const requestRoute = async ({ originPoint, destinationPoint, waypointPoints = [], alternatives = 0 }) => {
  const routePath = buildRoutePath([originPoint, ...waypointPoints, destinationPoint])
  try {
    const params = { waypoints: routePath, mode: "drive", apiKey: GEOAPIFY_API_KEY }
    if (alternatives > 0) params.alternatives = alternatives
    const response = await axios.get(`${GEOAPIFY_BASE_URL}/routing`, { params })
    const features = response?.data?.features || []
    if (features.length === 0) {
      throw createError(404, "Route not found", { code: "ROUTE_NOT_FOUND" })
    }
    const validRoutes = features.filter((f) =>
      f && typeof f.properties?.distance === "number" && typeof f.properties?.time === "number"
    )
    if (validRoutes.length === 0) {
      throw createError(404, "Route not found", { code: "ROUTE_NOT_FOUND" })
    }
    return { route: validRoutes[0], routes: validRoutes }
  } catch (error) {
    if (error?.details?.code === "ROUTE_NOT_FOUND" || error?.statusCode) throw error
    throw createError(503, "Routing service is temporarily unavailable", {
      code: "ROUTING_SERVICE_UNAVAILABLE",
      providerMessage: error?.message || "Unknown routing provider error",
    })
  }
}

export const getRouteDistance = async (origin, destination) => {
  const originPoint = normalizePoint(origin)
  const destinationPoint = normalizePoint(destination)
  if (!originPoint || !destinationPoint) {
    throw createError(400, "Invalid origin or destination coordinates", { code: "INVALID_COORDINATES" })
  }
  try {
    const { route } = await requestRoute({ originPoint, destinationPoint })
    return { distanceMeters: route.properties.distance, durationSeconds: route.properties.time }
  } catch (error) {
    if (error?.details?.code === "ROUTE_NOT_FOUND") {
      const distanceMeters = Math.round(haversineDistance(originPoint, destinationPoint))
      const durationSeconds = Math.round(distanceMeters / 13.89)
      return { distanceMeters, durationSeconds }
    }
    throw error
  }
}

export const getRouteDirections = async (origin, destination, waypoints = [], options = {}) => {
  const originPoint = normalizePoint(origin)
  const destinationPoint = normalizePoint(destination)
  if (!originPoint || !destinationPoint) {
    throw createError(400, "Invalid origin or destination coordinates", { code: "INVALID_COORDINATES" })
  }
  const waypointPoints = normalizeWaypoints(waypoints)
  const alternativesCount = options?.alternatives === true ? 3 : 0

  let route, routes, legs, steps, coordinates, path, normalizedRoutes
  try {
    const result = await requestRoute({ originPoint, destinationPoint, waypointPoints, alternatives: alternativesCount })
    route = result.route
    routes = result.routes
    legs = Array.isArray(route.properties?.legs) ? route.properties.legs : []
    steps = legs.flatMap((leg) => (Array.isArray(leg?.steps) ? leg.steps : []))
    coordinates = route.geometry?.coordinates?.flat(1) || []
    path = coordinates.map((coord) => ({ lat: coord[1], lng: coord[0] }))
    normalizedRoutes = routes.map((cr) => {
      const crCoords = cr.geometry?.coordinates?.flat(1) || []
      return { ...cr, distanceMeters: cr.properties?.distance, durationSeconds: cr.properties?.time, polyline: null, geometry: cr.geometry, geometryRaw: cr, coordinates: crCoords, path: crCoords.map((c) => ({ lat: c[1], lng: c[0] })), legs: cr.properties?.legs || [] }
    })
  } catch (error) {
    if (error?.details?.code === "ROUTE_NOT_FOUND") {
      const distanceMeters = Math.round(haversineDistance(originPoint, destinationPoint))
      const durationSeconds = Math.round(distanceMeters / 13.89)
      path = [originPoint, destinationPoint]
      coordinates = [[originPoint.lng, originPoint.lat], [destinationPoint.lng, destinationPoint.lat]]
      legs = []; steps = []; normalizedRoutes = []
      route = { properties: { distance: distanceMeters, time: durationSeconds } }
    } else {
      throw error
    }
  }
  return {
    distanceMeters: route.properties.distance,
    durationSeconds: route.properties.time,
    polyline: null, geometry: route.geometry, geometryRaw: route,
    coordinates, path, routes: normalizedRoutes, legs, steps,
    warnings: waypointPoints.length !== waypoints.length ? ["Some waypoints were ignored due to invalid coordinates"] : [],
  }
}

export const geocodeAddress = async (address) => {
  try {
    const url = `${GEOAPIFY_BASE_URL}/geocode/search`

    const tryGeocode = async (query) => {
      const res = await axios.get(url, {
        params: { text: query, apiKey: GEOAPIFY_API_KEY, format: "geojson", lang: "ar", filter: "countrycode:dz" },
      })
      if (res?.data?.error) {
        throw createError(502, `Geoapify geocoding error: ${res.data.error}`, {
          code: "GEOCODING_PROVIDER_ERROR", providerMessage: res.data.message || res.data.error,
        })
      }
      return res?.data?.features?.[0] || null
    }

    let feature = await tryGeocode(address)

    if (!feature) {
      const amended = `${address}, Algeria`
      console.warn(`Geoapify geocode zero results for "${address}", retrying with "${amended}"`)
      feature = await tryGeocode(amended)
    }

    if (!feature && /[\u0600-\u06FF]/.test(address)) {
      const amended = `${address}, الجزائر`
      console.warn(`Geoapify geocode zero results for "${address}", retrying with "${amended}"`)
      feature = await tryGeocode(amended)
    }

    if (!feature) {
      console.error(`Geoapify geocode zero results for address: "${address}"`)
      throw createError(404, "Address not found", { code: "ADDRESS_NOT_FOUND" })
    }
    return {
      lat: feature.properties.lat, lng: feature.properties.lon,
      displayName: feature.properties.formatted,
      address: { state: feature.properties.state || null, county: feature.properties.county || null },
    }
  } catch (error) {
    if (error?.statusCode) throw error
    if (error?.response) {
      console.error("Geoapify geocode HTTP error:", error.response.status, JSON.stringify(error.response.data).slice(0, 500))
    }
    throw createError(503, "Geocoding service unavailable", {
      code: "GEOCODING_SERVICE_UNAVAILABLE",
      providerMessage: error?.response?.data?.error || error?.message,
    })
  }
}

export const reverseGeocode = async (lat, lng) => {
  const parsedLat = Number(lat)
  const parsedLng = Number(lng)
  if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) {
    throw createError(400, "Invalid coordinates for reverse geocoding", {
      code: "INVALID_COORDINATES", raw: { lat, lng },
    })
  }
  try {
    const url = `${GEOAPIFY_BASE_URL}/geocode/reverse`
    const response = await axios.get(url, {
      params: { lat: parsedLat, lon: parsedLng, apiKey: GEOAPIFY_API_KEY, format: "geojson" },
    })
    if (response?.data?.error) {
      throw createError(502, `Geoapify reverse geocoding error: ${response.data.error}`, {
        code: "REVERSE_GEOCODING_PROVIDER_ERROR", providerMessage: response.data.message || response.data.error,
      })
    }
    const feature = response?.data?.features?.[0]
    if (!feature) {
      console.error(`Geoapify reverse geocode zero results. URL: ${url}?lat=${parsedLat}&lon=${parsedLng}&apiKey=***&format=geojson. Response keys: ${Object.keys(response?.data || {}).join(",")}`)
      throw createError(404, "Location not found", { code: "LOCATION_NOT_FOUND" })
    }
    return {
      lat: feature.properties.lat, lng: feature.properties.lon,
      displayName: feature.properties.formatted,
      address: { state: feature.properties.state || null, county: feature.properties.county || null },
    }
  } catch (error) {
    if (error?.statusCode) throw error
    if (error?.response) {
      console.error("Geoapify reverse geocode error:", error.response.status, JSON.stringify(error.response.data).slice(0, 500))
    }
    throw createError(503, "Reverse geocoding service unavailable", {
      code: "REVERSE_GEOCODING_SERVICE_UNAVAILABLE",
      providerMessage: error?.response?.data?.error || error?.message,
    })
  }
}

const formatDistanceText = (distanceMeters) => `${(distanceMeters / 1000).toFixed(1)} km`

export const getDistance = async (origin, destination) => {
  const { distanceMeters, durationSeconds } = await getRouteDistance(origin, destination)
  return {
    distance: distanceMeters, distanceText: formatDistanceText(distanceMeters),
    duration: durationSeconds, durationText: formatDurationText(durationSeconds),
    durationInTraffic: durationSeconds, durationInTrafficText: formatDurationText(durationSeconds),
  }
}

const sampleRoutePoints = (path, { minDistanceMeters = 40000, maxSamples = 10 } = {}) => {
  if (!Array.isArray(path) || path.length === 0) return []
  const samples = [path[0]]
  let distanceSinceSample = 0
  let previous = path[0]
  for (let i = 1; i < path.length; i++) {
    const point = path[i]
    distanceSinceSample += haversineDistance(previous, point)
    previous = point
    if (distanceSinceSample >= minDistanceMeters && samples.length < maxSamples - 1) {
      samples.push(point)
      distanceSinceSample = 0
    }
  }
  const lastPoint = path[path.length - 1]
  const lastSample = samples[samples.length - 1]
  if (!lastSample || lastSample.lat !== lastPoint.lat || lastSample.lng !== lastPoint.lng) {
    samples.push(lastPoint)
  }
  return samples
}

const resolveRouteStates = async (path, options = {}) => {
  const samples = sampleRoutePoints(path, options)
  if (samples.length === 0) return []
  const states = []
  const seen = new Set()
  for (const point of samples) {
    try {
      const result = await reverseGeocode(point.lat, point.lng)
      const state = result?.address?.state || result?.address?.county || null
      if (state && !seen.has(state)) { states.push(state); seen.add(state) }
    } catch { }
  }
  return states
}

export const getDirections = async (origin, destination, waypoints = [], options = {}) => {
  const route = await getRouteDirections(origin, destination, waypoints, options)
  const includeStates = options?.includeStates === true
  const routeStates = includeStates ? await resolveRouteStates(route.path, options) : []
  return {
    distance: route.distanceMeters,
    distanceText: formatDistanceText(route.distanceMeters),
    duration: route.durationSeconds,
    durationText: formatDurationText(route.durationSeconds),
    durationInTraffic: route.durationSeconds,
    durationInTrafficText: formatDurationText(route.durationSeconds),
    polyline: route.polyline, geometry: route.geometry,
    geometryRaw: route.geometryRaw, coordinates: route.coordinates,
    path: route.path, routes: route.routes, legs: route.legs,
    steps: route.steps, states: routeStates, bounds: null,
    copyrights: "© Geoapify & OpenStreetMap contributors",
    warnings: route.warnings,
  }
}

export { haversineDistance as distanceMeters }


