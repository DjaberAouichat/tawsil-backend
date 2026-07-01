import { sendSuccess, createError } from "../utils/response.js"
import { withTransaction } from "../lib/db.js"
import { findDeliveryById } from "../models/delivery.model.js"
import { findDriverByUserId } from "../models/driver.model.js"
import {
  createDeliveryRating,
  findRatingByDeliveryId,
  getDriverRatingAggregate,
  getTopRatedDrivers,
  hasRatedDelivery,
  createClientRating,
  findClientRatingByDeliveryId,
  getClientRatingAggregate,
  hasRatedDeliveryAsDriver,
  getDriverBadge,
  getClientBadge,
  getTopRatedClients,
  getWorstRatedDrivers,
  getWorstRatedClients,
  getDriversWithoutRatings,
  getClientsWithoutRatings,
  getRatingStatistics,
  getRatingDistribution,
  getRatingEvolution,
  getClientRatingEvolution,
} from "../models/rating.model.js"

// ── Client rates Driver ──
export const submitRating = async (req, res, next) => {
  try {
    const { deliveryId } = req.params
    const { communicationRating, packageRating, deliveryTimeRating, comment } = req.body

    const delivery = await findDeliveryById(null, deliveryId, { includeDriver: true, includeRequester: true })
    if (!delivery) return next(createError(404, "Delivery not found"))
    if (delivery.requesterId !== req.user.id) return next(createError(403, "Only the client can rate this delivery"))
    if (delivery.status !== "Delivered") return next(createError(400, "Delivery must be completed before rating"))

    const existing = await hasRatedDelivery(null, deliveryId, req.user.id)
    if (existing) {
      const age = Date.now() - new Date(delivery.updatedAt || delivery.createdAt).getTime()
      const hoursSinceDelivery = age / (1000 * 60 * 60)
      if (hoursSinceDelivery > 24) return next(createError(403, "Rating can only be modified within 24 hours"))
    }

    const averageRating = Number(((communicationRating + packageRating + deliveryTimeRating) / 3).toFixed(2))

    const rating = await withTransaction(async (connection) => {
      return createDeliveryRating(connection, {
        deliveryId,
        driverId: delivery.assignedDriverId,
        clientId: req.user.id,
        communicationRating,
        packageRating,
        deliveryTimeRating,
        averageRating,
        comment: comment || null,
      })
    })

    return sendSuccess(res, 200, "Rating submitted successfully", { rating })
  } catch (error) {
    next(error)
  }
}

// ── Driver rates Client ──
export const submitClientRating = async (req, res, next) => {
  try {
    const { deliveryId } = req.params
    const { communicationRating, flexibilityRating, meetingRespectRating, comment } = req.body

    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) return next(createError(404, "Driver profile not found"))

    const delivery = await findDeliveryById(null, deliveryId, { includeDriver: true, includeRequester: true })
    if (!delivery) return next(createError(404, "Delivery not found"))
    if (delivery.assignedDriverId !== req.user.id) return next(createError(403, "Only the assigned driver can rate this client"))
    if (delivery.status !== "Delivered") return next(createError(400, "Delivery must be completed before rating"))

    const existing = await hasRatedDeliveryAsDriver(null, deliveryId, req.user.id)
    if (existing) {
      const age = Date.now() - new Date(delivery.updatedAt || delivery.createdAt).getTime()
      const hoursSinceDelivery = age / (1000 * 60 * 60)
      if (hoursSinceDelivery > 24) return next(createError(403, "Rating can only be modified within 24 hours"))
    }

    const averageRating = Number(((communicationRating + flexibilityRating + meetingRespectRating) / 3).toFixed(2))

    const rating = await withTransaction(async (connection) => {
      return createClientRating(connection, {
        deliveryId,
        driverId: req.user.id,
        clientId: delivery.senderId,
        communicationRating,
        flexibilityRating,
        meetingRespectRating,
        averageRating,
        comment: comment || null,
      })
    })

    return sendSuccess(res, 200, "Client rating submitted successfully", { rating })
  } catch (error) {
    next(error)
  }
}

// ── GET endpoints ──

export const getDeliveryRating = async (req, res, next) => {
  try {
    const { deliveryId } = req.params
    const driverRating = await findRatingByDeliveryId(null, deliveryId)
    const clientRating = await findClientRatingByDeliveryId(null, deliveryId)
    return sendSuccess(res, 200, "Ratings fetched successfully", {
      driverRating: driverRating || null,
      clientRating: clientRating || null,
    })
  } catch (error) {
    next(error)
  }
}

export const getDriverRating = async (req, res, next) => {
  try {
    const { driverId } = req.params
    const data = await getDriverRatingAggregate(null, driverId)
    const badge = getDriverBadge(data.totalRatings, data.averageRating)
    return sendSuccess(res, 200, "Driver rating fetched successfully", { ...data, badge })
  } catch (error) {
    next(error)
  }
}

export const getClientRating = async (req, res, next) => {
  try {
    const { clientId } = req.params
    const data = await getClientRatingAggregate(null, clientId)
    const badge = getClientBadge(data.totalRatings, data.averageRating)
    return sendSuccess(res, 200, "Client rating fetched successfully", { ...data, badge })
  } catch (error) {
    next(error)
  }
}

export const getMyRating = async (req, res, next) => {
  try {
    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) return next(createError(404, "Driver profile not found"))
    const data = await getDriverRatingAggregate(null, driver.driverId)
    const badge = getDriverBadge(data.totalRatings, data.averageRating)
    return sendSuccess(res, 200, "Rating fetched successfully", { ...data, badge })
  } catch (error) {
    next(error)
  }
}

