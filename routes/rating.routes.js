import { Router } from "express"
import { authorize } from "../middleware/auth.js"
import { asyncHandler } from "../utils/response.js"
import { validateRequest } from "../middleware/validation.js"
import { submitRatingSchema } from "../validations/rating.validation.js"
import { submitClientRatingSchema } from "../validations/rating.validation.js"
import {
  submitRating,
  submitClientRating,
  getDeliveryRating,
  getDriverRating,
  getClientRating,
  getMyRating,
  getMyClientRating,
  getMyRatingDashboard,
  getTopRated,
  getTopDrivers,
  getTopClients,
  getWorstDrivers,
  getWorstClients,
  getUnratedDrivers,
  getUnratedClients,
  getStatistics,
  getEvolution,
  getDriverEvolution,
  getClientEvolution,
  getAdminRatings,
} from "../controllers/rating.controller.js"

const router = Router()

// Client rates Driver
router.post("/deliveries/:deliveryId/rate", authorize("client"), validateRequest(submitRatingSchema), asyncHandler(submitRating))

// Driver rates Client
router.post("/deliveries/:deliveryId/rate-client", authorize("driver"), validateRequest(submitClientRatingSchema), asyncHandler(submitClientRating))

// Get ratings for a specific delivery (both directions)
router.get("/deliveries/:deliveryId/rating", asyncHandler(getDeliveryRating))

// Driver's own rating summary (for driver profile)
router.get("/driver/me/rating", authorize("driver"), asyncHandler(getMyRating))

// Client's own rating summary (for client profile)
router.get("/client/me/rating", authorize("client"), asyncHandler(getMyClientRating))

// Dashboard rating for current user (works for both roles)
router.get("/dashboard", asyncHandler(getMyRatingDashboard))

// Rating evolution for current user
router.get("/evolution", asyncHandler(getEvolution))

// Rating evolution for a specific driver
router.get("/drivers/:driverId/evolution", asyncHandler(getDriverEvolution))

// Rating evolution for a specific client
router.get("/clients/:clientId/evolution", asyncHandler(getClientEvolution))

// Public: any specific driver's rating
router.get("/drivers/:driverId/rating", asyncHandler(getDriverRating))

// Public: any specific client's rating
router.get("/clients/:clientId/rating", asyncHandler(getClientRating))

// Top rated drivers (public)
router.get("/top-rated", asyncHandler(getTopRated))

// Statistics & distribution (public)
router.get("/statistics", asyncHandler(getStatistics))

// Top drivers / clients (with badges)
router.get("/top-drivers", authorize("admin", "authority"), asyncHandler(getTopDrivers))
router.get("/top-clients", authorize("admin", "authority"), asyncHandler(getTopClients))

// Worst rated
router.get("/worst-drivers", authorize("admin", "authority"), asyncHandler(getWorstDrivers))
router.get("/worst-clients", authorize("admin", "authority"), asyncHandler(getWorstClients))

// Without ratings
router.get("/unrated-drivers", authorize("admin", "authority"), asyncHandler(getUnratedDrivers))
router.get("/unrated-clients", authorize("admin", "authority"), asyncHandler(getUnratedClients))

// Admin: full ratings dashboard
router.get("/admin", authorize("admin", "authority"), asyncHandler(getAdminRatings))

export default router
