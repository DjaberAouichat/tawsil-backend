import crypto from "crypto"
import { getPool, exec } from "../lib/db.js"

const mapRow = (row) => {
  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    code: row.code,
    discount: row.discount !== null ? Number(row.discount) : null,
    startDate: row.start_date,
    endDate: row.end_date,
    targetUserType: row.target_user_type || "all",
    isActive: !!row.is_active,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const createPromotion = async (connection, { id, title, description, code, discount, startDate, endDate, targetUserType, createdBy }) => {
  await exec(
    connection,
    `INSERT INTO Promotions (id, title, description, code, discount, start_date, end_date, target_user_type, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, title, description || null, code || null, discount ?? null, startDate || null, endDate || null, targetUserType || "all", createdBy || null],
  )

  return findPromotionById(connection, id)
}

export const findPromotionById = async (connection, promotionId) => {
  const rows = await exec(
    connection,
    `SELECT id, title, description, code, discount, start_date, end_date, target_user_type, is_active, created_by, created_at, updated_at
     FROM Promotions WHERE id = ? LIMIT 1`,
    [promotionId],
  )
  return mapRow(rows[0])
}

export const listActivePromotions = async (connection, targetUserType = null) => {
  const params = []
  let where = "WHERE is_active = 1 AND (end_date IS NULL OR end_date >= NOW())"

  if (targetUserType && targetUserType !== "all") {
    where += " AND (target_user_type = ? OR target_user_type = 'all')"
    params.push(targetUserType)
  }

  const rows = await exec(
    connection,
    `SELECT id, title, description, code, discount, start_date, end_date, target_user_type, is_active, created_by, created_at, updated_at
     FROM Promotions ${where} ORDER BY created_at DESC`,
    params,
  )

  return rows.map(mapRow)
}

export const listAllPromotions = async (connection) => {
  const rows = await exec(
    connection,
    `SELECT id, title, description, code, discount, start_date, end_date, target_user_type, is_active, created_by, created_at, updated_at
     FROM Promotions ORDER BY created_at DESC`,
  )

  return rows.map(mapRow)
}

export const updatePromotion = async (connection, promotionId, fields) => {
  const sets = []
  const params = []

  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = ?`)
    params.push(value)
  }

  if (sets.length === 0) return findPromotionById(connection, promotionId)

  params.push(promotionId)
  await exec(
    connection,
    `UPDATE Promotions SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`,
    params,
  )

  return findPromotionById(connection, promotionId)
}

export const deactivatePromotion = async (connection, promotionId) => {
  await exec(
    connection,
    'UPDATE Promotions SET is_active = 0, updated_at = NOW() WHERE id = ?',
    [promotionId],
  )

  return findPromotionById(connection, promotionId)
}
