import { getPool, exec } from "../lib/db.js"
import { sendSuccess, createError } from "../utils/response.js"
import {
  countAuthorityComplaints,
  countAuthorityComplianceReports,
  countAuthorityIncidents,
  createAuthorityComplaint,
  createAuthorityComplianceReport,
  createAuthorityIncident,
  findAuthorityComplaintById,
  findAuthorityComplianceReportById,
  findAuthorityIncidentById,
  listAuthorityComplaints,
  listAuthorityComplianceReports,
  listAuthorityIncidents,
  updateAuthorityComplaint,
  updateAuthorityComplianceReport,
  updateAuthorityIncident,
} from "../models/authority.model.js"
import { updateDriverReviewStatus } from "../models/driver.model.js"
import { addDriverVerificationTimelineEvent, listDriverVerificationTimeline } from "../models/driver.model.js"

export const getAuthorityStats = async (_req, res, next) => {
  try {
    const [
      totalClients,
      totalDrivers,
      normalDrivers,
      proDrivers,
      activeDeliveries,
      completedDeliveries,
      cancelledDeliveries,
    ] = await Promise.all([
      exec(null, `SELECT COUNT(*) AS total FROM Requesters`),
      exec(null, `SELECT COUNT(*) AS total FROM Drivers`),
      exec(null, `SELECT COUNT(*) AS total FROM Drivers d WHERE NOT EXISTS (SELECT 1 FROM Documents doc WHERE doc.driver_id = d.participant_id AND UPPER(doc.document_type) IN ('RC'))`),
      exec(null, `SELECT COUNT(DISTINCT d.participant_id) AS total FROM Drivers d INNER JOIN Documents doc ON doc.driver_id = d.participant_id WHERE UPPER(doc.document_type) IN ('RC')`),
      exec(null, `SELECT COUNT(*) AS total FROM Deliveries WHERE status IN ('Pending','Accepted','InTransit','PickedUp')`),
      exec(null, `SELECT COUNT(*) AS total FROM Deliveries WHERE status = 'Delivered'`),
      exec(null, `SELECT COUNT(*) AS total FROM Deliveries WHERE status IN ('CancelledByUser','CancelledByDriver','Rejected','FailedDelivery')`),
    ])

    return sendSuccess(res, 200, "Authority stats fetched successfully", {
      stats: {
        totalClients: Number(totalClients[0]?.total || 0),
        totalDrivers: Number(totalDrivers[0]?.total || 0),
        normalDrivers: Number(normalDrivers[0]?.total || 0),
        proDrivers: Number(proDrivers[0]?.total || 0),
        activeDeliveries: Number(activeDeliveries[0]?.total || 0),
        completedDeliveries: Number(completedDeliveries[0]?.total || 0),
        cancelledDeliveries: Number(cancelledDeliveries[0]?.total || 0),
      },
    })
  } catch (error) {
    next(error)
  }
}

export const listAuthorityClients = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100)
    const offset = parseInt(req.query.offset, 10) || 0
    const search = req.query.search || null

    const clauses = []
    const params = []

    if (search) {
      clauses.push("(u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)")
      const like = `%${search}%`
      params.push(like, like, like, like)
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""

    const rows = await exec(
      null,
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.profile_picture,
              u.created_at, NULL AS wilaya, NULL AS commune
       FROM Users u
       JOIN Requesters r ON r.participant_id = u.id
       ${where}
       ORDER BY u.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    )

    const countRows = await exec(
      null,
      `SELECT COUNT(*) AS total FROM Users u JOIN Requesters r ON r.participant_id = u.id ${where}`,
      params,
    )

    return sendSuccess(res, 200, "Clients fetched successfully", {
      clients: rows.map((row) => ({
        id: row.id,
        firstName: row.first_name,
        lastName: row.last_name,
        email: row.email,
        phone: row.phone,
        profilePictureUrl: row.profile_picture || null,
        wilaya: row.wilaya || null,
        commune: row.commune || null,
        createdAt: row.created_at,
      })),
      total: Number(countRows[0]?.total || 0),
    })
  } catch (error) {
    next(error)
  }
}

