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
} from "../models/rating.model.js"

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

    const averageRating = Number(
      ((communicationRating + packageRating + deliveryTimeRating) / 3).toFixed(2),
    )

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

export const getDeliveryRating = async (req, res, next) => {
  try {
    const { deliveryId } = req.params
    const rating = await findRatingByDeliveryId(null, deliveryId)
    if (!rating) return next(createError(404, "Rating not found"))
    return sendSuccess(res, 200, "Rating fetched successfully", { rating })
  } catch (error) {
    next(error)
  }
}

export const getDriverRating = async (req, res, next) => {
  try {
    const { driverId } = req.params
    const data = await getDriverRatingAggregate(null, driverId)
    return sendSuccess(res, 200, "Driver rating fetched successfully", data)
  } catch (error) {
    next(error)
  }
}

export const getMyRating = async (req, res, next) => {
  try {
    const driver = await findDriverByUserId(null, req.user.id)
    if (!driver) return next(createError(404, "Driver profile not found"))
    const data = await getDriverRatingAggregate(null, driver.participantId)
    return sendSuccess(res, 200, "Rating fetched successfully", data)
  } catch (error) {
    next(error)
  }
}

export const getTopRated = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50)
    const drivers = await getTopRatedDrivers(null, { limit })
    return sendSuccess(res, 200, "Top rated drivers fetched successfully", { drivers })
  } catch (error) {
    next(error)
  }
}
