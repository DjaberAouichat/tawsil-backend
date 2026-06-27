import express from "express"
import { getActivePromotions } from "../controllers/promotion.controller.js"
import { authenticate } from "../middleware/auth.js"
import { asyncHandler } from "../utils/response.js"

const router = express.Router()

router.use(asyncHandler(authenticate))

router.get("/active", asyncHandler(getActivePromotions))

export default router