export const getAuthorityClientById = async (req, res, next) => {
  try {
    const { clientId } = req.params

    const userRows = await exec(
      null,
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.profile_picture,
              u.is_email_verified, u.created_at, NULL AS wilaya, NULL AS commune, u.address
       FROM Users u
       JOIN Requesters r ON r.participant_id = u.id
       WHERE u.id = ?
       LIMIT 1`,
      [clientId],
    )

    if (!userRows[0]) {
      return next(createError(404, "Client not found"))
    }

    const user = userRows[0]

    const [deliveries, totalDeliveries, completedDeliveries, cancelledDeliveries, totalSpent] = await Promise.all([
      exec(
        null,
        `SELECT d.id, d.status, d.package_type, d.package_weight_kg, d.package_description, d.created_at,
                d.requester_id, d.assigned_driver_id,
                dp.price, dp.final_price,
                pu.first_name AS pu_first_name, pu.last_name AS pu_last_name
         FROM Deliveries d
         LEFT JOIN deliverypricing dp ON dp.delivery_id = d.id
         LEFT JOIN Users pu ON pu.id = d.assigned_driver_id
         WHERE d.requester_id = ?
         ORDER BY d.created_at DESC
         LIMIT 50`,
        [clientId],
      ),
      exec(null, `SELECT COUNT(*) AS total FROM Deliveries WHERE requester_id = ?`, [clientId]),
      exec(null, `SELECT COUNT(*) AS total FROM Deliveries WHERE requester_id = ? AND status = 'Delivered'`, [clientId]),
      exec(null, `SELECT COUNT(*) AS total FROM Deliveries WHERE requester_id = ? AND status IN ('CancelledByUser','CancelledByDriver','Rejected','FailedDelivery')`, [clientId]),
      exec(
        null,
        `SELECT COALESCE(SUM(dp.final_price), 0) AS total FROM Deliveries d LEFT JOIN deliverypricing dp ON dp.delivery_id = d.id WHERE d.requester_id = ? AND d.status = 'Delivered'`,
        [clientId],
      ),
    ])

    return sendSuccess(res, 200, "Client profile fetched successfully", {
      client: {
        id: user.id,
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email,
        phone: user.phone,
        profilePictureUrl: user.profile_picture || null,
        wilaya: null,
        commune: null,
        address: user.address || null,
        isEmailVerified: !!user.is_email_verified,
        createdAt: user.created_at,
      },
      deliveries: deliveries.map((d) => ({
        id: d.id,
        status: d.status,
        pickupWilaya: null,
        dropoffWilaya: null,
        price: d.final_price ? Number(d.final_price) : (d.price ? Number(d.price) : 0),
        type: d.package_type,
        weight: d.package_weight_kg ? Number(d.package_weight_kg) : null,
        description: d.package_description,
        driverName: d.pu_first_name ? `${d.pu_first_name} ${d.pu_last_name || ""}`.trim() : null,
        createdAt: d.created_at,
      })),
      stats: {
        totalDeliveries: Number(totalDeliveries[0]?.total || 0),
        completedDeliveries: Number(completedDeliveries[0]?.total || 0),
        cancelledDeliveries: Number(cancelledDeliveries[0]?.total || 0),
        totalSpent: Number(totalSpent[0]?.total || 0),
      },
    })
  } catch (error) {
    next(error)
  }
}

export const listAuthorityDrivers = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100)
    const offset = parseInt(req.query.offset, 10) || 0
    const type = req.query.type || null
    const search = req.query.search || null

    const clauses = []
    const params = []

    if (type) {
      if (type === 'pro_transporter') {
        clauses.push("EXISTS (SELECT 1 FROM Documents doc WHERE doc.driver_id = d.participant_id AND UPPER(doc.document_type) IN ('RC'))")
      } else {
        clauses.push("NOT EXISTS (SELECT 1 FROM Documents doc WHERE doc.driver_id = d.participant_id AND UPPER(doc.document_type) IN ('RC'))")
      }
    }

    if (search) {
      clauses.push("(u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)")
      const like = `%${search}%`
      params.push(like, like, like, like)
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""

    const rows = await exec(
      null,
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.profile_picture,
              u.created_at, d.review_status, d.is_available,
              CASE WHEN EXISTS (SELECT 1 FROM Documents doc WHERE doc.driver_id = d.participant_id AND UPPER(doc.document_type) IN ('RC')) THEN 'pro_transporter' ELSE 'normal' END AS account_type
       FROM Users u
       JOIN Drivers d ON d.participant_id = u.id
       ${where}
       ORDER BY u.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    )

    const countRows = await exec(
      null,
      `SELECT COUNT(*) AS total FROM Users u JOIN Drivers d ON d.participant_id = u.id ${where}`,
      params,
    )

    return sendSuccess(res, 200, "Drivers fetched successfully", {
      drivers: rows.map((row) => ({
        id: row.id,
        firstName: row.first_name,
        lastName: row.last_name,
        email: row.email,
        phone: row.phone,
        profilePictureUrl: row.profile_picture || null,
        reviewStatus: row.review_status,
        accountType: row.account_type,
        isAvailable: !!row.is_available,
        createdAt: row.created_at,
      })),
      total: Number(countRows[0]?.total || 0),
    })
  } catch (error) {
    next(error)
  }
}

export const getAuthorityDriverById = async (req, res, next) => {
  try {
    const { driverId } = req.params

    const driverRows = await exec(
      null,
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.profile_picture,
              u.created_at, d.review_status, d.review_reason, d.is_available,
              CASE WHEN EXISTS (SELECT 1 FROM Documents doc WHERE doc.driver_id = d.participant_id AND UPPER(doc.document_type) IN ('RC')) THEN 'pro_transporter' ELSE 'normal' END AS account_type
       FROM Users u
       JOIN Drivers d ON d.participant_id = u.id
       WHERE u.id = ?
       LIMIT 1`,
      [driverId],
    )

    if (!driverRows[0]) {
      return next(createError(404, "Driver not found"))
    }

    const driver = driverRows[0]

    const [profile, vehicles, documents, deliveries] = await Promise.all([
      exec(
        null,
        `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.profile_picture,
                u.created_at,
                d.review_status, d.is_available,
                CASE WHEN EXISTS (SELECT 1 FROM Documents doc WHERE doc.driver_id = d.participant_id AND UPPER(doc.document_type) IN ('RC')) THEN 'pro_transporter' ELSE 'normal' END AS account_type,
                NULL AS wilaya, NULL AS commune, u.address, NULL AS birth_date
         FROM Users u
         JOIN Drivers d ON d.participant_id = u.id
         LEFT JOIN Requesters r ON r.participant_id = u.id
         WHERE u.id = ?
         LIMIT 1`,
        [driverId],
      ),
      exec(
        null,
        `SELECT id, make, model, year, color, license_plate, type, is_verified
         FROM Vehicles WHERE driver_id = ?`,
        [driverId],
      ),
      exec(
        null,
        `SELECT id, document_type, document_url, review_status, created_at
         FROM Documents WHERE driver_id = ? ORDER BY created_at DESC`,
        [driverId],
      ),
      exec(
        null,
        `SELECT d.id, d.status, d.package_type, d.package_weight_kg, d.created_at,
                dp.price, dp.final_price
         FROM Deliveries d
         LEFT JOIN deliverypricing dp ON dp.delivery_id = d.id
         WHERE d.assigned_driver_id = ?
         ORDER BY d.created_at DESC LIMIT 20`,
        [driverId],
      ),
    ])

    const p = profile[0]

    return sendSuccess(res, 200, "Driver profile fetched successfully", {
      driver: {
        id: p.id,
        firstName: p.first_name,
        lastName: p.last_name,
        email: p.email,
        phone: p.phone,
        profilePictureUrl: p.profile_picture || null,
        birthDate: p.birth_date || null,
        wilaya: p.wilaya || null,
        commune: p.commune || null,
        address: p.address || null,
        reviewStatus: p.review_status,
        accountType: p.account_type,
        isAvailable: !!p.is_available,
        createdAt: p.created_at,
      },
      vehicles: vehicles.map((v) => ({
        id: v.id,
        make: v.make,
        model: v.model,
        year: v.year,
        color: v.color,
        licensePlate: v.license_plate,
        type: v.type,
        capacity: null,
        isVerified: !!v.is_verified,
      })),
      documents: documents.map((doc) => ({
        id: doc.id,
        type: doc.document_type,
        fileUrl: doc.document_url,
        fileName: null,
        reviewStatus: doc.review_status,
        createdAt: doc.created_at,
      })),
      deliveries: deliveries.map((d) => ({
        id: d.id,
        status: d.status,
        pickupWilaya: null,
        dropoffWilaya: null,
        price: d.final_price ? Number(d.final_price) : (d.price ? Number(d.price) : 0),
        createdAt: d.created_at,
      })),
    })
  } catch (error) {
    next(error)
  }
}

