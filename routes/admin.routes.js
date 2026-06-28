import express from "express"
import {
  listAccounts,
  getAccount,
  blockAccount,
  unblockAccount,
  suspendAccount,
  unsuspendAccount,
  deleteAccount,
  overrideDeliveryStatus,
  verifyDriverDocuments,
  listAuthorityDeliveries,
  listAdminDriverReviews,
  updateDriverReviewStatusHandler,
  getDriverVerificationTimelineHandler,
  getDriverStatusHistoryHandler,
  getAdminDashboardSummary,
  getAdminDashboardStats,
  getAuthorityDashboardSummary,
  listAdminTrips,
  listAdminTransactions,
  listDriversByReviewStatus,
  listDriversWithSubmittedDocuments,
  getSettings,
  updateSetting,
} from "../controllers/admin.controller.js"
import { createPromotion, listPromotions, updatePromotionHandler, deactivatePromotionHandler } from "../controllers/promotion.controller.js"
import { authenticate, authorize } from "../middleware/auth.js"
import { validateRequest } from "../middleware/validation.js"
import {
  listAdminDriverReviewsSchema,
  updateDriverReviewStatusAdminSchema,
} from "../validations/admin.validation.js"
import { asyncHandler } from "../utils/response.js"

const router = express.Router()

router.use(asyncHandler(authenticate))

router.get("/dashboard", authorize("admin"), asyncHandler(getAdminDashboardStats))
router.get("/stats", authorize("admin"), asyncHandler(getAdminDashboardSummary))
router.get("/dashboard/stats", authorize("admin"), asyncHandler(getAdminDashboardStats))
router.get("/revenues", authorize("admin"), asyncHandler(getAdminDashboardStats))
router.get("/users", authorize("admin", "authority"), asyncHandler(listAccounts))
router.get("/clients", authorize("admin", "authority"), asyncHandler((req, res, next) => {
  req.adminRoleOverride = "client"
  return listAccounts(req, res, next)
}))
router.get("/drivers", authorize("admin", "authority"), asyncHandler((req, res, next) => {
  req.adminRoleOverride = "driver"
  return listAccounts(req, res, next)
}))
router.get("/accounts", authorize("admin", "authority"), asyncHandler(listAccounts))
router.get("/accounts/:userId", authorize("admin", "authority"), asyncHandler(getAccount))
router.patch("/accounts/:userId/block", authorize("admin"), asyncHandler(blockAccount))
router.patch("/accounts/:userId/unblock", authorize("admin"), asyncHandler(unblockAccount))
router.patch("/accounts/:userId/suspend", authorize("admin"), asyncHandler(suspendAccount))
router.patch("/accounts/:userId/unsuspend", authorize("admin"), asyncHandler(unsuspendAccount))
router.delete("/accounts/:userId", authorize("admin"), asyncHandler(deleteAccount))
router.patch("/deliveries/:deliveryId/override-status", authorize("admin"), asyncHandler(overrideDeliveryStatus))
router.patch("/drivers/:driverId/verify-documents", authorize("admin", "authority"), asyncHandler(verifyDriverDocuments))
router.get("/drivers/pending", authorize("admin", "authority"), asyncHandler((req, res, next) => {
  req.adminReviewStatusOverride = "pending"
  return listDriversByReviewStatus(req, res, next)
}))
router.get("/drivers/approved", authorize("admin", "authority"), asyncHandler((req, res, next) => {
  req.adminReviewStatusOverride = "approved"
  return listDriversByReviewStatus(req, res, next)
}))
router.get("/drivers/rejected", authorize("admin", "authority"), asyncHandler((req, res, next) => {
  req.adminReviewStatusOverride = "rejected"
  return listDriversByReviewStatus(req, res, next)
}))
router.patch(
  "/drivers/:driverId/review-status",
  authorize("admin", "authority"),
  validateRequest(updateDriverReviewStatusAdminSchema),
  asyncHandler(updateDriverReviewStatusHandler),
)
router.get(
  "/drivers/pending",
  authorize("admin", "authority"),
  validateRequest(listAdminDriverReviewsSchema),
  asyncHandler(listAdminDriverReviews),
)
router.get(
  "/drivers/approved",
  authorize("admin", "authority"),
  validateRequest(listAdminDriverReviewsSchema),
  asyncHandler(listAdminDriverReviews),
)
router.get(
  "/drivers/rejected",
  authorize("admin", "authority"),
  validateRequest(listAdminDriverReviewsSchema),
  asyncHandler(listAdminDriverReviews),
)
router.get(
  "/drivers/:driverId/verification-timeline",
  authorize("admin", "authority"),
  asyncHandler(getDriverVerificationTimelineHandler),
)
router.get(
  "/drivers/:driverId/status-history",
  authorize("admin", "authority"),
  asyncHandler(getDriverStatusHistoryHandler),
)
router.get("/verifications", authorize("admin", "authority"), asyncHandler(listDriversWithSubmittedDocuments))
router.get("/deliveries", authorize("authority", "admin"), asyncHandler(listAuthorityDeliveries))
router.get("/trips", authorize("admin", "authority"), asyncHandler(listAdminTrips))
router.get("/dashboard/summary", authorize("admin"), asyncHandler(getAdminDashboardSummary))
router.get("/transactions", authorize("admin"), asyncHandler(listAdminTransactions))
router.get("/authority/dashboard/summary", authorize("authority", "admin"), asyncHandler(getAuthorityDashboardSummary))

router.post("/promotions", authorize("admin"), asyncHandler(createPromotion))
router.get("/promotions", authorize("admin"), asyncHandler(listPromotions))
router.patch("/promotions/:promotionId", authorize("admin"), asyncHandler(updatePromotionHandler))
router.patch("/promotions/:promotionId/deactivate", authorize("admin"), asyncHandler(deactivatePromotionHandler))

router.get("/settings", authorize("admin"), asyncHandler(getSettings))
router.put("/settings/:key", authorize("admin"), asyncHandler(updateSetting))

export default router



