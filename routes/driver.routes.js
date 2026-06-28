import express from "express"
import { authenticate, authorize } from "../middleware/auth.js"
import { validateRequest } from "../middleware/validation.js"
import { asyncHandler } from "../utils/response.js"
import {
  getCurrentLocation,
  getCoverageZones,
  getDriverStats,
  markApprovalWelcomeShownHandler,
  saveFilterPreferences,
  saveNotificationPreferences,
} from "../controllers/driver.controller.js"
import { saveFilterPreferencesSchema } from "../validations/delivery-filter.validation.js"

const router = express.Router()
router.use(asyncHandler(authenticate))

router.get("/stats", authorize("driver"), asyncHandler(getDriverStats))
router.post("/approval-welcome-shown", authorize("driver"), asyncHandler(markApprovalWelcomeShownHandler))
router.get("/location/current", authorize("driver"), asyncHandler(getCurrentLocation))
router.get("/coverage-zones", authorize("driver"), asyncHandler(getCoverageZones))
router.put("/filter-preferences", authorize("driver"), validateRequest(saveFilterPreferencesSchema), asyncHandler(saveFilterPreferences))
router.put("/notification-preferences", authorize("driver"), asyncHandler(saveNotificationPreferences))

export default router