export const listAuthorityDeliveries = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100)
    const offset = parseInt(req.query.offset, 10) || 0
    const status = req.query.status || null
    const search = req.query.search || null

    const clauses = []
    const params = []

    if (status === "active") {
      clauses.push("d.status IN ('Pending','Accepted','InTransit','PickedUp')")
    } else if (status === "completed") {
      clauses.push("d.status = 'Delivered'")
    } else if (status === "cancelled") {
      clauses.push("d.status IN ('CancelledByUser','CancelledByDriver','Rejected','FailedDelivery')")
    }

    if (search) {
      clauses.push("(d.id LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ? OR du.first_name LIKE ? OR du.last_name LIKE ?)")
      const like = `%${search}%`
      params.push(like, like, like, like, like)
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""

    const rows = await exec(
      null,
      `SELECT d.id, d.status, d.package_type, d.package_weight_kg, d.package_description, d.created_at,
              d.requester_id, d.assigned_driver_id,
              dp.price, dp.final_price,
              u.first_name AS r_first_name, u.last_name AS r_last_name,
              du.first_name AS dr_first_name, du.last_name AS dr_last_name
       FROM Deliveries d
       LEFT JOIN deliverypricing dp ON dp.delivery_id = d.id
       LEFT JOIN Users u ON u.id = d.requester_id
       LEFT JOIN Users du ON du.id = d.assigned_driver_id
       ${where}
       ORDER BY d.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    )

    const countRows = await exec(
      null,
      `SELECT COUNT(*) AS total
       FROM Deliveries d
       LEFT JOIN deliverypricing dp ON dp.delivery_id = d.id
       LEFT JOIN Users u ON u.id = d.requester_id
       LEFT JOIN Users du ON du.id = d.assigned_driver_id
       ${where}`,
      params,
    )

    return sendSuccess(res, 200, "Deliveries fetched successfully", {
      deliveries: rows.map((row) => ({
        id: row.id,
        status: row.status,
        pickupWilaya: null,
        dropoffWilaya: null,
        price: row.final_price ? Number(row.final_price) : (row.price ? Number(row.price) : 0),
        type: row.package_type,
        weight: row.package_weight_kg ? Number(row.package_weight_kg) : null,
        description: row.package_description,
        clientName: row.r_first_name ? `${row.r_first_name} ${row.r_last_name || ""}`.trim() : null,
        driverName: row.dr_first_name ? `${row.dr_first_name} ${row.dr_last_name || ""}`.trim() : null,
        createdAt: row.created_at,
      })),
      total: Number(countRows[0]?.total || 0),
    })
  } catch (error) {
    next(error)
  }
}

export const getAuthorityDeliveryById = async (req, res, next) => {
  try {
    const { deliveryId } = req.params

    const dataRows = await exec(
      null,
      `SELECT d.id, d.status, d.package_type, d.package_weight_kg, d.package_description,
              d.created_at, d.updated_at, d.requester_id, d.assigned_driver_id,
              dp.price, dp.final_price,
              u.id AS client_id, u.first_name AS c_first_name, u.last_name AS c_last_name,
              u.email AS c_email, u.phone AS c_phone, u.profile_picture AS c_picture,
              u.address AS client_address,
              du.id AS driver_user_id, du.first_name AS d_first_name, du.last_name AS d_last_name,
              du.email AS d_email, du.phone AS d_phone, du.profile_picture AS d_picture,
              v.make, v.model, v.color, v.license_plate
       FROM Deliveries d
       LEFT JOIN deliverypricing dp ON dp.delivery_id = d.id
       LEFT JOIN Users u ON u.id = d.requester_id
       LEFT JOIN Users du ON du.id = d.assigned_driver_id
       LEFT JOIN Vehicles v ON v.driver_id = d.assigned_driver_id
       WHERE d.id = ?
       LIMIT 1`,
      [deliveryId],
    )

    if (!dataRows[0]) {
      return next(createError(404, "Delivery not found"))
    }

    const row = dataRows[0]

    const [locationRows] = await Promise.all([
      exec(null, `SELECT type, address, latitude, longitude FROM deliverylocations WHERE delivery_id = ?`, [deliveryId]),
    ])

    const pickupLoc = locationRows.find((l) => l.type === 'PICKUP')
    const dropoffLoc = locationRows.find((l) => l.type === 'DROPOFF')
    const deliveryPrice = row.final_price ? Number(row.final_price) : (row.price ? Number(row.price) : 0)

    return sendSuccess(res, 200, "Delivery fetched successfully", {
      delivery: {
        id: row.id,
        status: row.status,
        type: row.package_type,
        weight: row.package_weight_kg ? Number(row.package_weight_kg) : null,
        description: row.package_description,
        price: deliveryPrice,
        pickupWilaya: null,
        pickupCommune: null,
        pickupAddress: pickupLoc?.address || null,
        pickupLat: pickupLoc?.latitude ? Number(pickupLoc.latitude) : null,
        pickupLng: pickupLoc?.longitude ? Number(pickupLoc.longitude) : null,
        dropoffWilaya: null,
        dropoffCommune: null,
        dropoffAddress: dropoffLoc?.address || null,
        dropoffLat: dropoffLoc?.latitude ? Number(dropoffLoc.latitude) : null,
        dropoffLng: dropoffLoc?.longitude ? Number(dropoffLoc.longitude) : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      client: {
        id: row.client_id,
        firstName: row.c_first_name,
        lastName: row.c_last_name,
        email: row.c_email,
        phone: row.c_phone,
        profilePictureUrl: row.c_picture || null,
        wilaya: null,
        commune: null,
        address: row.client_address || null,
      },
      driver: row.driver_user_id ? {
        id: row.driver_user_id,
        firstName: row.d_first_name,
        lastName: row.d_last_name,
        email: row.d_email,
        phone: row.d_phone,
        profilePictureUrl: row.d_picture || null,
        vehicle: row.make ? {
          make: row.make,
          model: row.model,
          color: row.color,
          licensePlate: row.license_plate,
        } : null,
      } : null,
      tracking: [],
    })
  } catch (error) {
    next(error)
  }
}

export const getAuthorityOpsDashboardSummary = async (_req, res, next) => {
  try {
    const [
      openIncidents,
      unresolvedComplaints,
      complianceDrafts,
      compliancePublished,
      driversPending,
      driversRejected,
    ] = await Promise.all([
      countAuthorityIncidents(null, { status: "open" }),
      countAuthorityComplaints(null, { status: "new" }),
      countAuthorityComplianceReports(null, { status: "draft" }),
      countAuthorityComplianceReports(null, { status: "published" }),
      exec(null, `SELECT COUNT(*) AS total FROM Drivers WHERE review_status = 'pending'`),
      exec(null, `SELECT COUNT(*) AS total FROM Drivers WHERE review_status = 'rejected'`),
    ])

    return sendSuccess(res, 200, "Authority operations dashboard fetched successfully", {
      counts: {
        openIncidents,
        unresolvedComplaints,
        complianceDraftReports: complianceDrafts,
        compliancePublishedReports: compliancePublished,
        driversUnderReview: Number(driversPending[0]?.total || 0),
        rejectedDrivers: Number(driversRejected[0]?.total || 0),
      },
    })
  } catch (error) {
    next(error)
  }
}

export const listDriverReviewQueue = async (req, res, next) => {
  try {
    const parsedLimit = Number.parseInt(String(req.query.limit), 10)
    const parsedOffset = Number.parseInt(String(req.query.offset), 10)
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 0), 100) : 20
    const offset = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0
    const reviewStatus = req.query.reviewStatus || null

    const clauses = []
    const params = []

    if (reviewStatus) {
      clauses.push("d.review_status = ?")
      params.push(reviewStatus)
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""

    const rows = await exec(
      null,
      `SELECT d.participant_id AS driver_id, d.review_status, d.review_reason, d.reviewed_by, d.reviewed_at,
              d.is_documents_verified, d.is_available, d.availability,
              u.first_name, u.last_name, u.email, u.phone,
              (SELECT COUNT(*) FROM Documents doc WHERE doc.driver_id = d.participant_id) AS total_documents,
              (SELECT COUNT(*) FROM Documents doc WHERE doc.driver_id = d.participant_id AND doc.review_status = 'approved') AS approved_documents,
              (SELECT COUNT(*) FROM Documents doc WHERE doc.driver_id = d.participant_id AND doc.review_status = 'rejected') AS rejected_documents
       FROM Drivers d
       JOIN Users u ON u.id = d.participant_id
       ${where}
       ORDER BY d.reviewed_at DESC, d.participant_id DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    )

    const countRows = await exec(
      null,
      `SELECT COUNT(*) AS total
       FROM Drivers d
       ${where}`,
      params,
    )

    return sendSuccess(res, 200, "Driver review queue fetched successfully", {
      drivers: rows.map((row) => ({
        driverId: row.driver_id,
        user: {
          firstName: row.first_name,
          lastName: row.last_name,
          email: row.email,
          phone: row.phone,
        },
        reviewStatus: row.review_status,
        reviewReason: row.review_reason || null,
        reviewedBy: row.reviewed_by || null,
        reviewedAt: row.reviewed_at || null,
        isDocumentsVerified: !!row.is_documents_verified,
        availability: row.availability || "offline",
        isAvailable: !!row.is_available,
        documents: {
          total: Number(row.total_documents || 0),
          approved: Number(row.approved_documents || 0),
          rejected: Number(row.rejected_documents || 0),
        },
      })),
      total: Number(countRows[0]?.total || 0),
    })
  } catch (error) {
    next(error)
  }
}

