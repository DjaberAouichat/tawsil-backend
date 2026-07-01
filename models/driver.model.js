import crypto from "crypto"
import { getPool, exec } from "../lib/db.js"

export const ensureParticipant = async (connection, userId) => {
  await exec(
    connection,
    `INSERT INTO Participants (user_id)
     VALUES (?)
     ON DUPLICATE KEY UPDATE user_id = user_id`,
    [userId],
  )
}

export const createRequesterProfile = async (connection, userId) => {
  await ensureParticipant(connection, userId)
  await exec(connection, `INSERT INTO Requesters (participant_id) VALUES (?)`, [userId])
}

export const createDriverProfile = async (
  connection,
  {
    userId,
    licenseNumber = null,
    licenseExpiry = null,
    idCard = null,
    driverType = "normal_driver",
    isDocumentsVerified = false,
    isAvailable = false,
    availability = "offline",
  },
) => {
  await ensureParticipant(connection, userId)
  const params = [
    userId,
    licenseNumber,
    licenseExpiry,
    idCard,
    driverType,
    isDocumentsVerified ? 1 : 0,
    isAvailable ? 1 : 0,
    availability,
  ]
  await exec(
    connection,
    `INSERT INTO Drivers (
        participant_id,
        license_number,
        license_expiry,
        id_card,
        review_status,
        verification_status,
        review_reason,
        reviewed_by,
        reviewed_at,
        approved_at,
        driver_type,
        is_documents_verified,
        is_available,
        availability
     )
     VALUES (?, ?, ?, ?, 'pending', 'pending', NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
    params,
  )
}

export const findDriverByUserId = async (connection, userId) => {
  const rows = await exec(
    connection,
    `SELECT participant_id AS driverId,
            license_number AS licenseNumber,
            license_expiry AS licenseExpiry,
            id_card AS idCard,
            review_status AS reviewStatus,
            verification_status AS verificationStatus,
            review_reason AS reviewReason,
            reviewed_by AS reviewedBy,
            reviewed_at AS reviewedAt,
            approved_at AS approvedAt,
            driver_type AS driverType,
            is_documents_verified AS isDocumentsVerified,
            is_available AS isAvailable,
            availability,
            rating,
            vehicle_info AS vehicleInfo,
            vehicle_type AS vehicleType,
            max_weight_kg AS maxWeightKg,
            max_volume_m3 AS maxVolumeM3,
            max_size_category AS maxSizeCategory,
            filter_preferences AS filterPreferences,
            notification_preferences AS notificationPreferences,
            approval_welcome_shown AS approvalWelcomeShown
     FROM Drivers
     WHERE participant_id = ?
     LIMIT 1`,
    [userId],
  )

  return rows[0] || null
}

export const updateDriverVehicleType = async (connection, { driverId, vehicleType, maxWeightKg, maxVolumeM3, maxSizeCategory }) => {
  await exec(
    connection,
    `UPDATE Drivers
     SET vehicle_type = ?, max_weight_kg = ?, max_volume_m3 = ?, max_size_category = ?
     WHERE participant_id = ?`,
    [vehicleType, maxWeightKg, maxVolumeM3, maxSizeCategory, driverId],
  )
}

// Documents (uses existing Documents table)
export const createDriverDocument = async (connection, { id, driverId, type, url, expiryDate = null, isVerified = false }) => {
  await exec(
    connection,
    `INSERT INTO Documents (id, driver_id, document_type, document_url, expiry_date, is_verified)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, driverId, type, url, expiryDate, isVerified ? 1 : 0],
  )
  const rows = await exec(connection, `SELECT id, driver_id, document_type, document_url, expiry_date, is_verified, created_at FROM Documents WHERE id = ? LIMIT 1`, [id])
  return rows[0] || null
}

export const findDriverDocumentsByDriverId = async (connection, driverId) => {
  const rows = await exec(
    connection,
    `SELECT id, driver_id AS driverId, document_type AS type, document_url AS url,
            expiry_date AS expiryDate,
            review_status AS reviewStatus,
            review_reason AS reviewReason,
            reviewed_by AS reviewedBy,
            reviewed_at AS reviewedAt,
            is_verified AS isVerified,
            created_at
     FROM Documents
     WHERE driver_id = ?
     ORDER BY created_at DESC`,
    [driverId],
  )
  return rows
}

