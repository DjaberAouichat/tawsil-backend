import crypto from "crypto"
import { getPool, withTransaction, exec } from "../lib/db.js"
import { canTransitionDeliveryStatus } from "../utils/delivery-status.utils.js"
import { createError } from "../utils/response.js"

const toSafePaginationInt = (value, fallback = 0) => {
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.max(0, parsed)
}

const mapLocationRows = (rows) => {
  const result = {
    pickup: null,
    dropoff: null,
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

    if (row.type === "PICKUP") {
      result.pickup = point
    }

    if (row.type === "DROPOFF") {
      result.dropoff = point
    }
  }

  return result
}

const mapPricingRow = (row) => {
  if (!row) {
    return null
  }

  return {
    baseFee: row.base_fee ?? 0,
    distanceFee: row.distance_fee ?? 0,
    weightSurcharge: row.weight_surcharge ?? 0,
    sizeSurcharge: row.size_surcharge ?? 0,
    urgentSurcharge: row.urgent_surcharge ?? 0,
    estimatedPrice: row.price,
    finalPrice: row.final_price ?? null,
    currency: row.currency || "DA",
  }
}

const mapPaymentRow = (row) => {
  if (!row) {
    return null
  }

  return {
    method: row.method,
    status: row.status,
    transactionId: row.transaction_id || null,
  }
}

const mapProofRow = (row) => {
  if (!row) {
    return null
  }

  return {
    photoUrl: row.photo_url || null,
    recipientName: row.recipient_name || null,
    recipientSignature: row.recipient_signature || null,
    notes: row.notes || null,
    confirmedAt: row.confirmed_at || null,
  }
}

const mapTimelineRow = (row) => {
  if (!row) {
    return null
  }

  return {
    acceptedAt: row.accepted_at,
    driverArrivedPickupAt: row.driver_arrived_pickup_at,
    pickedUpAt: row.picked_up_at,
    inTransitAt: row.in_transit_at,
    arrivedDropoffAt: row.arrived_dropoff_at,
    deliveredAt: row.delivered_at,
    cancelledAt: row.cancelled_at,
    failedAt: row.failed_at,
    refundedAt: row.refunded_at,
  }
}

const normalizeWeightCategory = (sizeCategory) => {
  const value = String(sizeCategory || "").trim().toLowerCase()
  if (!value) {
    return null
  }

  const normalized = value.toUpperCase()
  const allowed = new Set(["SMALL", "MEDIUM", "LARGE", "XLARGE"])
  return allowed.has(normalized) ? normalized : null
}

export const insertDeliveryStatusHistory = async (connection, deliveryId, status, changedBy = null, note = null) => {
  await exec(
    connection,
    `INSERT INTO DeliveryStatusHistory (delivery_id, status, changed_by, note)
     VALUES (?, ?, ?, ?)`,
    [deliveryId, status, changedBy, note],
  )
}

const STATUS_GROUPS = {
  active: ["Pending", "Accepted", "DriverArrivedPickup", "PickedUp", "InTransit", "ArrivedDropoff"],
  pending: ["Pending"],
  inProgress: ["Accepted", "DriverArrivedPickup", "PickedUp", "InTransit", "ArrivedDropoff"],
  delivered: ["Delivered"],
  cancelled: ["CancelledByUser", "CancelledByDriver", "FailedDelivery", "Refunded"],
}

const STATUS_TO_GROUP = {
  Draft: "pending",
  Pending: "pending",
  Accepted: "inProgress",
  DriverArrivedPickup: "inProgress",
  PickedUp: "inProgress",
  InTransit: "inProgress",
  ArrivedDropoff: "inProgress",
  Delivered: "delivered",
  CancelledByUser: "cancelled",
  CancelledByDriver: "cancelled",
  Rejected: "cancelled",
  FailedDelivery: "cancelled",
  Refunded: "cancelled",
}

const TRACKABLE_STATUSES = new Set(["Accepted", "DriverArrivedPickup", "PickedUp", "InTransit", "ArrivedDropoff"])

const CANCELLABLE_STATUSES = new Set(["Draft", "Pending", "Accepted"])

const buildAvailableActions = (row) => {
  const status = row.status
  const hasAssignedDriver = !!row.assigned_driver_id

  return {
    canCancel: CANCELLABLE_STATUSES.has(status),
    canTrack: hasAssignedDriver && TRACKABLE_STATUSES.has(status),
    canAttachTrip: status === "Pending" && !hasAssignedDriver,
    canContactDriver: hasAssignedDriver,
  }
}

