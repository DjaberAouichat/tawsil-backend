import crypto from "crypto"
import { getPool, exec } from "../lib/db.js"

const mapTripRow = (row) => {
  if (!row) {
    return null
  }

  let parsedGeometry = null
  if (row.route_geometry) {
    try {
      parsedGeometry = typeof row.route_geometry === 'string'
        ? JSON.parse(row.route_geometry)
        : row.route_geometry
    } catch (_) {
      parsedGeometry = null
    }
  }

  return {
    id: row.id,
    driverId: row.driver_id,
    title: row.title || "",
    departureTime: row.departure_time,
    expectedArrivalTime: row.expected_arrival_time,
    maxDeliveries: row.max_deliveries,
    availableCapacity: row.available_capacity,
    vehicleType: row.vehicle_type || null,
    acceptedPackageSize: row.accepted_package_size || null,
    routeGeometry: parsedGeometry,
    routeDistanceMeters: row.route_distance_meters ?? null,
    routeDurationSeconds: row.route_duration_seconds ?? null,
    status: row.status,
    notes: row.notes || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const mapTripLocationRows = (rows) => {
  const result = {
    origin: null,
    destination: null,
  }

  for (const row of rows || []) {
    const coordinates =
      row.longitude === null || row.longitude === undefined || row.latitude === null || row.latitude === undefined
        ? null
        : [Number(row.longitude), Number(row.latitude)]

    const point = {
      address: row.address || "",
      location: {
        type: "Point",
        coordinates,
      },
    }

    if (row.type === "START") {
      result.origin = point
    }

    if (row.type === "END") {
      result.destination = point
    }
  }

  return result
}

const buildAvailableTripsQuery = (
  {
    originText = null,
    destinationText = null,
    departureFrom = null,
    departureTo = null,
    minCapacity = null,
  } = {},
) => {
  const params = []
  const clauses = ["t.status IN ('planned', 'active')"]

  if (Number.isFinite(Number(minCapacity)) && Number(minCapacity) > 0) {
    clauses.push("t.available_capacity >= ?")
    params.push(Number(minCapacity))
  } else {
    clauses.push("t.available_capacity > 0")
  }

  if (departureFrom) {
    clauses.push("t.departure_time >= ?")
    params.push(departureFrom)
  }

  if (departureTo) {
    clauses.push("t.departure_time <= ?")
    params.push(departureTo)
  }

  if (originText) {
    clauses.push("EXISTS (SELECT 1 FROM TripLocations l1 WHERE l1.trip_id = t.id AND l1.type = 'START' AND l1.address LIKE ?)")
    params.push(`%${originText}%`)
  }

  if (destinationText) {
    clauses.push("EXISTS (SELECT 1 FROM TripLocations l2 WHERE l2.trip_id = t.id AND l2.type = 'END' AND l2.address LIKE ?)")
    params.push(`%${destinationText}%`)
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  return {
    where,
    params,
  }
}

export const findOverlappingTrips = async (connection, driverId, departureTime, expectedArrivalTime) => {
  const rows = await exec(
    connection,
    `SELECT id, driver_id, departure_time, expected_arrival_time, status
     FROM Trips
     WHERE driver_id = ?
       AND status IN ('planned', 'active')
       AND departure_time < ?
       AND COALESCE(expected_arrival_time, '9999-12-31 23:59:59') > ?
     ORDER BY departure_time ASC
     LIMIT 1`,
    [driverId, expectedArrivalTime || departureTime, departureTime],
  )
  return rows[0] || null
}

export const createTrip = async (
  connection,
  {
    id,
    driverId,
    title = "",
    departureTime,
    expectedArrivalTime = null,
    maxDeliveries = 3,
    availableCapacity = null,
    vehicleType = null,
    acceptedPackageSize = null,
    status = "planned",
    notes = "",
    origin,
    destination,
    routeGeometry = null,
    routeDistanceMeters = null,
    routeDurationSeconds = null,
  },
) => {
  const capacity = availableCapacity ?? maxDeliveries
  const geometryJson = routeGeometry ? JSON.stringify(routeGeometry) : null

  await exec(
    connection,
    `INSERT INTO Trips (
      id, driver_id, title, departure_time, expected_arrival_time,
      max_deliveries, available_capacity, vehicle_type, accepted_package_size,
      route_geometry, route_distance_meters, route_duration_seconds,
      status, notes
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      driverId,
      title,
      departureTime,
      expectedArrivalTime,
      maxDeliveries,
      capacity,
      vehicleType,
      acceptedPackageSize,
      geometryJson,
      routeDistanceMeters,
      routeDurationSeconds,
      status,
      notes,
    ],
  )

  const locations = []
  if (origin) {
    locations.push({
      id: crypto.randomUUID(),
      tripId: id,
      type: "START",
      address: origin.address,
      longitude: origin.location?.coordinates?.[0],
      latitude: origin.location?.coordinates?.[1],
    })
  }

  if (destination) {
    locations.push({
      id: crypto.randomUUID(),
      tripId: id,
      type: "END",
      address: destination.address,
      longitude: destination.location?.coordinates?.[0],
      latitude: destination.location?.coordinates?.[1],
    })
  }

  for (const loc of locations) {
    await exec(
      connection,
      `INSERT INTO TripLocations (id, trip_id, type, address, latitude, longitude)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [loc.id, loc.tripId, loc.type, loc.address, loc.latitude, loc.longitude],
    )
  }

  return findTripById(connection, id)
}

export const findTripById = async (connection, tripId, { includeDriver = false } = {}) => {
  const tripRows = await exec(
    connection,
    `SELECT id, driver_id, title, departure_time, expected_arrival_time,
            max_deliveries, available_capacity, vehicle_type, accepted_package_size,
            route_geometry, route_distance_meters, route_duration_seconds,
            status, notes, created_at, updated_at
     FROM Trips
     WHERE id = ?
     LIMIT 1`,
    [tripId],
  )

  const trip = mapTripRow(tripRows[0])
  if (!trip) {
    return null
  }

  const locationRows = await exec(
    connection,
    `SELECT type, address, latitude, longitude
     FROM TripLocations
     WHERE trip_id = ?`,
    [tripId],
  )

  const locations = mapTripLocationRows(locationRows)

  let driver = null
  if (includeDriver) {
    const driverRows = await exec(
      connection,
      `SELECT u.id, u.first_name, u.last_name, u.phone, d.rating
       FROM Drivers d
       JOIN Users u ON u.id = d.participant_id
       WHERE d.participant_id = ?
       LIMIT 1`,
      [trip.driverId],
    )

    const row = driverRows[0]
    if (row) {
      driver = {
        id: row.id,
        firstName: row.first_name,
        lastName: row.last_name,
        phone: row.phone,
        rating: row.rating,
      }
    }
  }

  return {
    id: trip.id,
    driver: includeDriver ? driver : undefined,
    driverId: trip.driverId,
    title: trip.title,
    origin: locations.origin,
    destination: locations.destination,
    departureTime: trip.departureTime,
    expectedArrivalTime: trip.expectedArrivalTime,
    maxDeliveries: trip.maxDeliveries,
    availableCapacity: trip.availableCapacity,
    vehicleType: trip.vehicleType,
    acceptedPackageSize: trip.acceptedPackageSize,
    routeGeometry: trip.routeGeometry,
    routeDistanceMeters: trip.routeDistanceMeters,
    routeDurationSeconds: trip.routeDurationSeconds,
    status: trip.status,
    notes: trip.notes,
    createdAt: trip.createdAt,
    updatedAt: trip.updatedAt,
  }
}

export const listDriverTrips = async (connection, driverId, { status = null } = {}) => {
  const params = [driverId]
  let where = "WHERE driver_id = ?"

  if (status) {
    where += " AND status = ?"
    params.push(status)
  }

  const rows = await exec(
    connection,
    `SELECT id, driver_id, title, departure_time, expected_arrival_time,
            max_deliveries, available_capacity, vehicle_type, accepted_package_size,
            route_geometry, route_distance_meters, route_duration_seconds,
            status, notes, created_at, updated_at
     FROM Trips
     ${where}
     ORDER BY created_at DESC`,
    params,
  )

  const trips = []
  for (const row of rows) {
    const trip = await findTripById(connection, row.id, { includeDriver: false })
    if (trip) {
      trips.push(trip)
    }
  }

  return trips
}

export const listAvailableTrips = async (
  connection,
  {
    originText = null,
    destinationText = null,
    departureFrom = null,
    departureTo = null,
    minCapacity = null,
    limit = null,
    offset = null,
  } = {},
) => {
  const { where, params } = buildAvailableTripsQuery({
    originText,
    destinationText,
    departureFrom,
    departureTo,
    minCapacity,
  })

  const sqlParams = [...params]
  let paginationSql = ""
  const parsedLimit = Number.parseInt(String(limit), 10)
  const parsedOffset = Number.parseInt(String(offset), 10)
  if (Number.isFinite(parsedLimit) && Number.isFinite(parsedOffset)) {
    paginationSql = ` LIMIT ${Math.max(0, parsedLimit)} OFFSET ${Math.max(0, parsedOffset)}`
  }

  const rows = await exec(
    connection,
    `SELECT t.id
     FROM Trips t
     ${where}
     ORDER BY t.departure_time ASC${paginationSql}`,
    sqlParams,
  )

  const trips = []
  for (const row of rows) {
    const trip = await findTripById(connection, row.id, { includeDriver: true })
    if (trip) {
      trips.push(trip)
    }
  }

  return trips
}

export const countAvailableTrips = async (
  connection,
  {
    originText = null,
    destinationText = null,
    departureFrom = null,
    departureTo = null,
    minCapacity = null,
  } = {},
) => {
  const { where, params } = buildAvailableTripsQuery({
    originText,
    destinationText,
    departureFrom,
    departureTo,
    minCapacity,
  })

  const rows = await exec(
    connection,
    `SELECT COUNT(*) AS total
     FROM Trips t
     ${where}`,
    params,
  )

  return Number(rows[0]?.total || 0)
}

export const updateTripStatus = async (connection, tripId, status) => {
  await exec(connection, `UPDATE Trips SET status = ? WHERE id = ?`, [status, tripId])
  return findTripById(connection, tripId, { includeDriver: false })
}

export const updateTripDetails = async (connection, tripId, updates) => {
  const fields = []
  const params = []

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`)
      params.push(value)
    }
  }

  if (fields.length === 0) return findTripById(connection, tripId)

  params.push(tripId)
  await exec(connection, `UPDATE Trips SET ${fields.join(", ")} WHERE id = ?`, params)
  return findTripById(connection, tripId, { includeDriver: false })
}

export const deleteTrip = async (connection, tripId) => {
  await exec(connection, `DELETE FROM Trips WHERE id = ?`, [tripId])
}

export const countActiveDeliveriesForTrip = async (connection, tripId) => {
  const rows = await exec(
    connection,
    `SELECT COUNT(*) AS total
     FROM Deliveries
     WHERE trip_id = ?
       AND status NOT IN ('Delivered', 'CancelledByUser', 'CancelledByDriver', 'Rejected', 'FailedDelivery', 'Refunded')`,
    [tripId],
  )
  return Number(rows[0]?.total || 0)
}

export const autoCompleteExpiredTrips = async (connection) => {
  const rows = await exec(
    connection,
    `SELECT id FROM Trips
     WHERE status IN ('planned', 'active')
       AND expected_arrival_time IS NOT NULL
       AND expected_arrival_time <= NOW()`,
  )

  let completed = 0
  for (const row of rows) {
    const activeDeliveries = await countActiveDeliveriesForTrip(connection, row.id)
    if (activeDeliveries === 0) {
      await exec(connection, `UPDATE Trips SET status = 'completed' WHERE id = ?`, [row.id])
      completed++
    }
  }
  return completed
}

export const checkAndCompleteTrip = async (connection, tripId) => {
  const trip = await exec(
    connection,
    `SELECT id, status, expected_arrival_time FROM Trips WHERE id = ? LIMIT 1`,
    [tripId],
  )
  if (!trip[0]) return false
  if (trip[0].status !== 'planned' && trip[0].status !== 'active') return false
  if (!trip[0].expected_arrival_time) return false

  const now = new Date()
  if (new Date(trip[0].expected_arrival_time) > now) return false

  const activeDeliveries = await countActiveDeliveriesForTrip(connection, tripId)
  if (activeDeliveries === 0) {
    await exec(connection, `UPDATE Trips SET status = 'completed' WHERE id = ?`, [tripId])
    return true
  }
  return false
}
