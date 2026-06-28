import express from "express"
import rateLimit from "express-rate-limit"
import { authenticate, authorize } from "../middleware/auth.js"
import { validateRequest } from "../middleware/validation.js"
import { asyncHandler } from "../utils/response.js"
import {
  acceptDelivery,
  attachDeliveryToTrip,
  cancelDelivery,
  createDelivery,
  createDraftDelivery,
  detachDeliveryFromTrip,
  estimateDeliveryPrice,
  getDeliveryById,
  getDeliveryPdf,
  getDeliveryStatusHistory,
  getDeliveryTracking,
  getDeliveryTrackingStream,
  getDriverActiveDelivery,
  getDriverCurrentTrip,
  getDriverExecutionPayload,
  getDriverHome,
  getEarningsPreview,
  listAdminDeliveries,
  listDriverAvailableDeliveries,
  listDriverAvailablePackagesByWilaya,
  listDriverDeliveries,
  listUserDeliveries,
  markDeliveryCompleted,
  markPickupCompleted,
  publishDraftDelivery,
  rejectDelivery,
  updateDeliveryProgress,
  updateDriverLiveLocation,
  updatePaymentStatus,
} from "../controllers/delivery.workflow.js"
import { getNearbyDeliveries } from "../controllers/driver.controller.js"
import {
  acceptDeliverySchema,
  attachDeliveryToTripSchema,
  cancelDeliverySchema,
  createDeliverySchema,
  createDraftDeliverySchema,
  estimateDeliveryPriceSchema,
  markDeliveredSchema,
  publishDraftDeliverySchema,
  rejectDeliverySchema,
  updateDeliveryProgressSchema,
  updateDriverLocationSchema,
  updatePaymentStatusSchema,
} from "../validations/delivery.validation.js"
import { driverAvailableDeliveriesQuerySchema } from "../validations/delivery-filter.validation.js"

const router = express.Router()
router.use(asyncHandler(authenticate))

const withProgressStatus = (status) => (req, _res, next) => {
  req.body = { ...(req.body || {}), status }
  next()
}

const createDeliveryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user.id,
  message: {
    success: false,
    message: "You have reached the maximum number of deliveries per hour. Please try again later.",
    details: { code: "CREATE_DELIVERY_RATE_LIMITED" },
  },
})

// ── Static routes first (before /:deliveryId param routes) ─────────────

// Price estimation (no auth guard — handled inside controller)
router.post("/estimate", validateRequest(estimateDeliveryPriceSchema), asyncHandler(estimateDeliveryPrice))

// Requester (client) — static
router.post("/", authorize("client"), createDeliveryLimiter, validateRequest(createDeliverySchema), asyncHandler(createDelivery))
router.post("/draft", authorize("client"), validateRequest(createDraftDeliverySchema), asyncHandler(createDraftDelivery))
router.get("/user", authorize("client"), asyncHandler(listUserDeliveries))

// Driver — static
router.get("/driver/home", authorize("driver"), asyncHandler(getDriverHome))
router.get("/driver/current-trip", authorize("driver"), asyncHandler(getDriverCurrentTrip))
router.get("/driver/mine", authorize("driver"), asyncHandler(listDriverDeliveries))
router.get("/driver/available", authorize("driver"), validateRequest(driverAvailableDeliveriesQuerySchema), asyncHandler(listDriverAvailableDeliveries))
router.get("/driver/available-by-wilaya", authorize("driver"), asyncHandler(listDriverAvailablePackagesByWilaya))
router.get("/driver/active", authorize("driver"), asyncHandler(getDriverActiveDelivery))
router.get("/driver/nearby", authorize("driver"), asyncHandler(getNearbyDeliveries))
router.post("/driver/location", authorize("driver"), validateRequest(updateDriverLocationSchema), asyncHandler(updateDriverLiveLocation))

// Admin / Authority — static
router.get("/admin", authorize("admin", "authority"), asyncHandler(listAdminDeliveries))

// ── Parameterized routes (/deliveryId/...) ─────────────────────────────

// Shared
router.post("/:deliveryId/cancel", validateRequest(cancelDeliverySchema), asyncHandler(cancelDelivery))
router.get("/:deliveryId/pdf", asyncHandler(getDeliveryPdf))
router.get("/:deliveryId/tracking/stream", asyncHandler(getDeliveryTrackingStream))
router.get("/:deliveryId/tracking", asyncHandler(getDeliveryTracking))
router.get("/:deliveryId/status-history", asyncHandler(getDeliveryStatusHistory))
router.get("/:deliveryId", asyncHandler(getDeliveryById))
router.get("/:deliveryId/earnings-preview", authorize("driver"), asyncHandler(getEarningsPreview))

// Requester (client) — parameterized
router.post("/:deliveryId/publish", authorize("client"), validateRequest(publishDraftDeliverySchema), asyncHandler(publishDraftDelivery))
router.patch("/:deliveryId/attach-trip", authorize("client"), validateRequest(attachDeliveryToTripSchema), asyncHandler(attachDeliveryToTrip))
router.delete("/:deliveryId/detach-trip", authorize("client"), asyncHandler(detachDeliveryFromTrip))

// Driver — parameterized
router.get("/:deliveryId/driver-execution", authorize("driver"), asyncHandler(getDriverExecutionPayload))
router.post("/:deliveryId/accept", authorize("driver"), validateRequest(acceptDeliverySchema), asyncHandler(acceptDelivery))
router.post("/:deliveryId/reject", authorize("driver"), validateRequest(rejectDeliverySchema), asyncHandler(rejectDelivery))
router.post("/:deliveryId/arrived-pickup", authorize("driver"), withProgressStatus("DriverArrivedPickup"), validateRequest(updateDeliveryProgressSchema), asyncHandler(updateDeliveryProgress))
router.post("/:deliveryId/pickup-completed", authorize("driver"), asyncHandler(markPickupCompleted))
router.post("/:deliveryId/in-transit", authorize("driver"), withProgressStatus("InTransit"), validateRequest(updateDeliveryProgressSchema), asyncHandler(updateDeliveryProgress))
router.post("/:deliveryId/arrived-dropoff", authorize("driver"), withProgressStatus("ArrivedDropoff"), validateRequest(updateDeliveryProgressSchema), asyncHandler(updateDeliveryProgress))
router.post("/:deliveryId/progress", authorize("driver"), validateRequest(updateDeliveryProgressSchema), asyncHandler(updateDeliveryProgress))
router.post("/:deliveryId/delivery-completed", authorize("driver"), validateRequest(markDeliveredSchema), asyncHandler(markDeliveryCompleted))

// Admin / Authority — parameterized
router.patch("/:deliveryId/payment-status", authorize("admin", "authority"), validateRequest(updatePaymentStatusSchema), asyncHandler(updatePaymentStatus))

export default router