const getStatusesForGroup = (statusGroup) => {
  if (!statusGroup) {
    return null
  }

  return STATUS_GROUPS[statusGroup] || null
}

export const updateDeliveryStatus = async (connection, deliveryId, newStatus, expectedCurrentStatus, changedBy = null) => {
  const work = async (tx) => {
    const rows = await exec(
      tx,
      `SELECT status
       FROM Deliveries
       WHERE id = ?
       FOR UPDATE`,
      [deliveryId],
    )

    const row = rows[0]
    if (!row) {
      throw createError(404, "Delivery not found")
    }

    if (row.status !== expectedCurrentStatus) {
      throw createError(409, "Delivery status changed. Please refresh and retry.")
    }

    if (!canTransitionDeliveryStatus(row.status, newStatus)) {
      throw createError(400, `Invalid status transition from ${row.status} to ${newStatus}`)
    }

    const result = await exec(
      tx,
      `UPDATE Deliveries
       SET status = ?
       WHERE id = ? AND status = ?`,
      [newStatus, deliveryId, expectedCurrentStatus],
    )

    if (!result?.affectedRows) {
      throw createError(409, "Delivery status changed. Please refresh and retry.")
    }

    await insertDeliveryStatusHistory(tx, deliveryId, newStatus, changedBy)
  }

  if (connection) {
    await work(connection)
    return findDeliveryById(connection, deliveryId, { includeDriver: true, includeRequester: true, includeTrip: true })
  }

  return withTransaction(async (tx) => {
    await work(tx)
    return findDeliveryById(tx, deliveryId, { includeDriver: true, includeRequester: true, includeTrip: true })
  })
}

