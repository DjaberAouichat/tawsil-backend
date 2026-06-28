import express from "express"
import {
  createTrip,
  deleteTrip,
  getTripPdf,
  getTripById,
  listAvailableTrips,
  listCompatibleTripsForDelivery,
  listDriverTrips,
  listDriverActiveTrips,
  updateTrip,
  updateTripStatus,
} from "../controllers/trip.controller.js"
import { authenticate, authorize } from "../middleware/auth.js"
import { validateRequest } from "../middleware/validation.js"
import { asyncHandler } from "../utils/response.js"
import {
  createTripSchema,
  updateTripSchema,
  updateTripStatusSchema,
} from "../validations/trip.validation.js"

const router = express.Router()

router.use(asyncHandler(authenticate))

router.get("/compatible/:deliveryId", authorize("client"), asyncHandler(listCompatibleTripsForDelivery))
router.get("/available", authorize("client", "driver", "admin", "authority"), asyncHandler(listAvailableTrips))
router.get("/driver/mine", authorize("driver"), asyncHandler(listDriverTrips))
router.get("/driver/active", authorize("driver"), asyncHandler(listDriverActiveTrips))
router.post("/", authorize("driver"), validateRequest(createTripSchema), asyncHandler(createTrip))
router.patch("/:tripId", authorize("driver"), validateRequest(updateTripSchema), asyncHandler(updateTrip))
router.delete("/:tripId", authorize("driver"), asyncHandler(deleteTrip))
router.patch("/:tripId/status", authorize("driver", "admin", "authority"), validateRequest(updateTripStatusSchema), asyncHandler(updateTripStatus))
router.get("/:tripId/pdf", asyncHandler(getTripPdf))
router.get("/:tripId", asyncHandler(getTripById))

export default router
