import { getPool, exec } from "../lib/db.js"

const mapRow = (row) => {
  if (!row) return null
  return {
    id: row.id,
    driverId: row.driver_id,
    documentType: row.document_type,
    documentUrl: row.document_url,
    expiryDate: row.expiry_date || null,
    reviewStatus: row.review_status || (row.is_verified ? "approved" : "pending"),
    reviewReason: row.review_reason || null,
    reviewedBy: row.reviewed_by || null,
    reviewedAt: row.reviewed_at || null,
    isVerified: !!row.is_verified,
    createdAt: row.created_at || null,
  }
}

export const createDocument = async (connection, { id, driverId, documentType, documentUrl, expiryDate = null }) => {
  await exec(
    connection,
    `INSERT INTO Documents (id, driver_id, document_type, document_url, expiry_date, is_verified)
     VALUES (?, ?, ?, ?, ?, 0)`,
    [id, driverId, documentType, documentUrl, expiryDate || null],
  )
  return findDocumentById(connection, id)
}

export const findDocumentById = async (connection, documentId) => {
  const rows = await exec(
    connection,
    `SELECT id, driver_id, document_type, document_url, expiry_date,
            review_status, review_reason, reviewed_by, reviewed_at,
            is_verified, created_at
     FROM Documents WHERE id = ? LIMIT 1`,
    [documentId],
  )
  return mapRow(rows[0])
}

export const findDocumentsByDriverId = async (connection, driverId) => {
  const rows = await exec(
    connection,
    `SELECT id, driver_id, document_type, document_url, expiry_date,
            review_status, review_reason, reviewed_by, reviewed_at,
            is_verified, created_at
     FROM Documents WHERE driver_id = ? ORDER BY document_type`,
    [driverId],
  )
  return rows.map(mapRow)
}

export const updateDocument = async (connection, documentId, { documentUrl, expiryDate }) => {
  const updates = []
  const params = []

  if (documentUrl !== undefined) { updates.push("document_url = ?"); params.push(documentUrl) }
  if (expiryDate !== undefined) { updates.push("expiry_date = ?"); params.push(expiryDate || null) }

  if (!updates.length) return findDocumentById(connection, documentId)

  params.push(documentId)
  if (updates.length) {
    updates.push("review_status = 'pending'")
    updates.push("review_reason = NULL")
    updates.push("reviewed_by = NULL")
    updates.push("reviewed_at = NULL")
    updates.push("is_verified = 0")
  }

  await exec(connection, `UPDATE Documents SET ${updates.join(", ")} WHERE id = ?`, params)
  return findDocumentById(connection, documentId)
}

export const verifyDocument = async (connection, documentId, { reviewerId = null } = {}) => {
  await exec(
    connection,
    `UPDATE Documents
     SET is_verified = 1,
         review_status = 'approved',
         review_reason = NULL,
         reviewed_by = ?,
         reviewed_at = NOW()
     WHERE id = ?`,
    [reviewerId, documentId],
  )
  return findDocumentById(connection, documentId)
}

export const rejectDocument = async (connection, documentId, { reviewerId = null, reason = null } = {}) => {
  await exec(
    connection,
    `UPDATE Documents
     SET is_verified = 0,
         review_status = 'rejected',
         review_reason = ?,
         reviewed_by = ?,
         reviewed_at = NOW()
     WHERE id = ?`,
    [reason || null, reviewerId, documentId],
  )
  return findDocumentById(connection, documentId)
}

export const deleteDocument = async (connection, documentId) => {
  await exec(connection, `DELETE FROM Documents WHERE id = ?`, [documentId])
}
