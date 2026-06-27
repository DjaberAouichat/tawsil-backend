import express from "express"
import { authenticate, authorize } from "../middleware/auth.js"
import { validateRequest } from "../middleware/validation.js"
import {
  createComplaintReport,
  createComplianceReport,
  createIncidentReport,
  getAuthorityClientById,
  getAuthorityDeliveryById,
  getAuthorityDriverById,
  getAuthorityOpsDashboardSummary,
  getAuthorityStats,
  getComplianceReportById,
  getComplaintReportById,
  getDriverReviewTimelineForAuthority,
  getIncidentReportById,
  listAuthorityClients,
  listAuthorityDeliveries,
  listAuthorityDrivers,
  listComplianceReports,
  listComplaintReports,
  listDriverReviewQueue,
  listIncidentReports,
  updateComplianceReport,
  updateComplaintReport,
  updateDriverReviewDecision,
  updateIncidentReport,
} from "../controllers/authority.controller.js"
import {
  authorityClientIdSchema,
  authorityComplaintIdSchema,
  authorityComplianceReportIdSchema,
  authorityDeliveryIdSchema,
  authorityDriverIdSchema,
  authorityDriversQuerySchema,
  authorityDeliveriesQuerySchema,
  authorityClientsQuerySchema,
  authorityIncidentIdSchema,
  createComplaintSchema,
  createComplianceReportSchema,
  createIncidentSchema,
  getDriverReviewTimelineSchema,
  listComplaintsSchema,
  listComplianceReportsSchema,
  listDriverReviewQueueSchema,
  listIncidentsSchema,
  updateComplaintSchema,
  updateComplianceReportSchema,
  updateDriverReviewDecisionSchema,
  updateIncidentSchema,
} from "../validations/authority.validation.js"
import { asyncHandler } from "../utils/response.js"

const router = express.Router()

router.use(asyncHandler(authenticate))
router.use(authorize("authority", "admin"))

router.get("/dashboard/summary", asyncHandler(getAuthorityOpsDashboardSummary))

router.get("/stats", asyncHandler(getAuthorityStats))

router.get("/clients", validateRequest(authorityClientsQuerySchema), asyncHandler(listAuthorityClients))
router.get("/clients/:clientId", validateRequest(authorityClientIdSchema), asyncHandler(getAuthorityClientById))

router.get("/drivers", validateRequest(authorityDriversQuerySchema), asyncHandler(listAuthorityDrivers))
router.get("/drivers/:driverId", validateRequest(authorityDriverIdSchema), asyncHandler(getAuthorityDriverById))

router.get("/deliveries", validateRequest(authorityDeliveriesQuerySchema), asyncHandler(listAuthorityDeliveries))
router.get("/deliveries/:deliveryId", validateRequest(authorityDeliveryIdSchema), asyncHandler(getAuthorityDeliveryById))

router.get("/reviews/drivers", validateRequest(listDriverReviewQueueSchema), asyncHandler(listDriverReviewQueue))
router.patch("/reviews/drivers/:driverId/status", validateRequest(updateDriverReviewDecisionSchema), asyncHandler(updateDriverReviewDecision))
router.get("/reviews/drivers/:driverId/timeline", validateRequest(getDriverReviewTimelineSchema), asyncHandler(getDriverReviewTimelineForAuthority))

router.post("/reports/incidents", validateRequest(createIncidentSchema), asyncHandler(createIncidentReport))
router.get("/reports/incidents", validateRequest(listIncidentsSchema), asyncHandler(listIncidentReports))
router.get("/reports/incidents/:incidentId", validateRequest(authorityIncidentIdSchema), asyncHandler(getIncidentReportById))
router.patch("/reports/incidents/:incidentId", validateRequest(updateIncidentSchema), asyncHandler(updateIncidentReport))

router.post("/reports/complaints", validateRequest(createComplaintSchema), asyncHandler(createComplaintReport))
router.get("/reports/complaints", validateRequest(listComplaintsSchema), asyncHandler(listComplaintReports))
router.get("/reports/complaints/:complaintId", validateRequest(authorityComplaintIdSchema), asyncHandler(getComplaintReportById))
router.patch("/reports/complaints/:complaintId", validateRequest(updateComplaintSchema), asyncHandler(updateComplaintReport))

router.post("/reports/compliance", validateRequest(createComplianceReportSchema), asyncHandler(createComplianceReport))
router.get("/reports/compliance", validateRequest(listComplianceReportsSchema), asyncHandler(listComplianceReports))
router.get("/reports/compliance/:reportId", validateRequest(authorityComplianceReportIdSchema), asyncHandler(getComplianceReportById))
router.patch("/reports/compliance/:reportId", validateRequest(updateComplianceReportSchema), asyncHandler(updateComplianceReport))

export default router
