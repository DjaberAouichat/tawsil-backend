import express from "express"

import { authenticate, authorize } from "../middleware/auth.js"
import {
  getClientDashboardSummary,
  getDriverDashboardSummary,
  setDriverAvailability,
} from "../controllers/dashboard.controller.js"
import { asyncHandler } from "../utils/response.js"

const router = express.Router()

router.use(asyncHandler(authenticate))

router.get("/driver/summary", authorize("driver"), asyncHandler(getDriverDashboardSummary))
router.get("/client/summary", authorize("client"), asyncHandler(getClientDashboardSummary))
router.patch("/driver/availability", authorize("driver"), asyncHandler(setDriverAvailability))

export default router