export const createDelivery = async (
  connection,
  {
    id,
    requesterId,
    tripId = null,
    assignedDriverId = null,
    pickup,
    dropoff,
    recipient,
    packageInfo,
    packageImageUrl = "",
    deliveryNote = "",
    isUrgent = false,
    deliveryMode = "standard",
    pricing,
    payment,
    status = "Pending",
  },
) => {
  const packageWeightCategory = normalizeWeightCategory(packageInfo?.sizeCategory)

  const sql = `INSERT INTO Deliveries (
        id, requester_id, assigned_driver_id, trip_id,
        package_type, package_description, package_image_url,
        package_weight_category, package_size_category, package_weight_kg,
        package_length_cm, package_width_cm, package_height_cm, package_volume_m3,
        capacity_reserved, is_urgent, delivery_mode,
        recipient_name, recipient_phone, delivery_note, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const insertResult = await exec(
    connection,
    sql,
    [
      id,
      requesterId,
      assignedDriverId,
      tripId,
      packageInfo?.type || null,
      packageInfo?.description || null,
      packageImageUrl || null,
      packageWeightCategory,
      packageInfo?.sizeCategory || null,
      packageInfo?.weightKg ?? null,
      packageInfo?.dimensionsCm?.length ?? null,
      packageInfo?.dimensionsCm?.width ?? null,
      packageInfo?.dimensionsCm?.height ?? null,
      packageInfo?.volumeM3 ?? null,
      0,
      isUrgent ? 1 : 0,
      deliveryMode,
      recipient?.name || null,
      recipient?.phone || null,
      deliveryNote || null,
      status,
    ],
  )

  const locationRows = [
    {
      id: crypto.randomUUID(),
      type: "PICKUP",
      point: pickup,
    },
    {
      id: crypto.randomUUID(),
      type: "DROPOFF",
      point: dropoff,
    },
  ]

  for (const loc of locationRows) {
    const longitude = loc.point?.location?.coordinates?.[0]
    const latitude = loc.point?.location?.coordinates?.[1]

    await exec(
      connection,
      `INSERT INTO DeliveryLocations (id, delivery_id, type, address, latitude, longitude)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [loc.id, id, loc.type, loc.point?.address || null, latitude, longitude],
    )
  }

  if (pricing) {
    await exec(
      connection,
      `INSERT INTO DeliveryPricing (
         id, delivery_id, base_fee, distance_fee, weight_surcharge, size_surcharge, urgent_surcharge, price, final_price, currency
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        id,
        pricing.baseFee ?? 0,
        pricing.distanceFee ?? 0,
        pricing.weightSurcharge ?? 0,
        pricing.sizeSurcharge ?? 0,
        pricing.urgentSurcharge ?? 0,
        pricing.estimatedPrice,
        null,
        pricing.currency || "DA",
      ],
    )
  }

  if (payment) {
    await exec(
      connection,
      `INSERT INTO DeliveryPayments (id, delivery_id, method, status, transaction_id)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         method = VALUES(method),
         status = VALUES(status),
         transaction_id = VALUES(transaction_id)`,
      [
        crypto.randomUUID(),
        id,
        payment.method,
        payment.status,
        payment.transactionId || null,
      ],
    )
  }

  await exec(
    connection,
    `INSERT INTO DeliveryTimeline (id, delivery_id)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE id = id`,
    [crypto.randomUUID(), id],
  )

  return findDeliveryById(connection, id, { includeDriver: true, includeRequester: false, includeTrip: true })
}

export const findDeliveryById = async (
  connection,
  deliveryId,
  { includeDriver = false, includeRequester = false, includeTrip = false } = {},
) => {
  const deliveryRows = await exec(
    connection,
    `SELECT id, requester_id, assigned_driver_id, trip_id,
            package_type, package_description, package_image_url,
            package_weight_category, package_size_category, package_weight_kg,
            package_length_cm, package_width_cm, package_height_cm, package_volume_m3,
            capacity_reserved, is_urgent, delivery_mode, recipient_name, recipient_phone,
            delivery_note, status, created_at, updated_at
     FROM Deliveries
     WHERE id = ?
     LIMIT 1`,
    [deliveryId],
  )

  const row = deliveryRows[0]
  if (!row) {
    return null
  }

  const locationRows = await exec(
    connection,
    `SELECT type, address, latitude, longitude
     FROM DeliveryLocations
     WHERE delivery_id = ?`,
    [deliveryId],
  )

  const locations = mapLocationRows(locationRows)

  const pricingRows = await exec(
    connection,
    `SELECT base_fee, distance_fee, weight_surcharge, size_surcharge, urgent_surcharge, price, final_price, currency
     FROM DeliveryPricing
     WHERE delivery_id = ?
     LIMIT 1`,
    [deliveryId],
  )

  const paymentRows = await exec(
    connection,
    `SELECT method, status, transaction_id
     FROM DeliveryPayments
     WHERE delivery_id = ?
     LIMIT 1`,
    [deliveryId],
  )

  const proofRows = await exec(
    connection,
    `SELECT photo_url, recipient_name, recipient_signature, notes, confirmed_at
     FROM DeliveryProofs
     WHERE delivery_id = ?
     LIMIT 1`,
    [deliveryId],
  )

  const timelineRows = await exec(
    connection,
    `SELECT accepted_at, driver_arrived_pickup_at, picked_up_at, in_transit_at, arrived_dropoff_at, delivered_at, cancelled_at, failed_at, refunded_at
     FROM DeliveryTimeline
     WHERE delivery_id = ?
     LIMIT 1`,
    [deliveryId],
  )

  let requester = null
  if (includeRequester) {
    const requesterRows = await exec(
      connection,
      `SELECT u.id, u.first_name, u.last_name, u.phone, u.email
       FROM Users u
       WHERE u.id = ?
       LIMIT 1`,
      [row.requester_id],
    )

    const userRow = requesterRows[0]
    if (userRow) {
      requester = {
        id: userRow.id,
        firstName: userRow.first_name,
        lastName: userRow.last_name,
        phone: userRow.phone,
        email: userRow.email,
      }
    }
  }

  let assignedDriver = null
  if (includeDriver && row.assigned_driver_id) {
    const driverRows = await exec(
      connection,
      `SELECT u.id, u.first_name, u.last_name, u.phone, d.rating
       FROM Drivers d
       JOIN Users u ON u.id = d.participant_id
       WHERE d.participant_id = ?
       LIMIT 1`,
      [row.assigned_driver_id],
    )

    const driverRow = driverRows[0]
    if (driverRow) {
      assignedDriver = {
        id: driverRow.id,
        user: {
          id: driverRow.id,
          firstName: driverRow.first_name,
          lastName: driverRow.last_name,
          phone: driverRow.phone,
          rating: driverRow.rating,
        },
      }
    }
  }

  let trip = null
  if (includeTrip && row.trip_id) {
    const tripRows = await exec(
      connection,
      `SELECT id, driver_id, title, departure_time, expected_arrival_time,
              max_deliveries, available_capacity, vehicle_type, accepted_package_size, status
       FROM Trips
       WHERE id = ?
       LIMIT 1`,
      [row.trip_id],
    )

    const tripRow = tripRows[0]
    if (tripRow) {
      trip = {
        id: tripRow.id,
        driverId: tripRow.driver_id,
        title: tripRow.title || "",
        departureTime: tripRow.departure_time,
        expectedArrivalTime: tripRow.expected_arrival_time,
        maxDeliveries: tripRow.max_deliveries,
        availableCapacity: tripRow.available_capacity,
        vehicleType: tripRow.vehicle_type || null,
        acceptedPackageSize: tripRow.accepted_package_size || null,
        status: tripRow.status,
      }
    }
  }

  return {
    id: row.id,
    sender: includeRequester ? requester : undefined,
    senderId: row.requester_id,
    assignedDriverId: row.assigned_driver_id || null,
    tripId: row.trip_id || null,
    capacityReserved: Number(row.capacity_reserved || 0),
    assignedDriver: assignedDriver,
    trip,
    pickup: locations.pickup,
    dropoff: locations.dropoff,
    recipient: {
      name: row.recipient_name,
      phone: row.recipient_phone,
    },
    package: {
      type: row.package_type,
      description: row.package_description,
      imageUrl: row.package_image_url || "",
      sizeCategory: row.package_size_category || null,
      weightCategory: row.package_weight_category || null,
      weightKg: row.package_weight_kg ?? null,
      dimensionsCm:
        row.package_length_cm === null || row.package_width_cm === null || row.package_height_cm === null
          ? null
          : {
              length: Number(row.package_length_cm),
              width: Number(row.package_width_cm),
              height: Number(row.package_height_cm),
            },
      volumeM3: row.package_volume_m3 === null ? null : Number(row.package_volume_m3),
    },
    deliveryNote: row.delivery_note || "",
    pricing: mapPricingRow(pricingRows[0]),
    payment: mapPaymentRow(paymentRows[0]),
    proofOfDelivery: mapProofRow(proofRows[0]),
    timeline: mapTimelineRow(timelineRows[0]),
    status: row.status,
    statusGroup: STATUS_TO_GROUP[row.status] || "active",
    availableActions: buildAvailableActions(row),
    deliveryMode: row.delivery_mode || "standard",
    isUrgent: !!row.is_urgent,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const listUserDeliveries = async (
  connection,
  requesterId,
  { status = null, statusGroup = null, limit = 10, offset = 0 } = {},
) => {
  const params = [requesterId]
  let where = "WHERE d.requester_id = ?"

  if (status) {
    where += " AND d.status = ?"
    params.push(status)
  } else if (statusGroup) {
    const statuses = getStatusesForGroup(statusGroup)
    if (statuses?.length) {
      const placeholders = statuses.map(() => "?").join(", ")
      where += ` AND d.status IN (${placeholders})`
      params.push(...statuses)
    }
  }

  const safeLimit = toSafePaginationInt(limit, 10)
  const safeOffset = toSafePaginationInt(offset, 0)

  const rows = await exec(
    connection,
    `SELECT
       d.id, d.recipient_name, d.package_image_url, d.status, d.created_at, d.updated_at,
       pl.address AS pickup_address, pl.latitude AS pickup_lat, pl.longitude AS pickup_lng,
       dl.address AS dropoff_address, dl.latitude AS dropoff_lat, dl.longitude AS dropoff_lng,
       dp.price, dp.final_price,
       u.id AS driver_user_id, u.first_name AS driver_first_name,
       u.last_name AS driver_last_name, u.phone AS driver_phone,
       dr.rating AS driver_rating
     FROM Deliveries d
     LEFT JOIN DeliveryLocations pl ON pl.delivery_id = d.id AND pl.type = 'PICKUP'
     LEFT JOIN DeliveryLocations dl ON dl.delivery_id = d.id AND dl.type = 'DROPOFF'
     LEFT JOIN DeliveryPricing dp ON dp.delivery_id = d.id
     LEFT JOIN Drivers dr ON dr.participant_id = d.assigned_driver_id
     LEFT JOIN Users u ON u.id = dr.participant_id
     ${where}
     ORDER BY d.created_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    params,
  )

  return rows.map((row) => ({
    id: row.id,
    recipient: { name: row.recipient_name },
    package: { imageUrl: row.package_image_url || "" },
    status: row.status,
    statusGroup: STATUS_TO_GROUP[row.status] || "active",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pickup: {
      address: row.pickup_address || "",
      location: {
        type: "Point",
        coordinates:
          row.pickup_lng != null && row.pickup_lat != null
            ? [Number(row.pickup_lng), Number(row.pickup_lat)]
            : null,
      },
    },
    dropoff: {
      address: row.dropoff_address || "",
      location: {
        type: "Point",
        coordinates:
          row.dropoff_lng != null && row.dropoff_lat != null
            ? [Number(row.dropoff_lng), Number(row.dropoff_lat)]
            : null,
      },
    },
    pricing: {
      estimatedPrice: row.price ?? null,
      finalPrice: row.final_price ?? null,
    },
    assignedDriver: row.driver_user_id
      ? {
          id: row.driver_user_id,
          user: {
            id: row.driver_user_id,
            firstName: row.driver_first_name,
            lastName: row.driver_last_name,
            phone: row.driver_phone || null,
            rating: row.driver_rating || null,
          },
        }
      : null,
  }))
}