export const getMyClientRating = async (req, res, next) => {
  try {
    const data = await getClientRatingAggregate(null, req.user.id)
    const badge = getClientBadge(data.totalRatings, data.averageRating)
    return sendSuccess(res, 200, "Client rating fetched successfully", { ...data, badge })
  } catch (error) {
    next(error)
  }
}

// ── Dashboard (combined for current user) ──

export const getMyRatingDashboard = async (req, res, next) => {
  try {
    if (req.user.role === 'driver') {
      const driver = await findDriverByUserId(null, req.user.id)
      if (!driver) return next(createError(404, "Driver profile not found"))
      const rating = await getDriverRatingAggregate(null, driver.driverId)
      const badge = getDriverBadge(rating.totalRatings, rating.averageRating)
      return sendSuccess(res, 200, "Dashboard fetched", { ...rating, badge, role: 'driver' })
    }
    const rating = await getClientRatingAggregate(null, req.user.id)
    const badge = getClientBadge(rating.totalRatings, rating.averageRating)
    return sendSuccess(res, 200, "Dashboard fetched", { ...rating, badge, role: 'client' })
  } catch (error) {
    next(error)
  }
}

// ── Top rated ──

export const getTopRated = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50)
    const drivers = await getTopRatedDrivers(null, { limit })
    return sendSuccess(res, 200, "Top rated drivers fetched successfully", { drivers })
  } catch (error) {
    next(error)
  }
}

// ── Statistics ──

export const getStatistics = async (req, res, next) => {
  try {
    const stats = await getRatingStatistics(null)
    const driverDist = await getRatingDistribution(null, 'driver')
    const clientDist = await getRatingDistribution(null, 'client')
    return sendSuccess(res, 200, "Statistics fetched", { ...stats, driverDistribution: driverDist, clientDistribution: clientDist })
  } catch (error) {
    next(error)
  }
}

// ── Evolution ──

export const getEvolution = async (req, res, next) => {
  try {
    const months = Math.min(parseInt(req.query.months) || 12, 24)
    if (req.user.role === 'driver') {
      const driver = await findDriverByUserId(null, req.user.id)
      if (!driver) return next(createError(404, "Driver profile not found"))
      const evolution = await getRatingEvolution(null, driver.driverId, months)
      return sendSuccess(res, 200, "Evolution fetched", { evolution })
    }
    const evolution = await getClientRatingEvolution(null, req.user.id, months)
    return sendSuccess(res, 200, "Evolution fetched", { evolution })
  } catch (error) {
    next(error)
  }
}

export const getDriverEvolution = async (req, res, next) => {
  try {
    const months = Math.min(parseInt(req.query.months) || 12, 24)
    const { driverId } = req.params
    const evolution = await getRatingEvolution(null, driverId, months)
    return sendSuccess(res, 200, "Evolution fetched", { evolution })
  } catch (error) {
    next(error)
  }
}

export const getClientEvolution = async (req, res, next) => {
  try {
    const months = Math.min(parseInt(req.query.months) || 12, 24)
    const { clientId } = req.params
    const evolution = await getClientRatingEvolution(null, clientId, months)
    return sendSuccess(res, 200, "Evolution fetched", { evolution })
  } catch (error) {
    next(error)
  }
}

// ── Admin endpoints ──

// ── Individual admin endpoints ──

export const getTopDrivers = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50)
    const drivers = await getTopRatedDrivers(null, { limit })
    return sendSuccess(res, 200, "Top drivers fetched", { drivers })
  } catch (error) { next(error) }
}

export const getTopClients = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50)
    const clients = await getTopRatedClients(null, { limit })
    return sendSuccess(res, 200, "Top clients fetched", { clients })
  } catch (error) { next(error) }
}

export const getWorstDrivers = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50)
    const drivers = await getWorstRatedDrivers(null, { limit })
    return sendSuccess(res, 200, "Worst drivers fetched", { drivers })
  } catch (error) { next(error) }
}

export const getWorstClients = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50)
    const clients = await getWorstRatedClients(null, { limit })
    return sendSuccess(res, 200, "Worst clients fetched", { clients })
  } catch (error) { next(error) }
}

export const getUnratedDrivers = async (req, res, next) => {
  try {
    const drivers = await getDriversWithoutRatings(null)
    return sendSuccess(res, 200, "Unrated drivers fetched", { drivers })
  } catch (error) { next(error) }
}

export const getUnratedClients = async (req, res, next) => {
  try {
    const clients = await getClientsWithoutRatings(null)
    return sendSuccess(res, 200, "Unrated clients fetched", { clients })
  } catch (error) { next(error) }
}

export const getAdminRatings = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50)
    const [topDrivers, topClients, worstDrivers, worstClients, driversNoRating, clientsNoRating, stats] = await Promise.all([
      getTopRatedDrivers(null, { limit }),
      getTopRatedClients(null, { limit }),
      getWorstRatedDrivers(null, { limit }),
      getWorstRatedClients(null, { limit }),
      getDriversWithoutRatings(null),
      getClientsWithoutRatings(null),
      getRatingStatistics(null),
    ])

    const driverDist = await getRatingDistribution(null, 'driver')
    const clientDist = await getRatingDistribution(null, 'client')

    return sendSuccess(res, 200, "Admin ratings fetched successfully", {
      topDrivers,
      topClients,
      worstDrivers,
      worstClients,
      driversWithoutRatings: driversNoRating,
      clientsWithoutRatings: clientsNoRating,
      statistics: stats,
      driverDistribution: driverDist,
      clientDistribution: clientDist,
    })
  } catch (error) {
    next(error)
  }
}