export const updateDriverAvailability = async (connection, driverId, { isAvailable, availability }) => {
  const updates = []
  const params = []

  if (isAvailable !== undefined) {
    updates.push("is_available = ?")
    params.push(isAvailable ? 1 : 0)
  }

  if (availability !== undefined) {
    const allowed = ["available", "busy", "offline"]
    if (!allowed.includes(availability)) throw new Error(`Invalid availability: ${availability}`)
    updates.push("availability = ?")
    params.push(availability)
  }

  if (!updates.length) return

  params.push(driverId)
  await exec(connection, `UPDATE Drivers SET ${updates.join(", ")} WHERE participant_id = ?`, params)
}

export const updateDriverReviewStatus = async (
  connection,
  driverId,
  { reviewStatus, verificationStatus, reviewReason, reviewedBy, reviewedAt, approvedAt, isDocumentsVerified, isAvailable, availability, approvalWelcomeShown },
) => {
  const updates = []
  const params = []

  if (reviewStatus !== undefined) {
    const allowed = ["pending", "approved", "rejected", "blocked"]
    if (!allowed.includes(reviewStatus)) {
      throw new Error(`Invalid review status: ${reviewStatus}`)
    }
    updates.push("review_status = ?")
    params.push(reviewStatus)
  }

  if (verificationStatus !== undefined) {
    const allowed = ["pending", "approved", "rejected", "blocked"]
    if (!allowed.includes(verificationStatus)) {
      throw new Error(`Invalid verification status: ${verificationStatus}`)
    }
    updates.push("verification_status = ?")
    params.push(verificationStatus)
  }

  if (approvedAt !== undefined) {
    updates.push("approved_at = ?")
    params.push(approvedAt || null)
  }

  if (isAvailable !== undefined) {
    updates.push("is_available = ?")
    params.push(isAvailable ? 1 : 0)
  }

  if (availability !== undefined) {
    const allowedAvailability = ["available", "busy", "offline"]
    if (!allowedAvailability.includes(availability)) throw new Error(`Invalid availability: ${availability}`)
    updates.push("availability = ?")
    params.push(availability)
  }

  if (isDocumentsVerified !== undefined) {
    updates.push("is_documents_verified = ?")
    params.push(isDocumentsVerified ? 1 : 0)
  }

  if (approvalWelcomeShown !== undefined) {
    updates.push("approval_welcome_shown = ?")
    params.push(approvalWelcomeShown ? 1 : 0)
  }

  if (reviewReason !== undefined) {
    updates.push("review_reason = ?")
    params.push(reviewReason || null)
  }

  if (reviewedBy !== undefined) {
    updates.push("reviewed_by = ?")
    params.push(reviewedBy || null)
  }

  if (reviewedAt !== undefined) {
    updates.push("reviewed_at = ?")
    params.push(reviewedAt || null)
  }

  if (!updates.length) {
    return
  }

  params.push(driverId)
  await exec(connection, `UPDATE Drivers SET ${updates.join(", ")} WHERE participant_id = ?`, params)
}

export const markApprovalWelcomeShown = async (connection, driverId) => {
  await exec(
    connection,
    `UPDATE Drivers SET approval_welcome_shown = 1 WHERE participant_id = ?`,
    [driverId],
  )
}

// --- Vehicle ---

