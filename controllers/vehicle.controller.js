import crypto from "crypto"
import { exec } from "../lib/db.js"
import {
  createVehicle,
  findVehicleById,
  findVehiclesByDriverId,
  updateVehicle,
  deleteVehicle,
  assignVehicleToDriver,
  findDriverByUserId,
} from "../models/driver.model.js"
import { sendSuccess, createError } from "../utils/response.js"

export const addVehicle = async (req, res, next) => {
  try {
    const driverId = req.user.id
    const driver = await findDriverByUserId(null, driverId)
    if (!driver) return next(createError(404, "Driver profile not found"))

    const { make, model, year, color, licensePlate, insuranceNumber, insuranceExpiry, type } = req.body
    if (!make || !model) return next(createError(400, "make and model are required"))

    const vehicle = await createVehicle(null, {
      id: crypto.randomUUID(),
      driverId,
      make,
      model,
      year: year ? Number(year) : null,
      color: color || null,
      licensePlate: licensePlate || null,
      insuranceNumber: insuranceNumber || null,
      insuranceExpiry: insuranceExpiry || null,
      type: type || null,
      isVerified: false,
    })

    return sendSuccess(res, 201, "Vehicle added successfully", { vehicle })
  } catch (error) {
    next(error)
  }
}

export const getMyVehicles = async (req, res, next) => {
  try {
    const vehicles = await findVehiclesByDriverId(null, req.user.id)
    return sendSuccess(res, 200, "Vehicles fetched successfully", { vehicles })
  } catch (error) {
    next(error)
  }
}

export const getVehicle = async (req, res, next) => {
  try {
    const vehicle = await findVehicleById(null, req.params.vehicleId)
    if (!vehicle) return next(createError(404, "Vehicle not found"))

    const isAdmin = req.user.role === "admin" || req.user.role === "authority"
    if (!isAdmin && vehicle.driverId !== req.user.id) {
      return next(createError(403, "You are not authorized to access this vehicle"))
    }

    return sendSuccess(res, 200, "Vehicle fetched successfully", { vehicle })
  } catch (error) {
    next(error)
  }
}

export const updateVehicleHandler = async (req, res, next) => {
  try {
    const vehicle = await findVehicleById(null, req.params.vehicleId)
    if (!vehicle) return next(createError(404, "Vehicle not found"))

    const isAdmin = req.user.role === "admin" || req.user.role === "authority"
    if (vehicle.driverId !== req.user.id && !isAdmin) {
      return next(createError(403, "You can only update your own vehicles"))
    }

    const updated = await updateVehicle(null, req.params.vehicleId, req.body)
    return sendSuccess(res, 200, "Vehicle updated successfully", { vehicle: updated })
  } catch (error) {
    next(error)
  }
}

export const deleteVehicleHandler = async (req, res, next) => {
  try {
    const vehicle = await findVehicleById(null, req.params.vehicleId)
    if (!vehicle) return next(createError(404, "Vehicle not found"))

    const isAdmin = req.user.role === "admin" || req.user.role === "authority"
    if (vehicle.driverId !== req.user.id && !isAdmin) {
      return next(createError(403, "You can only delete your own vehicles"))
    }

    await deleteVehicle(null, req.params.vehicleId)
    return sendSuccess(res, 200, "Vehicle deleted successfully", { vehicleId: req.params.vehicleId })
  } catch (error) {
    next(error)
  }
}

export const assignVehicleToDriverHandler = async (req, res, next) => {
  try {
    const { vehicleId } = req.params
    const { driverId } = req.body

    if (!driverId) return next(createError(400, "driverId is required"))

    const vehicle = await findVehicleById(null, vehicleId)
    if (!vehicle) return next(createError(404, "Vehicle not found"))

    const isAdmin = req.user.role === "admin" || req.user.role === "authority"
    if (vehicle.driverId !== req.user.id && !isAdmin) {
      return next(createError(403, "Not authorized to reassign this vehicle"))
    }

    const targetDriver = await findDriverByUserId(null, driverId)
    if (!targetDriver) return next(createError(404, "Target driver not found"))

    const updated = await assignVehicleToDriver(null, vehicleId, driverId)
    return sendSuccess(res, 200, "Vehicle assigned to driver successfully", { vehicle: updated })
  } catch (error) {
    next(error)
  }
}

export const verifyVehicle = async (req, res, next) => {
  try {
    const { vehicleId } = req.params
    const { verified } = req.body

    const vehicle = await findVehicleById(null, vehicleId)
    if (!vehicle) return next(createError(404, "Vehicle not found"))

    await exec(null, `UPDATE Vehicles SET is_verified = ? WHERE id = ?`, [verified ? 1 : 0, vehicleId])
    const updated = await findVehicleById(null, vehicleId)
    return sendSuccess(res, 200, `Vehicle ${verified ? "verified" : "unverified"} successfully`, { vehicle: updated })
  } catch (error) {
    next(error)
  }
}
