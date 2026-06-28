import { getPool, exec } from "../lib/db.js"

export const createDeliveryRating = async (connection, {
  id,
  deliveryId,
  driverId,
  clientId,
  communicationRating,
  packageRating,
  deliveryTimeRating,
  averageRating,
  comment = null,
}) => {
  const rows = await exec(
    connection,
    `SELECT id FROM DeliveryRatings WHERE delivery_id = ? LIMIT 1`,
    [deliveryId],
  )
  if (rows[0]) {
    await exec(
      connection,
      `UPDATE DeliveryRatings
       SET communication_rating = ?, package_rating = ?, delivery_time_rating = ?,
           average_rating = ?, comment = ?, updated_at = NOW()
       WHERE delivery_id = ?`,
      [communicationRating, packageRating, deliveryTimeRating, averageRating, comment, deliveryId],
    )
    return findRatingByDeliveryId(connection, deliveryId)
  }

  const uuidResult = await exec(connection, `SELECT UUID() AS uuid`)
  const uuid = id || uuidResult[0]?.uuid

  await exec(
    connection,
    `INSERT INTO DeliveryRatings (id, delivery_id, driver_id, client_id,
        communication_rating, package_rating, delivery_time_rating,
        average_rating, comment)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuid, deliveryId, driverId, clientId, communicationRating, packageRating, deliveryTimeRating, averageRating, comment],
  )

  return findRatingByDeliveryId(connection, deliveryId)
}

export const findRatingByDeliveryId = async (connection, deliveryId) => {
  const rows = await exec(
    connection,
    `SELECT id, delivery_id, driver_id, client_id,
            communication_rating, package_rating, delivery_time_rating,
            average_rating, comment, created_at, updated_at
     FROM DeliveryRatings
     WHERE delivery_id = ?
     LIMIT 1`,
    [deliveryId],
  )
  return rows[0] || null
}

export const getDriverRatingAggregate = async (connection, driverId) => {
  const rows = await exec(
    connection,
    `SELECT
       ROUND(AVG(average_rating), 2) AS average_rating,
       COUNT(*) AS total_ratings,
       ROUND(AVG(communication_rating), 2) AS avg_communication,
       ROUND(AVG(package_rating), 2) AS avg_package,
       ROUND(AVG(delivery_time_rating), 2) AS avg_delivery_time
     FROM DeliveryRatings
     WHERE driver_id = ?`,
    [driverId],
  )
  return {
    averageRating: rows[0]?.average_rating ? Number(rows[0].average_rating) : 0,
    totalRatings: rows[0]?.total_ratings ? Number(rows[0].total_ratings) : 0,
    avgCommunication: rows[0]?.avg_communication ? Number(rows[0].avg_communication) : 0,
    avgPackage: rows[0]?.avg_package ? Number(rows[0].avg_package) : 0,
    avgDeliveryTime: rows[0]?.avg_delivery_time ? Number(rows[0].avg_delivery_time) : 0,
  }
}

export const getTopRatedDrivers = async (connection, { limit = 10 } = {}) => {
  const rows = await exec(
    connection,
    `SELECT
       d.participant_id AS driver_id,
       u.full_name,
       u.first_name,
       u.last_name,
       u.profile_picture,
       ROUND(AVG(r.average_rating), 2) AS average_rating,
       COUNT(r.id) AS total_ratings,
       (SELECT COUNT(*) FROM Deliveries del WHERE del.assigned_driver_id = d.participant_id) AS total_deliveries
     FROM DeliveryRatings r
     JOIN Drivers d ON d.participant_id = r.driver_id
     JOIN Users u ON u.id = d.participant_id
     GROUP BY d.participant_id
     HAVING total_ratings > 0
     ORDER BY average_rating DESC, total_ratings DESC
     LIMIT ?`,
    [limit],
  )

  return rows.map((row) => ({
    driverId: row.driver_id,
    displayName: row.full_name || `${row.first_name || ""} ${row.last_name || ""}`.trim(),
    profilePicture: row.profile_picture || null,
    averageRating: Number(row.average_rating) || 0,
    totalRatings: Number(row.total_ratings) || 0,
    totalDeliveries: Number(row.total_deliveries) || 0,
  }))
}

export const hasRatedDelivery = async (connection, deliveryId, clientId) => {
  const rows = await exec(
    connection,
    `SELECT id FROM DeliveryRatings WHERE delivery_id = ? AND client_id = ? LIMIT 1`,
    [deliveryId, clientId],
  )
  return !!rows[0]
}