export const createVehicle = async (
  connection,
  {
    id,
    driverId,
    type = null,
    make = null,
    model = null,
    year = null,
    color = null,
    licensePlate = null,
    insuranceNumber = null,
    insuranceExpiry = null,
    isVerified = false,
  },
) => {
  const params = [id, driverId, type, make, model, year, color, licensePlate, insuranceNumber, insuranceExpiry, isVerified ? 1 : 0]
  await exec(
    connection,
    `INSERT INTO Vehicles (
        id, driver_id, type, make, model, year, color, license_plate, insurance_number, insurance_expiry, is_verified
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params,
  )
  return findVehicleById(connection, id)
}

const mapVehicleRow = (row) => {
  if (!row) return null
  return {
    id: row.id,
    driverId: row.driver_id,
    type: row.type || null,
    make: row.make || null,
    model: row.model || null,
    year: row.year || null,
    color: row.color || null,
    licensePlate: row.license_plate || null,
    insuranceNumber: row.insurance_number || null,
    insuranceExpiry: row.insurance_expiry || null,
    isVerified: !!row.is_verified,
  }
}

export const findVehicleById = async (connection, vehicleId) => {
  const rows = await exec(
    connection,
    `SELECT id, driver_id, type, make, model, year, color, license_plate, insurance_number, insurance_expiry, is_verified
     FROM Vehicles WHERE id = ? LIMIT 1`,
    [vehicleId],
  )
  return mapVehicleRow(rows[0])
}

export const findVehiclesByDriverId = async (connection, driverId) => {
  const rows = await exec(
    connection,
    `SELECT id, driver_id, type, make, model, year, color, license_plate, insurance_number, insurance_expiry, is_verified
     FROM Vehicles WHERE driver_id = ? ORDER BY is_verified DESC`,
    [driverId],
  )
  return rows.map(mapVehicleRow)
}

export const updateVehicle = async (connection, vehicleId, data) => {
  const fieldMap = {
    type: "type",
    make: "make",
    model: "model",
    year: "year",
    color: "color",
    licensePlate: "license_plate",
    insuranceNumber: "insurance_number",
    insuranceExpiry: "insurance_expiry",
  }

  const updates = []
  const params = []

  for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
    if (data[jsKey] !== undefined) {
      updates.push(`${dbCol} = ?`)
      params.push(data[jsKey])
    }
  }

  if (!updates.length) return findVehicleById(connection, vehicleId)

  params.push(vehicleId)
  await exec(connection, `UPDATE Vehicles SET ${updates.join(", ")} WHERE id = ?`, params)
  return findVehicleById(connection, vehicleId)
}

export const deleteVehicle = async (connection, vehicleId) => {
  await exec(connection, `DELETE FROM Vehicles WHERE id = ?`, [vehicleId])
}

export const assignVehicleToDriver = async (connection, vehicleId, driverId) => {
  await exec(connection, `UPDATE Vehicles SET driver_id = ? WHERE id = ?`, [driverId, vehicleId])
  return findVehicleById(connection, vehicleId)
}

// --- Driver Location ---

export const upsertDriverLocation = async (connection, { driverId, latitude, longitude, accuracy = null, heading = null, speed = null }) => {
  await exec(
    connection,
    `INSERT INTO DriverLocation (driver_id, latitude, longitude, accuracy, heading, speed)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       latitude = VALUES(latitude),
       longitude = VALUES(longitude),
       accuracy = VALUES(accuracy),
       heading = VALUES(heading),
       speed = VALUES(speed)`,
    [driverId, latitude, longitude, accuracy, heading, speed],
  )
}

export const getDriverLocation = async (connection, driverId) => {
  const rows = await exec(
    connection,
    `SELECT driver_id AS driverId, latitude, longitude, accuracy, heading, speed, \`timestamp\`
     FROM DriverLocation
     WHERE driver_id = ?
     LIMIT 1`,
    [driverId],
  )

  return rows[0] || null
}

