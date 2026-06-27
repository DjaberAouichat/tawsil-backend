import { exec } from "../lib/db.js"

export const listAllSettings = async (connection) => {
  const rows = await exec(
    connection,
    `SELECT setting_key, setting_value, created_at, updated_at FROM Settings ORDER BY setting_key`,
  )
  return rows.map((r) => ({
    key: r.setting_key,
    value: r.setting_value,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
}

export const getSetting = async (connection, key) => {
  const rows = await exec(
    connection,
    `SELECT setting_key, setting_value FROM Settings WHERE setting_key = ? LIMIT 1`,
    [key],
  )
  if (!rows[0]) return null
  return { key: rows[0].setting_key, value: rows[0].setting_value }
}

export const upsertSetting = async (connection, key, value) => {
  await exec(
    connection,
    `INSERT INTO Settings (setting_key, setting_value)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [key, String(value)],
  )
  return { key, value: String(value) }
}