export const updateDriverReviewDecision = async (req, res, next) => {
  try {
    const { driverId } = req.params
    const { reviewStatus, reason } = req.body

    const rows = await exec(null, `SELECT participant_id FROM Drivers WHERE participant_id = ? LIMIT 1`, [driverId])
    if (!rows[0]) {
      return next(createError(404, "Driver not found"))
    }

    const isDocumentsVerified = reviewStatus === "approved" ? true : reviewStatus === "rejected" ? false : undefined

    await updateDriverReviewStatus(null, driverId, {
      reviewStatus,
      reviewReason: reason || null,
      reviewedBy: req.user.id,
      reviewedAt: new Date(),
      isDocumentsVerified,
    })

    await addDriverVerificationTimelineEvent(null, {
      driverId,
      eventType: "driver_review_updated",
      entityType: "driver",
      entityId: driverId,
      status: reviewStatus,
      reason: reason || null,
      actorId: req.user.id,
    })

    const updated = await exec(
      null,
      `SELECT participant_id, review_status, review_reason, reviewed_by, reviewed_at, is_documents_verified
       FROM Drivers
       WHERE participant_id = ?
       LIMIT 1`,
      [driverId],
    )

    return sendSuccess(res, 200, "Driver review updated successfully", {
      driverId,
      reviewStatus: updated[0]?.review_status || reviewStatus,
      reviewReason: updated[0]?.review_reason || null,
      reviewedBy: updated[0]?.reviewed_by || req.user.id,
      reviewedAt: updated[0]?.reviewed_at || null,
      isDocumentsVerified: !!updated[0]?.is_documents_verified,
    })
  } catch (error) {
    next(error)
  }
}

