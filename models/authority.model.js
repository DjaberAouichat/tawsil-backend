import crypto from "crypto"
import { getPool, exec } from "../lib/db.js"

const toSafeLimit = (value, fallback) => {
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return Math.min(parsed, 100)
}

const toSafeOffset = (value) => {
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0
  }

  return parsed
}

const mapIncident = (row) => ({
  id: row.id,
  deliveryId: row.delivery_id || null,
  tripId: row.trip_id || null,
  reportedByUserId: row.reported_by_user_id || null,
  assignedToAuthorityId: row.assigned_to_authority_id || null,
  severity: row.severity,
  status: row.status,
  title: row.title,
  description: row.description,
  resolutionNotes: row.resolution_notes || null,
  occurredAt: row.occurred_at,
  resolvedAt: row.resolved_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const mapComplaint = (row) => ({
  id: row.id,
  complainantUserId: row.complainant_user_id,
  targetUserId: row.target_user_id || null,
  deliveryId: row.delivery_id || null,
  tripId: row.trip_id || null,
  handledByAuthorityId: row.handled_by_authority_id || null,
  category: row.category,
  status: row.status,
  description: row.description,
  resolutionNotes: row.resolution_notes || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const parseJson = (value) => {
  if (!value) {
    return null
  }

  if (typeof value === "object") {
    return value
  }

  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const mapComplianceReport = (row) => ({
  id: row.id,
  type: row.type,
  status: row.status,
  generatedBy: row.generated_by || null,
  periodStart: row.period_start,
  periodEnd: row.period_end,
  summary: row.summary || null,
  reportJson: parseJson(row.report_json),
  createdAt: row.created_at,
  publishedAt: row.published_at,
})

export const createAuthorityIncident = async (connection, payload) => {
  const id = payload.id || crypto.randomUUID()

  await exec(
    connection,
    `INSERT INTO AuthorityIncidents (
      id, delivery_id, trip_id, reported_by_user_id, assigned_to_authority_id,
      severity, status, title, description, resolution_notes, occurred_at, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      payload.deliveryId || null,
      payload.tripId || null,
      payload.reportedByUserId || null,
      payload.assignedToAuthorityId || null,
      payload.severity || "medium",
      payload.status || "open",
      payload.title,
      payload.description,
      payload.resolutionNotes || null,
      payload.occurredAt || null,
      payload.resolvedAt || null,
    ],
  )

  return findAuthorityIncidentById(connection, id)
}

export const findAuthorityIncidentById = async (connection, incidentId) => {
  const rows = await exec(
    connection,
    `SELECT id, delivery_id, trip_id, reported_by_user_id, assigned_to_authority_id,
            severity, status, title, description, resolution_notes, occurred_at, resolved_at,
            created_at, updated_at
     FROM AuthorityIncidents
     WHERE id = ?
     LIMIT 1`,
    [incidentId],
  )

  return rows[0] ? mapIncident(rows[0]) : null
}

export const listAuthorityIncidents = async (connection, { status, severity, deliveryId, assignedToAuthorityId, limit = 20, offset = 0 } = {}) => {
  const clauses = []
  const params = []

  if (status) {
    clauses.push("status = ?")
    params.push(status)
  }
  if (severity) {
    clauses.push("severity = ?")
    params.push(severity)
  }
  if (deliveryId) {
    clauses.push("delivery_id = ?")
    params.push(deliveryId)
  }
  if (assignedToAuthorityId) {
    clauses.push("assigned_to_authority_id = ?")
    params.push(assignedToAuthorityId)
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  const safeLimit = toSafeLimit(limit, 20)
  const safeOffset = toSafeOffset(offset)

  const rows = await exec(
    connection,
    `SELECT id, delivery_id, trip_id, reported_by_user_id, assigned_to_authority_id,
            severity, status, title, description, resolution_notes, occurred_at, resolved_at,
            created_at, updated_at
     FROM AuthorityIncidents
     ${where}
     ORDER BY created_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    params,
  )

  return rows.map(mapIncident)
}

export const countAuthorityIncidents = async (connection, { status, severity, deliveryId, assignedToAuthorityId } = {}) => {
  const clauses = []
  const params = []

  if (status) {
    clauses.push("status = ?")
    params.push(status)
  }
  if (severity) {
    clauses.push("severity = ?")
    params.push(severity)
  }
  if (deliveryId) {
    clauses.push("delivery_id = ?")
    params.push(deliveryId)
  }
  if (assignedToAuthorityId) {
    clauses.push("assigned_to_authority_id = ?")
    params.push(assignedToAuthorityId)
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  const rows = await exec(connection, `SELECT COUNT(*) AS total FROM AuthorityIncidents ${where}`, params)
  return Number(rows[0]?.total || 0)
}

export const updateAuthorityIncident = async (connection, incidentId, payload = {}) => {
  const fieldMap = {
    assignedToAuthorityId: "assigned_to_authority_id",
    severity: "severity",
    status: "status",
    title: "title",
    description: "description",
    resolutionNotes: "resolution_notes",
    occurredAt: "occurred_at",
    resolvedAt: "resolved_at",
  }

  const updates = []
  const params = []

  for (const [key, column] of Object.entries(fieldMap)) {
    if (payload[key] !== undefined) {
      updates.push(`${column} = ?`)
      params.push(payload[key])
    }
  }

  if (!updates.length) {
    return findAuthorityIncidentById(connection, incidentId)
  }

  params.push(incidentId)
  await exec(connection, `UPDATE AuthorityIncidents SET ${updates.join(", ")} WHERE id = ?`, params)
  return findAuthorityIncidentById(connection, incidentId)
}

export const createAuthorityComplaint = async (connection, payload) => {
  const id = payload.id || crypto.randomUUID()

  await exec(
    connection,
    `INSERT INTO AuthorityComplaints (
      id, complainant_user_id, target_user_id, delivery_id, trip_id,
      handled_by_authority_id, category, status, description, resolution_notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      payload.complainantUserId,
      payload.targetUserId || null,
      payload.deliveryId || null,
      payload.tripId || null,
      payload.handledByAuthorityId || null,
      payload.category,
      payload.status || "new",
      payload.description,
      payload.resolutionNotes || null,
    ],
  )

  return findAuthorityComplaintById(connection, id)
}

export const findAuthorityComplaintById = async (connection, complaintId) => {
  const rows = await exec(
    connection,
    `SELECT id, complainant_user_id, target_user_id, delivery_id, trip_id, handled_by_authority_id,
            category, status, description, resolution_notes, created_at, updated_at
     FROM AuthorityComplaints
     WHERE id = ?
     LIMIT 1`,
    [complaintId],
  )

  return rows[0] ? mapComplaint(rows[0]) : null
}

export const listAuthorityComplaints = async (connection, { status, category, complainantUserId, deliveryId, limit = 20, offset = 0 } = {}) => {
  const clauses = []
  const params = []

  if (status) {
    clauses.push("status = ?")
    params.push(status)
  }
  if (category) {
    clauses.push("category = ?")
    params.push(category)
  }
  if (complainantUserId) {
    clauses.push("complainant_user_id = ?")
    params.push(complainantUserId)
  }
  if (deliveryId) {
    clauses.push("delivery_id = ?")
    params.push(deliveryId)
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  const safeLimit = toSafeLimit(limit, 20)
  const safeOffset = toSafeOffset(offset)

  const rows = await exec(
    connection,
    `SELECT id, complainant_user_id, target_user_id, delivery_id, trip_id, handled_by_authority_id,
            category, status, description, resolution_notes, created_at, updated_at
     FROM AuthorityComplaints
     ${where}
     ORDER BY created_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    params,
  )

  return rows.map(mapComplaint)
}

export const countAuthorityComplaints = async (connection, { status, category, complainantUserId, deliveryId } = {}) => {
  const clauses = []
  const params = []

  if (status) {
    clauses.push("status = ?")
    params.push(status)
  }
  if (category) {
    clauses.push("category = ?")
    params.push(category)
  }
  if (complainantUserId) {
    clauses.push("complainant_user_id = ?")
    params.push(complainantUserId)
  }
  if (deliveryId) {
    clauses.push("delivery_id = ?")
    params.push(deliveryId)
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  const rows = await exec(connection, `SELECT COUNT(*) AS total FROM AuthorityComplaints ${where}`, params)
  return Number(rows[0]?.total || 0)
}

export const updateAuthorityComplaint = async (connection, complaintId, payload = {}) => {
  const fieldMap = {
    targetUserId: "target_user_id",
    deliveryId: "delivery_id",
    tripId: "trip_id",
    handledByAuthorityId: "handled_by_authority_id",
    category: "category",
    status: "status",
    description: "description",
    resolutionNotes: "resolution_notes",
  }

  const updates = []
  const params = []

  for (const [key, column] of Object.entries(fieldMap)) {
    if (payload[key] !== undefined) {
      updates.push(`${column} = ?`)
      params.push(payload[key])
    }
  }

  if (!updates.length) {
    return findAuthorityComplaintById(connection, complaintId)
  }

  params.push(complaintId)
  await exec(connection, `UPDATE AuthorityComplaints SET ${updates.join(", ")} WHERE id = ?`, params)
  return findAuthorityComplaintById(connection, complaintId)
}

export const createAuthorityComplianceReport = async (connection, payload) => {
  const id = payload.id || crypto.randomUUID()

  await exec(
    connection,
    `INSERT INTO AuthorityComplianceReports (
      id, type, status, generated_by, period_start, period_end, summary, report_json, published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      payload.type,
      payload.status || "draft",
      payload.generatedBy || null,
      payload.periodStart || null,
      payload.periodEnd || null,
      payload.summary || null,
      payload.reportJson ? JSON.stringify(payload.reportJson) : null,
      payload.publishedAt || null,
    ],
  )

  return findAuthorityComplianceReportById(connection, id)
}

export const findAuthorityComplianceReportById = async (connection, reportId) => {
  const rows = await exec(
    connection,
    `SELECT id, type, status, generated_by, period_start, period_end, summary, report_json, created_at, published_at
     FROM AuthorityComplianceReports
     WHERE id = ?
     LIMIT 1`,
    [reportId],
  )

  return rows[0] ? mapComplianceReport(rows[0]) : null
}

export const listAuthorityComplianceReports = async (connection, { status, type, generatedBy, limit = 20, offset = 0 } = {}) => {
  const clauses = []
  const params = []

  if (status) {
    clauses.push("status = ?")
    params.push(status)
  }
  if (type) {
    clauses.push("type = ?")
    params.push(type)
  }
  if (generatedBy) {
    clauses.push("generated_by = ?")
    params.push(generatedBy)
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  const safeLimit = toSafeLimit(limit, 20)
  const safeOffset = toSafeOffset(offset)

  const rows = await exec(
    connection,
    `SELECT id, type, status, generated_by, period_start, period_end, summary, report_json, created_at, published_at
     FROM AuthorityComplianceReports
     ${where}
     ORDER BY created_at DESC
     LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    params,
  )

  return rows.map(mapComplianceReport)
}

export const countAuthorityComplianceReports = async (connection, { status, type, generatedBy } = {}) => {
  const clauses = []
  const params = []

  if (status) {
    clauses.push("status = ?")
    params.push(status)
  }
  if (type) {
    clauses.push("type = ?")
    params.push(type)
  }
  if (generatedBy) {
    clauses.push("generated_by = ?")
    params.push(generatedBy)
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
  const rows = await exec(connection, `SELECT COUNT(*) AS total FROM AuthorityComplianceReports ${where}`, params)
  return Number(rows[0]?.total || 0)
}

export const updateAuthorityComplianceReport = async (connection, reportId, payload = {}) => {
  const fieldMap = {
    type: "type",
    status: "status",
    generatedBy: "generated_by",
    periodStart: "period_start",
    periodEnd: "period_end",
    summary: "summary",
    reportJson: "report_json",
    publishedAt: "published_at",
  }

  const updates = []
  const params = []

  for (const [key, column] of Object.entries(fieldMap)) {
    if (payload[key] !== undefined) {
      updates.push(`${column} = ?`)
      if (key === "reportJson") {
        params.push(payload[key] ? JSON.stringify(payload[key]) : null)
      } else {
        params.push(payload[key])
      }
    }
  }

  if (!updates.length) {
    return findAuthorityComplianceReportById(connection, reportId)
  }

  params.push(reportId)
  await exec(connection, `UPDATE AuthorityComplianceReports SET ${updates.join(", ")} WHERE id = ?`, params)
  return findAuthorityComplianceReportById(connection, reportId)
}