export const countUserDeliveries = async (connection, requesterId, { status = null, statusGroup = null } = {}) => {
  const params = [requesterId]
  let where = "WHERE requester_id = ?"
  if (status) {
    where += " AND status = ?"
    params.push(status)
  } else {
    const statuses = getStatusesForGroup(statusGroup)
    if (statuses?.length) {
      const placeholders = statuses.map(() => "?").join(", ")
      where += ` AND status IN (${placeholders})`
      params.push(...statuses)
    }
  }

  const rows = await exec(connection, `SELECT COUNT(*) AS total FROM Deliveries ${where}`, params)
  return Number(rows[0]?.total || 0)
}

export const listAdminDeliveries = async (
  connection,
  {
    status = null,
    senderId = null,
    assignedDriverId = null,
    tripId = null,
    startDate = null,
    endDate = null,
    limit = 20,
    offset = 0,
  } = {},
) => {
  const params = []
  const clauses = []

  if (status) {
    clauses.push("d.status = ?")
    params.push(status)
  }
  if (senderId) {
    clauses.push("d.requester_id = ?")
    params.push(senderId)
  }
  if (assignedDriverId) {
    clauses.push("d.assigned_driver_id = ?")
    params.push(assignedDriverId)
  }
  if (tripId) {
    clauses.push("d.trip_id = ?")
    params.push(tripId)
  }
  if (startDate) {
    clauses.push("d.created_at >= ?")
    params.push(startDate)
  }
  if (endDate) {
    clauses.push("d.created_at <= ?")
    params.push(endDate)
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  const safeLimit = toSafePaginationInt(limit, 10)
  const safeOffset = toSafePaginationInt(offset, 0)

  const rows = await exec(
    connection,
    `SELECT d.id
     FROM Deliveries d
     ${where}
     ORDER BY d.created_at DESC
    LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    params,
  )

  const deliveries = []
  for (const row of rows) {
    const delivery = await findDeliveryById(connection, row.id, {
      includeDriver: true,
      includeRequester: true,
      includeTrip: true,
    })
    if (delivery) {
      deliveries.push(delivery)
    }
  }

  return deliveries
}

export const countAdminDeliveries = async (
  connection,
  { status = null, senderId = null, assignedDriverId = null, tripId = null, startDate = null, endDate = null } = {},
) => {
  const params = []
  const clauses = []

  if (status) {
    clauses.push("status = ?")
    params.push(status)
  }
  if (senderId) {
    clauses.push("requester_id = ?")
    params.push(senderId)
  }
  if (assignedDriverId) {
    clauses.push("assigned_driver_id = ?")
    params.push(assignedDriverId)
  }
  if (tripId) {
    clauses.push("trip_id = ?")
    params.push(tripId)
  }
  if (startDate) {
    clauses.push("created_at >= ?")
    params.push(startDate)
  }
  if (endDate) {
    clauses.push("created_at <= ?")
    params.push(endDate)
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  const rows = await exec(connection, `SELECT COUNT(*) AS total FROM Deliveries ${where}`, params)
  return Number(rows[0]?.total || 0)
}

export const listDriverAvailableDeliveries = async (connection, driverId, { limit = 100 } = {}) => {
  const safeLimit = toSafePaginationInt(limit, 100)
  const rows = await exec(
    connection,
    `SELECT d.id
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
           WHERE t.driver_id = ? AND t.status IN ('planned','active')
         )
       )
        LIMIT ${safeLimit}`,
    [driverId, driverId],
  )

  const deliveries = []
  for (const row of rows) {
    const delivery = await findDeliveryById(connection, row.id, {
      includeDriver: false,
      includeRequester: false,
      includeTrip: true,
    })
    if (delivery) {
      deliveries.push(delivery)
    }
  }

  return deliveries
}

export const listDriverDeliveries = async (
  connection,
  driverId,
  { status = null, limit = 20, offset = 0 } = {},
) => {
  const params = [driverId]
  let where = "WHERE d.assigned_driver_id = ?"

  if (status) {
    where += " AND d.status = ?"
    params.push(status)
  }

  const safeLimit = toSafePaginationInt(limit, 20)
  const safeOffset = toSafePaginationInt(offset, 0)

  const rows = await exec(
    connection,
    `SELECT d.id
     FROM Deliveries d
     ${where}
     ORDER BY d.updated_at DESC, d.created_at DESC
      LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    params,
  )

  const deliveries = []
  for (const row of rows) {
    const delivery = await findDeliveryById(connection, row.id, {
      includeDriver: true,
      includeRequester: true,
      includeTrip: true,
    })
    if (delivery) {
      deliveries.push(delivery)
    }
  }

  return deliveries
}