export const insertDriverLocationHistory = async (connection, { driverId, latitude, longitude, accuracy = null, heading = null, speed = null }) => {
  const id = crypto.randomUUID()
  await exec(
    connection,
    `INSERT INTO DriverLocationHistory (id, driver_id, latitude, longitude, accuracy, heading, speed)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, driverId, latitude, longitude, accuracy, heading, speed],
  )
  return id
}

export const pruneDriverLocationHistory = async (connection, driverId, keepCount = 100) => {
  await exec(
    connection,
    `DELETE FROM DriverLocationHistory
     WHERE driver_id = ? AND id NOT IN (
       SELECT id FROM (
         SELECT id FROM DriverLocationHistory
         WHERE driver_id = ?
         ORDER BY timestamp DESC
         LIMIT ?
       ) AS keep
     )`,
    [driverId, driverId, keepCount],
  )
}

// ── Verification Timeline ──────────────────────────────────────────────

const parseMetadata = (value) => {
  if (!value) return null
  if (typeof value === "object") return value
  try { return JSON.parse(value) } catch { return null }
}

const mapTimelineRow = (row) => ({
  id: row.id,
  driverId: row.driver_id,
  eventType: row.event_type,
  entityType: row.entity_type,
  entityId: row.entity_id,
  status: row.status,
  reason: row.reason || null,
  actorId: row.actor_id || null,
  metadata: parseMetadata(row.metadata),
  createdAt: row.created_at,
})

export const addDriverVerificationTimelineEvent = async (
  connection,
  { id = crypto.randomUUID(), driverId, eventType, entityType, entityId = null, status = null, reason = null, actorId = null, metadata = null },
) => {
  await exec(
    connection,
    `INSERT INTO DriverVerificationTimeline (id, driver_id, event_type, entity_type, entity_id, status, reason, actor_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, driverId, eventType, entityType, entityId, status, reason, actorId, metadata ? JSON.stringify(metadata) : null],
  )
  const rows = await exec(
    connection,
    `SELECT id, driver_id, event_type, entity_type, entity_id, status, reason, actor_id, metadata, created_at
     FROM DriverVerificationTimeline WHERE id = ? LIMIT 1`,
    [id],
  )
  return rows[0] ? mapTimelineRow(rows[0]) : null
}

export const insertDriverStatusHistory = async (connection, { driverId, oldStatus, newStatus, changedBy, comment }) => {
  const id = crypto.randomUUID()
  await exec(
    connection,
    `INSERT INTO DriverStatusHistory (id, driver_id, old_status, new_status, changed_by, comment)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, driverId, oldStatus || null, newStatus, changedBy || null, comment || null],
  )
  return id
}

export const listDriverStatusHistory = async (connection, driverId, { limit = 100, offset = 0 } = {}) => {
  const parsedLimit = Number.parseInt(String(limit), 10)
  const parsedOffset = Number.parseInt(String(offset), 10)
  const safeLimit = Number.isFinite(parsedLimit) ? Math.max(0, parsedLimit) : 100
  const safeOffset = Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0
  const rows = await exec(
    connection,
    `SELECT h.id, h.driver_id, h.old_status, h.new_status, h.changed_by, h.comment, h.changed_at,
            u.first_name AS changed_by_first_name, u.last_name AS changed_by_last_name
     FROM DriverStatusHistory h
     LEFT JOIN Users u ON u.id = h.changed_by
     WHERE h.driver_id = ?
     ORDER BY h.changed_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    [driverId],
  )
  return rows.map((r) => ({
    id: r.id,
    driverId: r.driver_id,
    oldStatus: r.old_status,
    newStatus: r.new_status,
    changedBy: r.changed_by,
    changedByName: r.changed_by_first_name && r.changed_by_last_name
      ? `${r.changed_by_first_name} ${r.changed_by_last_name}`.trim()
      : null,
    comment: r.comment,
    changedAt: r.changed_at,
  }))
}

export const listDriverVerificationTimeline = async (connection, driverId, { limit = 100, offset = 0 } = {}) => {
  const parsedLimit = Number.parseInt(String(limit), 10)
  const parsedOffset = Number.parseInt(String(offset), 10)
  const safeLimit = Number.isFinite(parsedLimit) ? Math.max(0, parsedLimit) : 100
  const safeOffset = Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0
  const rows = await exec(
    connection,
    `SELECT id, driver_id, event_type, entity_type, entity_id, status, reason, actor_id, metadata, created_at
     FROM DriverVerificationTimeline
     WHERE driver_id = ?
     ORDER BY created_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    [driverId],
  )
  return rows.map(mapTimelineRow)
}