export const getDriverReviewTimelineForAuthority = async (req, res, next) => {
  try {
    const { driverId } = req.params
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200)
    const offset = parseInt(req.query.offset, 10) || 0

    const driverRows = await exec(null, `SELECT participant_id FROM Drivers WHERE participant_id = ? LIMIT 1`, [driverId])
    if (!driverRows[0]) {
      return next(createError(404, "Driver not found"))
    }

    const timeline = await listDriverVerificationTimeline(null, driverId, {
      limit,
      offset,
    })

    return sendSuccess(res, 200, "Driver review timeline fetched successfully", {
      driverId,
      timeline,
      pagination: {
        limit,
        offset,
      },
    })
  } catch (error) {
    next(error)
  }
}

export const createIncidentReport = async (req, res, next) => {
  try {
    const incident = await createAuthorityIncident(null, {
      ...req.body,
      reportedByUserId: req.body.reportedByUserId || req.user.id,
    })

    return sendSuccess(res, 201, "Incident report created successfully", {
      incident,
    })
  } catch (error) {
    next(error)
  }
}

export const listIncidentReports = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100)
    const offset = parseInt(req.query.offset, 10) || 0

    const incidents = await listAuthorityIncidents(null, {
      status: req.query.status || null,
      severity: req.query.severity || null,
      deliveryId: req.query.deliveryId || null,
      assignedToAuthorityId: req.query.assignedToAuthorityId || null,
      limit,
      offset,
    })

    const total = await countAuthorityIncidents(null, {
      status: req.query.status || null,
      severity: req.query.severity || null,
      deliveryId: req.query.deliveryId || null,
      assignedToAuthorityId: req.query.assignedToAuthorityId || null,
    })

    return sendSuccess(res, 200, "Incident reports fetched successfully", {
      incidents,
      total,
      pagination: {
        limit,
        offset,
      },
    })
  } catch (error) {
    next(error)
  }
}

