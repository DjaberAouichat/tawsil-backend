import { getPool, exec } from "../lib/db.js"

const BAYESIAN_MIN_REVIEWS = 20

const computeBayesianScore = (avgRating, numReviews, globalAvg) => {
  const v = numReviews
  const m = BAYESIAN_MIN_REVIEWS
  const R = avgRating
  const C = globalAvg || 0
  if (v === 0) return 0
  return Number(((v / (v + m)) * R + (m / (v + m)) * C).toFixed(2))
}

const getGlobalAverageRating = async (connection) => {
  const rows = await exec(
    connection,
    `SELECT ROUND(AVG(average_rating), 2) AS avg FROM DeliveryRatings`,
  )
  return rows[0]?.avg ? Number(rows[0].avg) : 4.0
}

const getGlobalAverageClientRating = async (connection) => {
  const rows = await exec(
    connection,
    `SELECT ROUND(AVG(average_rating), 2) AS avg FROM ClientRatings`,
  )
  return rows[0]?.avg ? Number(rows[0].avg) : 4.0
}

// ── Driver Ratings (Client → Driver) ──

export const createDeliveryRating = async (connection, {
  id, deliveryId, driverId, clientId,
  communicationRating, packageRating, deliveryTimeRating,
  averageRating, comment = null,
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
  const globalAvg = await getGlobalAverageRating(connection)
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

  const avgRating = rows[0]?.average_rating ? Number(rows[0].average_rating) : 0
  const totalRatings = rows[0]?.total_ratings ? Number(rows[0].total_ratings) : 0

  return {
    averageRating: avgRating,
    totalRatings,
    bayesianScore: computeBayesianScore(avgRating, totalRatings, globalAvg),
    avgCommunication: rows[0]?.avg_communication ? Number(rows[0].avg_communication) : 0,
    avgPackage: rows[0]?.avg_package ? Number(rows[0].avg_package) : 0,
    avgDeliveryTime: rows[0]?.avg_delivery_time ? Number(rows[0].avg_delivery_time) : 0,
  }
}

export const hasRatedDelivery = async (connection, deliveryId, clientId) => {
  const rows = await exec(
    connection,
    `SELECT id FROM DeliveryRatings WHERE delivery_id = ? AND client_id = ? LIMIT 1`,
    [deliveryId, clientId],
  )
  return !!rows[0]
}

// ── Client Ratings (Driver → Client) ──

export const createClientRating = async (connection, {
  id, deliveryId, driverId, clientId,
  communicationRating, flexibilityRating, meetingRespectRating,
  averageRating, comment = null,
}) => {
  const rows = await exec(
    connection,
    `SELECT id FROM ClientRatings WHERE delivery_id = ? LIMIT 1`,
    [deliveryId],
  )
  if (rows[0]) {
    await exec(
      connection,
      `UPDATE ClientRatings
       SET communication_rating = ?, flexibility_rating = ?, meeting_respect_rating = ?,
           average_rating = ?, comment = ?, updated_at = NOW()
       WHERE delivery_id = ?`,
      [communicationRating, flexibilityRating, meetingRespectRating, averageRating, comment, deliveryId],
    )
    return findClientRatingByDeliveryId(connection, deliveryId)
  }

  const uuidResult = await exec(connection, `SELECT UUID() AS uuid`)
  const uuid = id || uuidResult[0]?.uuid

  await exec(
    connection,
    `INSERT INTO ClientRatings (id, delivery_id, driver_id, client_id,
        communication_rating, flexibility_rating, meeting_respect_rating,
        average_rating, comment)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuid, deliveryId, driverId, clientId, communicationRating, flexibilityRating, meetingRespectRating, averageRating, comment],
  )

  return findClientRatingByDeliveryId(connection, deliveryId)
}

export const findClientRatingByDeliveryId = async (connection, deliveryId) => {
  const rows = await exec(
    connection,
    `SELECT id, delivery_id, driver_id, client_id,
            communication_rating, flexibility_rating, meeting_respect_rating,
            average_rating, comment, created_at, updated_at
     FROM ClientRatings
     WHERE delivery_id = ?
     LIMIT 1`,
    [deliveryId],
  )
  return rows[0] || null
}

export const getClientRatingAggregate = async (connection, clientId) => {
  const globalAvg = await getGlobalAverageClientRating(connection)
  const rows = await exec(
    connection,
    `SELECT
       ROUND(AVG(average_rating), 2) AS average_rating,
       COUNT(*) AS total_ratings,
       ROUND(AVG(communication_rating), 2) AS avg_communication,
       ROUND(AVG(flexibility_rating), 2) AS avg_flexibility,
       ROUND(AVG(meeting_respect_rating), 2) AS avg_meeting_respect
     FROM ClientRatings
     WHERE client_id = ?`,
    [clientId],
  )

  const avgRating = rows[0]?.average_rating ? Number(rows[0].average_rating) : 0
  const totalRatings = rows[0]?.total_ratings ? Number(rows[0].total_ratings) : 0

  return {
    averageRating: avgRating,
    totalRatings,
    bayesianScore: computeBayesianScore(avgRating, totalRatings, globalAvg),
    avgCommunication: rows[0]?.avg_communication ? Number(rows[0].avg_communication) : 0,
    avgFlexibility: rows[0]?.avg_flexibility ? Number(rows[0].avg_flexibility) : 0,
    avgMeetingRespect: rows[0]?.avg_meeting_respect ? Number(rows[0].avg_meeting_respect) : 0,
  }
}

export const hasRatedDeliveryAsDriver = async (connection, deliveryId, driverId) => {
  const rows = await exec(
    connection,
    `SELECT id FROM ClientRatings WHERE delivery_id = ? AND driver_id = ? LIMIT 1`,
    [deliveryId, driverId],
  )
  return !!rows[0]
}

export const hasDriverRatedClient = async (connection, deliveryId) => {
  const rows = await exec(
    connection,
    `SELECT id FROM ClientRatings WHERE delivery_id = ? LIMIT 1`,
    [deliveryId],
  )
  return !!rows[0]
}

// ── Badges ──

export const getDriverBadge = (totalRatings, averageRating) => {
  if (totalRatings >= 100 && averageRating >= 4.9) return { id: 'gold', label: 'Conducteur Exemplaire', icon: '🥇' }
  if (totalRatings >= 50 && averageRating >= 4.7) return { id: 'silver', label: 'Conducteur Fiable', icon: '🥈' }
  if (totalRatings < 20) return { id: 'new', label: 'Nouveau Conducteur', icon: '🥉' }
  return { id: 'standard', label: 'Conducteur', icon: '🚗' }
}

export const getClientBadge = (totalRatings, averageRating) => {
  if (totalRatings >= 100 && averageRating >= 4.9) return { id: 'gold', label: 'Client Exemplaire', icon: '⭐' }
  if (totalRatings >= 50 && averageRating >= 4.7) return { id: 'silver', label: 'Client Fiable', icon: '⭐' }
  if (totalRatings < 20) return { id: 'new', label: 'Nouveau Client', icon: '🆕' }
  return { id: 'standard', label: 'Client', icon: '👤' }
}

// ── Admin: Top / Worst / No Ratings ──

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
  return rows.map((row) => {
    const avg = Number(row.average_rating) || 0
    const total = Number(row.total_ratings) || 0
    return {
      driverId: row.driver_id,
      displayName: row.full_name || `${row.first_name || ""} ${row.last_name || ""}`.trim(),
      profilePicture: row.profile_picture || null,
      averageRating: avg,
      totalRatings: total,
      totalDeliveries: Number(row.total_deliveries) || 0,
      badge: getDriverBadge(total, avg),
    }
  })
}

export const getTopRatedClients = async (connection, { limit = 10 } = {}) => {
  const rows = await exec(
    connection,
    `SELECT
       r.client_id AS client_id,
       u.full_name,
       u.first_name,
       u.last_name,
       u.profile_picture,
       ROUND(AVG(r.average_rating), 2) AS average_rating,
       COUNT(r.id) AS total_ratings,
       (SELECT COUNT(*) FROM Deliveries del WHERE del.sender_id = r.client_id) AS total_deliveries
     FROM ClientRatings r
     JOIN Requesters req ON req.participant_id = r.client_id
     JOIN Users u ON u.id = req.participant_id
     GROUP BY r.client_id
     HAVING total_ratings > 0
     ORDER BY average_rating DESC, total_ratings DESC
     LIMIT ?`,
    [limit],
  )
  return rows.map((row) => {
    const avg = Number(row.average_rating) || 0
    const total = Number(row.total_ratings) || 0
    return {
      clientId: row.client_id,
      displayName: row.full_name || `${row.first_name || ""} ${row.last_name || ""}`.trim(),
      profilePicture: row.profile_picture || null,
      averageRating: avg,
      totalRatings: total,
      totalDeliveries: Number(row.total_deliveries) || 0,
      badge: getClientBadge(total, avg),
    }
  })
}

export const getWorstRatedDrivers = async (connection, { limit = 10 } = {}) => {
  const rows = await exec(
    connection,
    `SELECT
       d.participant_id AS driver_id,
       u.full_name, u.first_name, u.last_name, u.profile_picture,
       ROUND(AVG(r.average_rating), 2) AS average_rating,
       COUNT(r.id) AS total_ratings,
       (SELECT COUNT(*) FROM Deliveries del WHERE del.assigned_driver_id = d.participant_id) AS total_deliveries
     FROM DeliveryRatings r
     JOIN Drivers d ON d.participant_id = r.driver_id
     JOIN Users u ON u.id = d.participant_id
     GROUP BY d.participant_id
     HAVING total_ratings > 0
     ORDER BY average_rating ASC, total_ratings DESC
     LIMIT ?`,
    [limit],
  )
  return rows.map((row) => {
    const avg = Number(row.average_rating) || 0
    const total = Number(row.total_ratings) || 0
    return {
      driverId: row.driver_id,
      displayName: row.full_name || `${row.first_name || ""} ${row.last_name || ""}`.trim(),
      profilePicture: row.profile_picture || null,
      averageRating: avg,
      totalRatings: total,
      totalDeliveries: Number(row.total_deliveries) || 0,
      badge: getDriverBadge(total, avg),
    }
  })
}

export const getWorstRatedClients = async (connection, { limit = 10 } = {}) => {
  const rows = await exec(
    connection,
    `SELECT
       r.client_id AS client_id,
       u.full_name, u.first_name, u.last_name, u.profile_picture,
       ROUND(AVG(r.average_rating), 2) AS average_rating,
       COUNT(r.id) AS total_ratings,
       (SELECT COUNT(*) FROM Deliveries del WHERE del.sender_id = r.client_id) AS total_deliveries
     FROM ClientRatings r
     JOIN Requesters req ON req.participant_id = r.client_id
     JOIN Users u ON u.id = req.participant_id
     GROUP BY r.client_id
     HAVING total_ratings > 0
     ORDER BY average_rating ASC, total_ratings DESC
     LIMIT ?`,
    [limit],
  )
  return rows.map((row) => {
    const avg = Number(row.average_rating) || 0
    const total = Number(row.total_ratings) || 0
    return {
      clientId: row.client_id,
      displayName: row.full_name || `${row.first_name || ""} ${row.last_name || ""}`.trim(),
      profilePicture: row.profile_picture || null,
      averageRating: avg,
      totalRatings: total,
      totalDeliveries: Number(row.total_deliveries) || 0,
      badge: getClientBadge(total, avg),
    }
  })
}

export const getDriversWithoutRatings = async (connection) => {
  const rows = await exec(
    connection,
    `SELECT d.participant_id AS driver_id, u.full_name, u.first_name, u.last_name, u.profile_picture
     FROM Drivers d
     JOIN Users u ON u.id = d.participant_id
     WHERE d.review_status = 'approved'
       AND NOT EXISTS (SELECT 1 FROM DeliveryRatings r WHERE r.driver_id = d.participant_id)`,
  )
  return rows.map((row) => ({
    driverId: row.driver_id,
    displayName: row.full_name || `${row.first_name || ""} ${row.last_name || ""}`.trim(),
    profilePicture: row.profile_picture || null,
  }))
}

export const getClientsWithoutRatings = async (connection) => {
  const rows = await exec(
    connection,
    `SELECT req.participant_id AS client_id, u.full_name, u.first_name, u.last_name, u.profile_picture
     FROM Requesters req
     JOIN Users u ON u.id = req.participant_id
     WHERE NOT EXISTS (SELECT 1 FROM ClientRatings r WHERE r.client_id = req.participant_id)`,
  )
  return rows.map((row) => ({
    clientId: row.client_id,
    displayName: row.full_name || `${row.first_name || ""} ${row.last_name || ""}`.trim(),
    profilePicture: row.profile_picture || null,
  }))
}

// ── Statistics ──

export const getRatingStatistics = async (connection) => {
  const [driverStats, clientStats, driverAvg, clientAvg, totalDriversRated, totalClientsRated] = await Promise.all([
    exec(connection, `SELECT COUNT(*) AS total FROM DeliveryRatings`),
    exec(connection, `SELECT COUNT(*) AS total FROM ClientRatings`),
    exec(connection, `SELECT ROUND(AVG(average_rating), 2) AS avg FROM DeliveryRatings`),
    exec(connection, `SELECT ROUND(AVG(average_rating), 2) AS avg FROM ClientRatings`),
    exec(connection, `SELECT COUNT(DISTINCT driver_id) AS total FROM DeliveryRatings`),
    exec(connection, `SELECT COUNT(DISTINCT client_id) AS total FROM ClientRatings`),
  ])
  return {
    totalDriverRatings: Number(driverStats[0]?.total) || 0,
    totalClientRatings: Number(clientStats[0]?.total) || 0,
    totalRatings: (Number(driverStats[0]?.total) || 0) + (Number(clientStats[0]?.total) || 0),
    platformAverageDriver: Number(driverAvg[0]?.avg) || 0,
    platformAverageClient: Number(clientAvg[0]?.avg) || 0,
    driversRated: Number(totalDriversRated[0]?.total) || 0,
    clientsRated: Number(totalClientsRated[0]?.total) || 0,
  }
}

// ── Star Distribution ──

export const getRatingDistribution = async (connection, type = 'driver') => {
  const table = type === 'client' ? 'ClientRatings' : 'DeliveryRatings'
  const rows = await exec(
    connection,
    `SELECT
       FLOOR(average_rating) AS star,
       COUNT(*) AS count
     FROM ${table}
     GROUP BY FLOOR(average_rating)
     ORDER BY star DESC`,
  )
  const dist = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 }
  for (const row of rows) {
    const s = Math.floor(Number(row.star))
    if (s >= 1 && s <= 5) dist[s] = Number(row.count)
  }
  return dist
}

// ── Evolution (monthly buckets) ──

export const getRatingEvolution = async (connection, driverId, months = 12) => {
  const rows = await exec(
    connection,
    `SELECT
       DATE_FORMAT(created_at, '%Y-%m') AS month,
       ROUND(AVG(average_rating), 2) AS avg,
       COUNT(*) AS count
     FROM DeliveryRatings
     WHERE driver_id = ?
       AND created_at >= DATE_SUB(NOW(), INTERVAL ? MONTH)
     GROUP BY DATE_FORMAT(created_at, '%Y-%m')
     ORDER BY month ASC`,
    [driverId, months],
  )
  return rows.map((row) => ({
    month: row.month,
    average: Number(row.avg) || 0,
    count: Number(row.count) || 0,
  }))
}

export const getClientRatingEvolution = async (connection, clientId, months = 12) => {
  const rows = await exec(
    connection,
    `SELECT
       DATE_FORMAT(created_at, '%Y-%m') AS month,
       ROUND(AVG(average_rating), 2) AS avg,
       COUNT(*) AS count
     FROM ClientRatings
     WHERE client_id = ?
       AND created_at >= DATE_SUB(NOW(), INTERVAL ? MONTH)
     GROUP BY DATE_FORMAT(created_at, '%Y-%m')
     ORDER BY month ASC`,
    [clientId, months],
  )
  return rows.map((row) => ({
    month: row.month,
    average: Number(row.avg) || 0,
    count: Number(row.count) || 0,
  }))
}
