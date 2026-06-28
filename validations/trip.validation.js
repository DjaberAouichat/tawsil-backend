import { z } from "zod"

const coordinatesSchema = z
  .array(z.number())
  .length(2, "Coordinates must contain [lng, lat]")
  .refine(
    ([lng, lat]) => Math.abs(lng) <= 180 && Math.abs(lat) <= 90,
    "Coordinates must be valid [lng, lat]",
  )

const pointSchema = z.object({
  address: z.string().min(3),
  location: z.object({
    coordinates: coordinatesSchema,
  }),
})

export const createTripSchema = z.object({
  title: z.string().max(120).optional(),
  origin: pointSchema,
  destination: pointSchema,
  departureTime: z.coerce.date(),
  expectedArrivalTime: z.coerce.date().optional(),
  maxDeliveries: z.number().int().min(1).max(50).optional(),
  vehicleType: z.enum(["standard", "comfort", "premium", "van"]).optional(),
  acceptedPackageSize: z.enum(["small_only", "up_to_medium", "up_to_large", "any"]).optional(),
  notes: z.string().max(500).optional(),
})

export const updateTripStatusSchema = z.object({
  status: z.enum(["planned", "active", "completed", "cancelled"]),
})

export const updateTripSchema = z.object({
  title: z.string().max(120).optional(),
  origin: pointSchema.optional(),
  destination: pointSchema.optional(),
  departureTime: z.coerce.date().optional(),
  expectedArrivalTime: z.coerce.date().optional(),
  maxDeliveries: z.number().int().min(1).max(50).optional(),
  vehicleType: z.enum(["standard", "comfort", "premium", "van"]).optional(),
  acceptedPackageSize: z.enum(["small_only", "up_to_medium", "up_to_large", "any"]).optional(),
  notes: z.string().max(500).optional(),
})
