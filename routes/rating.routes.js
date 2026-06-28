import express from "express"
import { authenticate, authorize } from "../middleware/auth.js"
import { validateRequest } from "../middleware/validation.js"
import { asyncHandler } from "../utils/response.js"
import {
  submitRating,
  getDeliveryRating,
  getDriverRating,
  getMyRating,
  getTopRated,
} from "../controllers/rating.controller.js"
import { submitRatingSchema } from "../validations/rating.validation.js"

const router = express.Router()
router.use(asyncHandler(authenticate))

router.post("/deliveries/:deliveryId/rate", authorize("client"), validateRequest(submitRatingSchema), asyncHandler(submitRating))
router.get("/deliveries/:deliveryId/rating", asyncHandler(getDeliveryRating))
router.get("/drivers/:driverId/rating", asyncHandler(getDriverRating))
router.get("/driver/me/rating", authorize("driver"), asyncHandler(getMyRating))
router.get("/admin/top-rated", authorize("admin", "authority"), asyncHandler(getTopRated))

export default router