export const countDriverDeliveries = async (connection, driverId, { status = null } = {}) => {
  const params = [driverId]
  let where = "WHERE assigned_driver_id = ?"

  if (status) {
    where += " AND status = ?"
    params.push(status)
  }

  const rows = await exec(connection, `SELECT COUNT(*) AS total FROM Deliveries ${where}`, params)
  return Number(rows[0]?.total || 0)
}

export const listUserDeliveriesBrief = async (
  connection,
  requesterId,
  { status = null, statusGroup = null, limit = 10, offset = 0 } = {},
) => {
  const params = [requesterId]
  let where = "WHERE d.requester_id = ?"

  if (status) {
    where += " AND d.status = ?"
    params.push(status)
  } else if (statusGroup) {
    const statuses = getStatusesForGroup(statusGroup)
    if (statuses?.length) {
      const placeholders = statuses.map(() => "?").join(", ")
      where += ` AND d.status IN (${placeholders})`
      params.push(...statuses)
    }
  }

  const safeLimit = toSafePaginationInt(limit, 10)
  const safeOffset = toSafePaginationInt(offset, 0)

  const rows = await exec(
    connection,
    `SELECT
       d.id, d.recipient_name, d.package_image_url, d.status, d.created_at, d.updated_at,
       pl.address AS pickup_address, pl.latitude AS pickup_lat, pl.longitude AS pickup_lng,
       dl.address AS dropoff_address, dl.latitude AS dropoff_lat, dl.longitude AS dropoff_lng,
       dp.price, dp.final_price,
       u.id AS driver_user_id, u.first_name AS driver_first_name,
       u.last_name AS driver_last_name, u.phone AS driver_phone,
       dr.rating AS driver_rating
     FROM Deliveries d
     LEFT JOIN DeliveryLocations pl ON pl.delivery_id = d.id AND pl.type = 'PICKUP'
     LEFT JOIN DeliveryLocations dl ON dl.delivery_id = d.id AND dl.type = 'DROPOFF'
     LEFT JOIN DeliveryPricing dp ON dp.delivery_id = d.id
     LEFT JOIN Drivers dr ON dr.participant_id = d.assigned_driver_id
     LEFT JOIN Users u ON u.id = dr.participant_id
     ${where}
     ORDER BY d.created_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    params,
  )

  return rows.map((row) => ({
    id: row.id,
    recipient: { name: row.recipient_name },
    package: { imageUrl: row.package_image_url || "" },
    status: row.status,
    statusGroup: STATUS_TO_GROUP[row.status] || "active",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pickup: {
      address: row.pickup_address || "",
      location: {
        type: "Point",
        coordinates:
          row.pickup_lng != null && row.pickup_lat != null
            ? [Number(row.pickup_lng), Number(row.pickup_lat)]
            : null,
      },
    },
    dropoff: {
      address: row.dropoff_address || "",
      location: {
        type: "Point",
        coordinates:
          row.dropoff_lng != null && row.dropoff_lat != null
            ? [Number(row.dropoff_lng), Number(row.dropoff_lat)]
            : null,
      },
    },
    pricing: {
      estimatedPrice: row.price ?? null,
      finalPrice: row.final_price ?? null,
    },
    assignedDriver: row.driver_user_id
      ? {
          id: row.driver_user_id,
          user: {
            id: row.driver_user_id,
            firstName: row.driver_first_name,
            lastName: row.driver_last_name,
            phone: row.driver_phone || null,
            rating: row.driver_rating || null,
          },
        }
      : null,
  }))
}
