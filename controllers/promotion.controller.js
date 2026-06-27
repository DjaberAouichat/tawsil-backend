import crypto from "crypto"
import { getPool, exec } from "../lib/db.js"
import { createPromotion as createPromotionRecord, listActivePromotions, listAllPromotions, updatePromotion as updatePromotionRecord, deactivatePromotion as deactivatePromotionRecord } from "../models/promotion.model.js"
import { createNotification } from "../utils/notification.utils.js"
import { sendSuccess, createError } from "../utils/response.js"

export const createPromotion = async (req, res, next) => {
  try {
    const { title, description, code, discount, startDate, endDate, targetUserType } = req.body

    if (!title) {
      return next(createError(400, "Title is required"))
    }

    const promotionId = crypto.randomUUID()
    const promotion = await createPromotionRecord(null, {
      id: promotionId,
      title,
      description: description || "",
      code: code || null,
      discount: discount ?? null,
      startDate: startDate || null,
      endDate: endDate || null,
      targetUserType: targetUserType || "all",
      createdBy: req.user.id,
    })

    // Send notification to all users (or targeted users)
    const userType = targetUserType === "driver" ? "driver" : targetUserType === "client" ? "client" : null
    let userParams = []
    let userWhere = "WHERE 1=1"

    if (userType) {
      if (userType === "driver") {
        userWhere = "WHERE u.id IN (SELECT participant_id FROM Drivers)"
      } else if (userType === "client") {
        userWhere = "WHERE u.id NOT IN (SELECT participant_id FROM Drivers)"
      }
    }

    const users = await exec(
      null,
      `SELECT id FROM Users u ${userWhere}`,
      userParams,
    )

    for (const user of users) {
      createNotification({
        recipient: user.id,
        title: "Nouvelle promotion disponible",
        message: description || title,
        type: "promotion",
        promotionId,
        data: {
          code: code || "",
          discount: discount != null ? `${discount}%` : "",
          expiresAt: endDate || "",
        },
        sendEmail: false,
      }).catch((err) => console.error("[promotion] Failed to notify user:", err))
    }

    return sendSuccess(res, 201, "Promotion created successfully", { promotion, notifiedUsers: users.length })
  } catch (error) {
    next(error)
  }
}

export const getActivePromotions = async (req, res, next) => {
  try {
    const userRole = req.user.role
    const targetUserType = userRole === "driver" ? "driver" : userRole === "client" ? "client" : null
    const promotions = await listActivePromotions(null, targetUserType)
    return sendSuccess(res, 200, "Active promotions fetched successfully", { promotions })
  } catch (error) {
    next(error)
  }
}

export const listPromotions = async (req, res, next) => {
  try {
    const promotions = await listAllPromotions(null)
    return sendSuccess(res, 200, "Promotions fetched successfully", { promotions })
  } catch (error) {
    next(error)
  }
}

export const updatePromotionHandler = async (req, res, next) => {
  try {
    const { promotionId } = req.params
    const { title, description, code, discount, startDate, endDate, targetUserType } = req.body

    const fields = {}
    if (title !== undefined) fields.title = title
    if (description !== undefined) fields.description = description
    if (code !== undefined) fields.code = code
    if (discount !== undefined) fields.discount = discount
    if (startDate !== undefined) fields.start_date = startDate
    if (endDate !== undefined) fields.end_date = endDate
    if (targetUserType !== undefined) fields.target_user_type = targetUserType

    const promotion = await updatePromotionRecord(null, promotionId, fields)
    if (!promotion) {
      return next(createError(404, "Promotion not found"))
    }

    return sendSuccess(res, 200, "Promotion updated successfully", { promotion })
  } catch (error) {
    next(error)
  }
}

export const deactivatePromotionHandler = async (req, res, next) => {
  try {
    const { promotionId } = req.params
    const promotion = await deactivatePromotionRecord(null, promotionId)

    if (!promotion) {
      return next(createError(404, "Promotion not found"))
    }

    return sendSuccess(res, 200, "Promotion deactivated successfully", { promotion })
  } catch (error) {
    next(error)
  }
}
