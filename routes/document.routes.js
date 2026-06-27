import express from "express"
import {
  addDocument,
  getMyDocuments,
  getDriverDocuments,
  modifyDocument,
  verifyDocumentHandler,
  rejectDocumentHandler,
  deleteDocumentHandler,
} from "../controllers/document.controller.js"
import { authenticate, authorize } from "../middleware/auth.js"
import { validateRequest } from "../middleware/validation.js"
import { asyncHandler } from "../utils/response.js"
import {
  addDocumentSchema,
  documentIdParamSchema,
  modifyDocumentSchema,
  reviewDocumentSchema,
} from "../validations/misc.validation.js"

const router = express.Router()

router.use(asyncHandler(authenticate))

router.post("/", authorize("driver"), validateRequest(addDocumentSchema), asyncHandler(addDocument))
router.get("/mine", authorize("driver"), asyncHandler(getMyDocuments))
router.get("/driver/:driverId", authorize("admin", "authority"), asyncHandler(getDriverDocuments))
router.patch("/:documentId", authorize("driver"), validateRequest(modifyDocumentSchema), asyncHandler(modifyDocument))
router.patch("/:documentId/verify", authorize("admin", "authority"), validateRequest(reviewDocumentSchema), asyncHandler(verifyDocumentHandler))
router.patch("/:documentId/reject", authorize("admin", "authority"), validateRequest(reviewDocumentSchema), asyncHandler(rejectDocumentHandler))
router.delete("/:documentId", authorize("driver", "admin", "authority"), validateRequest(documentIdParamSchema), asyncHandler(deleteDocumentHandler))

export default router
