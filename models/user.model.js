import { getPool, exec } from "../lib/db.js"

const mapUserRow = (row, { includePassword = false } = {}) => {
  if (!row) {
    return null
  }

  const user = {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    profilePicture: row.profile_picture || "",
    isOnboarded: !!row.is_onboarded,
    city: row.city || null,
    address: row.address || null,
    isEmailVerified: !!row.is_email_verified,
    isBlocked: !!row.is_blocked,
    isSuspended: !!row.is_suspended,
    tokenVersion: Number(row.token_version || 0),
    blockedAt: row.blocked_at || null,
    suspendedAt: row.suspended_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }

  if (includePassword) {
    user.passwordHash = row.password
  }

  return user
}

export const createUser = async (connection, {
  id,
  firstName,
  lastName,
  email,
  passwordHash,
  phone,
  profilePicture = "",
  isEmailVerified = false,
  isOnboarded = false,
}) => {
  await exec(
    connection,
    `INSERT INTO Users (id, first_name, last_name, email, password, phone, profile_picture, is_email_verified, is_onboarded, token_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ,
    [
      id,
      firstName,
      lastName,
      email,
      passwordHash,
      phone,
      profilePicture,
      isEmailVerified ? 1 : 0,
      isOnboarded ? 1 : 0,
      0,
    ],
  )

  const created = await findUserById(connection, id)
  return created
}

export const findUserById = async (connection, userId, { includePassword = false } = {}) => {
  const rows = await exec(
    connection,
      `SELECT id, first_name, last_name, email, password, phone, profile_picture,
        is_onboarded, city, address, is_email_verified, is_blocked, is_suspended, token_version, blocked_at, suspended_at,
            created_at, updated_at
     FROM Users
     WHERE id = ?
     LIMIT 1`,
    [userId],
  )

  return mapUserRow(rows[0], { includePassword })
}

export const findUserByEmail = async (connection, email, { includePassword = false } = {}) => {
  const rows = await exec(
    connection,
      `SELECT id, first_name, last_name, email, password, phone, profile_picture,
        is_onboarded, city, address, is_email_verified, is_blocked, is_suspended, token_version, blocked_at, suspended_at,
            created_at, updated_at
     FROM Users
     WHERE email = ?
     LIMIT 1`,
    [email],
  )

  return mapUserRow(rows[0], { includePassword })
}

export const findUserByPhone = async (connection, phone, { includePassword = false } = {}) => {
  const rows = await exec(
    connection,
      `SELECT id, first_name, last_name, email, password, phone, profile_picture,
        is_onboarded, city, address, is_email_verified, is_blocked, is_suspended, token_version, blocked_at, suspended_at,
            created_at, updated_at
     FROM Users
     WHERE phone = ?
     LIMIT 1`,
    [phone],
  )

  return mapUserRow(rows[0], { includePassword })
}

export const updateUserEmailVerified = async (connection, userId, isEmailVerified) => {
  await exec(connection, `UPDATE Users SET is_email_verified = ? WHERE id = ?`, [isEmailVerified ? 1 : 0, userId])
}

export const updateUserPassword = async (connection, userId, passwordHash) => {
  await exec(connection, `UPDATE Users SET password = ?, token_version = token_version + 1 WHERE id = ?`, [passwordHash, userId])
}

export const updateUserProfile = async (
  connection,
  userId,
  { firstName, lastName, phone, profilePicture, city, address, isOnboarded } = {},
) => {
  const updates = []
  const params = []

  if (firstName !== undefined) {
    updates.push("first_name = ?")
    params.push(firstName)
  }

  if (lastName !== undefined) {
    updates.push("last_name = ?")
    params.push(lastName)
  }

  if (phone !== undefined) {
    updates.push("phone = ?")
    params.push(phone)
  }

  if (profilePicture !== undefined) {
    updates.push("profile_picture = ?")
    params.push(profilePicture)
  }

  if (city !== undefined) {
    updates.push("city = ?")
    params.push(city)
  }

  if (address !== undefined) {
    updates.push("address = ?")
    params.push(address)
  }

  if (isOnboarded !== undefined) {
    updates.push("is_onboarded = ?")
    params.push(isOnboarded ? 1 : 0)
  }

  if (!updates.length) {
    return
  }

  params.push(userId)
  await exec(connection, `UPDATE Users SET ${updates.join(", ")} WHERE id = ?`, params)
}

export const getUserRole = async (connection, userId) => {
  const rows = await exec(
    connection,
    `SELECT
        EXISTS(SELECT 1 FROM Authorities WHERE user_id = ?) AS is_authority,
        EXISTS(SELECT 1 FROM Admins WHERE user_id = ?) AS is_admin,
        EXISTS(SELECT 1 FROM Drivers WHERE participant_id = ?) AS is_driver,
        EXISTS(SELECT 1 FROM Participants WHERE user_id = ?) AS is_participant,
        EXISTS(SELECT 1 FROM Requesters WHERE participant_id = ?) AS is_requester
     `,
    [userId, userId, userId, userId, userId],
  )

  const roleRow = rows[0] || {}
  if (roleRow.is_authority) return "authority"
  if (roleRow.is_admin) return "admin"
  if (roleRow.is_driver) return "driver"
  if (roleRow.is_requester) return "client"
  if (roleRow.is_participant) return "driver"

  return "client"
}

export const createUserToken = async (connection, { id, userId, type, tokenHash, expiresAt }) => {
  await exec(
    connection,
    `INSERT INTO UserTokens (id, user_id, type, token_hash, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, userId, type, tokenHash, expiresAt],
  )
}

export const consumeUserToken = async (connection, { type, tokenHash }) => {
  const rows = await exec(
    connection,
    `SELECT id, user_id, expires_at, used_at
     FROM UserTokens
     WHERE type = ? AND token_hash = ?
     ORDER BY created_at DESC
     LIMIT 1`,
    [type, tokenHash],
  )

  const token = rows[0]
  if (!token) {
    return null
  }

  if (token.used_at) {
    return null
  }

  const expiresAtMs = Number(token.expires_at)
  const nowMs = Date.now()
  const isExpired = expiresAtMs < nowMs

  if (Number.isNaN(expiresAtMs) || isExpired) {
    return null
  }

  const updateResult = await connection.execute(
    `UPDATE UserTokens SET used_at = NOW() WHERE id = ? AND used_at IS NULL`,
    [token.id]
  )

  // Check if UPDATE actually affected a row
  if (!updateResult[0] || updateResult[0].affectedRows === 0) {
    return null
  }

  return {
    id: token.id,
    userId: token.user_id,
  }
}
