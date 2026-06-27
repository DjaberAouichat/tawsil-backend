import crypto from "crypto"
import { getPool, exec } from "../lib/db.js"
import { sendSuccess, createError } from "../utils/response.js"

const toSafePaginationInt = (value, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.min(Math.max(parsed, 0), max)
}

const mapRow = (row) => {
  if (!row) return null
  return {
    id: row.id,
    fromUserId: row.from_user_id,
    toUserId: row.to_user_id,
    idDelivery: row.id_delivery || null,
    rating: row.rating,
    comment: row.comment || null,
    createdAt: row.created_at,
  }
}

const recalcDriverRating = async (toUserId) => {
  const avgRows = await exec(null, `SELECT AVG(rating) AS avg_rating FROM Rates WHERE to_user_id = ?`, [toUserId])
  const avg = Number(avgRows[0]?.avg_rating || 0)
  const isDriver = await exec(null, `SELECT participant_id FROM Drivers WHERE participant_id = ? LIMIT 1`, [toUserId])
  if (isDriver[0]) {
    await exec(null, `UPDATE Drivers SET rating = ? WHERE participant_id = ?`, [avg.toFixed(2), toUserId])
  }
}

export const createRate = async (req, res, next) => {
  try {
    const { toUserId, idDelivery, rating, comment } = req.body
    const fromUserId = req.user.id

    if (!toUserId || !rating) {
      return next(createError(400, "toUserId and rating are required"))
    }

    if (Number(rating) < 1 || Number(rating) > 5) {
      return next(createError(400, "Rating must be between 1 and 5"))
    }

    if (fromUserId === toUserId) {
      return next(createError(400, "You cannot rate yourself"))
    }

    const toUser = await exec(null, `SELECT id FROM Users WHERE id = ? LIMIT 1`, [toUserId])
    if (!toUser[0]) return next(createError(404, "Target user not found"))

    if (idDelivery) {
      const delivery = await exec(
        null,
        `SELECT id FROM Deliveries WHERE id = ? AND (requester_id = ? OR assigned_driver_id = ?) LIMIT 1`,
        [idDelivery, fromUserId, fromUserId],
      )
      if (!delivery[0]) return next(createError(403, "You are not part of this delivery"))
    }

    const existing = await exec(
      null,
      `SELECT id FROM Rates WHERE from_user_id = ? AND to_user_id = ?
       ${idDelivery ? "AND id_delivery = ?" : "AND id_delivery IS NULL"}
       LIMIT 1`,
      [fromUserId, toUserId, ...(idDelivery ? [idDelivery] : [])],
    )

    if (existing[0]) {
      return next(createError(409, "You have already rated this user for this delivery"))
    }

    const id = crypto.randomUUID()
    await exec(
      null,
      `INSERT INTO Rates (id, from_user_id, to_user_id, id_delivery, rating, comment)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, fromUserId, toUserId, idDelivery || null, Number(rating), comment || null],
    )

    await recalcDriverRating(toUserId)

    const created = await exec(null, `SELECT * FROM Rates WHERE id = ? LIMIT 1`, [id])
    return sendSuccess(res, 201, "Rating submitted successfully", { rate: mapRow(created[0]) })
  } catch (error) {
    next(error)
  }
}

export const updateRate = async (req, res, next) => {
  try {
    const { rateId } = req.params
    const { rating, comment } = req.body

    const rows = await exec(null, `SELECT * FROM Rates WHERE id = ? LIMIT 1`, [rateId])
    const rate = rows[0]
    if (!rate) return next(createError(404, "Rating not found"))
    if (rate.from_user_id !== req.user.id) return next(createError(403, "You can only edit your own ratings"))

    if (rating !== undefined && (Number(rating) < 1 || Number(rating) > 5)) {
      return next(createError(400, "Rating must be between 1 and 5"))
    }

    await exec(
      null,
      `UPDATE Rates SET rating = ?, comment = ? WHERE id = ?`,
      [rating !== undefined ? Number(rating) : rate.rating, comment !== undefined ? comment : rate.comment, rateId],
    )

    await recalcDriverRating(rate.to_user_id)

    const updated = await exec(null, `SELECT * FROM Rates WHERE id = ? LIMIT 1`, [rateId])
    return sendSuccess(res, 200, "Rating updated successfully", { rate: mapRow(updated[0]) })
  } catch (error) {
    next(error)
  }
}

export const deleteRate = async (req, res, next) => {
  try {
    const { rateId } = req.params

    const rows = await exec(null, `SELECT * FROM Rates WHERE id = ? LIMIT 1`, [rateId])
    const rate = rows[0]
    if (!rate) return next(createError(404, "Rating not found"))

    const isAdmin = req.user.role === "admin" || req.user.role === "authority"
    if (rate.from_user_id !== req.user.id && !isAdmin) {
      return next(createError(403, "You can only delete your own ratings"))
    }

    await exec(null, `DELETE FROM Rates WHERE id = ?`, [rateId])
    await recalcDriverRating(rate.to_user_id)

    return sendSuccess(res, 200, "Rating deleted successfully")
  } catch (error) {
    next(error)
  }
}

export const getUserRates = async (req, res, next) => {
  try {
    const { userId } = req.params
    const limit = toSafePaginationInt(req.query.limit, 10, 100)
    const offset = toSafePaginationInt(req.query.offset, 0)

    const rows = await exec(
      null,
      `SELECT r.*, u.first_name, u.last_name
       FROM Rates r
       JOIN Users u ON u.id = r.from_user_id
       WHERE r.to_user_id = ?
       ORDER BY r.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      [userId],
    )

    const countRows = await exec(
      null,
      `SELECT COUNT(*) AS total, AVG(rating) AS avg FROM Rates WHERE to_user_id = ?`,
      [userId],
    )

    return sendSuccess(res, 200, "Ratings fetched successfully", {
      rates: rows.map(mapRow),
      total: Number(countRows[0]?.total || 0),
      average: Number(countRows[0]?.avg || 0).toFixed(2),
    })
  } catch (error) {
    next(error)
  }
}