export const getIncidentReportById = async (req, res, next) => {
  try {
    const incident = await findAuthorityIncidentById(null, req.params.incidentId)
    if (!incident) {
      return next(createError(404, "Incident not found"))
    }

    return sendSuccess(res, 200, "Incident fetched successfully", {
      incident,
    })
  } catch (error) {
    next(error)
  }
}

export const updateIncidentReport = async (req, res, next) => {
  try {
    const existing = await findAuthorityIncidentById(null, req.params.incidentId)
    if (!existing) {
      return next(createError(404, "Incident not found"))
    }

    const shouldAutoResolveAt = req.body.status === "resolved" && req.body.resolvedAt === undefined

    const incident = await updateAuthorityIncident(null, req.params.incidentId, {
      ...req.body,
      resolvedAt: shouldAutoResolveAt ? new Date() : req.body.resolvedAt,
    })

    return sendSuccess(res, 200, "Incident updated successfully", {
      incident,
    })
  } catch (error) {
    next(error)
  }
}

export const createComplaintReport = async (req, res, next) => {
  try {
    const complaint = await createAuthorityComplaint(null, req.body)

    return sendSuccess(res, 201, "Complaint report created successfully", {
      complaint,
    })
  } catch (error) {
    next(error)
  }
}

export const listComplaintReports = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100)
    const offset = parseInt(req.query.offset, 10) || 0

    const complaints = await listAuthorityComplaints(null, {
      status: req.query.status || null,
      category: req.query.category || null,
      complainantUserId: req.query.complainantUserId || null,
      deliveryId: req.query.deliveryId || null,
      limit,
      offset,
    })

    const total = await countAuthorityComplaints(null, {
      status: req.query.status || null,
      category: req.query.category || null,
      complainantUserId: req.query.complainantUserId || null,
      deliveryId: req.query.deliveryId || null,
    })

    return sendSuccess(res, 200, "Complaint reports fetched successfully", {
      complaints,
      total,
      pagination: {
        limit,
        offset,
      },
    })
  } catch (error) {
    next(error)
  }
}

