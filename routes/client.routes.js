import express from "express"
import { clientHome } from "../controllers/client.controller.js"
import { authenticate, authorize } from "../middleware/auth.js"
import { asyncHandler } from "../utils/response.js"

const router = express.Router()

router.use(asyncHandler(authenticate))
router.get("/home", authorize("client"), asyncHandler(clientHome))

export default router
