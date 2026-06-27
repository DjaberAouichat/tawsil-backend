import express from "express"
import {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
} from "../controllers/notification.controller.js"
import { authenticate } from "../middleware/auth.js"
import { asyncHandler } from "../utils/response.js"

const router = express.Router()

// Dev-only test route: create notification without authentication
router.post('/test-create', express.json(), asyncHandler(async (req, res, next) => {
  try {
    // Lazy load controller to avoid circular import issues
    const { createNotificationTest } = await import('../controllers/notification.controller.js')
    return createNotificationTest(req, res, next)
  } catch (err) {
    next(err)
  }
}))

// Dev-only: GET variant using query params to avoid JSON body parsing issues in some shells
router.get('/test-create-get', asyncHandler(async (req, res, next) => {
  try {
    const { recipient, title, message, type } = req.query || {}
    const { createNotification: createNotificationUtil } = await import('../utils/notification.utils.js')

    if (!recipient) {
      return res.status(400).json({ success: false, message: 'recipient is required' })
    }

    const notif = await createNotificationUtil({
      recipient,
      title: title || 'Test notification',
      message: message || 'This is a test notification',
      type: type || 'test',
      sendEmail: false,
    })

    if (!notif) {
      return res.status(500).json({ success: false, message: 'Failed to create notification' })
    }

    return res.status(201).json({ success: true, message: 'Notification created', data: notif })
  } catch (err) {
    next(err)
  }
}))

router.use(asyncHandler(authenticate))

router.get("/", asyncHandler(listNotifications))
router.patch("/read-all", asyncHandler(markAllNotificationsRead))
router.patch("/:notificationId/read", asyncHandler(markNotificationRead))
router.delete("/:notificationId", asyncHandler(deleteNotification))

export default router