export const getComplaintReportById = async (req, res, next) => {
  try {
    const complaint = await findAuthorityComplaintById(null, req.params.complaintId)
    if (!complaint) {
      return next(createError(404, "Complaint not found"))
    }

    return sendSuccess(res, 200, "Complaint fetched successfully", {
      complaint,
    })
  } catch (error) {
    next(error)
  }
}

export const updateComplaintReport = async (req, res, next) => {
  try {
    const existing = await findAuthorityComplaintById(null, req.params.complaintId)
    if (!existing) {
      return next(createError(404, "Complaint not found"))
    }

    const complaint = await updateAuthorityComplaint(null, req.params.complaintId, req.body)

    return sendSuccess(res, 200, "Complaint updated successfully", {
      complaint,
    })
  } catch (error) {
    next(error)
  }
}

export const createComplianceReport = async (req, res, next) => {
  try {
    const publishedAt = req.body.status === "published" ? new Date() : null
    const report = await createAuthorityComplianceReport(null, {
      ...req.body,
      generatedBy: req.body.generatedBy || req.user.id,
      publishedAt,
    })

    return sendSuccess(res, 201, "Compliance report created successfully", {
      report,
    })
  } catch (error) {
    next(error)
  }
}

export const listComplianceReports = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100)
    const offset = parseInt(req.query.offset, 10) || 0

    const reports = await listAuthorityComplianceReports(null, {
      status: req.query.status || null,
      type: req.query.type || null,
      generatedBy: req.query.generatedBy || null,
      limit,
      offset,
    })

    const total = await countAuthorityComplianceReports(null, {
      status: req.query.status || null,
      type: req.query.type || null,
      generatedBy: req.query.generatedBy || null,
    })

    return sendSuccess(res, 200, "Compliance reports fetched successfully", {
      reports,
      total,
      pagination: {
        limit,
        offset,
      },
    })
  } catch (error) {
    next(error)
  }
}

export const getComplianceReportById = async (req, res, next) => {
  try {
    const report = await findAuthorityComplianceReportById(null, req.params.reportId)
    if (!report) {
      return next(createError(404, "Compliance report not found"))
    }

    return sendSuccess(res, 200, "Compliance report fetched successfully", {
      report,
    })
  } catch (error) {
    next(error)
  }
}

export const updateComplianceReport = async (req, res, next) => {
  try {
    const existing = await findAuthorityComplianceReportById(null, req.params.reportId)
    if (!existing) {
      return next(createError(404, "Compliance report not found"))
    }

    const shouldAutoPublishAt = req.body.status === "published" && req.body.publishedAt === undefined

    const report = await updateAuthorityComplianceReport(null, req.params.reportId, {
      ...req.body,
      publishedAt: shouldAutoPublishAt ? new Date() : req.body.publishedAt,
    })

    return sendSuccess(res, 200, "Compliance report updated successfully", {
      report,
    })
  } catch (error) {
    next(error)
  }
}
