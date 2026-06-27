import express from "express"
import {
  addVehicle,
  getMyVehicles,
  getVehicle,
  updateVehicleHandler,
  deleteVehicleHandler,
  assignVehicleToDriverHandler,
  verifyVehicle,
} from "../controllers/vehicle.controller.js"
import { authenticate, authorize } from "../middleware/auth.js"
import { validateRequest } from "../middleware/validation.js"
import { asyncHandler } from "../utils/response.js"
import {
  addVehicleSchema,
  assignVehicleSchema,
  updateVehicleSchema,
  vehicleIdParamSchema,
  verifyVehicleSchema,
} from "../validations/misc.validation.js"

const router = express.Router()

router.use(asyncHandler(authenticate))

router.post("/", authorize("driver"), validateRequest(addVehicleSchema), asyncHandler(addVehicle))
router.get("/mine", authorize("driver"), asyncHandler(getMyVehicles))
router.get("/:vehicleId", authorize("driver", "admin", "authority"), validateRequest(vehicleIdParamSchema), asyncHandler(getVehicle))
router.patch("/:vehicleId", authorize("driver", "admin", "authority"), validateRequest(updateVehicleSchema), asyncHandler(updateVehicleHandler))
router.delete("/:vehicleId", authorize("driver", "admin", "authority"), validateRequest(vehicleIdParamSchema), asyncHandler(deleteVehicleHandler))
router.patch("/:vehicleId/assign", authorize("driver", "admin", "authority"), validateRequest(assignVehicleSchema), asyncHandler(assignVehicleToDriverHandler))
router.patch("/:vehicleId/verify", authorize("admin", "authority"), validateRequest(verifyVehicleSchema), asyncHandler(verifyVehicle))

export default router
