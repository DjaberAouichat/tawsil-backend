import express from "express"
import {
  createRate,
  updateRate,
  deleteRate,
  getUserRates,
} from "../controllers/rate.controller.js"
import { authenticate } from "../middleware/auth.js"
import { asyncHandler } from "../utils/response.js"

const router = express.Router()

router.use(asyncHandler(authenticate))

router.post("/", asyncHandler(createRate))
router.get("/user/:userId", asyncHandler(getUserRates))
router.patch("/:rateId", asyncHandler(updateRate))
router.delete("/:rateId", asyncHandler(deleteRate))

export default router
