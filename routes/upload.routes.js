import express from "express"

import { uploadImage } from "../controllers/upload.controller.js"
import { authenticate } from "../middleware/auth.js"
import { runImageUpload } from "../middleware/upload.js"
import { asyncHandler } from "../utils/response.js"

const router = express.Router()

router.post("/upload-image", asyncHandler(authenticate), runImageUpload, asyncHandler(uploadImage))

export default router
